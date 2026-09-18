import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ThreadStore } from '../lib/store.mjs';
import { writeNativeEvidence } from '../lib/native-evidence.mjs';
import { mcpCapabilityId } from './mcp-policy.mjs';
import { recordHookScope, readHookScope } from './hook-scope.mjs';
import { evaluateScopedToolPolicy, evaluateToolPolicyHook } from './tool-policy-hook.mjs';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const authority = { hostId: 'fixture', accountScope: 'isolated' };
const scope = threadId => ({ ...authority, threadId });
const input = (extra = {}) => ({ hook_event_name: 'PreToolUse', session_id: A, turn_id: 'turn-fixture',
  tool_use_id: 'tool-fixture', tool_name: 'mcp__fixture__constant', tool_input: { ignored: 'private fixture arguments' }, ...extra });
const notification = (threadId = A, extra = {}) => ({ method: 'hook/started', params: { threadId, turnId: 'turn-fixture',
  run: { eventName: 'preToolUse', displayOrder: 2, sourcePath: 'C:\\<session-flags>\\config.toml',
    id: 'pre-tool-use:2:C:\\<session-flags>\\config.toml:tool-fixture', ...extra } } });
const entry = (serverName = 'fixture', pluginKey = '') => ({ id: mcpCapabilityId(serverName, pluginKey), kind: 'mcp', name: serverName,
  ...(pluginKey ? { parentId: `plugin:${pluginKey}` } : {}), configMapping: pluginKey
    ? { kind: 'plugin-mcp-server', serverName, pluginKey } : { kind: 'mcp-server', serverName } });
const appEntry = (appId, namespace) => ({ id: `app:${appId}`, kind: 'app', name: namespace,
  configMapping: { kind: 'app', appId }, toolBindings: [{ serverName: 'codex_apps',
    toolName: `${namespace}.read`, hookToolName: `mcp__codex_apps__${namespace}__read` }] });
const denial = value => assert.equal(value?.hookSpecificOutput?.permissionDecision, 'deny');
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'threadbrief-policy-hook-'));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith('threadbrief-policy-hook-'));
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const config = { currentThreadBinding: path.join(root, 'binding.json'), dataDirectory: path.join(root, 'store'),
    nativeEvidenceDirectory: path.join(root, 'native-evidence'), evidenceDirectory: path.join(root, 'evidence') };
  await writeFile(config.currentThreadBinding, JSON.stringify(authority));
  const configFile = path.join(root, 'runtime.json'); await writeFile(configFile, JSON.stringify(config));
  const directory = path.join(config.evidenceDirectory, 'hook-scopes'), store = new ThreadStore(config.dataDirectory);
  const save = async (threadId, overrides) => store.save(scope(threadId), { expectedRevision: (await store.get(scope(threadId))).revision, persona: '', background: '', overrides });
  const evidence = async (threadId, catalog, observedAt = new Date().toISOString()) => writeNativeEvidence(config.nativeEvidenceDirectory, scope(threadId), { bridgePid: process.pid, observedAt, catalog });
  return { root, config, configFile, directory, store, save, evidence };
}

test('backend event correlation records only IDs and ignores parent session ancestry', async t => {
  const f = await fixture(t);
  const saved = await recordHookScope({ notification: notification(B), directory: f.directory, authority });
  assert.deepEqual(saved.scope, scope(B)); assert.equal(saved.toolUseId, 'tool-fixture');
  assert.deepEqual(Object.keys(saved).sort(), ['observedAt', 'schemaVersion', 'scope', 'toolUseId', 'turnId']);
  assert.equal((await readHookScope({ input: input({ agent_id: B }), directory: f.directory, authority })).scope.threadId, B);
  assert.equal((await readHookScope({ input: input(), directory: f.directory, authority })).scope.threadId, B, 'Fork/root identity comes from receipt, not session_id');
  assert.equal(await readHookScope({ input: input({ agent_id: A }), directory: f.directory, authority }), null);
  assert.equal(await readHookScope({ input: input({ agent_id: 'bad' }), directory: f.directory, authority }), null);
});

test('receipts reject conflicting scope, stale time, foreign authority and wrong run prefix', async t => {
  const f = await fixture(t), args = { directory: f.directory, authority };
  const saved = await recordHookScope({ ...args, notification: notification() });
  const repeated = await recordHookScope({ ...args, notification: notification() });
  assert.equal(repeated.observedAt, saved.observedAt);
  await assert.rejects(recordHookScope({ ...args, notification: notification(B) }), /ambiguous/u);
  assert.equal(await readHookScope({ ...args, input: input(), now: Date.parse(saved.observedAt) + 300001 }), null);
  assert.equal(await readHookScope({ ...args, input: input(), now: Date.parse(saved.observedAt) - 5001 }), null);
  assert.equal(await readHookScope({ ...args, authority: { ...authority, accountScope: 'other' }, input: input() }), null);
  assert.equal(await recordHookScope({ ...args, notification: notification(A, { id: 'pre-tool-use:0:wrong:tool-fixture' }) }), null);
  assert.equal(await recordHookScope({ ...args, notification: notification(A, { eventName: 'postToolUse' }) }), null);
});

test('receipt lookup tolerates notification write race and never falls back to session_id', async t => {
  const f = await fixture(t), args = { directory: f.directory, authority, input: input() };
  assert.equal(await readHookScope({ ...args, waitMs: 0 }), null);
  const writing = delay(50).then(() => recordHookScope({ directory: f.directory, authority, notification: notification(B) }));
  assert.equal((await readHookScope({ ...args, waitMs: 500 })).scope.threadId, B); await writing;
  assert.equal(await readHookScope({ ...args, input: input({ tool_use_id: 'different' }), waitMs: 0 }), null);
});

test('untouched, persona, skills, enabled Apps and non-MCP calls do not alter original permission flow', async t => {
  const f = await fixture(t);
  for (const overrides of [{}, { 'skill:fixture': 'off' }, { 'app:fixture': 'on' }, { [entry().id]: 'on' }]) {
    await f.save(A, overrides);
    assert.equal(await evaluateScopedToolPolicy({ scope: scope(A), toolName: input().tool_name, config: f.config,
      readEvidence: () => { throw new Error('Evidence should not be read'); } }), null);
  }
  assert.equal(await evaluateToolPolicyHook({ input: input({ tool_name: 'exec_command' }) }), null);
  assert.equal(await evaluateToolPolicyHook({ input: input({ hook_event_name: 'PostToolUse' }) }), null);
});

test('App off uses exact trusted bindings and stays isolated from another App and another task', async t => {
  const f = await fixture(t), appA = appEntry('connector_a', 'fixture_a'), appB = appEntry('connector_b', 'fixture_b');
  const catalog = [entry('codex_apps'), entry(), appA, appB];
  await f.evidence(A, catalog); await f.evidence(B, catalog);
  await f.save(A, { [appA.id]: 'off', [appB.id]: 'on' });
  const check = (threadId, app) => evaluateScopedToolPolicy({ scope: scope(threadId),
    toolName: app.toolBindings[0].hookToolName, config: f.config });
  const blocked = await check(A, appA); denial(blocked);
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /application is disabled/u);
  assert.equal(await check(A, appB), null);
  assert.equal(await check(B, appA), null);
  assert.equal(await evaluateScopedToolPolicy({ scope: scope(A), toolName: input().tool_name, config: f.config }), null);
});

test('explicit MCP calls map raw tool ownership using trusted server and exact raw name', async t => {
  const f = await fixture(t), appA = appEntry('connector_a', 'fixture_a'), appB = appEntry('connector_b', 'fixture_b');
  await f.evidence(A, [entry('codex_apps'), entry(), appA, appB]);
  await f.save(A, { [appA.id]: 'off' });
  const call = (server, tool) => evaluateScopedToolPolicy({ scope: scope(A), config: f.config,
    toolName: `mcp__${server}__${tool}`, mcpCall: { server, tool } });
  denial(await call('codex_apps', appA.toolBindings[0].toolName));
  assert.equal(await call('codex_apps', appB.toolBindings[0].toolName), null);
  assert.equal(await call('fixture', appA.toolBindings[0].toolName), null, 'Same raw name on another known server is not this App');
  denial(await call('codex_apps', `${appA.toolBindings[0].toolName}_other`));
});

test('codex_apps server off overrides an enabled App for canonical and explicit calls', async t => {
  const f = await fixture(t), appsServer = entry('codex_apps'), app = appEntry('connector_a', 'fixture_a');
  await f.evidence(A, [appsServer, app]);
  await f.save(A, { [appsServer.id]: 'off', [app.id]: 'on' });
  denial(await evaluateScopedToolPolicy({ scope: scope(A), toolName: app.toolBindings[0].hookToolName, config: f.config }));
  denial(await evaluateScopedToolPolicy({ scope: scope(A), toolName: `mcp__codex_apps__${app.toolBindings[0].toolName}`,
    mcpCall: { server: 'codex_apps', tool: app.toolBindings[0].toolName }, config: f.config }));
});

test('Apps without verified mappings deny unknown calls while known ordinary MCP remains usable', async t => {
  const f = await fixture(t), unmapped = { ...appEntry('connector_a', 'fixture_a'), toolBindings: [] };
  await f.evidence(A, [entry('codex_apps'), entry(), unmapped]);
  await f.save(A, { [unmapped.id]: 'off' });
  const check = toolName => evaluateScopedToolPolicy({ scope: scope(A), toolName, config: f.config });
  denial(await check('mcp__codex_apps__fixture_a__read'));
  denial(await check('mcp__unverified_namespace__read'));
  assert.equal(await check(input().tool_name), null);
  denial(await evaluateScopedToolPolicy({ scope: scope(A), toolName: input().tool_name, config: f.config,
    readEvidence: async () => ({ evidence: null }) }));
  assert.equal(await evaluateScopedToolPolicy({ scope: scope(B), toolName: input().tool_name, config: f.config,
    readEvidence: async () => { throw new Error('Untouched task needs no App evidence'); } }), null);
});

test('App off then on restores the policy no-op without mutating tool definitions or ownership', async t => {
  const f = await fixture(t), app = appEntry('connector_a', 'fixture_a');
  const catalog = [entry('codex_apps'), app], before = structuredClone(catalog);
  const tools = [{ name: app.toolBindings[0].toolName, inputSchema: { type: 'object', properties: {} } }];
  const toolsBefore = JSON.stringify(tools);
  const observed = { evidence: { scope: scope(A), catalog, tools } };
  let reads = 0;
  const check = () => evaluateScopedToolPolicy({ scope: scope(A), toolName: app.toolBindings[0].hookToolName, config: f.config,
    readEvidence: async () => { reads++; return observed; } });
  await f.save(A, { [app.id]: 'off' }); denial(await check());
  await f.save(A, { [app.id]: 'on' }); assert.equal(await check(), null);
  assert.equal(reads, 1, 'Reenabled task does not even read or rewrite tool definitions');
  assert.deepEqual(catalog, before); assert.equal(JSON.stringify(tools), toolsBefore);
});

test('ambiguous App tool ownership denies rather than guessing the enabled App', async t => {
  const f = await fixture(t), appA = appEntry('connector_a', 'fixture_a'), appB = appEntry('connector_b', 'fixture_a');
  await f.evidence(A, [entry('codex_apps'), appA, appB]);
  await f.save(A, { [appA.id]: 'on', [appB.id]: 'off' });
  denial(await evaluateScopedToolPolicy({ scope: scope(A), toolName: appA.toolBindings[0].hookToolName, config: f.config }));
});

test('missing aggregate MCP entry cannot bypass a saved codex_apps server off preference', async t => {
  const f = await fixture(t), app = appEntry('connector_a', 'fixture_a');
  await f.evidence(A, [app]);
  await f.save(A, { [entry('codex_apps').id]: 'off', [app.id]: 'on' });
  denial(await evaluateScopedToolPolicy({ scope: scope(A), toolName: app.toolBindings[0].hookToolName, config: f.config }));
});

test('MCP and plugin off affect only exact task and server, with plugin parent precedence', async t => {
  const f = await fixture(t), managed = entry('fixture', 'fixture@local');
  await f.evidence(A, [managed, entry('fixture_other')]); await f.evidence(B, [managed]);
  await f.save(A, { [managed.id]: 'on', 'plugin:fixture@local': 'off' });
  const check = (threadId, toolName = input().tool_name) => evaluateScopedToolPolicy({ scope: scope(threadId), toolName, config: f.config });
  denial(await check(A)); assert.equal(await check(B), null);
  assert.equal(await check(A, 'mcp__fixture_other__constant'), null);
  denial(await check(A, 'mcp__unknown_or_normalized__constant'));
  await f.save(A, { [managed.id]: 'off' }); denial(await check(A));
  await f.save(A, { [managed.id]: 'on' }); assert.equal(await check(A), null);
});

test('valid stale evidence keeps exact mapping while corrupt mapping only denies edited task', async t => {
  const f = await fixture(t), managed = entry();
  await f.evidence(A, [managed], '2020-01-01T00:00:00.000Z');
  await f.save(A, { [managed.id]: 'off' });
  denial(await evaluateScopedToolPolicy({ scope: scope(A), toolName: input().tool_name, config: f.config }));
  const invalid = async () => ({ live: false, evidence: { scope: scope(B), catalog: [managed] } });
  denial(await evaluateScopedToolPolicy({ scope: scope(A), toolName: input().tool_name, config: f.config, readEvidence: invalid }));
  assert.equal(await evaluateScopedToolPolicy({ scope: scope(B), toolName: input().tool_name, config: f.config, readEvidence: invalid }), null);
  denial(await evaluateScopedToolPolicy({ scope: scope(A), toolName: input().tool_name, config: f.config,
    store: { get: async () => { throw new Error('Corrupt card with private detail'); } } }));
});

test('ambiguous namespaces or mismatched catalog IDs are denied without guessing Apps', async t => {
  const f = await fixture(t), a = entry('a'), ab = entry('a__b');
  await f.save(A, { [a.id]: 'off' });
  for (const catalog of [[a, ab], [{ ...a, id: 'mcp:not-the-mapping' }]]) {
    denial(await evaluateScopedToolPolicy({ scope: scope(A), toolName: 'mcp__a__b__constant', config: f.config,
      readEvidence: async () => ({ evidence: { scope: scope(A), catalog } }) }));
  }
});

test('hook receipt selects child card even if parent is disabled and tool arguments spoof scope', async t => {
  const f = await fixture(t), managed = entry();
  await f.evidence(A, [managed]); await f.evidence(B, [managed]);
  await f.save(A, { [managed.id]: 'off' });
  await recordHookScope({ notification: notification(B), directory: f.directory, authority });
  const childInput = input({ agent_id: B, tool_input: { threadId: A, agent_id: A, session_id: A } });
  assert.equal(await evaluateToolPolicyHook({ input: childInput, config: f.config }), null);
  await f.save(B, { [managed.id]: 'off' }); denial(await evaluateToolPolicyHook({ input: childInput, config: f.config }));
  denial(await evaluateToolPolicyHook({ input: input(), config: f.config, readScope: async () => null }));
});

async function runHook(configFile, payload) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./tool-policy-hook.mjs', import.meta.url)), configFile], { windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Hook timed out')); }, 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  child.stdin.end(JSON.stringify(payload)); return closed;
}

test('CLI consumes full stdin, emits empty allow or native deny JSON, and never logs arguments', async t => {
  const f = await fixture(t), managed = entry();
  await recordHookScope({ notification: notification(), directory: f.directory, authority });
  const untouched = await runHook(f.configFile, input());
  assert.deepEqual(untouched, { code: 0, stdout: '', stderr: '' });
  await f.evidence(A, [managed]); await f.save(A, { [managed.id]: 'off' });
  const blocked = await runHook(f.configFile, input({ tool_input: { secret: 'NEVER_LOG_THIS_MARKER', large: 'x'.repeat(100000) } }));
  assert.equal(blocked.code, 0); assert.equal(blocked.stderr, ''); denial(JSON.parse(blocked.stdout));
  assert.equal(blocked.stdout.includes('NEVER_LOG_THIS_MARKER'), false);
  assert.deepEqual(await runHook(f.configFile, input({ tool_name: 'exec_command' })), { code: 0, stdout: '', stderr: '' });
});
