import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, link, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const TTL = 5 * 60_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 1024
  && !/[\u0000-\u001f\u007f]/u.test(value);
const authorityScope = (authority, threadId) => uuid.test(threadId ?? '') && text(authority?.hostId) && text(authority?.accountScope)
  ? { hostId: authority.hostId.trim().normalize('NFC'), accountScope: authority.accountScope.trim().normalize('NFC'), threadId } : null;
const sameScope = (a, b) => ['hostId', 'accountScope', 'threadId'].every(key => a?.[key] === b?.[key]);
const receiptFile = (directory, turnId, toolUseId) => path.join(path.resolve(directory),
  createHash('sha256').update(JSON.stringify([turnId, toolUseId])).digest('hex') + '.json');
async function readReceipt(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new TypeError('Invalid hook scope receipt');
  return JSON.parse(await readFile(file, 'utf8'));
}

/** Record only a matched official backend notification, never a hook payload. */
export async function recordHookScope({ notification, directory, authority } = {}) {
  if (notification?.method !== 'hook/started') return null;
  const { threadId, turnId, run } = notification.params ?? {};
  if (run?.eventName !== 'preToolUse' || !Number.isSafeInteger(run.displayOrder) || run.displayOrder < 0
    || !text(run.sourcePath) || !text(run.id) || !text(turnId)) return null;
  const prefix = `pre-tool-use:${run.displayOrder}:${run.sourcePath}:`;
  if (!run.id.startsWith(prefix)) return null;
  const toolUseId = run.id.slice(prefix.length), scope = authorityScope(authority, threadId);
  if (!scope || !scope.hostId || !scope.accountScope || !text(toolUseId)) return null;
  const receipt = { schemaVersion: 1, scope, turnId, toolUseId, observedAt: new Date().toISOString() };
  const file = receiptFile(directory, turnId, toolUseId);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
  try {
    try { await link(temporary, file); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = await readReceipt(file);
      if (previous.schemaVersion !== 1 || !sameScope(previous.scope, scope) || previous.turnId !== turnId || previous.toolUseId !== toolUseId) {
        throw new TypeError('Hook scope correlation is ambiguous');
      }
      // Duplicate notification delivery must not extend a receipt's lifetime.
      return previous;
    }
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return receipt;
}

/** Resolve task identity using official event correlation, not session ancestry. */
export async function readHookScope({ input, directory, authority, waitMs = 2000, now = Date.now } = {}) {
  if (!text(input?.turn_id) || !text(input?.tool_use_id) || !directory) return null;
  if (input.agent_id != null && !uuid.test(input.agent_id)) return null;
  const file = receiptFile(directory, input.turn_id, input.tool_use_id);
  const until = Date.now() + Math.min(2000, Math.max(0, Number.isFinite(waitMs) ? waitMs : 2000));
  while (true) {
    try {
      const receipt = await readReceipt(file), scope = authorityScope(authority, receipt.scope?.threadId);
      const age = (typeof now === 'function' ? now() : now) - Date.parse(receipt.observedAt);
      if (receipt.schemaVersion !== 1 || !scope || !sameScope(receipt.scope, scope)
        || receipt.turnId !== input.turn_id || receipt.toolUseId !== input.tool_use_id
        || !Number.isFinite(age) || age < -5000 || age > TTL
        || input.agent_id != null && input.agent_id !== scope.threadId) return null;
      return receipt;
    } catch (error) {
      if (error.code !== 'ENOENT' || Date.now() >= until) return null;
      await delay(Math.min(40, Math.max(1, until - Date.now())));
    }
  }
}
