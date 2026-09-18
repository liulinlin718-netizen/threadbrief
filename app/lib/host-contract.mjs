import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const STAGES = ['discovery', 'skillLoading', 'dispatch'];
const PHASES = ['turn', 'start', 'resume', 'compact'];
const KINDS = ['skill', 'mcp', 'plugin', 'app'];
const SCOPE_KEYS = ['hostId', 'accountScope', 'threadId'];

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
export function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  throw failure('VALIDATION_ERROR', 'Only JSON values can be serialized');
}
function hash(value) { return createHash('sha256').update(stableSerialize(value)).digest('hex'); }
function normalizeScope(scope) {
  if (!record(scope)) throw failure('VALIDATION_ERROR', 'scope must be an object');
  const normalized = {};
  for (const key of SCOPE_KEYS) {
    if (typeof scope[key] !== 'string') throw failure('VALIDATION_ERROR', `Missing scope.${key}`);
    normalized[key] = scope[key].trim().normalize('NFC');
    if (!normalized[key] || normalized[key].length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized[key])) throw failure('VALIDATION_ERROR', `Invalid scope.${key}`);
  }
  return normalized;
}
function sameScope(left, right) { return stableSerialize(left) === stableSerialize(right); }
function empty(profile) { return !profile.persona && !profile.background && Object.keys(profile.overrides).length === 0; }
function issue(code, detail) { return { code, detail }; }
function unsupportedDecision(id, issues) { return { id, supported: false, allowed: false, reason: 'unsupported', issues: clone(issues) }; }

function readCatalog(catalog) {
  if (!Array.isArray(catalog)) throw failure('CATALOG_REQUIRED', 'The host must supply its real capability catalog');
  const entries = new Map();
  for (const source of catalog) {
    if (!record(source) || typeof source.id !== 'string' || !source.id || source.id.length > 256
      || ['__proto__', 'constructor', 'prototype'].includes(source.id) || entries.has(source.id)
      || !KINDS.includes(source.kind) || typeof source.hostAllowed !== 'boolean' || typeof source.defaultEnabled !== 'boolean'
      || (source.parentPluginId !== undefined && typeof source.parentPluginId !== 'string')
      || (source.requires !== undefined && (!Array.isArray(source.requires) || source.requires.some(id => typeof id !== 'string')))) {
      throw failure('CATALOG_INVALID', 'Capability metadata is invalid or incomplete');
    }
    entries.set(source.id, {
      id: source.id, kind: source.kind, hostAllowed: source.hostAllowed, defaultEnabled: source.defaultEnabled,
      parentPluginId: source.parentPluginId ?? null, requires: [...new Set(source.requires ?? [])].sort(),
    });
  }
  for (const entry of entries.values()) {
    if (entry.parentPluginId !== null && entries.get(entry.parentPluginId)?.kind !== 'plugin') throw failure('CATALOG_INVALID', `Missing plugin parent for ${entry.id}`);
    for (const dependency of entry.requires) if (!entries.has(dependency)) throw failure('CATALOG_INVALID', `Missing dependency for ${entry.id}`);
  }
  const done = new Set();
  const walking = new Set();
  const visit = id => {
    if (walking.has(id)) throw failure('CATALOG_INVALID', 'Capability dependency graph contains a cycle');
    if (done.has(id)) return;
    walking.add(id);
    const entry = entries.get(id);
    for (const next of [...entry.requires, ...(entry.parentPluginId ? [entry.parentPluginId] : [])]) visit(next);
    walking.delete(id);
    done.add(id);
  };
  for (const id of entries.keys()) visit(id);
  return entries;
}

/**
 * One permission calculation for discovery, reading skill instructions, and
 * actual invocation. Coverage is an assertion supplied by an integrated host;
 * setting a flag here does not install any hooks in Codex Desktop.
 */
export function createCapabilityPolicy({ overrides = {}, catalog, coverage = {} } = {}) {
  const issues = [];
  for (const field of [...STAGES, 'catalogComplete', 'scopeIsolation']) {
    if (coverage[field] !== true) issues.push(issue('MISSING_COVERAGE', field));
  }
  let entries = new Map();
  try { entries = readCatalog(catalog); }
  catch (err) { issues.push(issue(err.code ?? 'CATALOG_INVALID', err.message)); }
  if (!record(overrides)) issues.push(issue('OVERRIDES_INVALID', 'overrides must be an object'));
  else for (const [id, mode] of Object.entries(overrides)) {
    if (!entries.has(id)) issues.push(issue('UNKNOWN_CAPABILITY', id));
    if (!['on', 'off'].includes(mode)) issues.push(issue('OVERRIDES_INVALID', id));
  }
  const explicitOn = new Set(record(overrides) ? Object.keys(overrides).filter(id => overrides[id] === 'on') : []);
  const requested = new Set(explicitOn);
  if (!issues.length) {
    // Explicit activation may request permitted dependencies and plugin children.
    // An explicit off, a disabled ancestor, or host denial still wins below.
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of [...requested]) {
        const entry = entries.get(id);
        const canRequest = candidate => {
          if (overrides[candidate.id] === 'off' || !candidate.hostAllowed) return false;
          if (!requested.has(candidate.id) && !candidate.defaultEnabled) return false;
          return candidate.parentPluginId === null || canRequest(entries.get(candidate.parentPluginId));
        };
        if (!canRequest(entry)) continue;
        const additions = [...entry.requires];
        if (entry.kind === 'plugin') for (const child of entries.values()) if (child.parentPluginId === id) additions.push(child.id);
        for (const next of additions) if (!requested.has(next)) { requested.add(next); changed = true; }
      }
    }
  }
  const memo = new Map();
  const calculate = id => {
    if (memo.has(id)) return memo.get(id);
    const entry = entries.get(id);
    let reason = 'allowed';
    if (overrides[id] === 'off') reason = 'explicit-off';
    else if (!entry.hostAllowed) reason = 'host-denied';
    else if (entry.parentPluginId && !calculate(entry.parentPluginId).allowed) reason = 'plugin-disabled';
    else if (!requested.has(id) && !entry.defaultEnabled) reason = 'not-enabled';
    else if (entry.requires.some(next => !calculate(next).allowed)) reason = 'dependency-disabled';
    const result = { id, supported: true, allowed: reason === 'allowed', reason };
    memo.set(id, result);
    return result;
  };
  const decide = (id, stage) => {
    if (!STAGES.includes(stage)) return unsupportedDecision(id, [issue('UNKNOWN_STAGE', String(stage))]);
    if (issues.length) return unsupportedDecision(id, issues);
    if (!entries.has(id)) return unsupportedDecision(id, [issue('UNKNOWN_CAPABILITY', String(id))]);
    return clone(calculate(id));
  };
  const decisions = issues.length ? [] : [...entries.keys()].sort().map(id => decide(id, 'dispatch'));
  const changes = decisions.filter(item => Object.hasOwn(overrides, item.id)
    || item.allowed !== (entries.get(item.id).hostAllowed && entries.get(item.id).defaultEnabled))
    .map(item => ({ ...item, requested: overrides[item.id] ?? (requested.has(item.id) ? 'on' : 'inherit') }));
  return Object.freeze({
    supported: issues.length === 0, issues: clone(issues), decisions, changes, decide,
    discovery: id => decide(id, 'discovery'),
    skillLoading: id => decide(id, 'skillLoading'),
    dispatch: id => decide(id, 'dispatch'),
  });
}

/**
 * A boundary SDK for a host that really owns request assembly and tool dispatch.
 * It never calls a model, changes request fields, installs hooks, or writes
 * observations. A trusted host must attach context and enforce all three gates.
 * Coverage keys: context, scopeIsolation, discovery, skillLoading, dispatch,
 * catalogComplete, resume, compact, reset. scopeIsolation must also cover forks:
 * use a non-inherited host context slot or filter copied overlay content and
 * compacted summaries. A separate store key alone cannot erase copied history.
 */
export class HostContract {
  #store;
  #coverage;
  #key;
  #prepared = new WeakMap();

  constructor(store, { coverage = {}, acknowledgmentKey } = {}) {
    if (!store || typeof store.get !== 'function') throw failure('VALIDATION_ERROR', 'A ThreadStore-compatible reader is required');
    if (!record(coverage)) throw failure('VALIDATION_ERROR', 'coverage must be an object');
    if (acknowledgmentKey !== undefined && (!(acknowledgmentKey instanceof Uint8Array) || acknowledgmentKey.byteLength < 32)) {
      throw failure('VALIDATION_ERROR', 'acknowledgmentKey must contain at least 32 secret bytes');
    }
    this.#store = store;
    this.#coverage = Object.freeze({ ...coverage });
    // Persist this host-owned secret externally to verify receipts after restart.
    // The SDK itself neither reads nor writes a secret or any global config.
    this.#key = acknowledgmentKey === undefined ? randomBytes(32) : Buffer.from(acknowledgmentKey);
  }

  #signature(body) { return createHmac('sha256', this.#key).update(stableSerialize(body)).digest('hex'); }

  #verify(receipt, scope) {
    if (!record(receipt) || typeof receipt.signature !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.signature)) return false;
    const { signature, ...body } = receipt;
    try {
      if (body.version !== 1 || body.status !== 'host-acknowledged' || !sameScope(body.scope, scope)
        || !Number.isSafeInteger(body.revision) || body.revision < 0 || !['overlay', 'reset'].includes(body.mode)
        || !/^[a-f0-9]{64}$/u.test(body.compiledHash) || typeof body.turnId !== 'string' || !body.turnId
        || typeof body.acknowledgedAt !== 'string') return false;
      return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(this.#signature(body), 'hex'));
    } catch { return false; }
  }

  async prepare({ scope, request, lifecycle = 'turn', receipt, catalog } = {}) {
    const normalized = normalizeScope(scope);
    if (request === null || typeof request !== 'object') throw failure('VALIDATION_ERROR', 'request must be an object');
    if (!PHASES.includes(lifecycle)) throw failure('VALIDATION_ERROR', 'Unknown request lifecycle');
    const profile = await this.#store.get(normalized);
    const base = { scope: Object.freeze({ ...normalized }), revision: profile.revision, request, lifecycle, context: null, compiledHash: null };
    const reject = issues => Object.freeze({ ...base, status: 'unsupported', mode: 'unsupported', issues });
    if (receipt !== undefined && receipt !== null && !this.#verify(receipt, normalized)) return reject([issue('INVALID_RECEIPT', 'Receipt must be an acknowledgment from this trusted host and scope')]);
    if (receipt?.revision > profile.revision) return reject([issue('FUTURE_RECEIPT', 'Receipt refers to a newer configuration than this store')]);
    const needsReset = empty(profile) && receipt?.mode === 'overlay';
    if (empty(profile) && !needsReset) {
      const result = Object.freeze({ ...base, status: 'passthrough', mode: 'passthrough', issues: [] });
      this.#prepared.set(result, { scope: clone(normalized), profile: clone(profile), catalog: clone(catalog ?? []), revoked: new Map() });
      return result;
    }
    const issues = [];
    for (const field of ['context', 'scopeIsolation', ...(lifecycle === 'resume' || lifecycle === 'compact' ? [lifecycle] : []), ...(needsReset ? ['reset'] : [])]) {
      if (this.#coverage[field] !== true) issues.push(issue('MISSING_COVERAGE', field));
    }
    const hasCapabilities = Object.keys(profile.overrides).length > 0;
    const policy = hasCapabilities ? createCapabilityPolicy({ overrides: profile.overrides, catalog, coverage: this.#coverage }) : null;
    if (policy && !policy.supported) issues.push(...policy.issues);
    if (issues.length) return reject(issues);
    const mode = needsReset ? 'reset' : 'overlay';
    const payload = {
      type: 'threadbrief.user-preferences', version: 1, scope: normalized, revision: profile.revision, mode,
      persona: profile.persona, background: profile.background,
      overrides: profile.overrides, capabilityChanges: policy?.changes ?? [],
    };
    const context = {
      role: 'user',
      content: `${mode === 'reset'
        ? 'Stop using earlier ThreadBrief preference overlays for this scope. Preserve other conversation instructions and history; this does not undo past actions.'
        : 'Apply these user preferences only to this conversation scope. Existing system/developer instructions and host permissions remain authoritative. These preferences grant no permissions.'}\n${stableSerialize(payload)}`,
    };
    const compiledHash = hash(context);
    // Receipt deduplication is only safe on an ordinary turn with retained context.
    // Resume and compaction explicitly recover the same canonical content.
    const acknowledged = lifecycle === 'turn' && receipt?.revision === profile.revision && receipt.compiledHash === compiledHash && receipt.mode === mode;
    const result = Object.freeze({
      ...base, status: acknowledged ? 'already-acknowledged' : 'prepared', mode,
      context: acknowledged ? null : Object.freeze(context), compiledHash, issues: [],
      capabilityChanges: clone(policy?.changes ?? []),
    });
    this.#prepared.set(result, { scope: clone(normalized), profile: clone(profile), catalog: clone(catalog ?? []), context, revoked: new Map() });
    return result;
  }

  /**
   * Call ONLY from a trusted host after it has actually attached this context to
   * the identified turn. Never expose this method to an iframe/HTTP client as a
   * way to self-report application. This certifies a host assertion, not model
   * compliance, not a token-cache hit, and not a tool permission escalation.
   */
  acknowledge({ prepared, scope, revision, compiledHash, turnId, outcome } = {}) {
    const saved = this.#prepared.get(prepared);
    if (!saved || prepared.status !== 'prepared' || !prepared.context || outcome !== 'context-attached') {
      throw failure('ACKNOWLEDGMENT_INVALID', 'A real prepared context and explicit context-attached host outcome are required');
    }
    const normalized = normalizeScope(scope);
    if (!sameScope(normalized, saved.scope) || revision !== prepared.revision || compiledHash !== prepared.compiledHash
      || typeof turnId !== 'string' || !turnId.trim() || turnId.length > 256) {
      throw failure('ACKNOWLEDGMENT_INVALID', 'Host acknowledgment does not match scope, revision, compiled hash, and turn');
    }
    const body = {
      version: 1, status: 'host-acknowledged', scope: clone(saved.scope), revision,
      compiledHash, mode: prepared.mode, turnId, acknowledgedAt: new Date().toISOString(),
    };
    return Object.freeze({ ...body, scope: Object.freeze(body.scope), signature: this.#signature(body) });
  }

  async capabilityPolicy({ scope, catalog } = {}) {
    const normalized = normalizeScope(scope);
    const profile = await this.#store.get(normalized);
    return createCapabilityPolicy({ overrides: profile.overrides, catalog, coverage: this.#coverage });
  }

  /**
   * Current turn grants are frozen; any observed revocation is sticky until a
   * new prepare. Immutable store history catches off/on changes between calls.
   * Transient host permission revocations cannot be reconstructed from config
   * history: the host must pass each revocation through this gate (or maintain
   * its own revocation feed) before restoring its catalog. No polling SDK can
   * prove that an unobserved host-only event never occurred.
   */
  async authorize({ scope, prepared, id, stage, catalog } = {}) {
    const normalized = normalizeScope(scope);
    const saved = this.#prepared.get(prepared);
    if (!saved || !sameScope(saved.scope, normalized)) return unsupportedDecision(id, [issue('PREPARATION_REQUIRED', 'Use this host instance and the exact prepared scope')]);
    const initialPolicy = createCapabilityPolicy({ overrides: saved.profile.overrides, catalog: saved.catalog, coverage: this.#coverage });
    const before = initialPolicy.decide(id, stage);
    if (!initialPolicy.supported || !before.supported) return before;
    const observe = policy => {
      if (!policy.supported) return;
      // Observe the whole catalog so that disabling a plugin also revokes every
      // initially granted child, even when the current call names a sibling.
      for (const granted of initialPolicy.decisions.filter(item => item.allowed)) {
        if (saved.revoked.has(granted.id)) continue;
        const decision = policy.decide(granted.id, stage);
        if (!decision.supported) saved.revoked.set(granted.id, decision);
        else if (!decision.allowed) saved.revoked.set(granted.id, {
          id: granted.id, supported: true, allowed: false, reason: 'revoked-this-turn', revocationReason: decision.reason,
        });
      }
    };
    const current = await this.#store.get(normalized);
    const currentPolicy = createCapabilityPolicy({ overrides: current.overrides, catalog, coverage: this.#coverage });
    if (!currentPolicy.supported) return currentPolicy.decide(id, stage);
    observe(currentPolicy);
    if (current.revision < saved.profile.revision) return unsupportedDecision(id, [issue('REVISION_REWIND', 'Store revision moved behind this prepared turn')]);
    if (current.revision > saved.profile.revision) {
      if (typeof this.#store.history !== 'function') return unsupportedDecision(id, [issue('HISTORY_REQUIRED', 'Revision changed; intermediate revocations require immutable history')]);
      const history = await this.#store.history(normalized);
      if (!Array.isArray(history)) return unsupportedDecision(id, [issue('HISTORY_INCOMPLETE', 'Store history must contain immutable revision snapshots')]);
      const intervening = history.filter(item => Number.isSafeInteger(item?.revision) && item.revision > saved.profile.revision).sort((a, b) => a.revision - b.revision);
      if (!intervening.length || intervening.at(-1).revision < current.revision
        || intervening.some((item, index) => item.revision !== saved.profile.revision + index + 1)) {
        return unsupportedDecision(id, [issue('HISTORY_INCOMPLETE', 'Cannot prove every intervening configuration was checked')]);
      }
      for (const revision of intervening) {
        const policy = createCapabilityPolicy({ overrides: revision.overrides, catalog, coverage: this.#coverage });
        if (!policy.supported) return policy.decide(id, stage);
        observe(policy);
      }
    }
    if (saved.revoked.has(id)) return clone(saved.revoked.get(id));
    if (!before.allowed) return before;
    return currentPolicy.decide(id, stage);
  }
}
