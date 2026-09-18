import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalAppHookName, mapAppTools } from './app-tool-mapping.mjs';

const app = id => ({ id, runtimeName: 'Untrusted display label', enabled: true, callable: true });
const tool = (connectorId, name, connectorName = 'Fixture App') => ({ connectorId, name, connectorName });
const map = (appTools, apps = [app('connector_fixture')]) => mapAppTools({ servers: [{ name: 'codex_apps', appTools }], apps });

test('canonical names follow source normalization, connector prefix and hook underscore rules', () => {
  const vectors = [
    [tool('connector_gmail', 'gmail_search', 'Gmail'), 'mcp__codex_apps__gmail__search'],
    [tool('connector_drive', 'Google Drive.search-files', 'Google Drive'), 'mcp__codex_apps__google_drive__search_files'],
    [tool('connector_abc', 'connector_abc_search', null), 'mcp__codex_apps__search'],
    [tool('id', 'other__read', 'Fixture App'), 'mcp__codex_apps__fixture_app__other__read'],
    [tool('id', 'read', ' *** '), 'mcp__codex_apps__app__read'],
    [tool('id', '🚀Read🚀file', 'X🚀Y'), 'mcp__codex_apps__x_y__read_file'],
    [tool('id', 'Gmail', 'Gmail'), 'mcp__codex_apps__gmail__gmail'],
  ];
  for (const [value, expected] of vectors) assert.equal(canonicalAppHookName(value), expected);
});

test('mapping joins only exact installed connector IDs and preserves raw operation separately', () => {
  const result = map([tool('connector_fixture', 'fixture_app.read'), tool('uninstalled', 'other'), tool('connector_fixture', 'fixture_app.read')]);
  assert.deepEqual(result.unsupportedApps, []);
  assert.deepEqual(result.mappings, [{ appId: 'connector_fixture', toolNames: ['mcp__codex_apps__fixture_app__read'],
    toolBindings: [{ serverName: 'codex_apps', toolName: 'fixture_app.read', hookToolName: 'mcp__codex_apps__fixture_app__read' }] }]);
});

test('ordinary MCP metadata, runtimeName and display-only app summaries cannot establish a binding', () => {
  const result = mapAppTools({ servers: [{ name: 'custom_server', appTools: [tool('connector_fixture', 'read')] }],
    apps: [{ ...app('connector_fixture'), runtimeName: 'fixture_app', toolSummaries: [{ name: 'read' }] }] });
  assert.deepEqual(result.mappings, []); assert.equal(result.unsupportedApps[0].reason, 'APP_TOOL_CATALOG_UNAVAILABLE');
  assert.deepEqual(map([tool('another_id', 'read')]).mappings, []);
});

test('missing observed fields reject the whole App instead of granting partial coverage', () => {
  const missingName = { connectorId: 'connector_fixture', name: 'read' };
  for (const broken of [missingName, tool('connector_fixture', ''), tool('connector_fixture', 'read', 5)]) {
    const result = map([tool('connector_fixture', 'valid'), broken]);
    assert.deepEqual(result.mappings, []); assert.equal(result.unsupportedApps.length, 1);
  }
  assert.equal(canonicalAppHookName({ name: 'read', connectorName: 'Fixture' }), null);
});

test('duplicate apps, raw operation ownership and canonical name collisions remain unsupported', () => {
  const duplicate = map([tool('connector_fixture', 'read')], [app('connector_fixture'), app('connector_fixture')]);
  assert.equal(duplicate.unsupportedApps[0].reason, 'APP_ID_AMBIGUOUS');
  for (const tools of [
    [tool('A', 'read', 'X-Y'), tool('B', 'read', 'X Y')],
    [tool('A', 'same-raw', 'Alpha'), tool('B', 'same-raw', 'Beta')],
  ]) {
    const result = map(tools, [app('A'), app('B')]);
    assert.equal(result.mappings.length, 0); assert.ok(result.unsupportedApps.every(item => item.reason === 'APP_TOOL_BINDING_AMBIGUOUS'));
  }
  assert.equal(map([tool('connector_fixture', 'x-y'), tool('connector_fixture', 'x.y')]).mappings.length, 0);
});

test('mapping order is stable without modifying trusted input snapshots', () => {
  const args = { servers: [{ name: 'codex_apps', appTools: [tool('B', 'z'), tool('A', 'b'), tool('A', 'a')] }], apps: [app('B'), app('A')] };
  const before = structuredClone(args), a = mapAppTools(args);
  const b = mapAppTools({ servers: [{ ...args.servers[0], appTools: [...args.servers[0].appTools].reverse() }], apps: [...args.apps].reverse() });
  assert.deepEqual(a, b); assert.deepEqual(args, before);
});
