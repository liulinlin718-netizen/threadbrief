import { createHash } from 'node:crypto';
import { stableSerialize } from '../lib/host-contract.mjs';

const SOURCE_KEY = 'threadbrief';
const RECEIPT_TYPE = 'threadbrief.app-server-accepted';
const preparedPlans = new WeakSet();
const boundary = Object.freeze({
  requestScopedContext: true,
  capabilityEnforcement: false,
  forkHistoryIsolation: 'unverified',
  modelConsumption: 'unverified',
});

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function validId(value) {
  return (typeof value === 'string' && value.length > 0 && value.length <= 512)
    || (Number.isSafeInteger(value) && value >= 0);
}

function normalizeScope(value) {
  if (!record(value)) return null;
  const scope = {};
  for (const key of ['hostId', 'accountScope', 'threadId']) {
    if (typeof value[key] !== 'string') return null;
    scope[key] = value[key].trim().normalize('NFC');
    if (!scope[key] || scope[key].length > 512 || /[\u0000-\u001f\u007f]/u.test(scope[key])) return null;
  }
  return scope;
}

function validProfile(profile) {
  return record(profile) && Number.isSafeInteger(profile.revision) && profile.revision >= 0
    && typeof profile.persona === 'string' && profile.persona.length <= 8000
    && typeof profile.background === 'string' && profile.background.length <= 24000
    && record(profile.overrides) && Object.values(profile.overrides).every(mode => mode === 'on' || mode === 'off');
}

function acceptedForScope(receipt, scope, revision) {
  if (!record(receipt) || receipt.type !== RECEIPT_TYPE || receipt.version !== 1
    || receipt.status !== 'app-server-accepted' || receipt.evidence !== 'turn/start.result'
    || !['overlay', 'reset'].includes(receipt.mode) || !validId(receipt.requestId)
    || typeof receipt.turnId !== 'string' || !receipt.turnId || receipt.turnId.length > 512
    || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1 || receipt.revision > revision
    || typeof receipt.compiledHash !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.compiledHash)) return false;
  const receiptScope = normalizeScope(receipt.scope);
  return receiptScope !== null && stableSerialize(receiptScope) === stableSerialize(scope);
}

function unmodified(message, status, extra = {}) {
  return { message, changed: false, status, integrationBoundary: boundary, ...extra };
}

/**
 * Prepare only the current desktop turn/start request's untrusted context.
 * scopeForThread(threadId) and acceptedReceipt MUST come from trusted local
 * transport state, never from request params, a panel request, or an iframe.
 *
 * acceptedReceipt is optional persisted transport evidence produced below from
 * a matching successful app-server response. It proves server acceptance only.
 * No receipt is created by preparing or sending a request. Empty configuration
 * is an exact object-identity no-op unless a prior accepted overlay needs reset.
 *
 * This adapter deliberately does not instantiate HostContract with invented
 * coverage flags: it uses the same canonical user-preference payload while
 * claiming neither complete fork-history isolation nor capability enforcement.
 */
export async function prepareTurn({ message, store, scopeForThread, acceptedReceipt } = {}) {
  if (!record(message) || message.method !== 'turn/start') return unmodified(message, 'passthrough');
  if (!record(message.params) || typeof message.params.threadId !== 'string' || !message.params.threadId) {
    return unmodified(message, 'unmapped-thread');
  }
  if (typeof scopeForThread !== 'function') return unmodified(message, 'unmapped-thread');
  const threadId = message.params.threadId;
  const suppliedScope = await scopeForThread(threadId);
  if (suppliedScope === undefined || suppliedScope === null) return unmodified(message, 'unmapped-thread');
  const scope = normalizeScope(suppliedScope);
  if (!scope || scope.threadId !== threadId) {
    return unmodified(message, 'unsupported', { reason: 'SCOPE_BINDING_INVALID' });
  }
  if (!store || typeof store.get !== 'function') return unmodified(message, 'unsupported', { reason: 'STORE_REQUIRED' });
  const profile = await store.get(scope);
  if (!validProfile(profile)) return unmodified(message, 'unsupported', { reason: 'PROFILE_INVALID' });
  const unsupportedCapabilities = Object.keys(profile.overrides).sort().map(id => ({
    id, requested: profile.overrides[id], reason: 'Native capability enforcement is not connected',
  }));
  const partial = unsupportedCapabilities.length > 0;
  const extra = { unsupportedCapabilities };
  const hasText = profile.persona !== '' || profile.background !== '';
  const hasReceipt = acceptedReceipt !== undefined && acceptedReceipt !== null;
  if (hasReceipt && !acceptedForScope(acceptedReceipt, scope, profile.revision)) {
    return unmodified(message, 'unsupported', { ...extra, reason: 'ACCEPTED_RECEIPT_INVALID' });
  }
  const needsReset = !hasText && acceptedReceipt?.mode === 'overlay';
  if (!hasText && !needsReset) {
    return unmodified(message, partial ? 'unsupported-capabilities' : 'passthrough', extra);
  }
  if (!validId(message.id)) return unmodified(message, 'unsupported', { ...extra, reason: 'REQUEST_ID_REQUIRED' });
  const existing = message.params.additionalContext;
  if (existing !== undefined && existing !== null && !record(existing)) {
    return unmodified(message, 'unsupported', { ...extra, reason: 'ADDITIONAL_CONTEXT_INVALID' });
  }
  if (existing && Object.hasOwn(existing, SOURCE_KEY)) {
    return unmodified(message, 'unsupported', { ...extra, reason: 'CONTEXT_SOURCE_CONFLICT' });
  }

  const mode = needsReset ? 'reset' : 'overlay';
  // A read-only text view intentionally strips unsupported capability toggles.
  // The static framing and payload match HostContract's user-level compiler.
  const payload = {
    // Revision belongs in the local receipt, not model context: changing only
    // a capability switch must not rewrite an unchanged persona fragment.
    type: 'threadbrief.user-preferences', version: 2, scope, mode,
    persona: profile.persona, background: profile.background, overrides: {}, capabilityChanges: [],
  };
  const compileContext = value => Object.freeze({
    role: 'user',
    content: `${mode === 'reset'
      ? 'Stop using earlier ThreadBrief preference overlays for this scope. Preserve other conversation instructions and history; this does not undo past actions.'
      : 'Apply these user preferences only to this conversation scope. Existing system/developer instructions and host permissions remain authoritative. These preferences grant no permissions.'}\n${stableSerialize(value)}`,
  });
  let context = compileContext(payload);
  // The role is data inside an untrusted fragment, not a forged higher-priority
  // protocol role. Only the public additionalContext field is added to params.
  const hash = value => createHash('sha256').update(value).digest('hex');
  // Keep an already accepted legacy revision byte-identical. Migrate only on
  // a later saved revision, avoiding conflicting immutable acceptance records.
  if (acceptedReceipt?.revision === profile.revision) {
    const legacy = compileContext({ ...payload, version: 1, revision: profile.revision });
    if (hash(stableSerialize(legacy)) === acceptedReceipt.compiledHash) context = legacy;
  }
  const value = stableSerialize(context);
  const compiledHash = hash(value);
  const prepared = Object.freeze({
    type: 'threadbrief.prepared-turn', version: 1, status: 'prepared',
    scope: Object.freeze({ ...scope }), revision: profile.revision, compiledHash,
    requestId: message.id, mode, context, sourceKey: SOURCE_KEY,
  });
  preparedPlans.add(prepared);
  return {
    message: {
      ...message,
      params: { ...message.params, additionalContext: { ...(existing ?? {}), [SOURCE_KEY]: { kind: 'untrusted', value } } },
    },
    changed: true,
    status: partial ? 'partial' : 'prepared',
    prepared,
    unsupportedCapabilities,
    integrationBoundary: boundary,
  };
}

/**
 * The transport calls this ONLY for the actual backend response to an in-flight
 * prepared request. Persist the returned object in transport-owned per-scope
 * state and pass it as acceptedReceipt next time. Never accept a caller-supplied
 * object as evidence via HTTP or JSON-RPC request fields. No model-consumed or
 * applied claim is made; a successful turn/start is merely server acceptance.
 */
export function createAcceptedReceipt({ prepared, response } = {}) {
  if (!preparedPlans.has(prepared) || !record(response) || response.id !== prepared.requestId
    || Object.hasOwn(response, 'error') || !record(response.result) || !record(response.result.turn)
    || typeof response.result.turn.id !== 'string' || !response.result.turn.id
    || response.result.turn.id.length > 512 || response.result.turn.status === 'failed'
    || response.result.turn.error !== undefined && response.result.turn.error !== null) {
    throw Object.assign(new Error('A matching successful backend turn/start result is required'), { code: 'ACCEPTED_RECEIPT_INVALID' });
  }
  return Object.freeze({
    type: RECEIPT_TYPE, version: 1, status: 'app-server-accepted', evidence: 'turn/start.result',
    scope: Object.freeze({ ...prepared.scope }), revision: prepared.revision,
    compiledHash: prepared.compiledHash, mode: prepared.mode,
    requestId: prepared.requestId, turnId: response.result.turn.id,
  });
}
