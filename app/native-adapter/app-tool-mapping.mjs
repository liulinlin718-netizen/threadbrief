// Source-verified against OpenAI's public main branch, inspected 2026-09-18:
// https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/src/rmcp_client.rs
// https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/codex_apps.rs
// https://github.com/openai/codex/blob/main/codex-rs/utils/plugins/src/mcp_connector.rs
// https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/mcp.rs
// Installed CLI schema was checked; authenticated App execution was NOT tested.
// Only use same-backend codex_apps Tool._meta joined to app/installed IDs. Do
// not treat display names, app/read summaries, arbitrary MCP metadata or browser
// input as authority. This module does not grant permissions or call an App.

const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096
  && !/[\u0000-\u001f\u007f]/u.test(value);
const sanitize = value => [...value].map(character => /[A-Za-z0-9]/u.test(character)
  ? character.toLowerCase() : '_').join('').replace(/^_+|_+$/gu, '') || 'app';
const metaText = value => typeof value === 'string' && value.trim() ? value.trim() : null;

/** Exact public-source normalization; null is observed absence, not a guess. */
export function canonicalAppHookName({ name, connectorId, connectorName } = {}) {
  if (!text(name) || !text(connectorId) || connectorName !== null && (!text(connectorName) || !metaText(connectorName))) return null;
  const connector = metaText(connectorName), id = metaText(connectorId);
  if (!id) return null;
  let callable = sanitize(name);
  for (const prefix of [connector, id].filter(Boolean).map(sanitize)) {
    if (callable.startsWith(prefix) && callable.length > prefix.length) {
      callable = callable.slice(prefix.length); break;
    }
  }
  const namespace = connector === null ? 'codex_apps' : `codex_apps__${sanitize(connector)}`;
  return `mcp__${namespace.replace(/_+$/u, '')}__${callable.replace(/^_+/u, '')}`;
}

/**
 * servers[].appTools = [{name,connectorId,connectorName}], captured only from
 * codex_apps tools; connectorName is _meta.connector_name, falling back to
 * _meta.connector_display_name after trim/empty validation, or explicit null.
 * apps = the same scoped backend's app/installed.apps, using exact app.id.
 * Whole-App rejection avoids a partially mapped switch pretending full coverage.
 */
export function mapAppTools({ servers, apps } = {}) {
  const ids = Array.isArray(apps) ? apps.filter(app => text(app?.id)).map(app => app.id) : [];
  const known = new Set(ids), failures = new Map(), byApp = new Map();
  for (const id of ids) if (ids.indexOf(id) !== ids.lastIndexOf(id)) failures.set(id, 'APP_ID_AMBIGUOUS');
  const catalog = Array.isArray(servers) ? servers.filter(server => server?.name === 'codex_apps') : [];
  if (catalog.length !== 1 || !Array.isArray(catalog[0].appTools)) {
    for (const id of known) failures.set(id, catalog.length > 1 ? 'APP_SERVER_AMBIGUOUS' : 'APP_TOOL_CATALOG_UNAVAILABLE');
  } else {
    for (const tool of catalog[0].appTools) {
      const appId = metaText(tool?.connectorId);
      if (!appId || !known.has(appId)) continue;
      if (!Object.hasOwn(tool, 'connectorName')) { failures.set(appId, 'CONNECTOR_NAME_OBSERVATION_MISSING'); continue; }
      const hookToolName = canonicalAppHookName(tool);
      if (!hookToolName) { failures.set(appId, 'APP_TOOL_MAPPING_INVALID'); continue; }
      const binding = { serverName: 'codex_apps', toolName: tool.name, hookToolName };
      const existing = byApp.get(appId) ?? [];
      if (!existing.some(item => item.toolName === binding.toolName && item.hookToolName === binding.hookToolName)) existing.push(binding);
      byApp.set(appId, existing);
    }
  }
  const hookOwners = new Map(), rawOwners = new Map();
  for (const [appId, bindings] of byApp) for (const binding of bindings) {
    for (const [map, key] of [[hookOwners, binding.hookToolName], [rawOwners, binding.toolName]]) {
      const owners = map.get(key) ?? new Set(); owners.add(appId); map.set(key, owners);
    }
  }
  for (const owners of [...hookOwners.values(), ...rawOwners.values()]) if (owners.size > 1) {
    for (const appId of owners) failures.set(appId, 'APP_TOOL_BINDING_AMBIGUOUS');
  }
  // Different raw operations collapsing to one hook name are ambiguous even
  // within a single App; exact raw-vs-hook dispatch must not silently diverge.
  for (const [appId, bindings] of byApp) {
    if (new Set(bindings.map(item => item.hookToolName)).size !== bindings.length) failures.set(appId, 'APP_TOOL_BINDING_AMBIGUOUS');
  }
  const mappings = [], unsupportedApps = [];
  for (const appId of [...known].sort()) {
    const bindings = byApp.get(appId) ?? [];
    const reason = failures.get(appId) ?? (!bindings.length ? 'APP_TOOL_BINDINGS_MISSING' : null);
    if (reason) { unsupportedApps.push({ appId, reason }); continue; }
    bindings.sort((a, b) => a.hookToolName < b.hookToolName ? -1 : a.hookToolName > b.hookToolName ? 1 : 0);
    mappings.push({ appId, toolNames: bindings.map(item => item.hookToolName), toolBindings: bindings });
  }
  return { mappings, unsupportedApps };
}
