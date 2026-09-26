import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { writeDiagnosticJSON as atomicJSON } from './diagnostic-json.mjs';

const TTL = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MOUNT = new Set(['queued', 'opened', 'error']);
const PROFILE = new Set(['ready', 'accepted', 'error', 'not-connected']);
const CAPABILITY = new Set(['catalog-observed', 'pending-reload', 'partially-prepared', 'enforced', 'not-connected']);
const CONTROL = new Set(['supported', 'preference-only', 'unavailable']);
const KINDS = new Set(['skill', 'mcp', 'plugin', 'app']);
const tails = new Map();
const text = (value, limit = 512) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
function normalizedScope(scope) {
  if (!scope || !UUID.test(scope.threadId)) throw new TypeError('A real thread UUID is required');
  const result = {};
  for (const key of ['hostId', 'accountScope', 'threadId']) {
    const value = text(scope[key]);
    if (!value || !value.trim()) throw new TypeError('Invalid native evidence scope');
    result[key] = value.trim().normalize('NFC');
  }
  return result;
}
const sameScope = (a, b) => ['hostId', 'accountScope', 'threadId'].every(key => a?.[key] === b[key]);
export function nativeEvidenceFile(directory, scope) {
  const identity = normalizedScope(scope);
  return path.join(path.resolve(directory), createHash('sha256').update(JSON.stringify(identity)).digest('hex') + '.json');
}
function mapping(value) {
  if (!value || !['mcp-server', 'plugin-mcp-server', 'plugin', 'app', 'skill'].includes(value.kind)) return undefined;
  const result = { kind: value.kind };
  if (['mcp-server', 'plugin-mcp-server'].includes(value.kind)) {
    if (!text(value.serverName)) return undefined;
    result.serverName = value.serverName;
  }
  if (value.kind === 'plugin-mcp-server') {
    if (!text(value.pluginKey)) return undefined;
    result.pluginKey = value.pluginKey;
    if (text(value.pluginServerName)) result.pluginServerName = value.pluginServerName;
  }
  if (value.kind === 'plugin') { if (!text(value.pluginKey)) return undefined; result.pluginKey = value.pluginKey; }
  if (value.kind === 'app') { if (!text(value.appId)) return undefined; result.appId = value.appId; }
  if (value.kind === 'skill') {
    if (!text(value.path, 4096)) return undefined;
    result.path = value.path;
    if (text(value.skillName)) result.skillName = value.skillName;
  }
  return result;
}
function catalog(entries) {
  if (!Array.isArray(entries) || entries.length > 512) throw new TypeError('Invalid native capability catalog');
  const seen = new Set();
  return entries.map(entry => {
    if (!entry || !text(entry.id) || !text(entry.name, 300) || !KINDS.has(entry.kind) || seen.has(entry.id)) throw new TypeError('Invalid native capability entry');
    seen.add(entry.id);
    const result = {
      id: entry.id, name: entry.name, kind: entry.kind,
      defaultEnabled: entry.defaultEnabled === true,
      available: entry.available === true,
      effective: typeof entry.effective === 'boolean' ? entry.effective : null,
      control: CONTROL.has(entry.control) ? entry.control : 'preference-only',
      source: text(entry.source, 600) || '宿主任务目录',
      reason: text(entry.reason, 600) || '',
    };
    if (text(entry.parentId)) result.parentId = entry.parentId;
    if (Array.isArray(entry.childIds)) result.childIds = [...new Set(entry.childIds.filter(id => text(id)))].slice(0, 512);
    const configMapping = mapping(entry.configMapping);
    if (configMapping) result.configMapping = configMapping;
    if (entry.kind === 'app' && Array.isArray(entry.toolBindings)) {
      result.toolBindings = entry.toolBindings.filter(binding => binding?.serverName === 'codex_apps'
        && text(binding.toolName) && text(binding.hookToolName) && binding.hookToolName.startsWith('mcp__'))
        .slice(0, 512).map(({ serverName, toolName, hookToolName }) => ({ serverName, toolName, hookToolName }));
    }
    return result;
  });
}
function sanitize(value, scope) {
  if (!value || !sameScope(value.scope, scope) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.bridgePid) || value.bridgePid <= 0 || !text(value.observedAt, 40) || !Number.isFinite(Date.parse(value.observedAt))) throw new TypeError('Invalid native task evidence');
  const result = {
    schemaVersion: 1, scope, bridgePid: value.bridgePid, observedAt: value.observedAt,
    catalog: catalog(value.catalog || []),
  };
  if (value.catalogObservedAt !== undefined) {
    if (!text(value.catalogObservedAt, 40) || !Number.isFinite(Date.parse(value.catalogObservedAt))) throw new TypeError('Invalid catalog observation time');
    result.catalogObservedAt = value.catalogObservedAt;
  }
  if (value.catalogFailedKinds !== undefined) {
    if (!Array.isArray(value.catalogFailedKinds) || value.catalogFailedKinds.some(kind => !KINDS.has(kind))) throw new TypeError('Invalid failed catalog categories');
    result.catalogFailedKinds = [...new Set(value.catalogFailedKinds)];
  }
  if (value.mountStatus !== undefined) {
    if (!MOUNT.has(value.mountStatus)) throw new TypeError('Invalid mount evidence');
    result.mountStatus = value.mountStatus;
  }
  if (value.profileStatus !== undefined) {
    if (!PROFILE.has(value.profileStatus)) throw new TypeError('Invalid profile evidence');
    result.profileStatus = value.profileStatus;
  }
  if (value.capabilityStatus !== undefined) {
    if (!CAPABILITY.has(value.capabilityStatus)) throw new TypeError('Invalid capability evidence');
    result.capabilityStatus = value.capabilityStatus;
  }
  if (value.toolPolicyStatus !== undefined) {
    if (!['registered', 'observed', 'error'].includes(value.toolPolicyStatus)) throw new TypeError('Invalid tool policy evidence');
    result.toolPolicyStatus = value.toolPolicyStatus;
  }
  for (const field of ['profileRevision', 'capabilityRevision', 'skillInputRevision']) {
    if (value[field] !== undefined) {
      if (!Number.isSafeInteger(value[field]) || value[field] < 0) throw new TypeError('Invalid evidence revision');
      result[field] = value[field];
    }
  }
  if (value.skillInputIds !== undefined) {
    if (!Array.isArray(value.skillInputIds) || value.skillInputIds.length > 512 || value.skillInputIds.some(id => !text(id) || !id.startsWith('skill:'))) throw new TypeError('Invalid skill input evidence');
    result.skillInputIds = [...new Set(value.skillInputIds)];
  }
  return result;
}
async function boundedJSON(file) {
  if ((await stat(file)).size > 1_000_000) throw new TypeError('Native evidence is too large');
  return JSON.parse(await readFile(file, 'utf8'));
}

// Trusted local backend API only. Never exposed as an HTTP mutation route.
export async function writeNativeEvidence(directory, scope, patch) {
  const identity = normalizedScope(scope);
  const file = nativeEvidenceFile(directory, identity);
  if (!patch || !Number.isSafeInteger(patch.bridgePid) || patch.bridgePid <= 0) throw new TypeError('The observing bridge PID is required');
  const queued = (tails.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
    let previous = null;
    try { previous = sanitize(await boundedJSON(file), identity); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const inherited = previous?.bridgePid === patch.bridgePid ? previous : {};
    const merged = { ...inherited, ...patch, schemaVersion: 1, scope: identity, observedAt: patch.observedAt || new Date().toISOString() };
    // A heartbeat may carry the whole cached record. Only the first explicit
    // catalog gets an automatic timestamp; later real reads must provide one.
    if (!inherited.schemaVersion && merged.catalogObservedAt === undefined && Object.hasOwn(patch, 'catalog')) merged.catalogObservedAt = merged.observedAt;
    const value = sanitize(merged, identity);
    await atomicJSON(file, value);
    return value;
  });
  tails.set(file, queued);
  try { return await queued; } finally { if (tails.get(file) === queued) tails.delete(file); }
}

export async function readNativeEvidence(directory, scope, { bridgeDirectory, now = Date.now() } = {}) {
  if (!directory || !bridgeDirectory) return null;
  const identity = normalizedScope(scope);
  let evidence;
  try { evidence = sanitize(await boundedJSON(nativeEvidenceFile(directory, identity)), identity); }
  catch (error) { return error.code === 'ENOENT' ? null : { live: false, catalogFresh: false, reason: 'invalid-evidence', evidence: null }; }
  const fresh = value => { const at = Date.parse(value); return Number.isFinite(at) && now - at >= -5000 && now - at <= TTL; };
  const result = (live, reason, bridge) => {
    const catalogFresh = live && fresh(evidence.catalogObservedAt);
    const failed = new Set(evidence.catalogFailedKinds || []);
    return {
      live, catalogFresh, reason,
      evidence: { ...evidence, catalog: evidence.catalog.map(entry => ({ ...entry, effective: catalogFresh && !failed.has(entry.kind) ? entry.effective : null })) },
      ...(bridge ? { bridge } : {}),
    };
  };
  if (!fresh(evidence.observedAt)) return result(false, 'stale-evidence');
  let bridge;
  try { bridge = await boundedJSON(path.join(path.resolve(bridgeDirectory), `bridge-${evidence.bridgePid}.json`)); }
  catch { return result(false, 'missing-bridge'); }
  if (bridge.schemaVersion !== 1 || bridge.pid !== evidence.bridgePid || bridge.hostId !== identity.hostId || bridge.accountScope !== identity.accountScope) return result(false, 'bridge-scope-mismatch');
  if (bridge.initialized !== true || bridge.stopped !== false) return result(false, 'bridge-not-ready');
  if (!fresh(bridge.updatedAt)) return result(false, 'stale-bridge');
  return result(true, 'observed', { pid: bridge.pid, profileOverlay: bridge.profileOverlay === true, skillTurnInput: bridge.skillTurnInput === true, childProfileHook: bridge.childProfileHook === true, toolPolicyHooks: bridge.toolPolicyHooks === true, capabilityEnforcement: bridge.capabilityEnforcement === true, automaticPanelMount: bridge.automaticPanelMount === true });
}
