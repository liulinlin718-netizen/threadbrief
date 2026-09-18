import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { stableSerialize } from '../lib/host-contract.mjs';
import { prepareToolPolicyHookArgs, prepareToolPolicyTrust } from './tool-policy-registration.mjs';

const paths = { nodeExecutable: 'F:\\node.exe', hookFile: "D:\\Thread's Brief\\tool-policy-hook.mjs", runtimeConfigFile: 'D:\\Thread Brief\\runtime-config.json' };
const register = args => prepareToolPolicyHookArgs({ args, ...paths });
const registration = register(['app-server']);
const key = 'C:\\<session-flags>\\config.toml:pre_tool_use:0:0';
const hook = extra => ({ key, eventName: 'preToolUse', handlerType: 'command', command: registration.command,
  source: 'sessionFlags', currentHash: registration.expectedHash, matcher: registration.matcher,
  async: false, timeoutSec: 5, ...extra });
const inventory = hooks => ({ data: [{ cwd: 'D:\\project', hooks: hooks ?? [hook()] }] });
const request = (config, method = 'thread/resume') => ({ id: 42, method, params: { threadId: 'fixture',
  model: 'host-model', sandbox: 'read-only', approvalPolicy: 'on-request', input: ['original'],
  developerInstructions: 'keep host instruction', config } });
const trust = (message, inv = inventory(), reg = registration) => prepareToolPolicyTrust({ message, inventory: inv, registration: reg });
const quoted = parts => parts.map(part => /^[A-Za-z0-9_-]+$/u.test(part) ? part : JSON.stringify(part)).join('.');

test('registration appends no files, preserves original argv and quotes the three command arguments', () => {
  const args = ['--config', 'model="host-model"', 'app-server', '--listen', 'stdio://'];
  const result = register(args);
  assert.equal(result.enabled, true);
  assert.deepEqual(result.args.slice(2), args);
  assert.equal(result.args[0], '-c');
  assert.match(result.args[1], /^hooks\.PreToolUse=\[\{matcher="mcp__\.\*",hooks=\[/u);
  assert.match(result.args[1], /timeout=5/u);
  if (process.platform === 'win32') {
    assert.equal(result.command, "& 'F:\\node.exe' 'D:\\Thread''s Brief\\tool-policy-hook.mjs' 'D:\\Thread Brief\\runtime-config.json'");
  } else assert.match(result.command, /Thread'"'"'s Brief/u);
  assert.equal(result.expectedHash, `sha256:${createHash('sha256').update(stableSerialize({
    event_name: 'pre_tool_use', hooks: [{ async: false, command: result.command, timeout: 5, type: 'command' }], matcher: 'mcp__.*',
  })).digest('hex')}`);
});

test('same-layer CLI hook definitions are never replaced in split, joined or quoted forms', () => {
  for (const args of [
    ['-c', 'hooks.PreToolUse=[]', 'app-server'], ['app-server', '--config', 'hooks = {}'],
    ['--config=hooks."PreToolUse"=[]', 'app-server'], ["-chooks.'PreToolUse'=[]", 'app-server'],
    ['-c="hooks"."PreToolUse"=[]', 'app-server'], ['-c', '"hooks"={state={}}', 'app-server'],
  ]) {
    const result = register(args);
    assert.equal(result.enabled, false);
    assert.equal(result.args, args);
    assert.equal(result.reason, 'CLI_HOOK_DEFINITION_CONFLICT');
  }
});

test('unrelated hook events and hook state flags coexist, malformed config paths fail conservatively', () => {
  assert.equal(register(['-c', 'hooks.PostToolUse=[]', '-c', 'hooks.state={}', 'app-server']).enabled, true);
  assert.equal(register(['-c', '"hooks.PreToolUse"="literal unrelated key"', 'app-server']).enabled, true);
  for (const args of [['-c'], ['--config'], ['-c', 'hooks."broken=[]'], ['-c', 'missing-equals']]) {
    assert.equal(register(args).enabled, false);
  }
  assert.equal(prepareToolPolicyHookArgs({ args: ['app-server'], ...paths, hookFile: 'bad\npath' }).enabled, false);
});

test('natural start, resume and fork add only exact own hook state while preserving request fields', () => {
  for (const method of ['thread/start', 'thread/resume', 'thread/fork']) {
    const message = request({ unrelated: { keep: true } }, method);
    const before = JSON.stringify(message);
    const result = trust(message);
    assert.equal(result.ready, true);
    assert.equal(result.changed, true);
    assert.equal(result.key, key);
    assert.equal(JSON.stringify(message), before);
    assert.deepEqual({ ...result.message.params, config: undefined }, { ...message.params, config: undefined });
    assert.deepEqual(result.message.params.config, { unrelated: { keep: true }, 'hooks.state': {
      [key]: { enabled: true, trusted_hash: registration.expectedHash },
    } });
  }
});

test('nested existing state keeps every unrelated hook and own additional field', () => {
  const config = { hooks: { state: { other: { enabled: false, trusted_hash: 'keep' }, [key]: { note: 'keep own extra' } } } };
  const result = trust(request(config));
  assert.deepEqual(result.message.params.config, { 'hooks.state': {
    other: config.hooks.state.other, [key]: { note: 'keep own extra', enabled: true, trusted_hash: registration.expectedHash },
  } });
  assert.equal(result.message.params.config['hooks.state'].other, config.hooks.state.other);
});

test('nested, whole-state and quoted dotted forms normalize into one complete hooks.state table', () => {
  const whole = trust(request({ 'hooks.state': { other: { enabled: false } } }));
  assert.deepEqual(whole.message.params.config, { 'hooks.state': { other: { enabled: false }, [key]: { enabled: true, trusted_hash: registration.expectedHash } } });
  const enabledKey = quoted(['hooks', 'state', key, 'enabled']);
  const message = request({ [enabledKey]: true, 'hooks.state.other.enabled': false });
  const leaf = trust(message);
  assert.deepEqual(leaf.message.params.config, { 'hooks.state': { [key]: { enabled: true, trusted_hash: registration.expectedHash }, other: { enabled: false } } });
  const containerKey = quoted(['hooks', 'state', key]);
  const container = trust(request({ [containerKey]: { enabled: true } }));
  assert.deepEqual(container.message.params.config, { 'hooks.state': { [key]: { enabled: true, trusted_hash: registration.expectedHash } } });
  const alias = trust(request({ hooks: { state: { first: { enabled: false } } },
    '"hooks"."state"': { second: { trusted_hash: 'keep' } }, [enabledKey]: true, unrelated: { same: 'value' } }));
  assert.deepEqual(alias.message.params.config, { unrelated: { same: 'value' }, 'hooks.state': {
    first: { enabled: false }, second: { trusted_hash: 'keep' }, [key]: { enabled: true, trusted_hash: registration.expectedHash },
  } });
});

test('already matching own trust is ready without changing message identity', () => {
  const first = trust(request(undefined));
  const second = trust(first.message);
  assert.equal(second.ready, true);
  assert.equal(second.changed, false);
  assert.equal(second.message, first.message);
});

test('trust requires the exact backend-observed identity and normalized current hash', () => {
  for (const extra of [{ command: 'different' }, { matcher: '.*' }, { source: 'user' }, { eventName: 'postToolUse' },
    { handlerType: 'mcpTool' }, { currentHash: `sha256:${'0'.repeat(64)}` }, { currentHash: 'invalid' },
    { async: true }, { timeoutSec: 10 }, { key: '__proto__' }]) {
    const message = request(undefined);
    const result = trust(message, inventory([hook(extra)]));
    assert.equal(result.ready, false, JSON.stringify(extra));
    assert.equal(result.changed, false);
    assert.equal(result.message, message);
  }
});

test('duplicate cwd observations deduplicate one key, while different own keys remain ambiguous', () => {
  const duplicate = { data: [{ hooks: [hook()] }, { hooks: [hook()] }] };
  assert.equal(trust(request(undefined), duplicate).ready, true);
  assert.equal(trust(request(undefined), inventory([hook(), hook({ key: `${key}-second` })])).reason, 'HOOK_IDENTITY_AMBIGUOUS');
  assert.equal(trust(request(undefined), inventory([hook(), hook({ currentHash: `sha256:${'f'.repeat(64)}` })])).reason, 'HOOK_IDENTITY_MISMATCH');
});

test('an unrelated matching command from another source is never trusted', () => {
  const result = trust(request(undefined), inventory([hook({ source: 'plugin', key: 'other' }), hook()]));
  assert.equal(result.ready, true);
  assert.deepEqual(Object.keys(result.message.params.config['hooks.state']), [key]);
});

test('thread hook definitions and ambiguous state aliases are not overwritten', () => {
  for (const config of [{ 'hooks.PreToolUse': [] }, { '"hooks"."PreToolUse"': [] },
    { hooks: { PreToolUse: [] } }, { hooks: { PostToolUse: [] } }, { hooks: null }]) {
    const message = request(config);
    const result = trust(message);
    assert.equal(result.reason, 'HOST_HOOK_DEFINITION_CONFLICT');
    assert.equal(result.message, message);
  }
  const alias = request({ hooks: { state: { [key]: { enabled: false } } }, [quoted(['hooks', 'state', key, 'enabled'])]: true });
  assert.equal(trust(alias).reason, 'HOOK_STATE_ALIAS_CONFLICT');
  assert.equal(trust(request({ 'hooks.state': [] })).reason, 'HOOK_STATE_ANCESTOR_CONFLICT');
});

test('missing registration, malformed inventory and non-lifecycle requests do not claim readiness', () => {
  const message = request(undefined);
  for (const reg of [{ ...registration, enabled: false }, { ...registration, expectedHash: 'bad' }]) {
    assert.equal(trust(message, inventory(), reg).ready, false);
  }
  assert.equal(prepareToolPolicyTrust({ message, inventory: inventory() }).reason, 'HOOK_NOT_REGISTERED');
  for (const inv of [null, {}, { data: [{}] }, inventory([])]) assert.equal(trust(message, inv).ready, false);
  const turn = { id: 1, method: 'turn/start', params: { input: [{ type: 'text', text: 'unchanged' }] } };
  assert.equal(trust(turn).message, turn);
  assert.equal(trust(turn).ready, false);
});

const promptHookFile = "D:\\Thread's Brief\\child-profile-hook.mjs";
const registerBoth = (args = ['app-server']) => prepareToolPolicyHookArgs({ args, ...paths, promptHookFile });
const promptKey = 'C:\\<session-flags>\\config.toml:user_prompt_submit:0:0';
const promptMetadata = (reg, extra = {}) => ({ key: promptKey, eventName: 'userPromptSubmit', handlerType: 'command',
  command: reg.promptHook.command, source: 'sessionFlags', sourcePath: 'C:\\<session-flags>\\config.toml',
  matcher: null, currentHash: reg.promptHook.expectedHash, async: false, timeoutSec: 5, additionalContextLimit: 0, ...extra });

test('optional prompt hook adds a matcher-free definition and the exact normalized event hash', () => {
  const reg = registerBoth();
  assert.equal(reg.enabled, true);
  assert.equal(reg.command, registration.command);
  assert.equal(reg.expectedHash, registration.expectedHash);
  assert.deepEqual(reg.args.slice(4), ['app-server']);
  assert.equal(reg.args[2], '-c');
  assert.match(reg.args[3], /^hooks\.UserPromptSubmit=\[\{hooks=/u);
  assert.doesNotMatch(reg.args[3], /matcher/u);
  assert.match(reg.args[3], /additionalContextLimit=0/u);
  assert.doesNotMatch(reg.args[1], /additionalContextLimit/u);
  assert.equal(reg.promptHook.enabled, true);
  assert.equal(reg.promptHook.eventName, 'userPromptSubmit');
  assert.equal(reg.promptHook.matcher, null);
  assert.equal(reg.promptHook.additionalContextLimit, 0);
  assert.equal(reg.promptHook.expectedHash, `sha256:${createHash('sha256').update(stableSerialize({
    event_name: 'user_prompt_submit', hooks: [{ additionalContextLimit: 0, async: false, command: reg.promptHook.command, timeout: 5, type: 'command' }],
  })).digest('hex')}`);
  assert.equal(Object.hasOwn(registration, 'promptHook'), false);
});

test('CLI UserPromptSubmit conflicts disable only the prompt route and leave original arguments untouched', () => {
  for (const args of [['-c', 'hooks.UserPromptSubmit=[]', 'app-server'],
    ['--config=hooks."UserPromptSubmit"=[]', 'app-server'], ["-chooks.'UserPromptSubmit'=[]", 'app-server']]) {
    const reg = registerBoth(args);
    assert.equal(reg.enabled, true);
    assert.equal(reg.promptHook.enabled, false);
    assert.equal(reg.promptHook.reason, 'CLI_PROMPT_HOOK_DEFINITION_CONFLICT');
    assert.deepEqual(reg.args.slice(2), args);
    assert.equal(reg.command, registration.command);
    const accepted = trust(request(undefined), inventory(), reg);
    assert.equal(accepted.ready, true);
    assert.deepEqual(accepted.ownHookKeys, [key]);
  }
  const invalid = prepareToolPolicyHookArgs({ args: ['app-server'], ...paths, promptHookFile: 'bad\npath' });
  assert.equal(invalid.enabled, true);
  assert.equal(invalid.promptHook.enabled, false);
});

test('both observed own hooks are trusted atomically in one table with user state preserved', () => {
  const reg = registerBoth(), inv = inventory([hook(), promptMetadata(reg)]);
  const message = request({ 'hooks.state': { existingUserHook: { enabled: true, trusted_hash: 'preserved' } }, other: { untouched: true } });
  const before = JSON.stringify(message);
  const result = trust(message, inv, reg);
  assert.equal(result.ready, true);
  assert.equal(result.key, key);
  assert.deepEqual(result.ownHookKeys, [key, promptKey]);
  assert.deepEqual(result.ownHooks.map(({ key, eventName, matcher }) => ({ key, eventName, matcher })), [
    { key, eventName: 'preToolUse', matcher: 'mcp__.*' }, { key: promptKey, eventName: 'userPromptSubmit', matcher: null },
  ]);
  assert.equal(result.ownHooks[1].sourcePath, 'C:\\<session-flags>\\config.toml');
  assert.equal(result.ownHooks[1].additionalContextLimit, 0);
  assert.deepEqual(result.message.params.config, { other: message.params.config.other, 'hooks.state': {
    existingUserHook: { enabled: true, trusted_hash: 'preserved' },
    [key]: { enabled: true, trusted_hash: reg.expectedHash },
    [promptKey]: { enabled: true, trusted_hash: reg.promptHook.expectedHash },
  } });
  assert.equal(JSON.stringify(message), before);
  const again = trust(result.message, inv, reg);
  assert.equal(again.ready, true);
  assert.equal(again.changed, false);
  assert.equal(again.message, result.message);
});

test('a missing or mismatched configured prompt hook cannot yield partial trust readiness', () => {
  const reg = registerBoth();
  for (const hooks of [[hook()], [hook(), promptMetadata(reg, { currentHash: `sha256:${'a'.repeat(64)}` })],
    [hook(), promptMetadata(reg, { source: 'user' })], [hook(), promptMetadata(reg, { matcher: '.*' })],
    [hook(), promptMetadata(reg, { async: true })]]) {
    const message = request(undefined), result = trust(message, inventory(hooks), reg);
    assert.equal(result.ready, false);
    assert.equal(result.changed, false);
    assert.equal(result.message, message);
  }
});

test('duplicate prompt observations deduplicate, different keys or cross-event key reuse reject', () => {
  const reg = registerBoth();
  assert.equal(trust(request(undefined), inventory([hook(), promptMetadata(reg), promptMetadata(reg)]), reg).ready, true);
  for (const hooks of [[hook(), promptMetadata(reg), promptMetadata(reg, { key: `${promptKey}-other` })],
    [hook(), promptMetadata(reg, { key })]]) {
    assert.equal(trust(request(undefined), inventory(hooks), reg).reason, 'HOOK_IDENTITY_AMBIGUOUS');
  }
});

test('host thread prompt definitions are never replaced by automatic trust', () => {
  const reg = registerBoth();
  for (const config of [{ 'hooks.UserPromptSubmit': [] }, { hooks: { UserPromptSubmit: [] } }]) {
    const message = request(config), result = trust(message, inventory([hook(), promptMetadata(reg)]), reg);
    assert.equal(result.ready, false);
    assert.equal(result.reason, 'HOST_HOOK_DEFINITION_CONFLICT');
    assert.equal(result.message, message);
  }
});

test('prompt trust requires the observed unlimited-context setting, not a missing or smaller limit', () => {
  const reg = registerBoth();
  for (const additionalContextLimit of [undefined, null, 1, 2500, '0']) {
    const message = request(undefined);
    const result = trust(message, inventory([hook(), promptMetadata(reg, { additionalContextLimit })]), reg);
    assert.equal(result.ready, false);
    assert.equal(result.message, message);
    assert.equal(result.reason, 'HOOK_IDENTITY_MISMATCH');
  }
  const invalid = { ...reg, promptHook: { ...reg.promptHook, additionalContextLimit: 2500 } };
  assert.equal(trust(request(undefined), inventory([hook(), promptMetadata(reg)]), invalid).reason, 'PROMPT_HOOK_REGISTRATION_INVALID');
});
