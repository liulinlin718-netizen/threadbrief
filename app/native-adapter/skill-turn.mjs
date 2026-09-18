import path from 'node:path';
import { stableSerialize } from '../lib/host-contract.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = value => typeof value === 'string' && value.length > 0 && value === value.trim()
  && !/[\u0000-\u001f\u007f]/u.test(value);
const scopeKey = value => record(value) && ['hostId', 'accountScope', 'threadId'].every(key => text(value[key]))
  ? stableSerialize(Object.fromEntries(['hostId', 'accountScope', 'threadId'].map(key => [key, value[key].normalize('NFC')]))) : null;
const skillPath = value => {
  if (!text(value)) return null;
  if (path.win32.isAbsolute(value) && /^[A-Za-z]:[\\/]|^\\\\/u.test(value)) return path.win32.normalize(value).toLowerCase();
  return path.posix.isAbsolute(value) ? path.posix.normalize(value) : null;
};
const boundary = Object.freeze({
  mechanism: 'native-skill-input', globalWrites: false, removesExplicitUserInput: false,
  disable: 'stops-automatic-invocation', historyRemoval: false, modelConsumption: 'unverified',
});

/**
 * Invoke only explicitly enabled task skills using the public UserInput type.
 * profile, scope and catalog are trusted local snapshots, never browser fields.
 * A disabled switch stops this adapter's future invocations; it cannot erase
 * skill text already in history or prevent the user from invoking a skill.
 */
export function prepareSkillTurn({ message, profile, scope, catalog } = {}) {
  const unchanged = (status, extra = {}) => ({ message, changed: false, status,
    appendedCapabilities: [], unsupportedCapabilities: [], revision: profile?.revision,
    integrationBoundary: boundary, ...extra });
  if (!record(message) || message.method !== 'turn/start') return unchanged('passthrough');
  if (!record(profile) || !Number.isSafeInteger(profile.revision) || profile.revision < 0 || !record(profile.overrides)) {
    return unchanged('unsupported', { reason: 'PROFILE_INVALID' });
  }
  const selected = Object.entries(profile.overrides).filter(([id, mode]) => mode === 'on'
    && (id.startsWith('skill:') || Array.isArray(catalog?.items) && catalog.items.some(item => item?.id === id && item.kind === 'skill')))
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (!selected.length) return unchanged('inactive');
  const rejectAll = reason => unchanged('unsupported', { reason,
    unsupportedCapabilities: selected.map(([id, requested]) => ({ id, requested, reason })) });
  const key = scopeKey(scope);
  if (!key || !record(message.params) || scope.threadId !== message.params.threadId) return rejectAll('SCOPE_BINDING_INVALID');
  if (!record(catalog) || scopeKey(catalog.scope) !== key || !Array.isArray(catalog.items)) return rejectAll('TRUSTED_CATALOG_SCOPE_MISSING_OR_MISMATCHED');
  if (!Array.isArray(message.params.input)) return rejectAll('HOST_INPUT_INVALID');
  const unsupportedCapabilities = [], candidates = [];
  for (const [id, requested] of selected) {
    const reject = reason => unsupportedCapabilities.push({ id, requested, reason });
    const matches = catalog.items.filter(item => record(item) && item.id === id);
    if (matches.length !== 1) { reject(matches.length ? 'CATALOG_ID_AMBIGUOUS' : 'CAPABILITY_NOT_IN_TRUSTED_CATALOG'); continue; }
    const item = matches[0], mapping = item.configMapping;
    // A plugin switch temporarily suppresses its children without discarding
    // their saved choices or preventing an otherwise valid conversation turn.
    if (item.kind === 'skill' && item.parentId && profile.overrides[item.parentId] === 'off') continue;
    if (item.kind !== 'skill' || !record(mapping) || mapping.kind !== 'skill'
      || !skillPath(mapping.path) || !text(mapping.skillName)) { reject('EXACT_SKILL_MAPPING_INVALID'); continue; }
    if (item.hostAllowed === false) { reject('HOST_PERMISSION_DENIED'); continue; }
    if (item.defaultEnabled === false) { reject('NATIVE_SKILL_DISABLED'); continue; }
    candidates.push({ id, path: mapping.path, name: mapping.skillName });
  }
  // All-or-nothing: callers must not send a partial skill selection silently.
  if (unsupportedCapabilities.length) return unchanged('unsupported', { unsupportedCapabilities });
  const existing = new Set(message.params.input.filter(item => record(item) && item.type === 'skill').map(item => skillPath(item.path)).filter(Boolean));
  const appendedCapabilities = [];
  for (const candidate of candidates) {
    const key = skillPath(candidate.path);
    if (existing.has(key)) continue;
    existing.add(key); appendedCapabilities.push(candidate);
  }
  if (!appendedCapabilities.length) return unchanged('already-invoked');
  return { ...unchanged('prepared'), changed: true, appendedCapabilities,
    message: { ...message, params: { ...message.params,
      input: [...message.params.input, ...appendedCapabilities.map(({ name, path }) => ({ type: 'skill', name, path }))] } } };
}
