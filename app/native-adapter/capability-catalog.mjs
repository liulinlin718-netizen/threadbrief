import { createHash } from 'node:crypto';
import { mapAppTools } from './app-tool-mapping.mjs';

const identity = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const preference = { available: true, effective: null, control: 'preference-only' };

// Proven identifiers come from the backend metadata, never display names or
// the browser's requested preference IDs. No tool schemas are retained.
export async function readCapabilityCatalog({ rpc, scope, cwd, servers }) {
  const items = servers.map(server => ({
    id: `mcp:${identity(`${server.pluginId || ''}:${server.name}`)}`,
    name: server.name, kind: 'mcp',
    defaultEnabled: server.runtimeStatus !== 'disabled',
    // This field controls whether a preference can be edited. A disabled
    // known server must remain switchable back on; effective is runtime state.
    available: true,
    effective: server.runtimeStatus === 'connected' ? true : server.runtimeStatus === 'disabled' ? false : null,
    control: 'preference-only', source: '当前任务 MCP 运行目录',
    reason: server.pluginId === 'codex-app-tools@openai-bundled' && server.name === 'codex_app'
      ? '关闭后自动挂载卡片不可用；已打开的卡片仍可保存'
      : '修改将在任务重新加载时尝试应用',
    ...(server.pluginId ? { parentId: `plugin:${server.pluginId}` } : {}),
    configMapping: server.pluginId
      ? { kind: 'plugin-mcp-server', pluginKey: server.pluginId, serverName: server.name, pluginServerName: server.name }
      : { kind: 'mcp-server', serverName: server.name },
  }));
  const calls = [
    ['skills', 'skills/list', { cwds: [cwd], forceReload: false }],
    ['plugins', 'plugin/installed', { cwds: [cwd] }],
    ['apps', 'app/installed', { threadId: scope.threadId, forceRefresh: false }],
  ];
  const results = await Promise.allSettled(calls.map(([, method, params]) => rpc.call(method, params)));
  const failures = [];
  for (let index = 0; index < results.length; index++) {
    const response = results[index];
    if (response.status !== 'fulfilled' || response.value.error) { failures.push(calls[index][0]); continue; }
    const value = response.value.result;
    if (index === 0) for (const group of value.data || []) for (const skill of group.skills || []) {
      if (!skill.path || !skill.name) continue;
      const key = skill.pluginId ? `plugin:${skill.pluginId};skill:${skill.name}` : `path:${skill.path.replaceAll('\\', '/').toLowerCase()}`;
      items.push({ id: `skill:${identity(key)}`, name: skill.interface?.displayName || skill.name, kind: 'skill',
        defaultEnabled: skill.enabled === true, ...preference, source: '当前任务工作目录的 Skills 配置',
        reason: '开启后在本任务后续输入中加入技能；关闭停止追加，已有历史保留',
        ...(skill.pluginId ? { parentId: `plugin:${skill.pluginId}` } : {}),
        configMapping: { kind: 'skill', path: skill.path, skillName: skill.name },
      });
    }
    if (index === 1) for (const marketplace of value.marketplaces || []) for (const plugin of marketplace.plugins || []) {
      if (!plugin.id || plugin.installed !== true) continue;
      items.push({ id: `plugin:${plugin.id}`, name: plugin.interface?.displayName || plugin.name, kind: 'plugin',
        defaultEnabled: plugin.enabled === true, ...preference, source: '当前任务工作目录的已安装插件',
        reason: plugin.id === 'codex-app-tools@openai-bundled'
          ? '关闭后自动挂载卡片不可用；已打开的卡片仍可保存'
          : '修改将在任务重新加载时尝试应用', configMapping: { kind: 'plugin', pluginKey: plugin.id },
      });
    }
    if (index === 2) {
      const mappings = new Map(mapAppTools({ servers, apps: value.apps || [] }).mappings.map(item => [item.appId, item]));
      for (const app of value.apps || []) {
      if (!app.id) continue;
      const mapped = mappings.get(app.id);
      items.push({ id: `app:${app.id}`, name: app.name || app.runtimeName || app.id, kind: 'app',
        defaultEnabled: app.enabled === true, ...preference, effective: typeof app.enabled === 'boolean' && typeof app.callable === 'boolean' ? app.enabled && app.callable : null,
        source: '当前任务已提交的应用目录',
        reason: mapped ? '执行映射来自宿主工具元数据；真实应用调用待验证' : '宿主尚未提供可核对的应用工具映射',
        ...(mapped ? { toolBindings: mapped.toolBindings } : {}),
        configMapping: { kind: 'app', appId: app.id },
      });
      }
    }
  }
  for (const item of items) if (item.kind === 'plugin') item.childIds = items.filter(child => child.parentId === item.id).map(child => child.id);
  return { scope, items, failures };
}
