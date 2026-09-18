import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, open, rename, link, unlink, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const EMPTY = () => ({ revision: 0, persona: '', background: '', overrides: {} });
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const EVENTS = Object.freeze({
  prepared: ['prepared'], submitted: ['pending', 'accepted', 'failed'],
  accepted: ['accepted'], applied: ['applied'], rejected: ['rejected'],
  failed: ['failed'], reset: ['prepared', 'pending', 'accepted', 'applied', 'failed'],
  host_observed: ['unknown', 'observed'], panel_visible: ['observed'],
});
const SCOPE_FIELDS = ['hostId', 'accountScope', 'threadId'];
const OBSERVATION_FIELDS = new Set(['event', 'turnId', 'revision', 'status', 'detail', 'receivedAt']);
const LOCK_TIMEOUT_MS = 15_000;

function error(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function digest(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function revision(value, label = 'expectedRevision') {
  if (!Number.isSafeInteger(value) || value < 0) throw error('VALIDATION_ERROR', `${label} must be a non-negative safe integer`);
  return value;
}

function normalizeScope(scope) {
  if (!isRecord(scope)) throw error('VALIDATION_ERROR', 'scope must be an object');
  const result = {};
  for (const key of SCOPE_FIELDS) {
    const value = scope[key];
    if (typeof value !== 'string') throw error('VALIDATION_ERROR', `${key} must be a non-empty string`);
    result[key] = value.trim().normalize('NFC');
    if (!result[key] || result[key].length > 512 || /[\u0000-\u001f\u007f]/u.test(result[key])) {
      throw error('VALIDATION_ERROR', `${key} must contain 1–512 printable characters`);
    }
  }
  return result;
}

function normalizeProfile(profile) {
  if (!isRecord(profile)) throw error('VALIDATION_ERROR', 'profile must be an object');
  for (const [key, limit] of [['persona', 8000], ['background', 24000]]) {
    if (typeof profile[key] !== 'string' || profile[key].length > limit) {
      throw error('VALIDATION_ERROR', `${key} must be a string of at most ${limit} characters`);
    }
  }
  if (!isRecord(profile.overrides)) throw error('VALIDATION_ERROR', 'overrides must be an object');
  const keys = Object.keys(profile.overrides);
  if (keys.length > 512) throw error('VALIDATION_ERROR', 'at most 512 capability overrides are supported');
  const entries = new Map();
  for (const raw of keys) {
    const key = raw.trim().normalize('NFC');
    if (!key || key.length > 256 || RESERVED.has(key) || /[\u0000-\u001f\u007f]/u.test(key) || entries.has(key)) {
      throw error('VALIDATION_ERROR', 'invalid or duplicate normalized capability id');
    }
    const mode = profile.overrides[raw];
    if (!['on', 'off', 'inherit'].includes(mode)) throw error('VALIDATION_ERROR', `invalid mode for ${key}`);
    entries.set(key, mode);
  }
  const overrides = {};
  for (const key of [...entries.keys()].sort()) {
    if (entries.get(key) !== 'inherit') overrides[key] = entries.get(key);
  }
  return { persona: profile.persona, background: profile.background, overrides };
}

function snapshot(record) {
  return copy({ revision: record.revision, persona: record.persona, background: record.background, overrides: record.overrides });
}

function checkExpected(current, expected) {
  if (current.revision !== expected) {
    throw error('REVISION_CONFLICT', 'This thread configuration changed; reload before saving.', {
      expectedRevision: expected, actualRevision: current.revision,
    });
  }
}

function normalizeVersionName(value) {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw error('VALIDATION_ERROR', '版本名称必须是文本，不能包含控制字符');
  }
  const name = value.trim().normalize('NFC');
  if ([...name].length > 80) throw error('VALIDATION_ERROR', '版本名称最多 80 个字符');
  return name;
}

function checkHistoryExpected(metadata, expected) {
  if (metadata.historyRevision !== expected) {
    throw error('HISTORY_CONFLICT', '版本列表已在其他页面更改，请刷新后重试', {
      expectedHistoryRevision: expected, actualHistoryRevision: metadata.historyRevision,
    });
  }
}

function normalizeObservation(input) {
  if (!isRecord(input) || Object.keys(input).some(key => !OBSERVATION_FIELDS.has(key))) {
    throw error('VALIDATION_ERROR', 'unsupported observation fields');
  }
  if (!Object.hasOwn(EVENTS, input.event) || !EVENTS[input.event].includes(input.status)) {
    throw error('VALIDATION_ERROR', 'observation event/status combination is invalid');
  }
  const result = { event: input.event, revision: revision(input.revision, 'observation revision'), status: input.status };
  for (const [key, limit] of [['turnId', 256], ['detail', 500]]) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string' || input[key].length > limit || (key === 'turnId' && !input[key].trim())) {
        throw error('VALIDATION_ERROR', `${key} must be a string of at most ${limit} characters`);
      }
      result[key] = input[key];
    }
  }
  const receivedAt = input.receivedAt ?? new Date().toISOString();
  if (typeof receivedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(receivedAt)
    || !Number.isFinite(Date.parse(receivedAt))) throw error('VALIDATION_ERROR', 'receivedAt must be an ISO UTC timestamp');
  result.receivedAt = new Date(receivedAt).toISOString();
  const paddedTimestamp = receivedAt.replace(/(?:\.(\d{1,3}))?Z$/u, (_, fraction) => `.${(fraction ?? '').padEnd(3, '0')}Z`);
  if (result.receivedAt !== paddedTimestamp) throw error('VALIDATION_ERROR', 'receivedAt contains an invalid calendar date');
  return result;
}

async function syncDirectory(path) {
  let handle;
  try { handle = await open(path, 'r'); await handle.sync(); }
  catch (err) {
    // Windows does not expose directory fsync through Node. File data is still fsynced.
    if (!['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP'].includes(err.code)) throw err;
  } finally { await handle?.close(); }
}

async function regularJSON(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000) throw error('CORRUPT_STORE', 'Unexpected store file type or size');
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') throw err; throw error('CORRUPT_STORE', 'Cannot decode persisted store data', { cause: err }); }
}

async function ensureDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('CORRUPT_STORE', 'Expected a real store directory');
}

async function windowsSharingRetry(operation) {
  const started = Date.now();
  let pause = 5;
  while (true) {
    try { return await operation(); }
    catch (err) {
      // A scanner can briefly hold a Windows handle without delete sharing.
      // Keep the original atomic operation; never unlink a rename destination.
      // Permanent access errors still surface, and data-validation errors are
      // never retried or converted into revision conflicts.
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)
        || Date.now() - started >= 1000) throw err;
      await delay(pause);
      pause = Math.min(pause * 2, 50);
    }
  }
}

async function removeFile(path) {
  await windowsSharingRetry(() => unlink(path)).catch(err => { if (err.code !== 'ENOENT') throw err; });
}

async function durableWrite(path, value, { immutable = false } = {}) {
  const temp = `${path}.${process.pid}.${randomUUID()}.pending`;
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(`${canonical(value)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    // A hard link publishes an immutable revision atomically and refuses overwrite.
    // Mutable observations and lock tickets use atomic rename of a flushed file.
    if (immutable) await link(temp, path);
    else await windowsSharingRetry(() => rename(temp, path));
    await syncDirectory(resolve(path, '..'));
  } finally {
    await handle?.close();
    await removeFile(temp);
  }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { if (err.code === 'ESRCH') return false; if (err.code === 'EPERM') return true; throw err; }
}

/**
 * Local-file Lamport bakery mutex. Each contender owns a unique ticket path.
 * A dead process's ticket can be ignored without renaming another owner's lock.
 * Live processes are never displaced on an elapsed-time lease. PID reuse errs
 * toward LOCK_TIMEOUT, not takeover. Local coherent filesystem required; this
 * is deliberately not a distributed/network-filesystem lock.
 */
async function withMutex(directory, operation) {
  await ensureDirectory(directory);
  const token = `${process.pid}-${randomUUID()}`;
  const path = join(directory, `${token}.ticket.json`);
  const mine = { version: 1, pid: process.pid, token, number: null };
  const started = Date.now();
  async function tickets() {
    const result = [];
    for (const name of (await readdir(directory)).filter(name => name.endsWith('.ticket.json'))) {
      let value;
      try { value = await regularJSON(join(directory, name)); }
      catch (err) { if (err.code === 'ENOENT') continue; throw err; }
      if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 0
        || `${value.token}.ticket.json` !== name || !/^\d+-[0-9a-f-]{36}$/u.test(value.token)
        || !(value.number === null || (Number.isSafeInteger(value.number) && value.number > 0))) {
        throw error('CORRUPT_STORE', 'Invalid lock ticket; refusing unsafe takeover');
      }
      if (processAlive(value.pid)) result.push(value);
      else await removeFile(join(directory, name));
    }
    return result;
  }
  try {
    await durableWrite(path, mine);
    const current = await tickets();
    const highest = current.reduce((max, item) => Math.max(max, item.number ?? 0), 0);
    if (highest === Number.MAX_SAFE_INTEGER) throw error('LOCK_TIMEOUT', 'Lock ticket counter exhausted');
    mine.number = highest + 1;
    await durableWrite(path, mine);
    while (true) {
      const others = (await tickets()).filter(item => item.token !== token);
      const blocked = others.some(item => item.number === null || item.number < mine.number
        || (item.number === mine.number && item.token < token));
      if (!blocked) return await operation();
      if (Date.now() - started >= LOCK_TIMEOUT_MS) throw error('LOCK_TIMEOUT', 'Configuration is busy; no live lock was taken over');
      await delay(12 + Math.floor(Math.random() * 18));
    }
  } finally { await removeFile(path); }
}

/** Per-host, per-account, per-thread local configuration. No Codex RPC is performed. */
export class ThreadStore {
  constructor(dataDirectory) {
    if (typeof dataDirectory !== 'string' || !dataDirectory.trim()) throw error('VALIDATION_ERROR', 'dataDirectory is required');
    this.dataDirectory = resolve(dataDirectory);
  }

  _paths(scope) {
    const normalized = normalizeScope(scope);
    const id = digest(normalized);
    return { scope: normalized, directory: join(this.dataDirectory, id), lock: join(this.dataDirectory, '.locks', id) };
  }

  async _records(paths) {
    let names;
    try {
      const stat = await lstat(paths.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('CORRUPT_STORE', 'Unexpected thread directory type');
      names = await readdir(paths.directory);
    } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
    const files = names.filter(name => /^r.*\.json$/u.test(name)).sort();
    const records = [];
    let previousHash = null;
    for (const [index, name] of files.entries()) {
      if (name !== `r${String(index + 1).padStart(16, '0')}.json`) throw error('CORRUPT_STORE', 'Missing or unexpected revision file');
      let value;
      try { value = await regularJSON(join(paths.directory, name)); }
      catch (err) { throw error('CORRUPT_STORE', 'Cannot read immutable revision', { cause: err }); }
      try {
        if (!isRecord(value) || value.version !== 1 || value.revision !== index + 1
          || canonical(value.scope) !== canonical(paths.scope) || value.previousHash !== previousHash) throw new Error('Invalid revision metadata');
        const normalized = normalizeProfile(value);
        if (canonical(normalized) !== canonical({ persona: value.persona, background: value.background, overrides: value.overrides })) throw new Error('Noncanonical profile');
        const { hash, ...body } = value;
        if (typeof hash !== 'string' || digest(body) !== hash) throw new Error('Revision checksum mismatch');
        previousHash = hash;
        records.push(value);
      } catch (err) { throw error('CORRUPT_STORE', 'Persisted revision failed validation', { cause: err }); }
    }
    return records;
  }

  async get(scope) {
    const records = await this._records(this._paths(scope));
    return records.length ? snapshot(records.at(-1)) : EMPTY();
  }

  async history(scope) { return (await this._records(this._paths(scope))).map(snapshot); }

  async _versionMetadata(paths) {
    let value;
    try { value = await regularJSON(join(paths.directory, 'history-metadata.json')); }
    catch (err) { if (err.code === 'ENOENT') return { historyRevision: 0, entries: {} }; throw err; }
    try {
      if (!isRecord(value) || value.version !== 1 || canonical(value.scope) !== canonical(paths.scope)
        || !Number.isSafeInteger(value.historyRevision) || value.historyRevision < 1 || !isRecord(value.entries)) {
        throw new Error('Invalid version metadata');
      }
      const { hash, ...body } = value;
      if (digest(body) !== hash) throw new Error('Version metadata checksum mismatch');
      for (const [key, entry] of Object.entries(value.entries)) {
        if (!/^[1-9]\d*$/u.test(key) || !Number.isSafeInteger(Number(key)) || !isRecord(entry)
          || Object.keys(entry).some(field => !['name', 'deleted'].includes(field))
          || (!Object.hasOwn(entry, 'name') && !Object.hasOwn(entry, 'deleted'))
          || (Object.hasOwn(entry, 'deleted') && entry.deleted !== true)
          || (Object.hasOwn(entry, 'name') && (!entry.name || normalizeVersionName(entry.name) !== entry.name))) {
          throw new Error('Invalid version entry');
        }
      }
      return copy({ historyRevision: value.historyRevision, entries: value.entries });
    } catch (err) { throw error('CORRUPT_STORE', 'Persisted version metadata failed validation', { cause: err }); }
  }

  _versionHistory(records, metadata) {
    for (const [key, entry] of Object.entries(metadata.entries)) {
      if (Number(key) > records.length || (entry.deleted && Number(key) === records.length)) {
        throw error('CORRUPT_STORE', 'Version metadata refers to a missing or active deleted revision');
      }
    }
    return {
      historyRevision: metadata.historyRevision,
      history: records.filter(record => !metadata.entries[record.revision]?.deleted)
        .map(record => ({ revision: record.revision, ...(metadata.entries[record.revision]?.name ? { name: metadata.entries[record.revision].name } : {}) })),
    };
  }

  async versionHistory(scope) {
    const paths = this._paths(scope);
    // Read metadata first: revisions can only be appended, so each referenced
    // immutable record is guaranteed to exist when the chain is read next.
    const metadata = await this._versionMetadata(paths);
    return this._versionHistory(await this._records(paths), metadata);
  }

  async _changeVersion(scope, input, operation) {
    const paths = this._paths(scope);
    if (!isRecord(input)) throw error('VALIDATION_ERROR', 'version input is required');
    const expected = revision(input.expectedRevision);
    const expectedHistory = revision(input.expectedHistoryRevision, 'expectedHistoryRevision');
    const target = revision(input.targetRevision, 'targetRevision');
    const name = operation === 'rename' ? normalizeVersionName(input.name) : undefined;
    const validate = (records, metadata) => {
      checkExpected(records.at(-1) ?? EMPTY(), expected);
      checkHistoryExpected(metadata, expectedHistory);
      this._versionHistory(records, metadata);
      if (target === 0 || target > records.length || metadata.entries[target]?.deleted) {
        throw error('REVISION_NOT_FOUND', '此版本不存在或已删除');
      }
      if (operation === 'delete' && target === records.length) {
        throw error('VALIDATION_ERROR', '当前版本正在使用，请先恢复其他版本，再删除此版本');
      }
    };
    const initialMetadata = await this._versionMetadata(paths);
    const initialRecords = await this._records(paths);
    validate(initialRecords, initialMetadata);
    if (operation === 'rename' && (initialMetadata.entries[target]?.name ?? '') === name) {
      return this._versionHistory(initialRecords, initialMetadata);
    }
    return withMutex(paths.lock, async () => {
      const records = await this._records(paths);
      const metadata = await this._versionMetadata(paths);
      validate(records, metadata);
      if (metadata.historyRevision === Number.MAX_SAFE_INTEGER) throw error('VALIDATION_ERROR', 'Version metadata counter exhausted');
      const entries = copy(metadata.entries);
      if (operation === 'delete') entries[target] = { ...entries[target], deleted: true };
      else if (name) entries[target] = { name };
      else delete entries[target];
      const body = { version: 1, scope: paths.scope, historyRevision: metadata.historyRevision + 1, entries };
      await durableWrite(join(paths.directory, 'history-metadata.json'), { ...body, hash: digest(body) });
      return this._versionHistory(records, body);
    });
  }

  async renameVersion(scope, input) { return this._changeVersion(scope, input, 'rename'); }

  async deleteVersion(scope, input) { return this._changeVersion(scope, input, 'delete'); }

  async _commit(paths, records, profile) {
    const previous = records.at(-1);
    const current = previous ? snapshot(previous) : EMPTY();
    if (canonical(profile) === canonical({ persona: current.persona, background: current.background, overrides: current.overrides })) return current;
    if (current.revision === Number.MAX_SAFE_INTEGER) throw error('VALIDATION_ERROR', 'Revision counter exhausted');
    await ensureDirectory(paths.directory);
    const body = { version: 1, scope: paths.scope, revision: current.revision + 1, ...profile, previousHash: previous?.hash ?? null };
    const record = { ...body, hash: digest(body) };
    await durableWrite(join(paths.directory, `r${String(record.revision).padStart(16, '0')}.json`), record, { immutable: true });
    return snapshot(record);
  }

  async save(scope, input) {
    const paths = this._paths(scope);
    if (!isRecord(input)) throw error('VALIDATION_ERROR', 'save input is required');
    const expected = revision(input.expectedRevision);
    const profile = normalizeProfile(input);
    // An equal save can linearize at this read: it requires no directories or lock.
    const initial = await this._records(paths);
    const current = initial.length ? snapshot(initial.at(-1)) : EMPTY();
    checkExpected(current, expected);
    if (canonical(profile) === canonical({ persona: current.persona, background: current.background, overrides: current.overrides })) return current;
    return withMutex(paths.lock, async () => {
      const records = await this._records(paths);
      checkExpected(records.at(-1) ?? EMPTY(), expected);
      return this._commit(paths, records, profile);
    });
  }

  async rollback(scope, input) {
    const paths = this._paths(scope);
    if (!isRecord(input)) throw error('VALIDATION_ERROR', 'rollback input is required');
    const expected = revision(input.expectedRevision);
    const target = revision(input.targetRevision, 'targetRevision');
    const select = (records, metadata) => {
      checkExpected(records.at(-1) ?? EMPTY(), expected);
      this._versionHistory(records, metadata);
      if (target > records.length || metadata.entries[target]?.deleted) throw error('REVISION_NOT_FOUND', '此版本不存在或已删除');
      return target === 0 ? EMPTY() : snapshot(records[target - 1]);
    };
    const initialMetadata = await this._versionMetadata(paths);
    const initial = await this._records(paths);
    const selected = select(initial, initialMetadata);
    const current = initial.at(-1) ?? EMPTY();
    const profileOf = item => ({ persona: item.persona, background: item.background, overrides: item.overrides });
    if (canonical(profileOf(selected)) === canonical(profileOf(current))) return snapshot(current);
    // Selection and publication share the metadata mutex. A deleted version
    // cannot be restored using a selection read before its deletion committed.
    return withMutex(paths.lock, async () => {
      const records = await this._records(paths);
      const chosen = select(records, await this._versionMetadata(paths));
      return this._commit(paths, records, profileOf(chosen));
    });
  }

  async _observations(paths) {
    let value;
    try { value = await regularJSON(join(paths.directory, 'observations.json')); }
    catch (err) { if (err.code === 'ENOENT') return []; throw err; }
    try {
      if (!isRecord(value) || value.version !== 1 || canonical(value.scope) !== canonical(paths.scope)
        || !Array.isArray(value.observations) || value.observations.length > 100) throw new Error('Invalid observations');
      const { hash, ...body } = value;
      if (digest(body) !== hash) throw new Error('Observation checksum mismatch');
      const observations = value.observations.map(normalizeObservation);
      if (canonical(observations) !== canonical(value.observations)) throw new Error('Noncanonical observations');
      return copy(observations);
    } catch (err) { throw error('CORRUPT_STORE', 'Persisted observations failed validation', { cause: err }); }
  }

  async observations(scope) { return this._observations(this._paths(scope)); }

  async recordObservation(scope, observation) {
    const paths = this._paths(scope);
    const normalized = normalizeObservation(observation);
    return withMutex(paths.lock, async () => {
      const observations = [...await this._observations(paths), normalized].slice(-100);
      await ensureDirectory(paths.directory);
      const body = { version: 1, scope: paths.scope, observations };
      await durableWrite(join(paths.directory, 'observations.json'), { ...body, hash: digest(body) });
      return copy(normalized);
    });
  }
}
