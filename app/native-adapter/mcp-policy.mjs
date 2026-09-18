import { createHash } from 'node:crypto';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export const mcpCapabilityId = (serverName, pluginKey = '') =>
  `mcp:${createHash('sha256').update(`${pluginKey}:${serverName}`).digest('hex').slice(0, 24)}`;

// Trust boundary: use this only behind the Codex backend that overwrites
// params._meta.threadId with the executing task identity. A raw arbitrary MCP
// client can forge metadata; this module is not its authentication boundary.
// Never infer identity from model-controlled arguments or session_id: parent
// and child agents can share a session but not a task card.
export async function evaluateMcpPolicy({ message, serverName, pluginKey = '', authority, store }) {
  if (message?.method !== 'tools/call') return { allowed: true };
  const threadId = message.params?._meta?.threadId;
  if (!uuid.test(threadId || '')) return { allowed: false, reason: 'TASK_ID_REQUIRED' };
  const scope = { hostId: authority.hostId, accountScope: authority.accountScope, threadId };
  const profile = await store.get(scope);
  const id = mcpCapabilityId(serverName, pluginKey);
  const disabled = profile.overrides[id] === 'off'
    || pluginKey && profile.overrides[`plugin:${pluginKey}`] === 'off';
  return { allowed: !disabled, scope, revision: profile.revision, id,
    ...(disabled ? { reason: 'TASK_CAPABILITY_DISABLED' } : {}) };
}
