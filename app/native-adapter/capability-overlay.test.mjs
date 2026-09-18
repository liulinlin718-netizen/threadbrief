import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ThreadStore } from '../lib/store.mjs';
import { prepareCapabilityOverlay } from './capability-overlay.mjs';

const scope = { hostId: 'local', accountScope: 'trusted-account', threadId: '01a0af0e-b48d-7842-bbbc-dc205c337556' };
const sibling = '01a0af0e-b48d-7842-bbbc-dc205c337557';
const resolve = threadId => threadId === scope.threadId ? scope : null;
const item = (id, kind, configMapping, extra = {}) => ({ id, kind, configMapping, ...extra });
const mcp = item('mcp:opaque-hash', 'mcp', { kind: 'mcp-server', serverName: 'fixture' });
const plugin = item('plugin:opaque-id', 'plugin', { kind: 'plugin', pluginKey: 'sample@local' });
const app = item('app:opaque-id', 'app', { kind: 'app', appId: 'app_123' });
const catalog = (...items) => ({ scope, items });
const request = config => ({ id: 17, method: 'thread/resume', params: {
  threadId: scope.threadId, config, baseInstructions: 'host base', developerInstructions: 'host developer',
  model: 'host-model', permissions: 'host-profile', cwd: 'C:\\host',
  runtimeWorkspaceRoots: ['C:\\host'], serviceTier: 'host-tier', excludeTurns: true,
  opaqueFutureField: { preserve: 'unchanged' },
} });
const storeWith = overrides => ({ get: async () => ({ revision: 3, overrides }) });
const prepare = (message, overrides, entries = [mcp], extra = {}) => prepareCapabilityOverlay({
  message, store: storeWith(overrides), scopeForThread: resolve, catalog: catalog(...entries), ...extra,
});

test('untouched task is exact identity, does not need catalog, and creates no store files', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'threadbrief-capability-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = request({ 'mcp_servers.fixture': { command: 'host', enabled: true } });
  const result = await prepareCapabilityOverlay({ message: original, store: new ThreadStore(path.join(root, 'data')), scopeForThread: resolve });
  assert.equal(result.message, original);
  assert.equal(result.status, 'passthrough');
  assert.deepEqual(await readdir(root), []);
});

test('start and fork never inherit a parent recipe or read parent overrides', async () => {
  const store = { get() { throw new Error('must not read'); } };
  for (const method of ['thread/start', 'thread/fork', 'turn/start', 'initialize']) {
    const original = { ...request({ original: true }), method };
    const result = await prepareCapabilityOverlay({ message: original, store, scopeForThread: resolve, catalog: catalog(mcp) });
    assert.equal(result.message, original);
    assert.equal(result.changed, false);
    if (method === 'thread/fork' || method === 'thread/start') assert.equal(result.status, 'deferred-target-scope');
  }
});

test('identity and mappings come only from trusted scope and scope-bound catalog', async () => {
  const original = request({});
  original.params.scope = { ...scope, accountScope: 'forged' };
  original.params.catalog = catalog(item('mcp:opaque-hash', 'mcp', { kind: 'mcp-server', serverName: 'forged' }));
  const result = await prepare(original, { [mcp.id]: 'off' });
  assert.equal(result.prepared.scope.accountScope, scope.accountScope);
  assert.equal(result.message.params.config.mcp_servers.fixture.enabled, false);
  const different = await prepare({ ...original, params: { ...original.params, threadId: sibling } }, { [mcp.id]: 'off' });
  assert.equal(different.status, 'unmapped-thread');
  const mismatch = await prepare(original, { [mcp.id]: 'off' }, [mcp], { catalog: { scope: { ...scope, accountScope: 'other' }, items: [mcp] } });
  assert.equal(mismatch.message, original);
  assert.match(mismatch.reason, /CATALOG_SCOPE/u);
});

test('nested config changes one boolean and preserves all host recipe fields and references', async () => {
  const config = { mcp_servers: { fixture: { command: 'host-node', args: ['host-script'], env: { HOST: 'value' }, enabled: true }, other: { enabled: true } }, model_provider: 'host-provider' };
  const original = request(config), before = JSON.stringify(original);
  const result = await prepare(original, { [mcp.id]: 'off' });
  assert.equal(result.message.params.config.mcp_servers.fixture.enabled, false);
  assert.equal(result.message.params.config.mcp_servers.fixture.args, config.mcp_servers.fixture.args);
  assert.equal(result.message.params.config.mcp_servers.fixture.env, config.mcp_servers.fixture.env);
  assert.equal(result.message.params.config.mcp_servers.other, config.mcp_servers.other);
  for (const key of Object.keys(original.params).filter(key => key !== 'config')) assert.equal(result.message.params[key], original.params[key]);
  assert.equal(JSON.stringify(original), before);
  assert.equal(result.integrationBoundary.capabilityEnforcement, false);
  assert.equal(result.prepared.status, 'prepared');
  assert.equal(result.deferredHotChange, true);
  assert.equal(result.prepared.applied, undefined);
});

test('dotted table and quoted literal IDs are merged without rewriting transport settings', async () => {
  const special = item('mcp:special', 'mcp', { kind: 'mcp-server', serverName: 'fixture.v2' });
  const original = request({ 'mcp_servers."fixture.v2"': { command: 'node', enabled: true, disabled_tools: ['blocked'] }, 'apps.other.enabled': false });
  const result = await prepare(original, { [special.id]: 'off' }, [special]);
  assert.deepEqual(result.message.params.config, { 'mcp_servers."fixture.v2"': { command: 'node', enabled: false, disabled_tools: ['blocked'] }, 'apps.other.enabled': false });
  const exact = request({ 'mcp_servers.fixture.enabled': true, 'mcp_servers.fixture.command': 'node' });
  const leaf = await prepare(exact, { [mcp.id]: 'off' });
  assert.deepEqual(leaf.message.params.config, { 'mcp_servers.fixture.enabled': false, 'mcp_servers.fixture.command': 'node' });
});

test('sibling dotted keys are retained and unsafe aliases or scalar ancestors are unsupported', async () => {
  const original = request({ 'mcp_servers.other': { command: 'host' } });
  const result = await prepare(original, { [mcp.id]: 'off' });
  assert.equal(result.message.params.config['mcp_servers.other'], original.params.config['mcp_servers.other']);
  assert.equal(result.message.params.config['mcp_servers.fixture.enabled'], false);
  for (const config of [
    { mcp_servers: { fixture: { enabled: true } }, 'mcp_servers.fixture.enabled': true },
    { mcp_servers: 'scalar' }, { 'mcp_servers.fixture.enabled.child': 'unexpected' },
    { 'mcp_servers."unterminated': {} },
  ]) {
    const ambiguous = request(config), before = JSON.stringify(config);
    const result = await prepare(ambiguous, { [mcp.id]: 'off' });
    assert.equal(result.message, ambiguous);
    assert.equal(result.status, 'unsupported');
    assert.equal(JSON.stringify(config), before);
  }
});

test('exact plugin, plugin MCP and app mappings never derive keys from UI IDs', async () => {
  const child = item('mcp:plugin-hash', 'mcp', { kind: 'plugin-mcp-server', pluginKey: 'sample@local', serverName: 'runtime-name', pluginServerName: 'manifest-name' });
  const original = request({ plugins: { 'sample@local': { customHostField: 42 } } });
  const result = await prepare(original, { [plugin.id]: 'off', [child.id]: 'off', [app.id]: 'off' }, [plugin, child, app]);
  assert.deepEqual(result.message.params.config.plugins['sample@local'], { customHostField: 42, enabled: false, mcp_servers: { 'manifest-name': { enabled: false } } });
  assert.equal(result.message.params.config.apps.app_123.enabled, false);
  assert.deepEqual(result.affectedCategories, ['app', 'mcp', 'plugin']);
  assert.equal(JSON.stringify(result.message.params.config).includes('opaque'), false);
});

test('missing hashed mappings and skill baselines remain explicit unsupported while safe deltas proceed', async () => {
  const skill = item('skill:opaque-hash', 'skill', { kind: 'skill', path: 'C:\\skills\\review\\SKILL.md' });
  const unmapped = { id: 'plugin:known-looking@market', name: 'Friendly title', kind: 'plugin' };
  const config = { skills: { config: [{ path: 'C:\\other\\SKILL.md', enabled: false }] } };
  const original = request(config);
  const result = await prepare(original, { [mcp.id]: 'off', [skill.id]: 'on', [unmapped.id]: 'off' }, [mcp, skill, unmapped]);
  assert.equal(result.status, 'partial-prepared');
  assert.equal(result.message.params.config.skills, config.skills);
  assert.deepEqual(new Set(result.unsupportedCapabilities.map(value => value.reason)), new Set(['EXACT_CONFIG_MAPPING_MISSING', 'SKILL_BASELINE_REQUIRED']));
});

test('host denial, parent off, duplicate targets and prototype names never become enablement', async () => {
  const child = { ...mcp, parentId: plugin.id };
  const parentOff = await prepare(request({}), { [plugin.id]: 'off', [child.id]: 'on' }, [plugin, child]);
  assert.equal(parentOff.message.params.config.plugins['sample@local'].enabled, false);
  assert.equal(parentOff.message.params.config.mcp_servers, undefined);
  assert.equal(parentOff.unsupportedCapabilities[0].reason, 'PARENT_CAPABILITY_DISABLED');
  const denied = await prepare(request({}), { [mcp.id]: 'on' }, [{ ...mcp, hostAllowed: false }]);
  assert.equal(denied.unsupportedCapabilities[0].reason, 'HOST_PERMISSION_DENIED');
  const alias = { ...mcp, id: 'mcp:alias' };
  const ambiguous = await prepare(request({}), { [mcp.id]: 'on', [alias.id]: 'off' }, [mcp, alias]);
  assert.equal(ambiguous.changed, false);
  assert.equal(ambiguous.unsupportedCapabilities.length, 2);
  const dangerous = item('mcp:danger', 'mcp', { kind: 'mcp-server', serverName: '__proto__' });
  assert.equal((await prepare(request({}), { [dangerous.id]: 'on' }, [dangerous])).changed, false);
  assert.equal({}.enabled, undefined);
});

test('existing matching value and cleared overrides preserve identity; compilation has no timestamps', async () => {
  const original = request({ 'mcp_servers.fixture.enabled': false });
  assert.equal((await prepare(original, { [mcp.id]: 'off' })).message, original);
  assert.equal((await prepare(original, {})).message, original);
  const first = await prepare(request({}), { [mcp.id]: 'off' });
  const second = await prepare(request({}), { [mcp.id]: 'off' });
  assert.equal(first.prepared.configHash, second.prepared.configHash);
  assert.equal(first.prepared.timestamp, undefined);
});
