import test from 'node:test';
import assert from 'node:assert/strict';
import { createSkillConfigBaseline } from './skill-config.mjs';
import { prepareCapabilityOverlay } from './capability-overlay.mjs';

const scope = { hostId: 'local', accountScope: 'fixture-account', threadId: '01a0af0e-b48d-7842-bbbc-dc205c337556' };
const cwd = 'C:\\fixture';
const target = 'C:\\skills\\target\\SKILL.md', sibling = 'C:\\skills\\sibling\\SKILL.md';
const skill = { id: 'skill:target', kind: 'skill', configMapping: { kind: 'skill', path: target, skillName: 'target' } };
const mcp = { id: 'mcp:fixture', kind: 'mcp', configMapping: { kind: 'mcp-server', serverName: 'fixture' } };
const request = config => ({ id: 1, method: 'thread/resume', params: { threadId: scope.threadId, cwd,
  ...(config === undefined ? {} : { config }), dynamicTools: [], opaqueRecipe: { preserve: 'yes' } } });
function response(entries = [], lower = []) {
  return { config: { skills: { config: structuredClone(entries), max_context_tokens: 1000 } }, origins: {},
    layers: [entries, ...lower].map((config, i) => ({ name: { type: i ? 'user' : 'sessionFlags' }, version: `v${i}`,
      config: { skills: { config: structuredClone(config) } }, disabledReason: null })) };
}
const baseline = (message, configRead = response(), extra = {}) => createSkillConfigBaseline({ scope, request: message, cwd, response: configRead, ...extra });
async function prepare(message, overrides, skillBaseline, extra = {}) {
  return prepareCapabilityOverlay({ message, store: { get: async () => ({ revision: 4, overrides }) },
    scopeForThread: () => scope, catalog: { scope, items: [skill, mcp] }, skillBaseline, ...extra });
}

test('empty overrides keep exact identity without baseline, and an untouched complete baseline does too', async () => {
  const original = request({ skills: { config: [{ path: target, enabled: false }] } });
  assert.equal((await prepare(original, {})).message, original);
  assert.equal((await prepare(original, { [skill.id]: 'off' }, baseline(original))).message, original);
  assert.equal((await prepare(original, {}, { status: 'ready', entries: [] })).message, original);
});

test('inherited complete array is copied, sibling selectors/settings and every host recipe field survive', async () => {
  const inherited = [{ path: sibling, enabled: false, futureMetadata: { retain: 7 } }, { name: 'other-name', enabled: true }];
  const original = request({ skills: { max_context_tokens: 999, include_instructions: false }, model_provider: 'fixture-provider' });
  const read = response(inherited), before = structuredClone(read);
  const token = baseline(original, read);
  // Source mutation after binding cannot silently change the captured baseline.
  read.config.skills.config[0].enabled = true;
  const result = await prepare(original, { [skill.id]: 'off', [mcp.id]: 'off' }, token);
  assert.deepEqual(result.message.params.config.skills, { max_context_tokens: 999, include_instructions: false,
    config: [...inherited, { path: target, enabled: false }] });
  assert.equal(result.message.params.config.mcp_servers.fixture.enabled, false);
  assert.deepEqual(result.message.params.config.skills.config[0], before.config.skills.config[0]);
  for (const [key, value] of Object.entries(original.params)) if (key !== 'config') assert.equal(result.message.params[key], value);
  assert.deepEqual(result.affectedCategories, ['mcp', 'skill']);
  assert.equal(result.integrationBoundary.capabilityEnforcement, false);
  assert.equal(result.prepared.status, 'prepared');
  assert.equal(result.deferredHotChange, true);
});

test('host array wins over inherited effective array and on/off/restore never modifies either baseline', async () => {
  const hostEntries = [{ path: target, enabled: false }, { path: sibling, enabled: false }];
  const original = request({ '"skills"."config"': hostEntries, 'skills.max_context_tokens': 555, future: { stable: true } });
  const before = structuredClone(original), token = baseline(original, response([{ path: 'C:\\disk\\SKILL.md', enabled: false }]));
  const on = await prepare(original, { [skill.id]: 'on' }, token);
  assert.deepEqual(on.message.params.config['"skills"."config"'], [{ path: target, enabled: true }, hostEntries[1]]);
  assert.equal(on.message.params.config['skills.max_context_tokens'], 555);
  assert.deepEqual(original, before);
  assert.equal((await prepare(original, { [skill.id]: 'off' }, token)).message, original);
  assert.equal((await prepare(original, {}, token)).message, original);
  assert.equal(on.message.params.config.future, original.params.config.future);
});

test('baseline is bound to complete original request identity, scope and trusted cwd', async () => {
  const original = request({}), token = baseline(original);
  const cloned = structuredClone(original);
  assert.equal((await prepare(cloned, { [skill.id]: 'off' }, token)).unsupportedCapabilities[0].reason, 'SKILL_BASELINE_BINDING_MISMATCH');
  original.id = 2;
  assert.equal((await prepare(original, { [skill.id]: 'off' }, token)).unsupportedCapabilities[0].reason, 'SKILL_BASELINE_BINDING_MISMATCH');
  const otherAccount = { ...scope, accountScope: 'other-account' }, second = request({});
  const accountResult = await prepare(second, { [skill.id]: 'off' }, baseline(second), { scopeForThread: () => otherAccount, catalog: { scope: otherAccount, items: [skill] } });
  assert.equal(accountResult.unsupportedCapabilities[0].reason, 'SKILL_BASELINE_BINDING_MISMATCH');
  const wrongCwd = baseline(second, response(), { cwd: 'C:\\different' });
  assert.equal(wrongCwd.reason, 'SKILL_BASELINE_CWD_MISMATCH');
});

test('missing/full-read failure never blocks independent safe deltas or fabricates acceptance', async () => {
  for (const source of [null, { config: { skills: { config: [] } }, origins: {} }, { error: { code: -1 }, result: response() }, { ...response(), layers: null }]) {
    const original = request({}), token = baseline(original, source);
    const result = await prepare(original, { [skill.id]: 'off', [mcp.id]: 'off' }, token);
    assert.equal(result.status, 'partial-prepared');
    assert.equal(result.message.params.config.skills, undefined);
    assert.equal(result.message.params.config.mcp_servers.fixture.enabled, false);
    assert.equal(result.prepared.capabilities.some(value => value.kind === 'skill'), false);
    assert.equal(result.unsupportedCapabilities[0].reason, 'SKILL_BASELINE_FULL_CONFIG_READ_REQUIRED');
  }
  const original = request({});
  assert.equal((await prepare(original, { [skill.id]: 'off' }, { type: 'threadbrief.skill-config-baseline', status: 'ready' })).message, original);
});

test('lower-layer name overlaps and duplicate target paths fail closed without changing non-target skills', async () => {
  for (const inherited of [
    response([], [[{ name: 'target', enabled: false }]]),
    response([{ path: target, enabled: false }, { path: target.toUpperCase(), enabled: true }]),
    response([{ path: 'C:\\skills\\target', enabled: false }]),
  ]) {
    const original = request({}), result = await prepare(original, { [skill.id]: 'on' }, baseline(original, inherited));
    assert.equal(result.message, original);
    assert.equal(result.unsupportedCapabilities.length, 1);
    assert.match(result.unsupportedCapabilities[0].reason, /SKILL_(?:NAME|PATH|DIRECTORY)_SELECTOR/u);
  }
  const original = request({}), unknownName = { ...skill, configMapping: { kind: 'skill', path: target } };
  const result = await prepare(original, { [skill.id]: 'on' }, baseline(original, response([{ name: 'any', enabled: false }])), { catalog: { scope, items: [unknownName] } });
  assert.equal(result.unsupportedCapabilities[0].reason, 'SKILL_NAME_SELECTOR_OVERLAP_UNSUPPORTED');
});

test('aliases/scalar skills config and malformed complete arrays are rejected instead of replacing host data', async () => {
  for (const config of [
    { skills: { config: [] }, 'skills.config': [] }, { skills: 'scalar' },
    { 'skills.config': { invalid: true } }, { 'skills.config.0': { enabled: true } },
    { 'skills.config': [{ path: target, enabled: 'false' }] },
    { 'skills.config': [{ name: 'target', path: target, enabled: true }] },
  ]) {
    const original = request(config), before = structuredClone(original);
    const result = await prepare(original, { [skill.id]: 'off' }, baseline(original));
    assert.equal(result.message, original);
    assert.equal(result.status, 'unsupported');
    assert.deepEqual(original, before);
  }
});

test('multiple skill deltas share one full array and compilation is stable without timestamps', async () => {
  const second = { id: 'skill:sibling', kind: 'skill', configMapping: { kind: 'skill', path: sibling, skillName: 'sibling' } };
  const original = request({ 'skills.max_context_tokens': 999 }), token = baseline(original);
  const args = { catalog: { scope, items: [skill, second] } };
  const one = await prepare(original, { [skill.id]: 'off', [second.id]: 'on' }, token, args);
  const two = await prepare(original, { [skill.id]: 'off', [second.id]: 'on' }, token, args);
  assert.deepEqual(one.message.params.config['skills.config'], [{ path: sibling, enabled: true }, { path: target, enabled: false }]);
  assert.equal(one.prepared.configHash, two.prepared.configHash);
  assert.deepEqual(one.affectedCategories, ['skill']);
  assert.equal(one.prepared.capabilities.length, 2);
  assert.equal(one.prepared.applied, undefined);
});
