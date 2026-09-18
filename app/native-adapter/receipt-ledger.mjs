import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, readdir, readFile, open, link, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stableSerialize } from '../lib/host-contract.mjs';

const SCOPE_KEYS = ['hostId', 'accountScope', 'threadId'];
const RECEIPT_KEYS = ['type', 'version', 'status', 'evidence', 'scope', 'revision', 'compiledHash', 'mode', 'requestId', 'turnId'];
const REVISION_DIRECTORY = /^r[0-9]{16}$/u;
const HASH_FILE = /^[a-f0-9]{64}\.json$/u;
const PENDING_FILE = /^\.pending-[0-9]+-[a-f0-9-]{36}$/u;

function failure(code, message, cause) { return Object.assign(new Error(message), { code, ...(cause ? { cause } : {}) }); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function digest(value) { return createHash('sha256').update(stableSerialize(value)).digest('hex'); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function exactlyKeys(value, keys) { return record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }

function normalizeScope(value) {
  if (!record(value)) throw failure('RECEIPT_INVALID', 'A host/account/thread scope is required');
  const scope = {};
  for (const key of SCOPE_KEYS) {
    if (typeof value[key] !== 'string') throw failure('RECEIPT_INVALID', `Invalid scope.${key}`);
    scope[key] = value[key].trim().normalize('NFC');
    if (!scope[key] || scope[key].length > 512 || /[\u0000-\u001f\u007f]/u.test(scope[key])) throw failure('RECEIPT_INVALID', `Invalid scope.${key}`);
  }
  return scope;
}

function normalizeReceipt(value) {
  if (!exactlyKeys(value, RECEIPT_KEYS) || value.type !== 'threadbrief.app-server-accepted' || value.version !== 1
    || value.status !== 'app-server-accepted' || value.evidence !== 'turn/start.result'
    || !Number.isSafeInteger(value.revision) || value.revision < 1 || !['overlay', 'reset'].includes(value.mode)
    || typeof value.compiledHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.compiledHash)
    || !((typeof value.requestId === 'string' && value.requestId.length > 0 && value.requestId.length <= 512)
      || (Number.isSafeInteger(value.requestId) && value.requestId >= 0))
    || typeof value.turnId !== 'string' || !value.turnId || value.turnId.length > 512
    || !exactlyKeys(value.scope, SCOPE_KEYS)) throw failure('RECEIPT_INVALID', 'Only a bounded app-server accepted receipt is supported');
  return { ...clone(value), scope: normalizeScope(value.scope) };
}

function identity(receipt) {
  return stableSerialize({ scope: receipt.scope, revision: receipt.revision, compiledHash: receipt.compiledHash, mode: receipt.mode });
}

function paths(directory, scope, revision) {
  if (typeof directory !== 'string' || !directory.trim()) throw failure('RECEIPT_INVALID', 'Receipt directory is required');
  const root = resolve(directory);
  const scoped = join(root, digest(scope));
  return { root, scoped, ...(revision ? { revision: join(scoped, `r${String(revision).padStart(16, '0')}`) } : {}) };
}

async function ensureDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('RECEIPT_CORRUPT', 'Expected a real receipt directory');
}

async function inspectDirectory(directory) {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('RECEIPT_CORRUPT', 'Unexpected receipt directory type');
    return await readdir(directory);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function retrySharing(operation) {
  const started = Date.now();
  while (true) {
    try { return await operation(); }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || Date.now() - started >= 1000) throw error;
      await delay(20);
    }
  }
}

async function syncDirectory(directory) {
  let handle;
  try { handle = await open(directory, 'r'); await handle.sync(); }
  catch (error) { if (!['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP'].includes(error.code)) throw error; }
  finally { await handle?.close(); }
}

async function readRecord(file) {
  let value;
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) throw new Error('Invalid receipt file type or size');
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw error;
    throw failure('RECEIPT_CORRUPT', 'Cannot decode receipt data', error);
  }
  try {
    if (!exactlyKeys(value, ['version', 'receipt', 'checksum']) || value.version !== 1 || value.checksum !== digest(value.receipt)) throw new Error('Receipt checksum mismatch');
    const receipt = normalizeReceipt(value.receipt);
    if (stableSerialize(receipt) !== stableSerialize(value.receipt)) throw new Error('Noncanonical receipt scope');
    return receipt;
  } catch (error) { throw failure('RECEIPT_CORRUPT', 'Receipt validation failed', error); }
}

async function readCommit(directory, scope, revision) {
  const names = await inspectDirectory(directory);
  if (names === null) return null;
  if (names.some(name => name !== 'accepted.json' && !HASH_FILE.test(name) && !PENDING_FILE.test(name))) {
    throw failure('RECEIPT_CORRUPT', 'Unknown entry in receipt revision directory');
  }
  let receipt;
  try { receipt = await readRecord(join(directory, 'accepted.json')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (receipt.revision !== revision || stableSerialize(receipt.scope) !== stableSerialize(scope)) {
    throw failure('RECEIPT_CORRUPT', 'Receipt does not match its scope and revision directory');
  }
  let referenced;
  try { referenced = await readRecord(join(directory, `${receipt.compiledHash}.json`)); }
  catch (error) { throw failure('RECEIPT_CORRUPT', 'Committed receipt is missing its immutable hash record', error); }
  if (stableSerialize(referenced) !== stableSerialize(receipt)) throw failure('RECEIPT_CORRUPT', 'Committed receipt and hash record disagree');
  return receipt;
}

/** No writes on read. Each scope is independent; accepted revisions may have gaps. */
export async function readAcceptedReceipt(directory, suppliedScope) {
  const scope = normalizeScope(suppliedScope);
  const location = paths(directory, scope);
  const names = await inspectDirectory(location.scoped);
  if (names === null) return null;
  if (names.some(name => !REVISION_DIRECTORY.test(name))) throw failure('RECEIPT_CORRUPT', 'Unknown entry in scoped receipt ledger');
  let latest = null;
  for (const name of names.sort()) {
    const revision = Number(name.slice(1));
    if (!Number.isSafeInteger(revision) || revision < 1) throw failure('RECEIPT_CORRUPT', 'Invalid accepted revision directory');
    const receipt = await readCommit(join(location.scoped, name), scope, revision);
    if (receipt && (!latest || receipt.revision > latest.revision)) latest = receipt;
  }
  return latest === null ? null : clone(latest);
}

/**
 * Trusted transport evidence only: this is not a frontend receipt-creation API.
 * A fixed accepted.json hard-link atomically commits the first context for a
 * revision. The hash file is complete before publication; different revisions
 * share no mutable head, so an old acceptance can never replace newer evidence.
 * An uncommitted hash/pending file after a crash is not acceptance evidence.
 */
export async function writeAcceptedReceipt(directory, suppliedReceipt) {
  const receipt = normalizeReceipt(suppliedReceipt);
  const location = paths(directory, receipt.scope, receipt.revision);
  // Refuse to add to an already damaged ledger rather than hiding its history.
  await readAcceptedReceipt(directory, receipt.scope);
  await ensureDirectory(location.root);
  await ensureDirectory(location.scoped);
  await ensureDirectory(location.revision);
  const committed = await readCommit(location.revision, receipt.scope, receipt.revision);
  if (committed) {
    if (identity(committed) !== identity(receipt)) throw failure('RECEIPT_CONFLICT', 'This revision already accepted a different context or mode');
    return clone(committed);
  }
  const file = join(location.revision, `${receipt.compiledHash}.json`);
  const temporary = join(location.revision, `.pending-${process.pid}-${randomUUID()}`);
  const encoded = { version: 1, receipt, checksum: digest(receipt) };
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${stableSerialize(encoded)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    try { await retrySharing(() => link(temporary, file)); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readRecord(file);
      if (identity(existing) !== identity(receipt)) throw failure('RECEIPT_CONFLICT', 'Hash record belongs to a conflicting receipt');
    }
    try { await retrySharing(() => link(file, join(location.revision, 'accepted.json'))); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await syncDirectory(location.revision);
    const final = await readCommit(location.revision, receipt.scope, receipt.revision);
    if (!final || identity(final) !== identity(receipt)) throw failure('RECEIPT_CONFLICT', 'Another context won the immutable revision commit');
    return clone(final);
  } finally {
    await handle?.close();
    await retrySharing(() => unlink(temporary)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
