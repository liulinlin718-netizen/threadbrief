import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { ThreadStore } from '../lib/store.mjs';

const run = promisify(execFile);
const scope = { hostId: 'local', accountScope: 'account-A', threadId: 'child-A' };
const empty = { revision: 0, persona: '', background: '', overrides: {} };
const profile = (expectedRevision, persona = 'Reviewer', overrides = {}) => ({ expectedRevision, persona, background: '', overrides });
const storeURL = new URL('../lib/store.mjs', import.meta.url).href;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'threadbrief-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory: join(root, 'data'), store: new ThreadStore(join(root, 'data')) };
}

test('reading and saving an untouched default create no files', async t => {
  const { root, store } = await fixture(t);
  assert.deepEqual(await store.get(scope), empty);
  assert.deepEqual(await store.history(scope), []);
  assert.deepEqual(await store.versionHistory(scope), { historyRevision: 0, history: [] });
  assert.deepEqual(await store.observations(scope), []);
  assert.deepEqual(await store.save(scope, profile(0, '', { 'skill:a': 'inherit' })), empty);
  assert.deepEqual(await store.rollback(scope, { expectedRevision: 0, targetRevision: 0 }), empty);
  assert.deepEqual(await readdir(root), []);
});

test('scope isolation includes host/account/thread and hashes traversal-like ids', async t => {
  const { directory, store } = await fixture(t);
  await store.save(scope, profile(0));
  for (const other of [{ ...scope, hostId: 'remote' }, { ...scope, accountScope: 'B' }, { ...scope, threadId: 'parent' }]) {
    assert.deepEqual(await store.get(other), empty);
  }
  const traversal = { ...scope, threadId: '../../outside' };
  await store.save(traversal, profile(0, 'Safe'));
  assert.equal((await store.get(traversal)).persona, 'Safe');
  const names = await readdir(directory);
  assert.equal(names.filter(name => /^[a-f0-9]{64}$/u.test(name)).length, 2);
  assert.ok(names.every(name => name === '.locks' || /^[a-f0-9]{64}$/u.test(name)));
  assert.deepEqual(await store.get({ ...scope, hostId: ' local ' }), await store.get(scope));
});

test('canonical no-op preserves existing files and capability inheritance deletes overrides', async t => {
  const { directory, store } = await fixture(t);
  const first = await store.save(scope, profile(0, 'Reviewer', { 'mcp:server/tool?x': 'on', 'skill:b': 'off' }));
  const id = (await readdir(directory)).find(name => !name.startsWith('.'));
  const original = await readFile(join(directory, id, 'r0000000000000001.json'), 'utf8');
  assert.deepEqual(await store.save(scope, profile(1, 'Reviewer', { 'skill:b': 'off', 'mcp:server/tool?x': 'on' })), first);
  assert.equal(await readFile(join(directory, id, 'r0000000000000001.json'), 'utf8'), original);
  assert.equal((await readdir(join(directory, id))).length, 1);
  const next = await store.save(scope, profile(1, 'Reviewer', { 'skill:b': 'inherit' }));
  assert.equal(next.revision, 2);
  assert.deepEqual(next.overrides, {});
});

test('validation rejects dangerous ids, long profiles, bad scope, and invalid modes', async t => {
  const { store } = await fixture(t);
  for (const overrides of [JSON.parse('{"__proto__":"on"}'), { constructor: 'off' }, { a: 'enabled' }, { ['a'.repeat(257)]: 'on' }]) {
    await assert.rejects(store.save(scope, profile(0, 'x', overrides)), { code: 'VALIDATION_ERROR' });
  }
  await assert.rejects(store.save(scope, profile(0, 'x'.repeat(8001))), { code: 'VALIDATION_ERROR' });
  await assert.rejects(store.save(scope, { ...profile(0), background: 'x'.repeat(24001) }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(store.get({ ...scope, threadId: '' }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(store.save(scope, profile(-1)), { code: 'VALIDATION_ERROR' });
});

test('same-process concurrent CAS permits exactly one revision and detects stale no-op', async t => {
  const { store } = await fixture(t);
  for (let round = 0; round < 30; round += 1) {
    const concurrentScope = { ...scope, threadId: `${scope.threadId}-${round}` };
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => store.save(concurrentScope, profile(0, `Persona ${i}`))));
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
    const failures = results.filter(item => item.status === 'rejected');
    assert.ok(failures.every(item => item.reason.code === 'REVISION_CONFLICT'), failures.map(item => `${item.reason.code}: ${item.reason.message}`).join('\n'));
    assert.equal((await store.get(concurrentScope)).revision, 1);
    const current = await store.get(concurrentScope);
    await assert.rejects(store.save(concurrentScope, { ...current, expectedRevision: 0 }), { code: 'REVISION_CONFLICT' });
  }
});

test('cross-process concurrent CAS never silently loses a committed update', async t => {
  const { directory, store } = await fixture(t);
  const code = `import {ThreadStore} from ${JSON.stringify(storeURL)};
    const store = new ThreadStore(process.argv[1]);
    try {const state=await store.save(${JSON.stringify(scope)}, {expectedRevision:0,persona:process.argv[2],background:'',overrides:{}}); console.log(JSON.stringify({ok:true,state}));}
    catch(error){console.log(JSON.stringify({ok:false,code:error.code}));}`;
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) => run(process.execPath, ['--input-type=module', '-e', code, directory, `worker ${index}`])));
  const parsed = results.map(item => JSON.parse(item.stdout));
  assert.equal(parsed.filter(item => item.ok).length, 1);
  assert.ok(parsed.filter(item => !item.ok).every(item => item.code === 'REVISION_CONFLICT'));
  assert.equal((await store.history(scope)).length, 1);
  assert.equal((await store.get(scope)).persona, parsed.find(item => item.ok).state.persona);
});

test('rollback creates a new revision and only changes the selected thread', async t => {
  const { store } = await fixture(t);
  const sibling = { ...scope, threadId: 'child-B' };
  await store.save(scope, profile(0, 'First', { a: 'on' }));
  await store.save(scope, profile(1, 'Second'));
  await store.save(sibling, profile(0, 'Sibling'));
  const rollback = await store.rollback(scope, { expectedRevision: 2, targetRevision: 1 });
  assert.deepEqual(rollback, { revision: 3, persona: 'First', background: '', overrides: { a: 'on' } });
  assert.equal((await store.get(sibling)).persona, 'Sibling');
  assert.deepEqual((await store.history(scope)).map(item => item.persona), ['First', 'Second', 'First']);
  assert.deepEqual(await store.rollback(scope, { expectedRevision: 3, targetRevision: 0 }), { ...empty, revision: 4 });
  await assert.rejects(store.rollback(scope, { expectedRevision: 4, targetRevision: 99 }), { code: 'REVISION_NOT_FOUND' });
  await assert.rejects(store.rollback(scope, { expectedRevision: 2, targetRevision: 1 }), { code: 'REVISION_CONFLICT' });
});

test('malformed or modified committed data fails closed without replacement', async t => {
  const { directory, store } = await fixture(t);
  await store.save(scope, profile(0));
  const id = (await readdir(directory)).find(name => !name.startsWith('.'));
  const path = join(directory, id, 'r0000000000000001.json');
  const record = JSON.parse(await readFile(path, 'utf8'));
  record.persona = 'tampered';
  await writeFile(path, JSON.stringify(record));
  await assert.rejects(store.get(scope), { code: 'CORRUPT_STORE' });
  await assert.rejects(store.save(scope, profile(1)), { code: 'CORRUPT_STORE' });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).persona, 'tampered');
  await writeFile(path, '{broken');
  await assert.rejects(store.history(scope), { code: 'CORRUPT_STORE' });
});

test('observations are independent, bounded, validated, and do not imply model delivery', async t => {
  const { store } = await fixture(t);
  const initial = await store.save(scope, profile(0));
  await store.recordObservation(scope, { event: 'prepared', status: 'prepared', revision: 1, detail: 'built locally' });
  assert.deepEqual(await store.get(scope), initial);
  assert.equal((await store.history(scope)).length, 1);
  await assert.rejects(store.recordObservation(scope, { event: 'prepared', status: 'applied', revision: 1 }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(store.recordObservation(scope, { event: 'applied', status: 'applied', revision: 1, receipt: 'arbitrary string' }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(store.recordObservation(scope, { event: 'host_observed', status: 'unknown', revision: 1, detail: 'x'.repeat(501) }), { code: 'VALIDATION_ERROR' });
  for (let i = 0; i < 101; i += 1) await store.recordObservation(scope, { event: 'panel_visible', status: 'observed', revision: 1, detail: `${i}` });
  const records = await store.observations(scope);
  assert.equal(records.length, 100);
  assert.equal(records[0].detail, '1');
  assert.equal(records.at(-1).detail, '100');
  assert.deepEqual(await store.get(scope), initial);
  assert.deepEqual(await store.observations({ ...scope, threadId: 'other' }), []);
});

test('crashed process tickets recover without a timeout lease or deleting live locks', async t => {
  const { directory, store } = await fixture(t);
  await store.save(scope, profile(0));
  const id = (await readdir(directory)).find(name => !name.startsWith('.'));
  const lockDirectory = join(directory, '.locks', id);
  const deadProcess = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const deadPid = deadProcess.pid;
  await new Promise((resolve, reject) => { deadProcess.once('error', reject); deadProcess.once('exit', resolve); });
  const token = `${deadPid}-00000000-0000-4000-8000-000000000000`;
  await writeFile(join(lockDirectory, `${token}.ticket.json`), JSON.stringify({ version: 1, pid: deadPid, token, number: null }));
  const state = await store.save(scope, profile(1, 'After crash'));
  assert.equal(state.revision, 2);
  assert.deepEqual(await readdir(lockDirectory), []);
});

test('a live process keeps its lock even when the ticket is old', async t => {
  const { directory, store } = await fixture(t);
  await store.save(scope, profile(0));
  const id = (await readdir(directory)).find(name => !name.startsWith('.'));
  const token = `${process.pid}-00000000-0000-4000-8000-000000000000`;
  const ticketPath = join(directory, '.locks', id, `${token}.ticket.json`);
  await writeFile(ticketPath, JSON.stringify({ version: 1, pid: process.pid, token, number: 1, createdAt: '2000-01-01T00:00:00Z' }));
  let settled = false;
  const pending = store.save(scope, profile(1, 'Waited')).finally(() => { settled = true; });
  await delay(120);
  assert.equal(settled, false);
  assert.equal(JSON.parse(await readFile(ticketPath, 'utf8')).token, token);
  await unlink(ticketPath);
  assert.equal((await pending).revision, 2);
});

test('pending uncommitted files are ignored and revision gaps fail closed', async t => {
  const { directory, store } = await fixture(t);
  await store.save(scope, profile(0));
  const id = (await readdir(directory)).find(name => !name.startsWith('.'));
  await writeFile(join(directory, id, 'r0000000000000002.json.crashed.pending'), '{partial');
  assert.equal((await store.get(scope)).revision, 1);
  await writeFile(join(directory, id, 'r0000000000000003.json'), '{}');
  await assert.rejects(store.get(scope), { code: 'CORRUPT_STORE' });
});

const versionInput = (expectedRevision, expectedHistoryRevision, targetRevision, name) => ({ expectedRevision, expectedHistoryRevision, targetRevision, ...(name === undefined ? {} : { name }) });

test('version names persist independently from configuration and unnamed no-ops do not write', async t => {
  const { directory, store } = await fixture(t);
  const current = await store.save(scope, profile(0, 'Reviewer', { 'skill:a': 'on' }));
  const id = (await readdir(directory)).find(name => !name.startsWith('.'));
  const chainPath = join(directory, id, 'r0000000000000001.json');
  const original = await readFile(chainPath, 'utf8');
  assert.deepEqual(await store.renameVersion(scope, versionInput(1, 0, 1, '')), { historyRevision: 0, history: [{ revision: 1 }] });
  assert.deepEqual(await readdir(join(directory, id)), ['r0000000000000001.json']);
  assert.deepEqual(await store.renameVersion(scope, versionInput(1, 0, 1, '  严格审阅  ')), { historyRevision: 1, history: [{ revision: 1, name: '严格审阅' }] });
  const metadataPath = join(directory, id, 'history-metadata.json');
  const metadata = await readFile(metadataPath, 'utf8');
  assert.deepEqual(await store.get(scope), current);
  assert.deepEqual(await store.history(scope), [current]);
  assert.equal(await readFile(chainPath, 'utf8'), original);
  const reopened = new ThreadStore(directory);
  assert.deepEqual(await reopened.versionHistory(scope), { historyRevision: 1, history: [{ revision: 1, name: '严格审阅' }] });
  await reopened.renameVersion(scope, versionInput(1, 1, 1, '严格审阅'));
  assert.equal(await readFile(metadataPath, 'utf8'), metadata);
  assert.deepEqual(await reopened.renameVersion(scope, versionInput(1, 1, 1, '  ')), { historyRevision: 2, history: [{ revision: 1 }] });
});

test('deleting a historical version keeps immutable audit/configuration data and cannot be restored', async t => {
  const { store } = await fixture(t);
  await store.save(scope, profile(0, 'First'));
  const current = await store.save(scope, profile(1, 'Second'));
  await store.renameVersion(scope, versionInput(2, 0, 1, 'First name'));
  assert.deepEqual(await store.deleteVersion(scope, versionInput(2, 1, 1)), { historyRevision: 2, history: [{ revision: 2 }] });
  assert.deepEqual(await store.get(scope), current);
  assert.deepEqual((await store.history(scope)).map(item => item.persona), ['First', 'Second']);
  await assert.rejects(store.rollback(scope, { expectedRevision: 2, targetRevision: 1 }), { code: 'REVISION_NOT_FOUND' });
  await assert.rejects(store.renameVersion(scope, versionInput(2, 2, 1, 'Hidden')), { code: 'REVISION_NOT_FOUND' });
  await assert.rejects(store.deleteVersion(scope, versionInput(2, 2, 1)), { code: 'REVISION_NOT_FOUND' });
  assert.equal((await store.save(scope, profile(2, 'Third'))).revision, 3);
  assert.deepEqual(await store.versionHistory(scope), { historyRevision: 2, history: [{ revision: 2 }, { revision: 3 }] });
});

test('current versions are protected and metadata edits stay in the complete task namespace', async t => {
  const { store } = await fixture(t);
  await store.save(scope, profile(0, 'First'));
  await store.save(scope, profile(1, 'Second'));
  await assert.rejects(store.deleteVersion(scope, versionInput(2, 0, 2)), { code: 'VALIDATION_ERROR' });
  for (const other of [{ ...scope, threadId: 'child-B' }, { ...scope, accountScope: 'account-B' }, { ...scope, hostId: 'remote' }]) {
    await store.save(other, profile(0, 'Other'));
    await store.renameVersion(other, versionInput(1, 0, 1, 'Other name'));
    assert.deepEqual(await store.versionHistory(scope), { historyRevision: 0, history: [{ revision: 1 }, { revision: 2 }] });
  }
  await store.deleteVersion(scope, versionInput(2, 0, 1));
  const restored = await store.rollback(scope, { expectedRevision: 2, targetRevision: 0 });
  assert.equal(restored.revision, 3);
  await store.deleteVersion(scope, versionInput(3, 1, 2));
  assert.deepEqual(await store.versionHistory(scope), { historyRevision: 2, history: [{ revision: 3 }] });
});

test('version operations validate names, revision tokens, and unavailable targets before writing', async t => {
  const { root, store } = await fixture(t);
  await assert.rejects(store.renameVersion(scope, versionInput(0, 0, 0, 'Default')), { code: 'REVISION_NOT_FOUND' });
  await assert.rejects(store.deleteVersion(scope, versionInput(0, 0, 1)), { code: 'REVISION_NOT_FOUND' });
  assert.deepEqual(await readdir(root), []);
  await store.save(scope, profile(0));
  for (const name of [undefined, null, 7, 'a'.repeat(81), 'New\nname', 'Hidden\u202ename']) {
    await assert.rejects(store.renameVersion(scope, versionInput(1, 0, 1, name)), { code: 'VALIDATION_ERROR' });
  }
  await assert.rejects(store.renameVersion(scope, { ...versionInput(1, 0, 1, 'Name'), expectedHistoryRevision: undefined }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(store.renameVersion(scope, versionInput(1, 0, 99, 'Name')), { code: 'REVISION_NOT_FOUND' });
  assert.deepEqual(await store.versionHistory(scope), { historyRevision: 0, history: [{ revision: 1 }] });
});

test('concurrent metadata edits use a separate CAS counter and reject stale no-ops', async t => {
  const { store } = await fixture(t);
  await store.save(scope, profile(0));
  const attempts = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => store.renameVersion(scope, versionInput(1, 0, 1, `Name ${i}`))));
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  assert.ok(attempts.filter(item => item.status === 'rejected').every(item => item.reason.code === 'HISTORY_CONFLICT'));
  const named = await store.versionHistory(scope);
  assert.equal(named.historyRevision, 1);
  assert.equal((await store.get(scope)).revision, 1);
  await assert.rejects(store.renameVersion(scope, versionInput(1, 0, 1, named.history[0].name)), { code: 'HISTORY_CONFLICT' });
  await store.save(scope, profile(1, 'Changed configuration'));
  await assert.rejects(store.renameVersion(scope, versionInput(1, 1, 1, 'New name')), { code: 'REVISION_CONFLICT' });
});

test('cross-process version rename CAS publishes exactly one metadata update', async t => {
  const { directory, store } = await fixture(t);
  await store.save(scope, profile(0));
  const code = `import {ThreadStore} from ${JSON.stringify(storeURL)};
    const store = new ThreadStore(process.argv[1]);
    try {await store.renameVersion(${JSON.stringify(scope)}, {expectedRevision:1,expectedHistoryRevision:0,targetRevision:1,name:process.argv[2]}); console.log(JSON.stringify({ok:true}));}
    catch(error){console.log(JSON.stringify({ok:false,code:error.code}));}`;
  const results = await Promise.all(Array.from({ length: 4 }, (_, index) => run(process.execPath, ['--input-type=module', '-e', code, directory, `Name ${index}`])));
  const parsed = results.map(item => JSON.parse(item.stdout));
  assert.equal(parsed.filter(item => item.ok).length, 1);
  assert.ok(parsed.filter(item => !item.ok).every(item => item.code === 'HISTORY_CONFLICT'));
  assert.equal((await store.versionHistory(scope)).historyRevision, 1);
  assert.equal((await store.get(scope)).revision, 1);
});

test('deletion and rollback serialize so a deleted snapshot cannot be restored afterward', async t => {
  const { store } = await fixture(t);
  for (let i = 0; i < 6; i += 1) {
    const targetScope = { ...scope, threadId: `race-${i}` };
    await store.save(targetScope, profile(0, 'First'));
    await store.save(targetScope, profile(1, 'Second'));
    const [deletion, restoration] = await Promise.allSettled([
      store.deleteVersion(targetScope, versionInput(2, 0, 1)),
      store.rollback(targetScope, { expectedRevision: 2, targetRevision: 1 }),
    ]);
    if (deletion.status === 'fulfilled') {
      assert.equal(restoration.status, 'rejected');
      assert.equal(restoration.reason.code, 'REVISION_NOT_FOUND');
      assert.equal((await store.get(targetScope)).persona, 'Second');
    } else {
      assert.equal(deletion.reason.code, 'REVISION_CONFLICT');
      assert.equal(restoration.status, 'fulfilled');
      assert.equal((await store.get(targetScope)).persona, 'First');
    }
  }
});

test('modified metadata fails closed for version operations without changing active configuration', async t => {
  const { directory, store } = await fixture(t);
  const current = await store.save(scope, profile(0));
  await store.renameVersion(scope, versionInput(1, 0, 1, 'Name'));
  const id = (await readdir(directory)).find(name => !name.startsWith('.'));
  const metadataPath = join(directory, id, 'history-metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  metadata.entries['1'].name = 'Tampered';
  await writeFile(metadataPath, JSON.stringify(metadata));
  await assert.rejects(store.versionHistory(scope), { code: 'CORRUPT_STORE' });
  await assert.rejects(store.renameVersion(scope, versionInput(1, 1, 1, 'Repair')), { code: 'CORRUPT_STORE' });
  await assert.rejects(store.rollback(scope, { expectedRevision: 1, targetRevision: 0 }), { code: 'CORRUPT_STORE' });
  assert.deepEqual(await store.get(scope), current);
  assert.deepEqual(await store.history(scope), [current]);
  assert.equal(JSON.parse(await readFile(metadataPath, 'utf8')).entries['1'].name, 'Tampered');
});

test('shared versions span sibling tasks while restores remain thread local', async t => {
  const { store } = await fixture(t);
  const sibling = { ...scope, threadId: 'child-B' };
  const otherAccount = { ...scope, accountScope: 'account-B', threadId: 'child-C' };
  await store.save(scope, profile(0, 'Parent profile'));
  await store.save(sibling, profile(0, 'Sibling profile'));
  await store.save(otherAccount, profile(0, 'Other account'));
  const fromParent = await store.sharedVersionHistory(scope);
  const fromSibling = await store.sharedVersionHistory(sibling);
  assert.deepEqual(fromParent.history.map(item => item.revision), [1, 2]);
  assert.deepEqual(fromSibling.history.map(item => item.revision), [1, 2]);
  assert.equal(fromParent.history.find(item => item.current).revision, 1);
  assert.equal(fromSibling.history.find(item => item.current).revision, 2);
  assert.deepEqual((await store.sharedVersionHistory(otherAccount)).history.map(item => item.revision), [1]);
  assert.equal((await store.sharedVersionHistory(scope)).history.length, 2);
  const restored = await store.restoreSharedVersion(sibling, { expectedRevision: 1, targetRevision: 1 });
  assert.equal(restored.persona, 'Parent profile');
  assert.equal(restored.revision, 2);
  assert.equal((await store.get(scope)).revision, 1);
  assert.equal((await store.get(scope)).persona, 'Parent profile');
});

test('shared names are global and a version in use by any task cannot be deleted', async t => {
  const { store } = await fixture(t);
  const sibling = { ...scope, threadId: 'child-B' };
  await store.save(scope, profile(0, 'Shared one'));
  await store.save(sibling, profile(0, 'Shared two'));
  await store.sharedVersionHistory(scope);
  const named = await store.renameSharedVersion(scope, versionInput(1, 0, 1, '团队基线'));
  assert.equal(named.history[0].name, '团队基线');
  assert.equal((await store.sharedVersionHistory(sibling)).history[0].name, '团队基线');
  await assert.rejects(store.deleteSharedVersion(sibling, versionInput(1, 1, 1)), { code: 'VALIDATION_ERROR' });
  await store.restoreSharedVersion(scope, { expectedRevision: 1, targetRevision: 2 });
  const deleted = await store.deleteSharedVersion(sibling, versionInput(1, 1, 1));
  assert.equal(deleted.history.some(item => item.revision === 1), false);
  await assert.rejects(store.restoreSharedVersion(scope, { expectedRevision: 2, targetRevision: 1 }), { code: 'REVISION_NOT_FOUND' });
});

test('shared deletion and restoration serialize around active-task protection', async t => {
  const { store } = await fixture(t);
  const sibling = { ...scope, threadId: 'child-B' };
  await store.save(scope, profile(0, 'Shared one'));
  await store.save(sibling, profile(0, 'Shared two'));
  await store.sharedVersionHistory(scope);
  await store.restoreSharedVersion(scope, { expectedRevision: 1, targetRevision: 2 });
  const [deletion, restoration] = await Promise.allSettled([
    store.deleteSharedVersion(sibling, versionInput(1, 0, 1)),
    store.restoreSharedVersion(scope, { expectedRevision: 2, targetRevision: 1 }),
  ]);
  if (deletion.status === 'fulfilled') {
    assert.equal(restoration.status, 'rejected');
    assert.equal(restoration.reason.code, 'REVISION_NOT_FOUND');
    assert.equal((await store.get(scope)).persona, 'Shared two');
  } else {
    assert.equal(deletion.reason.code, 'VALIDATION_ERROR');
    assert.equal(restoration.status, 'fulfilled');
    assert.equal((await store.get(scope)).persona, 'Shared one');
  }
});
