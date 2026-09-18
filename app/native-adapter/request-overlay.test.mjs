import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThreadStore } from '../lib/store.mjs';
import { prepareTurn, createAcceptedReceipt } from './request-overlay.mjs';
import { createHash } from 'node:crypto';
import { stableSerialize } from '../lib/host-contract.mjs';

const scope = { hostId: 'local', accountScope: 'trusted-account', threadId: 'child-A' };
const map = threadId => threadId === scope.threadId ? { ...scope } : undefined;
const profile = (expectedRevision, persona = '', background = '', overrides = {}) => ({ expectedRevision, persona, background, overrides });
const message = (threadId = scope.threadId) => ({
  id: 17, method: 'turn/start',
  params: {
    threadId, input: [{ type: 'text', text: 'Original request' }],
    additionalContext: { original: { kind: 'application', value: 'Host context' } },
    model: 'unchanged', effort: 'high', toolOutput: { source: 'original' },
  },
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'threadbrief-overlay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new ThreadStore(join(root, 'data')) };
}
function accepted(prepared) {
  return createAcceptedReceipt({ prepared, response: { id: prepared.requestId, result: { turn: { id: 'turn-real-response', status: 'inProgress', items: [], error: null } } } });
}

test('untouched configuration preserves exact object identity and context and creates no files', async t => {
  const { root, store } = await fixture(t);
  const original = message();
  const before = JSON.stringify(original);
  const result = await prepareTurn({ message: original, store, scopeForThread: map });
  assert.equal(result.message, original);
  assert.equal(result.message.params.additionalContext, original.params.additionalContext);
  assert.equal(result.changed, false);
  assert.equal(result.prepared, undefined);
  assert.equal(JSON.stringify(original), before);
  assert.deepEqual(await readdir(root), []);
});

test('other methods and unknown threads never read configuration or alter requests', async () => {
  let reads = 0;
  const store = { get: async () => { reads += 1; throw new Error('must not read'); } };
  for (const original of [{ id: 1, method: 'initialize', params: {} }, message('unknown'), { id: 2, method: 'turn/start', params: {} }]) {
    const result = await prepareTurn({ message: original, store, scopeForThread: map });
    assert.equal(result.message, original);
    assert.equal(result.changed, false);
  }
  assert.equal(reads, 0);
});

test('overlay adds only an untrusted source and preserves existing fields and input references', async t => {
  const { store } = await fixture(t);
  await store.save(scope, profile(0, 'Careful reviewer', 'This project is a local desktop tool.'));
  const original = message();
  const result = await prepareTurn({ message: original, store, scopeForThread: map });
  assert.equal(result.status, 'prepared');
  assert.equal(result.changed, true);
  assert.equal(result.message.params.input, original.params.input);
  assert.equal(result.message.params.toolOutput, original.params.toolOutput);
  assert.equal(result.message.params.model, original.params.model);
  assert.equal(result.message.params.additionalContext.original, original.params.additionalContext.original);
  assert.equal(original.params.additionalContext.threadbrief, undefined);
  assert.equal(result.message.params.additionalContext.threadbrief.kind, 'untrusted');
  const context = JSON.parse(result.message.params.additionalContext.threadbrief.value);
  assert.equal(context.role, 'user');
  assert.match(context.content, /Careful reviewer/u);
  assert.deepEqual(await store.observations(scope), []);
  assert.equal(result.integrationBoundary.forkHistoryIsolation, 'unverified');
  assert.equal(result.integrationBoundary.modelConsumption, 'unverified');
});

test('identity is resolved only by trusted scope mapping and stays isolated by thread and account', async t => {
  const { store } = await fixture(t);
  await store.save(scope, profile(0, 'Only A'));
  const original = message();
  original.params.accountScope = 'attacker-account';
  original.params.scope = { ...scope, accountScope: 'attacker-account' };
  original.params.acceptedReceipt = { status: 'applied' };
  const result = await prepareTurn({ message: original, store, scopeForThread: map });
  assert.equal(result.prepared.scope.accountScope, 'trusted-account');
  const sibling = message('child-B');
  assert.equal((await prepareTurn({ message: sibling, store, scopeForThread: threadId => ({ ...scope, threadId }) })).message, sibling);
  const otherAccount = message();
  assert.equal((await prepareTurn({ message: otherAccount, store, scopeForThread: threadId => ({ ...scope, threadId, accountScope: 'different' }) })).message, otherAccount);
  const mismatched = await prepareTurn({ message: original, store, scopeForThread: () => ({ ...scope, threadId: 'child-B' }) });
  assert.equal(mismatched.status, 'unsupported');
  assert.equal(mismatched.reason, 'SCOPE_BINDING_INVALID');
});

test('same source is never overwritten and empty configuration does not inspect or remove it', async t => {
  const { store } = await fixture(t);
  const original = message();
  original.params.additionalContext.threadbrief = { kind: 'application', value: 'Another owner' };
  assert.equal((await prepareTurn({ message: original, store, scopeForThread: map })).message, original);
  await store.save(scope, profile(0, 'Reviewer'));
  const result = await prepareTurn({ message: original, store, scopeForThread: map });
  assert.equal(result.message, original);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.reason, 'CONTEXT_SOURCE_CONFLICT');
});

test('successive real turns use deterministic content even after a transport acceptance receipt', async t => {
  const { store } = await fixture(t);
  await store.save(scope, profile(0, 'Reviewer', 'Stable background'));
  const first = await prepareTurn({ message: message(), store, scopeForThread: map });
  const receipt = accepted(first.prepared);
  const next = { ...message(), id: 'next-request' };
  const second = await prepareTurn({ message: next, store, scopeForThread: map, acceptedReceipt: JSON.parse(JSON.stringify(receipt)) });
  assert.equal(second.changed, true);
  assert.equal(first.message.params.additionalContext.threadbrief.value, second.message.params.additionalContext.threadbrief.value);
  assert.equal(first.prepared.compiledHash, second.prepared.compiledHash);
  assert.equal(second.prepared.status, 'prepared');
  assert.equal(receipt.status, 'app-server-accepted');
  assert.equal(Object.hasOwn(receipt, 'applied'), false);
  assert.equal(Object.hasOwn(receipt, 'modelConsumed'), false);
});

test('restoring empty text requires same-thread accepted evidence to emit a reset', async t => {
  const { store } = await fixture(t);
  await store.save(scope, profile(0, 'Reviewer'));
  const first = await prepareTurn({ message: message(), store, scopeForThread: map });
  const receipt = accepted(first.prepared);
  await store.save(scope, profile(1));
  const original = message();
  assert.equal((await prepareTurn({ message: original, store, scopeForThread: map })).message, original);
  const reset = await prepareTurn({ message: original, store, scopeForThread: map, acceptedReceipt: receipt });
  assert.equal(reset.prepared.mode, 'reset');
  assert.match(reset.prepared.context.content, /does not undo past actions/u);
  const afterReset = await prepareTurn({ message: original, store, scopeForThread: map, acceptedReceipt: accepted(reset.prepared) });
  assert.equal(afterReset.message, original);
  const foreign = await prepareTurn({ message: original, store, scopeForThread: map, acceptedReceipt: { ...receipt, scope: { ...scope, threadId: 'parent' } } });
  assert.equal(foreign.status, 'unsupported');
  assert.equal(foreign.message, original);
  const fakePrepared = await prepareTurn({ message: original, store, scopeForThread: map, acceptedReceipt: first.prepared });
  assert.equal(fakePrepared.status, 'unsupported');
});

test('server acceptance requires a real prepared object and a matching successful response', async t => {
  const { store } = await fixture(t);
  await store.save(scope, profile(0, 'Reviewer'));
  const { prepared } = await prepareTurn({ message: message(), store, scopeForThread: map });
  assert.throws(() => createAcceptedReceipt({ prepared, response: { id: prepared.requestId, error: { message: 'denied' } } }), { code: 'ACCEPTED_RECEIPT_INVALID' });
  assert.throws(() => createAcceptedReceipt({ prepared, response: { id: 'different', result: { turn: { id: 'turn' } } } }), { code: 'ACCEPTED_RECEIPT_INVALID' });
  assert.throws(() => accepted({ ...prepared }), { code: 'ACCEPTED_RECEIPT_INVALID' });
  assert.throws(() => createAcceptedReceipt({ prepared, response: { id: prepared.requestId, result: { turn: { id: 'turn', status: 'failed' } } } }), { code: 'ACCEPTED_RECEIPT_INVALID' });
});

test('unsupported capability toggles remain explicit without blocking independent persona preparation', async t => {
  const { store } = await fixture(t);
  await store.save(scope, profile(0, '', '', { 'skill:review': 'on', 'plugin:other': 'off' }));
  const original = message();
  const onlyCapabilities = await prepareTurn({ message: original, store, scopeForThread: map });
  assert.equal(onlyCapabilities.message, original);
  assert.equal(onlyCapabilities.status, 'unsupported-capabilities');
  assert.equal(onlyCapabilities.unsupportedCapabilities.length, 2);
  assert.equal(onlyCapabilities.integrationBoundary.capabilityEnforcement, false);
  await store.save(scope, profile(1, 'Independent persona', '', { 'skill:review': 'on', 'plugin:other': 'off' }));
  const partial = await prepareTurn({ message: original, store, scopeForThread: map });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.changed, true);
  assert.equal(partial.unsupportedCapabilities.length, 2);
  assert.doesNotMatch(partial.prepared.context.content, /skill:review|plugin:other/u);
  const payload = JSON.parse(partial.prepared.context.content.slice(partial.prepared.context.content.indexOf('\n') + 1));
  assert.deepEqual(payload.overrides, {});
  assert.deepEqual(payload.capabilityChanges, []);
  assert.equal((await store.get(scope)).overrides['skill:review'], 'on');
});

test('capability-only edits and content restoration keep unchanged persona context bytes', async t => {
  const { store } = await fixture(t);
  await store.save(scope, profile(0, 'Stable persona', 'Stable background'));
  const first = await prepareTurn({ message: message(), store, scopeForThread: map });
  await store.save(scope, profile(1, 'Stable persona', 'Stable background', { 'mcp:notes': 'off' }));
  const second = await prepareTurn({ message: message(), store, scopeForThread: map, acceptedReceipt: accepted(first.prepared) });
  assert.equal(second.prepared.revision, 2);
  assert.equal(second.message.params.additionalContext.threadbrief.value, first.message.params.additionalContext.threadbrief.value);
  assert.equal(second.prepared.compiledHash, first.prepared.compiledHash);
  await store.save(scope, profile(2, 'Temporary persona', 'Stable background'));
  await store.rollback(scope, { expectedRevision: 3, targetRevision: 1 });
  const restored = await prepareTurn({ message: message(), store, scopeForThread: map, acceptedReceipt: accepted(second.prepared) });
  assert.equal(restored.prepared.revision, 4);
  assert.equal(restored.prepared.compiledHash, first.prepared.compiledHash);
});

test('an accepted legacy revision remains byte-identical before the next saved revision', async t => {
  const { store } = await fixture(t);
  await store.save(scope, profile(0, 'Existing profile'));
  const first = await prepareTurn({ message: message(), store, scopeForThread: map });
  const context = JSON.parse(first.message.params.additionalContext.threadbrief.value);
  const split = context.content.indexOf('\n');
  const payload = { ...JSON.parse(context.content.slice(split + 1)), version: 1, revision: 1 };
  context.content = context.content.slice(0, split + 1) + stableSerialize(payload);
  const legacyValue = stableSerialize(context);
  const legacyReceipt = { ...accepted(first.prepared), compiledHash: createHash('sha256').update(legacyValue).digest('hex') };
  const unchanged = await prepareTurn({ message: message(), store, scopeForThread: map, acceptedReceipt: legacyReceipt });
  assert.equal(unchanged.message.params.additionalContext.threadbrief.value, legacyValue);
  await store.save(scope, profile(1, 'Existing profile', '', { 'mcp:notes': 'off' }));
  const migrated = await prepareTurn({ message: message(), store, scopeForThread: map, acceptedReceipt: legacyReceipt });
  assert.equal(migrated.message.params.additionalContext.threadbrief.value, first.message.params.additionalContext.threadbrief.value);
});
