import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSkillTurn } from './skill-turn.mjs';

const scope = { hostId: 'local', accountScope: 'fixture', threadId: 'abc' };
const skill = { id: 'skill:fixture', kind: 'skill', name: 'Display name', configMapping: {
  kind: 'skill', path: 'C:\\fixture\\skills\\sample\\SKILL.md', skillName: 'canonical-name',
} };
const catalog = { scope, items: [skill] };
const profile = { revision: 2, overrides: { [skill.id]: 'on' } };
const message = () => ({ id: 9, method: 'turn/start', params: { threadId: scope.threadId,
  input: [{ type: 'text', text: 'Use this task configuration.' }], model: 'original-model',
  additionalContext: { owner: { kind: 'untrusted', value: 'host content' } }, approvalsReviewer: 'user',
} });

test('untouched, disabled and non-skill settings preserve original request and input identity', () => {
  for (const overrides of [{}, { [skill.id]: 'off' }, { 'mcp:fixture': 'on' }, { 'plugin:fixture': 'off' }]) {
    const original = message();
    const result = prepareSkillTurn({ message: original, profile: { ...profile, overrides }, scope, catalog });
    assert.equal(result.changed, false); assert.equal(result.message, original);
    assert.equal(result.message.params.input, original.params.input);
  }
});

test('uses exact native path and canonical name, preserves all original input and host fields', () => {
  const original = message(), result = prepareSkillTurn({ message: original, profile, scope, catalog });
  assert.equal(result.status, 'prepared'); assert.equal(result.changed, true);
  assert.deepEqual(result.message.params.input.at(-1), { type: 'skill', name: 'canonical-name', path: skill.configMapping.path });
  assert.equal(result.message.params.input[0], original.params.input[0]);
  assert.deepEqual({ ...result.message.params, input: original.params.input }, original.params);
  assert.equal(original.params.input.length, 1); assert.equal(result.revision, 2);
  assert.deepEqual(result.appendedCapabilities.map(item => item.id), [skill.id]);
});

test('repeated application and explicit equivalent Windows path are identity no-ops', () => {
  const once = prepareSkillTurn({ message: message(), profile, scope, catalog });
  assert.equal(prepareSkillTurn({ message: once.message, profile, scope, catalog }).message, once.message);
  const original = message();
  original.params.input.push({ type: 'skill', name: 'user alias', path: 'c:/FIXTURE/skills/sample/SKILL.md' });
  const result = prepareSkillTurn({ message: original, profile, scope, catalog });
  assert.equal(result.message, original); assert.equal(result.status, 'already-invoked');
});

test('off stops auto-invocation and never strips explicit skill input or rewrites history', () => {
  const original = message(); original.params.input.push({ type: 'skill', name: 'chosen', path: skill.configMapping.path });
  const result = prepareSkillTurn({ message: original, profile: { ...profile, overrides: { [skill.id]: 'off' } }, scope, catalog });
  assert.equal(result.message, original); assert.equal(result.integrationBoundary.historyRemoval, false);
  assert.equal(result.message.params.input.length, 2);
});

test('foreign scope, absent mapping and malformed inputs reject selected skill without altering request', () => {
  for (const patch of [
    { scope: { ...scope, threadId: 'other' } },
    { catalog: { ...catalog, scope: { ...scope, accountScope: 'another-account' } } },
    { catalog: undefined },
    { catalog: { scope, items: {} } },
    { catalog: { scope, items: [] } },
    { catalog: { scope, items: [skill, skill] } },
    { catalog: { scope, items: [{ ...skill, configMapping: { kind: 'skill', path: 'relative/SKILL.md', skillName: 'name' } }] } },
    { catalog: { scope, items: [{ ...skill, configMapping: { kind: 'skill', path: skill.configMapping.path } }] } },
    { message: { ...message(), params: { threadId: scope.threadId, input: null } } },
  ]) {
    const args = { message: message(), profile, scope, catalog, ...patch };
    const result = prepareSkillTurn(args);
    assert.equal(result.status, 'unsupported'); assert.equal(result.message, args.message);
    assert.deepEqual(result.unsupportedCapabilities.map(item => item.id), [skill.id]);
  }
});

test('host denial or disabled plugin prevents any partial additions', () => {
  const second = { ...skill, id: 'skill:second', configMapping: { kind: 'skill', path: '/fixture/second/SKILL.md', skillName: 'second' } };
  for (const denied of [{ ...skill, hostAllowed: false }, { ...skill, defaultEnabled: false }]) {
    const original = message();
    const result = prepareSkillTurn({ message: original, scope, catalog: { scope, items: [denied, second] },
      profile: { revision: 4, overrides: { [skill.id]: 'on', [second.id]: 'on', 'plugin:parent': 'off', 'mcp:other': 'on' } } });
    assert.equal(result.status, 'unsupported'); assert.equal(result.message, original);
    assert.equal(result.unsupportedCapabilities.length, 1); assert.deepEqual(result.appendedCapabilities, []);
  }
});

test('plugin off suppresses saved child skill choices without blocking unrelated turn input', () => {
  const original = message(), owned = { ...skill, parentId: 'plugin:parent' };
  const args = { message: original, scope, catalog: { scope, items: [owned] },
    profile: { revision: 3, overrides: { [skill.id]: 'on', 'plugin:parent': 'off' } } };
  const stopped = prepareSkillTurn(args);
  assert.equal(stopped.message, original);
  assert.deepEqual(stopped.unsupportedCapabilities, []);
  assert.equal(prepareSkillTurn({ ...args, profile: { ...args.profile, overrides: { [skill.id]: 'on', 'plugin:parent': 'on' } } }).changed, true);
});

test('stable skill ordering is independent of saved override key order and revision', () => {
  const second = { ...skill, id: 'skill:aaa', configMapping: { kind: 'skill', path: '/fixture/SKILL.md', skillName: 'other' } };
  const shared = { message: message(), scope, catalog: { scope, items: [skill, second] } };
  const a = prepareSkillTurn({ ...shared, profile: { revision: 8, overrides: { [skill.id]: 'on', [second.id]: 'on' } } });
  const b = prepareSkillTurn({ ...shared, profile: { revision: 9, overrides: { [second.id]: 'on', [skill.id]: 'on' } } });
  assert.deepEqual(a.message, b.message);
  assert.equal(a.message.params.input[1].name, 'other');
});
