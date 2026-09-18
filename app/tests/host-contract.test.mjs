import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostContract, createCapabilityPolicy, stableSerialize } from '../lib/host-contract.mjs';
import { ThreadStore } from '../lib/store.mjs';

const scope = { hostId: 'local', accountScope: 'account-A', threadId: 'child-A' };
const coverage = { context: true, scopeIsolation: true, discovery: true, skillLoading: true, dispatch: true, catalogComplete: true, resume: true, compact: true, reset: true };
const catalog = [
  { id: 'plugin:review', kind: 'plugin', hostAllowed: true, defaultEnabled: true },
  { id: 'skill:review', kind: 'skill', hostAllowed: true, defaultEnabled: false, parentPluginId: 'plugin:review' },
  { id: 'mcp:search', kind: 'mcp', hostAllowed: true, defaultEnabled: true, parentPluginId: 'plugin:review' },
  { id: 'app:private', kind: 'app', hostAllowed: false, defaultEnabled: false },
  { id: 'skill:dependent', kind: 'skill', hostAllowed: true, defaultEnabled: false, requires: ['mcp:search'] },
];
const profile = (expectedRevision, persona = '', overrides = {}) => ({ expectedRevision, persona, background: '', overrides });
const request = () => ({ input: [{ role: 'user', content: 'Review this change' }], tools: [{ type: 'function', name: 'read' }], instructions: 'Original agent rules', prompt_cache_key: 'unchanged' });
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'threadbrief-host-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const store = new ThreadStore(join(root, 'data'));
  return { root, store, host: new HostContract(store, { coverage, ...options }) };
}
function acknowledge(host, prepared, extra = {}) {
  return host.acknowledge({ prepared, scope: prepared.scope, revision: prepared.revision, compiledHash: prepared.compiledHash, turnId: 'turn-1', outcome: 'context-attached', ...extra });
}

test('untouched configuration is exact request identity passthrough with no coverage/catalog/files', async t => {
  const { root, store } = await fixture(t);
  const host = new HostContract(store);
  const original = request();
  const before = JSON.stringify(original);
  for (const lifecycle of ['start', 'turn', 'resume', 'compact']) {
    const result = await host.prepare({ scope, request: original, lifecycle });
    assert.equal(result.status, 'passthrough');
    assert.equal(result.request, original);
    assert.equal(result.request.tools, original.tools);
    assert.equal(result.context, null);
  }
  assert.equal(JSON.stringify(original), before);
  assert.deepEqual(await readdir(root), []);
});

test('persona is only a prepared user context, does not mutate a request or record delivery, and is thread-isolated', async t => {
  const { store, host } = await fixture(t);
  await store.save(scope, profile(0, 'Be a careful reviewer'));
  const original = request();
  const result = await host.prepare({ scope, request: original });
  assert.equal(result.status, 'prepared');
  assert.equal(result.request, original);
  assert.equal(result.context.role, 'user');
  assert.match(result.context.content, /Be a careful reviewer/u);
  assert.equal((await store.observations(scope)).length, 0);
  assert.equal((await host.prepare({ scope: { ...scope, threadId: 'parent' }, request: original })).status, 'passthrough');
  assert.equal((await host.prepare({ scope: { ...scope, accountScope: 'other' }, request: original })).status, 'passthrough');
  assert.equal(original.input.length, 1);
  assert.equal(original.instructions, 'Original agent rules');
  assert.equal(original.prompt_cache_key, 'unchanged');
});

test('compilation is canonical across key order, catalog order, repeated preparation, and lifecycle recovery', async t => {
  const { store, host } = await fixture(t);
  await store.save(scope, profile(0, 'Reviewer', { 'skill:review': 'on', 'app:private': 'off' }));
  const first = await host.prepare({ scope, request: request(), catalog });
  const reversed = await host.prepare({ scope: { threadId: scope.threadId, accountScope: scope.accountScope, hostId: scope.hostId }, request: request(), catalog: [...catalog].reverse(), lifecycle: 'compact' });
  assert.equal(first.context.content, reversed.context.content);
  assert.equal(first.compiledHash, reversed.compiledHash);
  assert.equal(first.status, 'prepared');
  assert.equal((await host.prepare({ scope, request: request(), catalog })).status, 'prepared');
  assert.equal(stableSerialize({ b: 2, a: 1 }), '{"a":1,"b":2}');
});

test('missing host coverage and unknown capability report unsupported without a context', async t => {
  const { store } = await fixture(t);
  await store.save(scope, profile(0, 'Reviewer'));
  const unsupported = await new HostContract(store).prepare({ scope, request: request() });
  assert.equal(unsupported.status, 'unsupported');
  assert.equal(unsupported.context, null);
  assert.ok(unsupported.issues.some(item => item.detail === 'context'));
  await store.save(scope, profile(1, '', { 'unknown:tool': 'on' }));
  const missing = await new HostContract(store, { coverage: { ...coverage, dispatch: false } }).prepare({ scope, request: request(), catalog });
  assert.equal(missing.status, 'unsupported');
  assert.ok(missing.issues.some(item => item.code === 'UNKNOWN_CAPABILITY'));
  assert.ok(missing.issues.some(item => item.detail === 'dispatch'));
  const noCatalog = await new HostContract(store, { coverage }).prepare({ scope, request: request() });
  assert.ok(noCatalog.issues.some(item => item.code === 'CATALOG_REQUIRED'));
});

test('discovery, skill loading and dispatch share the exact permission calculation', () => {
  const policy = createCapabilityPolicy({ overrides: { 'skill:review': 'on', 'app:private': 'on' }, catalog, coverage });
  for (const entry of catalog) {
    assert.deepEqual(policy.discovery(entry.id), policy.skillLoading(entry.id));
    assert.deepEqual(policy.skillLoading(entry.id), policy.dispatch(entry.id));
  }
  assert.equal(policy.dispatch('skill:review').allowed, true);
  assert.equal(policy.dispatch('app:private').allowed, false);
  assert.equal(policy.dispatch('app:private').reason, 'host-denied');
  assert.equal(policy.dispatch('missing').supported, false);
});

test('plugin enable expands children; explicit child off and parent off always win', () => {
  const enabled = createCapabilityPolicy({ overrides: { 'plugin:review': 'on', 'mcp:search': 'off' }, catalog, coverage });
  assert.equal(enabled.dispatch('skill:review').allowed, true);
  assert.equal(enabled.dispatch('mcp:search').allowed, false);
  const disabled = createCapabilityPolicy({ overrides: { 'plugin:review': 'off', 'skill:review': 'on' }, catalog, coverage });
  assert.equal(disabled.dispatch('skill:review').allowed, false);
  assert.equal(disabled.dispatch('mcp:search').allowed, false);
  assert.equal(disabled.dispatch('skill:review').reason, 'plugin-disabled');
});

test('dependencies are subject to explicit off and host grants; unknown/cyclic dependencies are unsupported', () => {
  const denied = createCapabilityPolicy({ overrides: { 'skill:dependent': 'on', 'mcp:search': 'off' }, catalog, coverage });
  assert.equal(denied.dispatch('skill:dependent').reason, 'dependency-disabled');
  const permitted = createCapabilityPolicy({ overrides: { 'skill:dependent': 'on' }, catalog, coverage });
  assert.equal(permitted.dispatch('skill:dependent').allowed, true);
  const invalid = createCapabilityPolicy({ catalog: [{ ...catalog[0], requires: ['missing'] }], coverage });
  assert.equal(invalid.supported, false);
  const cycle = createCapabilityPolicy({ catalog: [{ ...catalog[0], requires: ['plugin:review'] }], coverage });
  assert.equal(cycle.supported, false);
  const deniedPlugin = createCapabilityPolicy({ overrides: { plugin: 'on' }, coverage, catalog: [
    { id: 'plugin', kind: 'plugin', hostAllowed: false, defaultEnabled: false, requires: ['tool'] },
    { id: 'tool', kind: 'mcp', hostAllowed: true, defaultEnabled: false },
  ] });
  assert.equal(deniedPlugin.dispatch('plugin').allowed, false);
  assert.equal(deniedPlugin.dispatch('tool').allowed, false, 'Denied activation cannot enable unrelated dependencies');
});

test('only explicit matching host acknowledgment creates a usable receipt; tampering and cross-scope replay fail', async t => {
  const { store, host } = await fixture(t);
  await store.save(scope, profile(0, 'Reviewer'));
  const prepared = await host.prepare({ scope, request: request() });
  assert.throws(() => { prepared.scope.threadId = 'other'; }, TypeError);
  assert.throws(() => acknowledge(host, prepared, { revision: 999 }), { code: 'ACKNOWLEDGMENT_INVALID' });
  assert.throws(() => acknowledge(host, prepared, { compiledHash: '0'.repeat(64) }), { code: 'ACKNOWLEDGMENT_INVALID' });
  assert.throws(() => acknowledge(host, prepared, { outcome: 'prepared' }), { code: 'ACKNOWLEDGMENT_INVALID' });
  assert.throws(() => acknowledge(host, { ...prepared }), { code: 'ACKNOWLEDGMENT_INVALID' });
  const receipt = acknowledge(host, prepared);
  assert.equal(receipt.status, 'host-acknowledged');
  const repeated = await host.prepare({ scope, request: request(), receipt });
  assert.equal(repeated.status, 'already-acknowledged');
  assert.equal(repeated.context, null);
  assert.equal((await host.prepare({ scope, request: request(), receipt: { ...receipt, revision: 0 } })).status, 'unsupported');
  assert.equal((await host.prepare({ scope: { ...scope, threadId: 'child-B' }, request: request(), receipt })).status, 'unsupported');
  assert.deepEqual(await store.observations(scope), []);
});

test('changed profiles, resume, and compaction require fresh attachment; stable content remains identical', async t => {
  const { store, host } = await fixture(t);
  await store.save(scope, profile(0, 'Reviewer'));
  const prepared = await host.prepare({ scope, request: request() });
  const receipt = acknowledge(host, prepared);
  for (const lifecycle of ['resume', 'compact']) {
    const recovered = await host.prepare({ scope, request: request(), receipt, lifecycle });
    assert.equal(recovered.status, 'prepared');
    assert.equal(recovered.context.content, prepared.context.content);
    assert.equal(recovered.compiledHash, prepared.compiledHash);
  }
  await store.save(scope, profile(1, 'Researcher'));
  const changed = await host.prepare({ scope, request: request(), receipt });
  assert.equal(changed.status, 'prepared');
  assert.notEqual(changed.compiledHash, prepared.compiledHash);
});

test('restoring defaults emits a reset only for an acknowledged prior overlay', async t => {
  const { store, host } = await fixture(t);
  await store.save(scope, profile(0, 'Reviewer'));
  const prepared = await host.prepare({ scope, request: request() });
  const receipt = acknowledge(host, prepared);
  await store.save(scope, profile(1));
  assert.equal((await host.prepare({ scope, request: request() })).status, 'passthrough');
  const reset = await host.prepare({ scope, request: request(), receipt });
  assert.equal(reset.status, 'prepared');
  assert.equal(reset.mode, 'reset');
  assert.match(reset.context.content, /does not undo past actions/u);
  const resetReceipt = acknowledge(host, reset);
  assert.equal((await host.prepare({ scope, request: request(), receipt: resetReceipt })).status, 'passthrough');
});

test('receipt persistence requires the same host-owned secret, not arbitrary serialized receipt text', async t => {
  const key = new Uint8Array(32).fill(7);
  const { store, host } = await fixture(t, { acknowledgmentKey: key });
  await store.save(scope, profile(0, 'Reviewer'));
  const receipt = acknowledge(host, await host.prepare({ scope, request: request() }));
  const restarted = new HostContract(store, { coverage, acknowledgmentKey: key });
  assert.equal((await restarted.prepare({ scope, request: request(), receipt: JSON.parse(JSON.stringify(receipt)) })).status, 'already-acknowledged');
  const unrelated = new HostContract(store, { coverage });
  assert.equal((await unrelated.prepare({ scope, request: request(), receipt })).status, 'unsupported');
});

test('live revocations apply at dispatch, later enables wait for a newly prepared turn, and grants never exceed host permission', async t => {
  const { store, host } = await fixture(t);
  await store.save(scope, profile(0, '', { 'skill:review': 'on' }));
  const prepared = await host.prepare({ scope, request: request(), catalog });
  const check = (id, liveCatalog = catalog) => host.authorize({ scope, prepared, id, stage: 'dispatch', catalog: liveCatalog });
  assert.equal((await check('skill:review')).allowed, true);
  await store.save(scope, profile(1, '', { 'skill:review': 'off', 'skill:dependent': 'on' }));
  assert.equal((await check('skill:review')).allowed, false);
  assert.equal((await check('skill:dependent')).allowed, false);
  const current = await host.prepare({ scope, request: request(), catalog });
  assert.equal((await host.authorize({ scope, prepared: current, id: 'skill:dependent', stage: 'dispatch', catalog })).allowed, true);
  const revoked = catalog.map(item => item.id === 'mcp:search' ? { ...item, hostAllowed: false } : item);
  assert.equal((await host.authorize({ scope, prepared: current, id: 'skill:dependent', stage: 'dispatch', catalog: revoked })).allowed, false);
  assert.equal((await host.authorize({ scope: { ...scope, threadId: 'other' }, prepared, id: 'skill:review', stage: 'dispatch', catalog })).supported, false);
});

test('observed capability and host permission revocations stay off after re-enable until a new prepare', async t => {
  const { store, host } = await fixture(t);
  await store.save(scope, profile(0, '', { 'skill:review': 'on' }));
  const prepared = await host.prepare({ scope, request: request(), catalog });
  const check = (plan = prepared, liveCatalog = catalog) => host.authorize({ scope, prepared: plan, id: 'skill:review', stage: 'dispatch', catalog: liveCatalog });
  assert.equal((await check()).allowed, true);
  await store.save(scope, profile(1, '', { 'skill:review': 'off' }));
  assert.equal((await check()).allowed, false);
  await store.save(scope, profile(2, '', { 'skill:review': 'on' }));
  assert.equal((await check()).reason, 'revoked-this-turn');
  const fresh = await host.prepare({ scope, request: request(), catalog });
  assert.equal((await check(fresh)).allowed, true);
  const deniedCatalog = catalog.map(item => item.id === 'plugin:review' ? { ...item, hostAllowed: false } : item);
  assert.equal((await check(fresh, deniedCatalog)).allowed, false);
  assert.equal((await check(fresh)).reason, 'revoked-this-turn');
  assert.equal((await check(await host.prepare({ scope, request: request(), catalog }))).allowed, true);
});

test('immutable history catches an unobserved parent off/on interval and revokes its children for the prepared turn', async t => {
  const { store, host } = await fixture(t);
  await store.save(scope, profile(0, '', { 'skill:review': 'on', 'skill:dependent': 'on' }));
  const prepared = await host.prepare({ scope, request: request(), catalog });
  await store.save(scope, profile(1, '', { 'plugin:review': 'off', 'skill:review': 'on', 'skill:dependent': 'on' }));
  await store.save(scope, profile(2, '', { 'skill:review': 'on', 'skill:dependent': 'on' }));
  for (const id of ['skill:review', 'mcp:search', 'skill:dependent']) {
    const result = await host.authorize({ scope, prepared, id, stage: 'dispatch', catalog });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'revoked-this-turn');
  }
  const fresh = await host.prepare({ scope, request: request(), catalog });
  assert.equal((await host.authorize({ scope, prepared: fresh, id: 'skill:dependent', stage: 'dispatch', catalog })).allowed, true);
  const readerWithoutHistory = new HostContract({ get: value => store.get(value) }, { coverage });
  const noHistoryPlan = await readerWithoutHistory.prepare({ scope, request: request(), catalog });
  await store.save(scope, profile(3, 'New profile', { 'skill:review': 'on', 'skill:dependent': 'on' }));
  const unsupported = await readerWithoutHistory.authorize({ scope, prepared: noHistoryPlan, id: 'skill:review', stage: 'dispatch', catalog });
  assert.equal(unsupported.supported, false);
  assert.ok(unsupported.issues.some(item => item.code === 'HISTORY_REQUIRED'));
});
