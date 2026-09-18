import { createHash } from 'node:crypto';
import { stableSerialize } from '../lib/host-contract.mjs';
import { mergeSkillConfig } from './skill-config.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const prohibited = new Set(['__proto__', 'prototype', 'constructor']);
const boundary = Object.freeze({
  naturalHostRecipeOnly: true, forcedUnsubscribe: false, globalWrites: false,
  capabilityEnforcement: false, application: 'not-confirmed',
  loadedResumeMayRetainPreviousConfiguration: true,
});
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 512
  && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value) && !prohibited.has(value);
function normalizeScope(value) {
  if (!record(value)) return null;
  const result = {};
  for (const key of ['hostId', 'accountScope', 'threadId']) {
    if (!identifier(value[key])) return null;
    result[key] = value[key].normalize('NFC');
  }
  return result;
}
const sameScope = (left, right) => left && right && stableSerialize(left) === stableSerialize(right);
const prefix = (left, right) => left.length <= right.length && left.every((part, i) => part === right[i]);
const keyForPath = parts => parts.map(part => /^[A-Za-z0-9_-]+$/u.test(part) ? part : JSON.stringify(part)).join('.');

// Top-level config keys can be dotted paths. Keys inside their JSON object
// values are literal table keys, including IDs containing periods.
function parseKey(key) {
  const parts = [];
  let i = 0;
  while (i < key.length) {
    if (key[i] === '"' || key[i] === "'") {
      const quote = key[i], start = i++;
      let escaped = false;
      for (; i < key.length; i += 1) {
        if (quote === '"' && !escaped && key[i] === '\\') { escaped = true; continue; }
        if (!escaped && key[i] === quote) break;
        escaped = false;
      }
      if (i >= key.length) return null;
      const token = key.slice(start, ++i);
      try { parts.push(quote === '"' ? JSON.parse(token) : token.slice(1, -1)); } catch { return null; }
    } else {
      const start = i;
      while (i < key.length && key[i] !== '.') i += 1;
      const token = key.slice(start, i);
      if (!token || /[\s"'\[\]#=]/u.test(token)) return null;
      parts.push(token);
    }
    if (!identifier(parts.at(-1))) return null;
    if (i === key.length) break;
    if (key[i++] !== '.' || i === key.length) return null;
  }
  return parts.length ? parts : null;
}
function nestedValue(parts, value) {
  return parts.reduceRight((child, key) => ({ [key]: child }), value);
}
function replaceNested(value, parts, enabled) {
  if (!parts.length) {
    if (record(value) || Array.isArray(value)) return { error: 'CONFIG_VALUE_CONFLICT' };
    return { value: enabled, changed: value !== enabled };
  }
  if (value !== undefined && !record(value)) return { error: 'CONFIG_ANCESTOR_CONFLICT' };
  const current = value ?? {};
  const [key, ...rest] = parts;
  const child = replaceNested(Object.hasOwn(current, key) ? current[key] : undefined, rest, enabled);
  if (child.error) return child;
  return child.changed ? { value: { ...current, [key]: child.value }, changed: true } : { value, changed: false };
}
function mergeBoolean(config, target, enabled) {
  const roots = Object.keys(config).map(key => ({ key, path: parseKey(key) }));
  if (roots.some(entry => !entry.path && (entry.key === target[0] || entry.key.startsWith(`${target[0]}.`)))) {
    return { error: 'CONFIG_KEY_ENCODING_UNSUPPORTED' };
  }
  const candidates = roots.filter(entry => entry.path && (prefix(entry.path, target) || prefix(target, entry.path)));
  if (candidates.length > 1) return { error: 'CONFIG_ALIAS_CONFLICT' };
  if (candidates.length === 1) {
    const entry = candidates[0];
    if (!prefix(entry.path, target)) return { error: 'CONFIG_VALUE_CONFLICT' };
    const result = replaceNested(config[entry.key], target.slice(entry.path.length), enabled);
    if (result.error) return result;
    return result.changed ? { config: { ...config, [entry.key]: result.value }, changed: true } : { config, changed: false };
  }
  // Introduce a nested table if this category is absent. When the host already
  // uses dotted entries, append a quoted leaf without replacing their tables.
  if (!roots.some(entry => entry.path?.[0] === target[0])) {
    return { config: { ...config, [target[0]]: nestedValue(target.slice(1), enabled) }, changed: true };
  }
  return { config: { ...config, [keyForPath(target)]: enabled }, changed: true };
}
function mappingPath(item) {
  const mapping = item?.configMapping;
  if (!record(mapping)) return { error: 'EXACT_CONFIG_MAPPING_MISSING' };
  let parts;
  if (item.kind === 'mcp' && mapping.kind === 'mcp-server') parts = ['mcp_servers', mapping.serverName, 'enabled'];
  else if (item.kind === 'mcp' && mapping.kind === 'plugin-mcp-server') {
    parts = ['plugins', mapping.pluginKey, 'mcp_servers', mapping.pluginServerName ?? mapping.serverName, 'enabled'];
  } else if (item.kind === 'plugin' && mapping.kind === 'plugin') parts = ['plugins', mapping.pluginKey, 'enabled'];
  else if (item.kind === 'app' && mapping.kind === 'app') parts = ['apps', mapping.appId, 'enabled'];
  else if (item.kind === 'skill' && mapping.kind === 'skill') {
    return { parts: ['skills', 'config'], skillPath: mapping.path, skillName: mapping.skillName };
  } else return { error: 'CONFIG_MAPPING_KIND_UNSUPPORTED' };
  return parts.every(identifier) ? { parts } : { error: 'CONFIG_MAPPING_IDENTIFIER_INVALID' };
}
const unchanged = (message, status, extra = {}) => ({ message, changed: false, status, affectedCategories: [],
  unsupportedCapabilities: [], integrationBoundary: boundary, ...extra });

/**
 * Only overlays a natural host-owned resume recipe for an already known task.
 * scopeForThread and catalog MUST be supplied by the local trusted transport.
 * Never pass panel/request-provided catalog, mapping, or account identity here.
 * catalog={scope:{hostId,accountScope,threadId},items:[{id,kind,configMapping}]}.
 * A saved UI ID/name/hash is not a host configuration key. No mapping is inferred.
 * Skills additionally require createSkillConfigBaseline's fresh opaque token;
 * absent/incomplete baselines reject only those skill changes.
 *
 * Preparing a delta is not host acceptance or effective tool enforcement.
 * Ordinary resume of an already subscribed task can retain old configuration;
 * this module does not unsubscribe, reload, reconstruct a recipe, or write files.
 */
export async function prepareCapabilityOverlay({ message, store, scopeForThread, catalog, skillBaseline } = {}) {
  if (!record(message)) return unchanged(message, 'passthrough');
  if (['thread/start', 'thread/fork'].includes(message.method)) {
    // A fork's threadId identifies its parent, not its as-yet-unassigned child.
    return unchanged(message, 'deferred-target-scope', { deferredHotChange: true, reason: 'DESTINATION_THREAD_ID_NOT_YET_BOUND' });
  }
  if (message.method !== 'thread/resume') return unchanged(message, 'passthrough');
  if (!record(message.params) || !uuid.test(message.params.threadId ?? '') || typeof scopeForThread !== 'function') {
    return unchanged(message, 'unmapped-thread');
  }
  const scope = normalizeScope(await scopeForThread(message.params.threadId));
  if (!scope) return unchanged(message, 'unmapped-thread');
  if (scope.threadId !== message.params.threadId) return unchanged(message, 'unsupported', { reason: 'SCOPE_BINDING_INVALID' });
  if (!store || typeof store.get !== 'function') return unchanged(message, 'unsupported', { reason: 'STORE_REQUIRED' });
  const profile = await store.get(scope);
  if (!record(profile) || !Number.isSafeInteger(profile.revision) || profile.revision < 0 || !record(profile.overrides)) {
    return unchanged(message, 'unsupported', { reason: 'PROFILE_INVALID' });
  }
  const overrides = Object.entries(profile.overrides).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (!overrides.length) return unchanged(message, 'passthrough');
  const unsupportedCapabilities = [];
  const rejectAll = reason => unchanged(message, 'unsupported', { reason, deferredHotChange: true,
    unsupportedCapabilities: overrides.map(([id, requested]) => ({ id, requested, reason })) });
  if (!record(catalog) || !sameScope(normalizeScope(catalog.scope), scope) || !Array.isArray(catalog.items)) return rejectAll('TRUSTED_CATALOG_SCOPE_MISSING_OR_MISMATCHED');
  if (message.params.config !== undefined && message.params.config !== null && !record(message.params.config)) return rejectAll('HOST_CONFIG_INVALID');
  const candidates = [];
  for (const [id, requested] of overrides) {
    const reject = reason => unsupportedCapabilities.push({ id, requested, reason });
    if (requested !== 'on' && requested !== 'off') { reject('OVERRIDE_MODE_INVALID'); continue; }
    const matches = catalog.items.filter(item => record(item) && item.id === id);
    if (matches.length !== 1) { reject(matches.length ? 'CATALOG_ID_AMBIGUOUS' : 'CAPABILITY_NOT_IN_TRUSTED_CATALOG'); continue; }
    const item = matches[0];
    if (requested === 'on' && item.hostAllowed === false) { reject('HOST_PERMISSION_DENIED'); continue; }
    if (requested === 'on' && item.parentId && profile.overrides[item.parentId] === 'off') { reject('PARENT_CAPABILITY_DISABLED'); continue; }
    const mapping = mappingPath(item);
    if (mapping.error) { reject(mapping.error); continue; }
    candidates.push({ id, requested, kind: item.kind, path: mapping.parts,
      ...(item.kind === 'skill' ? { skillPath: mapping.skillPath, skillName: mapping.skillName } : {}) });
  }
  let config = message.params.config ?? {};
  const preparedCapabilities = [], categories = new Set();
  let changed = false;
  for (const candidate of candidates.filter(value => value.kind !== 'skill')) {
    if (candidates.some(other => other !== candidate && stableSerialize(other.path) === stableSerialize(candidate.path))) {
      unsupportedCapabilities.push({ id: candidate.id, requested: candidate.requested, reason: 'CONFIG_MAPPING_TARGET_AMBIGUOUS' }); continue;
    }
    const result = mergeBoolean(config, candidate.path, candidate.requested === 'on');
    if (result.error) { unsupportedCapabilities.push({ id: candidate.id, requested: candidate.requested, reason: result.error }); continue; }
    config = result.config; changed ||= result.changed;
    categories.add(candidate.kind);
    preparedCapabilities.push({ id: candidate.id, requested: candidate.requested, kind: candidate.kind, configPath: candidate.path });
  }
  const skillChanges = candidates.filter(value => value.kind === 'skill').map(value => ({ ...value, path: value.skillPath }));
  if (skillChanges.length) {
    const result = mergeSkillConfig({ baseline: skillBaseline, scope, request: message, config, changes: skillChanges });
    config = result.config; changed ||= result.changed;
    unsupportedCapabilities.push(...result.unsupported);
    for (const candidate of result.accepted) {
      categories.add('skill');
      preparedCapabilities.push({ id: candidate.id, requested: candidate.requested, kind: 'skill',
        configPath: ['skills', 'config'], skillPath: candidate.path });
    }
  }
  const extra = { affectedCategories: [...categories].sort(), unsupportedCapabilities,
    deferredHotChange: true, reason: 'AWAITING_NATURAL_HOST_RELOAD_AND_RUNTIME_EVIDENCE' };
  if (!changed) return unchanged(message, unsupportedCapabilities.length ? 'unsupported' : 'host-config-already-matches', extra);
  return {
    ...unchanged(message, unsupportedCapabilities.length ? 'partial-prepared' : 'prepared-for-natural-resume', extra),
    changed: true, message: { ...message, params: { ...message.params, config } },
    prepared: Object.freeze({ type: 'threadbrief.prepared-capability-overlay', status: 'prepared',
      scope: Object.freeze({ ...scope }), revision: profile.revision, method: message.method,
      configHash: createHash('sha256').update(stableSerialize(config)).digest('hex'),
      capabilities: Object.freeze(preparedCapabilities.map(value => Object.freeze({ ...value, configPath: Object.freeze([...value.configPath]) }))),
    }),
  };
}
