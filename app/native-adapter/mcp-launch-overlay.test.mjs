import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMcpLaunch } from './mcp-launch-overlay.mjs';

const options = { nodeExecutable: 'F:\\node.exe', gatewayFile: 'D:\\Thread Brief\\mcp-gateway.mjs', runtimeConfigFile: 'D:\\Thread Brief\\runtime-config.json' };
const request = (config, method = 'thread/resume') => ({ id: 7, method, params: {
  threadId: 'fixture-task', model: 'host-model', cwd: 'D:\\project', sandbox: 'read-only',
  developerInstructions: 'host instructions', config,
} });
const prepare = (message, effectiveConfig, extra = {}) => prepareMcpLaunch({ ...options, message, effectiveConfig, ...extra });
const gatewayArgs = (name, command, args = []) => [options.gatewayFile, options.runtimeConfigFile, name, '', '--', command, ...args];

test('natural lifecycle wraps only stdio commands while keeping host instructions and server configuration', () => {
  for (const method of ['thread/start', 'thread/resume', 'thread/fork']) {
    const server = { command: 'original.exe', args: ['--arg', 'space path', '"quoted"', '', '中文'],
      env: { MODE: 'fixture' }, cwd: 'D:\\tool', enabled: true, startup_timeout_sec: 20, enabled_tools: ['echo'] };
    const message = request({ model_reasoning_effort: 'high', mcp_servers: { echo: server } }, method);
    const before = JSON.stringify(message);
    const result = prepare(message, {});
    assert.equal(result.changed, true);
    assert.equal(JSON.stringify(message), before);
    assert.deepEqual({ ...result.message.params, config: undefined }, { ...message.params, config: undefined });
    assert.deepEqual(result.message.params.config, { ...message.params.config, mcp_servers: { echo: { ...server,
      command: options.nodeExecutable, args: gatewayArgs('echo', server.command, server.args) } } });
    assert.deepEqual(result.wrappedServers, [{ serverName: 'echo', pluginKey: '', configPath: ['mcp_servers', 'echo'], alreadyWrapped: false }]);
  }
});

test('resolved baseline commands become leaf-only overrides without copying globals or changing permissions', () => {
  const effectiveConfig = { mcp_servers: {
    a: { command: 'a.exe', args: ['a'], env: { SECRET_REFERENCE: 'kept in backend configuration' }, cwd: '/host/tool' },
    b: { command: 'b.exe' },
  }, approval_policy: 'never', model: 'baseline-model' };
  const message = request(undefined);
  const before = JSON.stringify(effectiveConfig);
  const result = prepare(message, effectiveConfig);
  assert.deepEqual(result.message.params.config, { mcp_servers: {
    a: { command: options.nodeExecutable, args: gatewayArgs('a', 'a.exe', ['a']) },
    b: { command: options.nodeExecutable, args: gatewayArgs('b', 'b.exe') },
  } });
  assert.equal(JSON.stringify(effectiveConfig), before);
  assert.equal(result.message.params.model, 'host-model');
});

test('host dotted and quoted TOML values take precedence without rewriting unrelated keys', () => {
  const message = request({ 'mcp_servers."a.b".command': 'host.exe', "mcp_servers.'a.b'.args": ['host'],
    'mcp_servers."a.b".env': { HOST: 'same' }, approval_policy: 'on-request' });
  const result = prepare(message, { mcp_servers: { 'a.b': { command: 'base.exe', args: ['base'] } } });
  assert.deepEqual(result.message.params.config, { ...message.params.config,
    'mcp_servers."a.b".command': options.nodeExecutable,
    "mcp_servers.'a.b'.args": gatewayArgs('a.b', 'host.exe', ['host']) });
  assert.equal(result.unsupportedServers.length, 0);
});

test('quoted whole-table overrides retain other server fields and fill absent args from the baseline', () => {
  const message = request({ 'mcp_servers."space name"': { command: 'host.exe', env_vars: ['TOKEN'], required: true } });
  const result = prepare(message, { 'mcp_servers."space name".args': ['baseline arg'] });
  assert.deepEqual(result.message.params.config['mcp_servers."space name"'], {
    ...message.params.config['mcp_servers."space name"'], command: options.nodeExecutable,
    args: gatewayArgs('space name', 'host.exe', ['baseline arg']),
  });
});

test('new fields follow existing dotted override style without replacing host tables', () => {
  const message = request({ 'mcp_servers.one.env': { TOKEN: 'unchanged' }, 'mcp_servers.one.enabled': true });
  const result = prepare(message, { mcp_servers: { one: { command: 'tool.exe' } } });
  assert.deepEqual(result.message.params.config, { ...message.params.config,
    'mcp_servers.one.command': options.nodeExecutable, 'mcp_servers.one.args': gatewayArgs('one', 'tool.exe') });
});

test('disabled servers remain disabled and HTTP or unresolved plugin servers are explicitly unsupported', () => {
  const message = request({ 'mcp_servers.off.enabled': false });
  const result = prepare(message, { mcp_servers: {
    off: { command: 'off.exe', enabled: true }, http: { url: 'https://example.invalid/mcp' },
    plugin: { command: 'not-an-ordinary-server.exe' },
  } }, { catalog: { items: [
    { kind: 'mcp', configMapping: { kind: 'plugin-mcp-server', serverName: 'plugin', pluginKey: 'plugin@market' } },
    { kind: 'mcp', configMapping: { kind: 'mcp-server', serverName: 'unresolved' } },
  ] } });
  assert.equal(result.message, message);
  assert.equal(result.changed, false);
  assert.equal(result.wrappedServers.length, 0);
  assert.deepEqual(result.unsupportedServers, [
    { serverName: 'plugin', reason: 'PLUGIN_SERVER_UNRESOLVED', pluginKey: 'plugin@market' },
    { serverName: 'unresolved', reason: 'SERVER_CONFIG_UNRESOLVED' },
    { serverName: 'http', reason: 'NON_STDIO_SERVER' },
  ]);
});

test('conflicting aliases reject only that server and leave independent commands wrappable', () => {
  const message = request({ mcp_servers: { conflict: { command: 'one.exe' } }, 'mcp_servers.conflict.command': 'two.exe' });
  const result = prepare(message, { mcp_servers: { safe: { command: 'safe.exe' } } });
  assert.equal(result.changed, true);
  assert.equal(result.message.params.config['mcp_servers.conflict.command'], 'two.exe');
  assert.equal(result.message.params.config.mcp_servers.conflict.command, 'one.exe');
  assert.deepEqual(result.unsupportedServers, [{ serverName: 'conflict', reason: 'SERVER_CONFIG_AMBIGUOUS' }]);
  assert.deepEqual(result.message.params.config.mcp_servers.safe.args, gatewayArgs('safe', 'safe.exe'));
});

test('malformed table or key encoding preserves the entire original request', () => {
  for (const config of [ { mcp_servers: null }, { 'mcp_servers."unterminated.command': 'tool' },
    JSON.parse('{"mcp_servers":{"__proto__":{"command":"tool"}}}') ]) {
    const message = request(config);
    const result = prepare(message, { mcp_servers: { safe: { command: 'safe.exe' } } });
    assert.equal(result.message, message);
    assert.equal(result.changed, false);
    assert.equal(result.unsupportedServers[0].reason, 'MCP_CONFIG_AMBIGUOUS');
  }
});

test('invalid stdio launch fields are not coerced or shell-parsed', () => {
  for (const server of [{ command: ['tool'] }, { command: 'tool', args: '--one two' },
    { command: 'tool', args: null }, { command: 'tool', args: [1] }, { command: 'tool\0bad' },
    { command: 'tool', enabled: 'true' }, { command: 'tool', transport: 'http' }]) {
    const message = request(undefined);
    const result = prepare(message, { mcp_servers: { invalid: server } });
    assert.equal(result.changed, false);
    assert.equal(result.message, message);
    assert.equal(result.unsupportedServers.length, 1);
  }
});

test('already wrapped servers are idempotent and unrecognized gateway recipes are never nested', () => {
  const first = prepare(request(undefined), { mcp_servers: { echo: { command: 'echo.exe', args: ['a'] } } });
  const second = prepare(first.message, {});
  assert.equal(second.message, first.message);
  assert.equal(second.changed, false);
  assert.equal(second.wrappedServers[0].alreadyWrapped, true);
  const message = request({ mcp_servers: { echo: { command: options.nodeExecutable, args: [options.gatewayFile, 'unknown'] } } });
  const invalid = prepare(message, {});
  assert.equal(invalid.message, message);
  assert.equal(invalid.unsupportedServers[0].reason, 'EXISTING_GATEWAY_CONFIGURATION_UNRECOGNIZED');
});

test('Windows batch files and unresolved bare commands never acquire an implicit shell', { skip: process.platform !== 'win32' }, () => {
  const message = request(undefined);
  const result = prepare(message, { mcp_servers: {
    batch: { command: 'C:\\Program Files\\nodejs\\npx.CMD', args: ['--package', 'fixture'] },
    bat: { command: 'fixture.bat' }, npx: { command: 'npx', args: ['fixture'] },
    uvx: { command: 'uvx', args: ['fixture'] }, exe: { command: 'uvx.exe', args: ['fixture'] },
  } });
  assert.deepEqual(result.unsupportedServers, [
    { serverName: 'batch', reason: 'BATCH_COMMAND_UNSUPPORTED' },
    { serverName: 'bat', reason: 'BATCH_COMMAND_UNSUPPORTED' },
    { serverName: 'npx', reason: 'BARE_COMMAND_UNRESOLVED' },
    { serverName: 'uvx', reason: 'BARE_COMMAND_UNRESOLVED' },
  ]);
  assert.deepEqual(result.wrappedServers.map(server => server.serverName), ['exe']);
  assert.deepEqual(result.message.params.config.mcp_servers.exe.args, gatewayArgs('exe', 'uvx.exe', ['fixture']));
});

test('non-lifecycle messages and an empty configuration retain exact request identity', () => {
  for (const message of [{ id: 1, method: 'turn/start', params: { input: [{ type: 'text', text: 'same' }] } }, request(undefined)]) {
    const result = prepare(message, {});
    assert.equal(result.message, message);
    assert.equal(result.changed, false);
  }
});
