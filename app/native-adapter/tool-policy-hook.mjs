import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ThreadStore } from '../lib/store.mjs';
import { readNativeEvidence } from '../lib/native-evidence.mjs';
import { mcpCapabilityId } from './mcp-policy.mjs';
import { readHookScope } from './hook-scope.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
const sameScope = (a, b) => ['hostId', 'accountScope', 'threadId'].every(key => a?.[key] === b[key]);
const managedToolName = value => typeof value === 'string' && /^mcp__.+__.+$/u.test(value);
const managedTool = input => input?.hook_event_name === 'PreToolUse'
  && managedToolName(input.tool_name);
const denied = reason => ({ hookSpecificOutput: {
  hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
} });
const unavailable = () => denied('ThreadBrief could not verify this task capability policy. The tool was not executed.');

/**
 * Codex invokes this trusted hook before native MCP dispatch. Hook input is
 * backend-created JSON, correlated with a trusted hook/started receipt. Never
 * obtain identity from tool_input, environment or a parent session's card.
 * agent_id, when present, must agree with that backend receipt.
 *
 * Returning null is an exact policy no-op: no permission grant is emitted.
 * Catalog TTL describes runtime observation freshness, not mapping validity.
 * readNativeEvidence still validates the complete scope and stored structure.
 */
export async function evaluateToolPolicyHook({ input, config, authority, store, readEvidence = readNativeEvidence, readScope = readHookScope } = {}) {
  if (!managedTool(input)) return null;
  try {
    const identity = authority ?? JSON.parse(await readFile(config.currentThreadBinding, 'utf8'));
    if (!text(identity?.hostId) || !text(identity?.accountScope)) return unavailable();
    const receipt = await readScope({ input, directory: path.join(config.evidenceDirectory, 'hook-scopes'), authority: identity });
    if (!receipt?.scope) return unavailable();
    return evaluateScopedToolPolicy({ scope: receipt.scope, toolName: input.tool_name, config, store, readEvidence });
  } catch { return unavailable(); }
}

/** Caller must supply scope from trusted backend binding or event correlation. */
export async function evaluateScopedToolPolicy({ scope, toolName, mcpCall, config, store, readEvidence = readNativeEvidence } = {}) {
  if (!managedToolName(toolName)) return null;
  if (!uuid.test(scope?.threadId ?? '') || !text(scope?.hostId) || !text(scope?.accountScope)) return unavailable();
  try {
    const profile = await (store ?? new ThreadStore(config.dataDirectory)).get(scope);
    if (!record(profile) || !Number.isSafeInteger(profile.revision) || profile.revision < 0 || !record(profile.overrides)) return unavailable();
    const disabled = Object.entries(profile.overrides).filter(([id, mode]) => mode === 'off' && /^(?:mcp|plugin|app):/u.test(id));
    // Untouched cards, persona-only edits and Skills must not
    // depend on evidence availability or change the original permission flow.
    if (!disabled.length) return null;
    const observed = await readEvidence(config.nativeEvidenceDirectory, scope, { bridgeDirectory: config.evidenceDirectory });
    const evidence = observed?.evidence;
    if (!record(evidence) || !sameScope(evidence.scope, scope) || !Array.isArray(evidence.catalog)) return unavailable();
    const appMatches = evidence.catalog.filter(item => item.kind === 'app' && item.configMapping?.kind === 'app'
      && item.id === `app:${item.configMapping.appId}` && Array.isArray(item.toolBindings)
      && item.toolBindings.some(binding => binding.serverName === 'codex_apps' && (binding.hookToolName === toolName
        || mcpCall?.server === binding.serverName && mcpCall?.tool === binding.toolName)));
    if (appMatches.length > 1) return unavailable();
    if (appMatches.length === 1 && profile.overrides[mcpCapabilityId('codex_apps')] === 'off') {
      return denied('This capability is disabled in this task card. The tool was not executed.');
    }
    if (appMatches.length === 1 && profile.overrides[appMatches[0].id] === 'off') {
      return denied('This application is disabled in this task card. The tool was not executed.');
    }
    const matches = [];
    for (const item of evidence.catalog) {
      if (item?.kind !== 'mcp') continue;
      const mapping = item.configMapping;
      if (!record(mapping) || !['mcp-server', 'plugin-mcp-server'].includes(mapping.kind) || !text(mapping.serverName)) continue;
      if (!(toolName.startsWith(`mcp__${mapping.serverName}__`) || mcpCall?.server === mapping.serverName
        || appMatches.length && mapping.serverName === 'codex_apps')) continue;
      const pluginKey = mapping.kind === 'plugin-mcp-server' ? mapping.pluginKey : '';
      if ((pluginKey && !text(pluginKey)) || (mapping.kind === 'plugin-mcp-server' && !pluginKey)
        || item.id !== mcpCapabilityId(mapping.serverName, pluginKey)
        || (item.parentId && item.parentId !== `plugin:${pluginKey}`)) return unavailable();
      matches.push({ id: item.id, pluginKey, serverName: mapping.serverName });
    }
    // A disabled task preference must not be bypassed by an unverified server
    // name normalization or a missing catalog entry. Other known servers still
    // proceed below when their own task preferences permit the call.
    if (!matches.length) return appMatches.length === 1 ? null : unavailable();
    // Prefix ambiguity (a__b vs a + a tool b__...) is never guessed. Normal
    // catalog IDs are unique; duplicate or conflicting matches are invalid.
    if (matches.length !== 1) return unavailable();
    const match = matches[0];
    if (match.serverName === 'codex_apps' && !appMatches.length && disabled.some(([id]) => id.startsWith('app:'))) return unavailable();
    const off = profile.overrides[match.id] === 'off'
      || match.pluginKey && profile.overrides[`plugin:${match.pluginKey}`] === 'off';
    return off ? denied('This capability is disabled in this task card. The tool was not executed.') : null;
  } catch {
    // A corrupt card or evidence affects only the hook invocation's own scope.
    // No request arguments, instructions, paths or authentication are logged.
    return unavailable();
  }
}

async function main() {
  let input, decision;
  try {
    const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!managedTool(input)) return;
    const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
    decision = await evaluateToolPolicyHook({ input, config });
  } catch {
    // Unknown/non-MCP events remain untouched even if the hook is registered
    // too broadly. Valid managed input with broken runtime configuration denies.
    if (managedTool(input)) decision = unavailable();
  }
  if (decision) process.stdout.write(JSON.stringify(decision) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
