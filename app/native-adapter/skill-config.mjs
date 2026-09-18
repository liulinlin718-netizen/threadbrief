import path from 'node:path';
import { createHash } from 'node:crypto';
import { stableSerialize } from '../lib/host-contract.mjs';

const baselines = new WeakMap();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096
  && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
const digest = value => createHash('sha256').update(stableSerialize(value)).digest('hex');
const scopeKey = scope => record(scope) && ['hostId', 'accountScope', 'threadId'].every(key => text(scope[key]))
  ? stableSerialize(Object.fromEntries(['hostId', 'accountScope', 'threadId'].map(key => [key, scope[key].normalize('NFC')]))) : null;
function absolute(value) {
  if (!text(value)) return null;
  if (/^[a-z]:[\\/]/iu.test(value) || /^\\\\[^\\]/u.test(value)) return path.win32.normalize(value).replaceAll('\\', '/').toLowerCase();
  if (value.startsWith('/')) return path.posix.normalize(value);
  return null;
}
function parseKey(key) {
  const parts = []; let i = 0;
  while (i < key.length) {
    if (key[i] === '"' || key[i] === "'") {
      const quote = key[i], start = i++; let escaped = false;
      for (; i < key.length; i += 1) {
        if (quote === '"' && !escaped && key[i] === '\\') { escaped = true; continue; }
        if (!escaped && key[i] === quote) break;
        escaped = false;
      }
      if (i >= key.length) return null;
      const token = key.slice(start, ++i);
      try { parts.push(quote === '"' ? JSON.parse(token) : token.slice(1, -1)); } catch { return null; }
    } else {
      const start = i; while (i < key.length && key[i] !== '.') i += 1;
      const token = key.slice(start, i);
      if (!token || /[\s"'\[\]#=]/u.test(token)) return null;
      parts.push(token);
    }
    if (!text(parts.at(-1)) || ['__proto__', 'constructor', 'prototype'].includes(parts.at(-1))) return null;
    if (i === key.length) break;
    if (key[i++] !== '.' || i === key.length) return null;
  }
  return parts.length ? parts : null;
}
function skillSlot(config) {
  if (!record(config)) return { error: 'HOST_CONFIG_INVALID' };
  const entries = Object.keys(config).map(key => ({ key, parts: parseKey(key) }));
  if (entries.some(entry => !entry.parts && /^["']?skills(?:[."']|$)/u.test(entry.key))) return { error: 'CONFIG_KEY_ENCODING_UNSUPPORTED' };
  const matches = entries.filter(entry => entry.parts?.[0] === 'skills'
    && (entry.parts.length === 1 || entry.parts[1] === 'config'));
  if (matches.length > 1) return { error: 'CONFIG_ALIAS_CONFLICT' };
  if (!matches.length) return { present: false, entries: [], style: entries.some(entry => entry.parts?.[0] === 'skills') ? 'dotted' : 'new' };
  const entry = matches[0];
  if (entry.parts.length > 2) return { error: 'CONFIG_VALUE_CONFLICT' };
  const nested = entry.parts.length === 1;
  if (nested && !record(config[entry.key])) return { error: 'CONFIG_ANCESTOR_CONFLICT' };
  const present = !nested || Object.hasOwn(config[entry.key], 'config');
  const value = nested ? config[entry.key].config : config[entry.key];
  if (present && !Array.isArray(value)) return { error: 'SKILL_CONFIG_ARRAY_INVALID' };
  return { present, entries: present ? value : [], style: nested ? 'nested' : 'leaf', key: entry.key };
}
function validateEntries(entries) {
  return Array.isArray(entries) && entries.every(entry => record(entry) && typeof entry.enabled === 'boolean'
    && ((Object.hasOwn(entry, 'path') && absolute(entry.path) && !Object.hasOwn(entry, 'name'))
      || (Object.hasOwn(entry, 'name') && text(entry.name) && !Object.hasOwn(entry, 'path'))));
}
function putEntries(config, slot, entries) {
  if (slot.style === 'nested') return { ...config, [slot.key]: { ...config[slot.key], config: entries } };
  if (slot.style === 'leaf') return { ...config, [slot.key]: entries };
  if (slot.style === 'dotted') return { ...config, 'skills.config': entries };
  return { ...config, skills: { config: entries } };
}
const unsupported = reason => Object.freeze({ type: 'threadbrief.skill-config-baseline', status: 'unsupported', reason });

/**
 * Trusted transport only. `response` must be the fresh successful result (or RPC
 * envelope) from this backend's config/read({cwd, includeLayers:true}). It is not
 * task-scoped: the original host resume recipe is also required. Never call this
 * with panel input, a cached catalog, a partial array, or a previously overlaid
 * recipe. The opaque token prevents serialization/reuse under another request;
 * it does not authenticate a dishonest caller inside the trusted transport.
 *
 * Config/read's effective array replaces lower arrays, but the skill loader also
 * reads selectors from individual layers. We preserve the complete host array
 * (if supplied), otherwise the complete effective array, and leave all lower
 * layers in place. All layers are inspected for overlapping selectors.
 */
export function createSkillConfigBaseline({ scope, request, cwd, response } = {}) {
  const binding = scopeKey(scope), normalizedCwd = absolute(cwd);
  if (!binding || !normalizedCwd || request?.method !== 'thread/resume' || !record(request.params)
    || request.params.threadId !== scope.threadId) return unsupported('SKILL_BASELINE_SCOPE_INVALID');
  if (request.params.cwd != null && absolute(request.params.cwd) !== normalizedCwd) return unsupported('SKILL_BASELINE_CWD_MISMATCH');
  const source = record(response) && !Object.hasOwn(response, 'error') && Object.hasOwn(response, 'result') ? response.result : response;
  if (!record(source) || Object.hasOwn(source, 'error') || !record(source.config)
    || !Array.isArray(source.layers) || !record(source.origins)) return unsupported('SKILL_BASELINE_FULL_CONFIG_READ_REQUIRED');
  const host = skillSlot(request.params.config ?? {}), effective = skillSlot(source.config);
  if (host.error || effective.error) return unsupported(host.error ?? effective.error);
  const layerEntries = [];
  for (const layer of source.layers) {
    if (!record(layer) || !record(layer.name) || !text(layer.name.type) || !text(layer.version) || !record(layer.config)) return unsupported('SKILL_BASELINE_LAYERS_INVALID');
    if (layer.disabledReason != null) continue;
    const slot = skillSlot(layer.config);
    if (slot.error || !validateEntries(slot.entries)) return unsupported(slot.error ?? 'SKILL_BASELINE_ENTRIES_INVALID');
    layerEntries.push(...slot.entries);
  }
  if (!validateEntries(host.entries) || !validateEntries(effective.entries)) return unsupported('SKILL_BASELINE_ENTRIES_INVALID');
  try {
    const token = Object.freeze({ type: 'threadbrief.skill-config-baseline', status: 'ready' });
    const entries = structuredClone(host.present ? host.entries : effective.entries);
    // Keep all arrays, even replaced ones, for ambiguity detection. They are not
    // concatenated into an overriding array, which could change selector order.
    baselines.set(token, { request, scope: binding, cwd: normalizedCwd,
      recipeHash: digest(request), entries,
      selectors: structuredClone([...host.entries, ...effective.entries, ...layerEntries]) });
    return token;
  } catch { return unsupported('SKILL_BASELINE_NOT_SERIALIZABLE'); }
}

/**
 * Pure recipe preparation, never a claim that the backend loaded the skill.
 * An enabled skill is available for selection; this does not append a `skill`
 * turn input, load its full text, or grant permissions beyond host policy.
 */
export function mergeSkillConfig({ baseline, scope, request, config, changes } = {}) {
  const rejectAll = reason => ({ config, changed: false, accepted: [],
    unsupported: changes.map(change => ({ id: change.id, requested: change.requested, reason })) });
  const data = baselines.get(baseline);
  if (!data) return rejectAll(baseline?.status === 'unsupported' ? baseline.reason : 'SKILL_BASELINE_REQUIRED');
  if (data.request !== request || data.scope !== scopeKey(scope) || data.recipeHash !== digest(request)
    || (request.params.cwd != null && absolute(request.params.cwd) !== data.cwd)) return rejectAll('SKILL_BASELINE_BINDING_MISMATCH');
  const slot = skillSlot(config);
  if (slot.error) return rejectAll(slot.error);
  const entries = structuredClone(data.entries), accepted = [], unsupportedChanges = [];
  let changed = false;
  for (const change of changes) {
    const reject = reason => unsupportedChanges.push({ id: change.id, requested: change.requested, reason });
    const target = absolute(change.path);
    if (!target || !['on', 'off'].includes(change.requested)) { reject('SKILL_EXACT_PATH_INVALID'); continue; }
    if (changes.some(other => other !== change && absolute(other.path) === target)) { reject('CONFIG_MAPPING_TARGET_AMBIGUOUS'); continue; }
    // Changing a name rule could affect other skills with that same name. A new
    // path rule's precedence against a name rule is not established by the host
    // contract, so fail closed rather than rewriting or guessing.
    if (data.selectors.some(entry => entry.name !== undefined && (!text(change.skillName) || entry.name === change.skillName))) {
      reject('SKILL_NAME_SELECTOR_OVERLAP_UNSUPPORTED'); continue;
    }
    if (data.selectors.some(entry => entry.path && target.startsWith(`${absolute(entry.path).replace(/\/$/u, '')}/`))) {
      reject('SKILL_DIRECTORY_SELECTOR_OVERLAP_UNSUPPORTED'); continue;
    }
    const matches = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.path && absolute(entry.path) === target);
    if (matches.length > 1) { reject('SKILL_PATH_SELECTOR_AMBIGUOUS'); continue; }
    const enabled = change.requested === 'on';
    if (!matches.length) { entries.push({ path: change.path, enabled }); changed = true; }
    else if (matches[0].entry.enabled !== enabled) { entries[matches[0].index] = { ...matches[0].entry, enabled }; changed = true; }
    accepted.push(change);
  }
  return { config: changed ? putEntries(config, slot, entries) : config, changed, accepted, unsupported: unsupportedChanges };
}
