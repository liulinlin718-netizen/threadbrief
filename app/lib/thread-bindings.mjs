import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, link, unlink, rename } from 'node:fs/promises';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{32}$/;
const same = (a, b) => typeof a === 'string' && typeof b === 'string'
  && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function authorityValue(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError('Invalid panel authority');
  return value.trim().normalize('NFC');
}
async function publish(file, bytes, exclusive = false) {
  const temporary = `${file}.${randomBytes(12).toString('hex')}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try {
    if (exclusive) {
      try { await link(temporary, file); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    } else await rename(temporary, file);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

// Local backend-only API. There is deliberately no HTTP registration endpoint.
// The key protects against forged browser input, not another process with this user's file access.
export async function openThreadBindings({ directory, binding }) {
  const authority = { hostId: authorityValue(binding?.hostId), accountScope: authorityValue(binding?.accountScope) };
  const root = path.resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await publish(path.join(root, 'registry.key'), randomBytes(32), true);
  const key = await readFile(path.join(root, 'registry.key'));
  if (key.length !== 32) throw new TypeError('Invalid local panel registry key');
  const sign = payload => createHmac('sha256', key).update(JSON.stringify(payload)).digest('hex');
  const encode = payload => JSON.stringify({ payload, signature: sign(payload) });
  async function decode(file) {
    const text = await readFile(file, 'utf8');
    if (text.length > 10000) throw new TypeError('Invalid local panel binding');
    const envelope = JSON.parse(text);
    if (!envelope?.payload || !same(envelope.signature, sign(envelope.payload))) throw new TypeError('Invalid local panel binding signature');
    const record = envelope.payload;
    if (record.version !== 1 || record.hostId !== authority.hostId || record.accountScope !== authority.accountScope) throw new TypeError('Panel registry authority does not match launcher');
    return record;
  }
  await publish(path.join(root, 'authority.json'), encode({ version: 1, ...authority }), true);
  await decode(path.join(root, 'authority.json'));
  await mkdir(path.join(root, 'threads'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(root, 'panels'), { recursive: true, mode: 0o700 });
  const validRecord = record => typeof record.threadId === 'string' && UUID.test(record.threadId)
    && typeof record.token === 'string' && TOKEN.test(record.token);
  async function lookup(token) {
    if (!TOKEN.test(token)) return null;
    try {
      const record = await decode(path.join(root, 'panels', `${token}.json`));
      if (!validRecord(record) || !same(record.token, token) || typeof record.title !== 'string' || record.title.length > 500) throw new TypeError('Invalid local panel binding');
      return { threadId: record.threadId, ...authority, title: record.title, token };
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function register({ threadId, title }, { token } = {}) {
    if (typeof threadId !== 'string' || !UUID.test(threadId)) throw new TypeError('A real thread UUID is required');
    if (token !== undefined && !TOKEN.test(token)) throw new TypeError('Invalid local panel token');
    if (title !== undefined && (typeof title !== 'string' || title.length > 500 || /[\u0000-\u001f\u007f]/u.test(title))) throw new TypeError('Invalid task title');
    const requested = token === undefined ? null : await lookup(token);
    if (requested && requested.threadId !== threadId) throw new TypeError('Panel token already belongs to another task');
    const indexFile = path.join(root, 'threads', `${threadId}.json`);
    await publish(indexFile, encode({ version: 1, ...authority, threadId, token: token ?? randomBytes(24).toString('base64url') }), true);
    const index = await decode(indexFile);
    if (!validRecord(index) || index.threadId !== threadId || (token !== undefined && !same(index.token, token))) throw new TypeError('Task already has a different panel binding');
    const existing = await lookup(index.token);
    if (existing && existing.threadId !== threadId) throw new TypeError('Panel token already belongs to another task');
    const nextTitle = title === undefined ? existing?.title || '' : title;
    if (!existing || existing.title !== nextTitle) {
      await publish(path.join(root, 'panels', `${index.token}.json`), encode({ ...index, title: nextTitle }), !existing);
    }
    const registered = await lookup(index.token);
    if (registered.threadId !== threadId) throw new TypeError('Panel token already belongs to another task');
    return registered;
  }
  return { register, lookup, directory: root };
}
