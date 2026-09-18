import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { nativeEvidenceFile, readNativeEvidence, writeNativeEvidence } from '../lib/native-evidence.mjs';
import { createPanelService } from '../lib/panel-service.mjs';

const scope = { hostId: 'native-test-host', accountScope: 'native-test-account', threadId: '11111111-2222-4333-8444-555555555555' };
const other = { ...scope, threadId: '11111111-2222-4333-8444-555555555556' };
const entry = {
  id: 'mcp:observed-server', name: 'Observed server', kind: 'mcp', defaultEnabled: true, available: true,
  effective: true, control: 'preference-only', source: '官方 backend 任务目录',
  configMapping: { kind: 'plugin-mcp-server', serverName: 'runtime-name', pluginKey: 'fixture@test', pluginServerName: 'manifest-name', command: 'not-allowed' },
  environment: { SECRET: 'never-publish' },
};
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'threadbrief-native-evidence-'));
  const directory = path.join(root, 'evidence'), bridgeDirectory = path.join(root, 'bridges');
  await mkdir(bridgeDirectory);
  t.after(() => rm(root, { recursive: true, force: true }));
  const heartbeat = (patch = {}) => writeFile(path.join(bridgeDirectory, 'bridge-12345.json'), JSON.stringify({ schemaVersion: 1, pid: 12345, initialized: true, stopped: false, hostId: scope.hostId, accountScope: scope.accountScope, updatedAt: new Date().toISOString(), profileOverlay: true, capabilityEnforcement: false, automaticPanelMount: true, ...patch }));
  const evidence = (patch = {}) => writeNativeEvidence(directory, scope, { bridgePid: 12345, mountStatus: 'queued', profileStatus: 'ready', capabilityStatus: 'catalog-observed', catalog: [entry], ...patch });
  return { root, directory, bridgeDirectory, heartbeat, evidence, read: () => readNativeEvidence(directory, scope, { bridgeDirectory }) };
}

test('native evidence requires matching live bridge and strips non-catalog fields', async t => {
  const f = await fixture(t);
  await f.evidence();
  assert.equal((await f.read()).live, false);
  await f.heartbeat();
  const live = await f.read();
  assert.equal(live.live, true);
  assert.equal(live.catalogFresh, true);
  assert.equal(live.evidence.catalog[0].effective, true);
  assert.deepEqual(live.evidence.catalog[0].configMapping, { kind: 'plugin-mcp-server', serverName: 'runtime-name', pluginKey: 'fixture@test', pluginServerName: 'manifest-name' });
  assert.equal(JSON.stringify(live).includes('never-publish'), false);
  assert.equal(JSON.stringify(live).includes('not-allowed'), false);
  await writeNativeEvidence(f.directory, scope, { bridgePid: 12345, capabilityStatus: 'pending-reload' });
  assert.equal((await f.read()).evidence.catalog.length, 1);
  assert.equal((await f.read()).evidence.capabilityStatus, 'pending-reload');
});

test('expired evidence, stale heartbeat, stopped bridge and authority mismatch fail closed', async t => {
  const f = await fixture(t);
  await f.heartbeat();
  const old = new Date(Date.now() - 31_000).toISOString();
  await f.evidence({ observedAt: old });
  assert.equal((await f.read()).reason, 'stale-evidence');
  await f.evidence(); await f.heartbeat({ updatedAt: old });
  assert.equal((await f.read()).reason, 'stale-bridge');
  await f.heartbeat({ stopped: true });
  assert.equal((await f.read()).reason, 'bridge-not-ready');
  await f.heartbeat({ accountScope: 'different-account' });
  assert.equal((await f.read()).reason, 'bridge-scope-mismatch');
  await f.heartbeat({ updatedAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal((await f.read()).live, false);
});

test('skill mappings retain the backend name without treating display labels as selectors', async t => {
  const f = await fixture(t);
  await f.heartbeat();
  const skill = { ...entry, id: 'skill:fixture', name: 'Friendly label', kind: 'skill', configMapping: { kind: 'skill', path: 'C:/fixture/SKILL.md', skillName: 'canonical-skill', instruction: 'discard' } };
  await f.evidence({ catalog: [skill] });
  assert.deepEqual((await f.read()).evidence.catalog[0].configMapping, { kind: 'skill', path: 'C:/fixture/SKILL.md', skillName: 'canonical-skill' });
  await f.evidence({ catalog: [{ ...skill, configMapping: { kind: 'skill', path: 'C:/fixture/SKILL.md' } }] });
  assert.equal((await f.read()).evidence.catalog[0].configMapping.skillName, undefined);
});

test('skill input status requires a live bridge and an acceptance matching the saved revision', async t => {
  const f = await fixture(t);
  await f.heartbeat({ skillTurnInput: true });
  const skill = { ...entry, id: 'skill:fixture', kind: 'skill', configMapping: { kind: 'skill', path: 'C:/fixture/SKILL.md', skillName: 'fixture' } };
  await f.evidence({ catalog: [skill], skillInputRevision: 1, skillInputIds: [skill.id] });
  const app = await createPanelService({ binding: scope, dataDirectory: path.join(f.root, 'data'), nativeEvidenceDirectory: f.directory, bridgeDirectory: f.bridgeDirectory });
  t.after(() => app.close());
  const read = () => app.state();
  await app.store.save(scope, { expectedRevision: 0, persona: '', background: '', overrides: { [skill.id]: 'on' } });
  assert.equal((await read()).catalog[0].inclusion, 'accepted');
  await app.store.save(scope, { expectedRevision: 1, persona: '', background: '', overrides: { [skill.id]: 'off' } });
  assert.equal((await read()).catalog[0].inclusion, 'stopped');
  await app.store.save(scope, { expectedRevision: 2, persona: '', background: '', overrides: { [skill.id]: 'on' } });
  assert.equal((await read()).catalog[0].inclusion, 'next-turn');
  await f.heartbeat({ skillTurnInput: true, stopped: true });
  assert.equal((await read()).catalog.some(item => item.inclusion === 'accepted'), false);
});

test('task evidence cannot be reused for another scope and a new bridge inherits no old state', async t => {
  const f = await fixture(t);
  await f.heartbeat(); await f.evidence();
  assert.equal(await readNativeEvidence(f.directory, other, { bridgeDirectory: f.bridgeDirectory }), null);
  await copyFile(nativeEvidenceFile(f.directory, scope), nativeEvidenceFile(f.directory, other));
  const forged = await readNativeEvidence(f.directory, other, { bridgeDirectory: f.bridgeDirectory });
  assert.equal(forged.live, false);
  assert.equal(forged.evidence, null);
  await writeNativeEvidence(f.directory, scope, { bridgePid: 54321, profileStatus: 'ready' });
  const stored = JSON.parse(await readFile(nativeEvidenceFile(f.directory, scope), 'utf8'));
  assert.deepEqual(stored.catalog, []);
  assert.equal(stored.mountStatus, undefined);
});

test('panel uses fresh task evidence while queued mount never claims applied capabilities', async t => {
  const f = await fixture(t);
  await f.heartbeat(); await f.evidence({ capabilityStatus: 'enforced' });
  const dataDirectory = path.join(f.root, 'data');
  const app = await createPanelService({ binding: scope, dataDirectory, registryDirectory: path.join(f.root, 'registry'), nativeEvidenceDirectory: f.directory, bridgeDirectory: f.bridgeDirectory });
  t.after(() => app.close());
  const read = async url => (await fetch(url + '/api/state')).json();
  const current = await read(app.url);
  assert.equal(current.integration.context.status, 'connected');
  assert.equal(current.integration.mount.status, 'native-queued');
  assert.equal(current.integration.capabilities.status, 'catalog-observed');
  assert.equal(current.catalog[0].effective, true);
  assert.equal(current.config.revision, 0);
  await assert.rejects(readdir(dataDirectory), { code: 'ENOENT' });
  const registered = await app.registry.register({ threadId: other.threadId });
  const otherState = await read(app.origin + '/panel/' + registered.token);
  assert.equal(otherState.integration.context.status, 'not-connected');
  assert.deepEqual(otherState.catalog, []);
  await f.evidence({ capabilityStatus: 'partially-prepared', profileStatus: 'accepted', profileRevision: 99 });
  const pending = await read(app.url);
  assert.equal(pending.integration.context.status, 'connected');
  assert.equal(pending.integration.capabilities.status, 'partially-prepared');
  await f.heartbeat({ stopped: true });
  const expired = await read(app.url);
  assert.equal(expired.integration.context.status, 'not-connected');
  assert.equal(expired.integration.capabilities.status, 'not-connected');
  assert.deepEqual(expired.catalog, []);
});

test('heartbeats keep bridge live without refreshing the independently dated catalog', async t => {
  const f = await fixture(t);
  const old = new Date(Date.now() - 31_000).toISOString();
  await f.heartbeat(); await f.evidence({ catalogObservedAt: old });
  await writeNativeEvidence(f.directory, scope, { bridgePid: 12345 });
  // A whole-record heartbeat can carry cached catalog rows as well.
  await writeNativeEvidence(f.directory, scope, { bridgePid: 12345, catalog: [entry] });
  const oldCatalog = await f.read();
  assert.equal(oldCatalog.live, true);
  assert.equal(oldCatalog.catalogFresh, false);
  assert.equal(oldCatalog.evidence.catalogObservedAt, old);
  assert.equal(oldCatalog.evidence.catalog[0].effective, null);
  assert.equal(oldCatalog.evidence.catalog[0].available, true);
  await f.evidence({ catalogObservedAt: new Date().toISOString() });
  assert.equal((await f.read()).catalogFresh, true);
  assert.equal((await f.read()).evidence.catalog[0].effective, true);
});

test('legacy catalog lacking observation time remains unknown after a cached heartbeat', async t => {
  const f = await fixture(t);
  await f.heartbeat(); await f.evidence();
  const file = nativeEvidenceFile(f.directory, scope);
  const legacy = JSON.parse(await readFile(file, 'utf8'));
  delete legacy.catalogObservedAt;
  await writeFile(file, JSON.stringify(legacy));
  await writeNativeEvidence(f.directory, scope, { bridgePid: 12345, catalog: legacy.catalog });
  assert.equal((await f.read()).live, true);
  assert.equal((await f.read()).catalogFresh, false);
});

test('failed catalog categories lose old effective values while successful kinds remain fresh', async t => {
  const f = await fixture(t);
  const appEntry = { ...entry, id: 'app:fixture', kind: 'app', name: 'Fixture app', effective: false, configMapping: { kind: 'app', appId: 'fixture-app' } };
  await f.heartbeat();
  await f.evidence({ catalog: [entry, appEntry], catalogFailedKinds: ['app'], catalogObservedAt: new Date().toISOString() });
  const partial = await f.read();
  assert.equal(partial.catalogFresh, true);
  assert.equal(partial.evidence.catalog[0].effective, true);
  assert.equal(partial.evidence.catalog[1].effective, null);
  await writeNativeEvidence(f.directory, scope, { bridgePid: 12345 });
  assert.deepEqual((await f.read()).evidence.catalogFailedKinds, ['app']);
  await f.evidence({ catalog: [entry, appEntry], catalogFailedKinds: [], catalogObservedAt: new Date().toISOString() });
  assert.equal((await f.read()).evidence.catalog[1].effective, false);
});

test('stale or partially failed catalog stays editable without claiming runtime availability', async t => {
  const f = await fixture(t);
  await f.heartbeat();
  await f.evidence({ catalogObservedAt: new Date(Date.now() - 31_000).toISOString() });
  const app = await createPanelService({ binding: scope, dataDirectory: path.join(f.root, 'data'), nativeEvidenceDirectory: f.directory, bridgeDirectory: f.bridgeDirectory });
  t.after(() => app.close());
  const read = async () => (await fetch(app.url + '/api/state')).json();
  const stale = await read();
  assert.equal(stale.integration.context.status, 'connected');
  assert.equal(stale.integration.mount.status, 'native-queued');
  assert.equal(stale.integration.capabilities.status, 'catalog-stale');
  assert.equal(stale.catalog[0].effective, null);
  assert.equal(stale.catalog[0].available, true);
  assert.match(stale.catalog[0].reason, /旧快照.*未知/);
  await f.evidence({ catalogFailedKinds: ['mcp'], catalogObservedAt: new Date().toISOString() });
  const partial = await read();
  assert.equal(partial.integration.capabilities.status, 'catalog-partial');
  assert.equal(partial.catalog[0].effective, null);
  assert.equal(partial.catalog[0].available, true);
  assert.match(partial.catalog[0].reason, /读取失败/);
});

test('a live tool policy failure replaces prior success while task preferences remain editable and saved', async t => {
  const f = await fixture(t);
  await f.heartbeat({ toolPolicyHooks: true, capabilityEnforcement: true });
  const plugin = { ...entry, id: 'plugin:fixture@test', name: 'Fixture plugin', kind: 'plugin',
    configMapping: { kind: 'plugin', pluginKey: 'fixture@test' } };
  await f.evidence({ catalog: [entry, plugin], capabilityStatus: 'enforced', toolPolicyStatus: 'registered' });
  const app = await createPanelService({ binding: scope, dataDirectory: path.join(f.root, 'data'),
    nativeEvidenceDirectory: f.directory, bridgeDirectory: f.bridgeDirectory });
  t.after(() => app.close());
  const read = async () => (await fetch(app.url + '/api/state')).json();
  const initial = { persona: 'Keep this task profile', background: 'Keep this background', overrides: { [entry.id]: 'on' } };
  await app.store.save(scope, { expectedRevision: 0, ...initial });
  assert.equal((await read()).integration.capabilities.status, 'registered');
  await writeNativeEvidence(f.directory, scope, { bridgePid: 12345, toolPolicyStatus: 'observed' });
  const succeeded = await read();
  assert.equal(succeeded.integration.capabilities.status, 'connected');
  await writeNativeEvidence(f.directory, scope, { bridgePid: 12345, toolPolicyStatus: 'error' });
  assert.equal((await f.read()).live, true);
  const failed = await read();
  assert.deepEqual(failed.integration.capabilities, { status: 'error', label: '能力控制暂不可用' });
  assert.deepEqual(failed.config, succeeded.config);
  assert.deepEqual(failed.history, succeeded.history);
  for (const item of failed.catalog) {
    assert.equal(item.executionPolicy, 'error');
    assert.equal(item.available, true);
    assert.equal(item.control, 'preference-only');
    assert.match(item.reason, /宿主暂时无法运行本任务的能力控制.*仍可编辑和保存/u);
  }
  const response = await fetch(app.url + '/api/config', { method: 'PUT',
    headers: { 'content-type': 'application/json', origin: app.origin },
    body: JSON.stringify({ expectedRevision: 1, ...initial, overrides: { [entry.id]: 'off' } }),
  });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.config.revision, 2);
  assert.equal(saved.config.persona, initial.persona);
  assert.equal(saved.config.background, initial.background);
  assert.equal(saved.catalog.find(item => item.id === entry.id).desired, 'off');
  assert.equal(saved.integration.capabilities.status, 'error');
  assert.deepEqual(await app.store.get(scope), saved.config);
});
