const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
const nameValid = value => typeof value === 'string' && value.length > 0 && value.length <= 512
  && !/[\u0000-\u001f\u007f]/u.test(value) && !reserved.has(value);
const text = value => typeof value === 'string' && value.length > 0 && !value.includes('\0');
const fields = new Set(['command', 'args', 'enabled', 'url', 'transport', 'type']);
const quotePath = parts => parts.map(part => /^[A-Za-z0-9_-]+$/u.test(part) ? part : JSON.stringify(part)).join('.');

// Only top-level override keys are TOML paths; object member names are literal.
function parseKey(key) {
  const parts = [];
  for (let i = 0; i < key.length;) {
    if (key[i] === '"' || key[i] === "'") {
      const quote = key[i], start = i++;
      let escaped = false;
      for (; i < key.length; i += 1) {
        if (quote === '"' && !escaped && key[i] === '\\') { escaped = true; continue; }
        if (!escaped && key[i] === quote) break;
        escaped = false;
      }
      if (i === key.length) return null;
      const token = key.slice(start, ++i);
      try { parts.push(quote === '"' ? JSON.parse(token) : token.slice(1, -1)); } catch { return null; }
    } else {
      const start = i;
      while (i < key.length && key[i] !== '.') i += 1;
      const token = key.slice(start, i);
      if (!/^[A-Za-z0-9_-]+$/u.test(token)) return null;
      parts.push(token);
    }
    if (!nameValid(parts.at(-1))) return null;
    if (i === key.length) break;
    if (key[i++] !== '.' || i === key.length) return null;
  }
  return parts.length ? parts : null;
}

function inspect(config) {
  const servers = new Map();
  let invalid = false, categoryRoot, hasDotted = false;
  const server = name => {
    if (!nameValid(name)) { invalid = true; return null; }
    if (!servers.has(name)) servers.set(name, { fields: new Map(), invalid: false });
    return servers.get(name);
  };
  const addField = (entry, key, value, location) => {
    if (!fields.has(key)) return;
    if (entry.fields.has(key)) { entry.invalid = true; return; }
    entry.fields.set(key, { value, ...location });
  };
  const addTable = (name, value, location) => {
    const entry = server(name);
    if (!entry) return;
    if (!record(value) || entry.container) { entry.invalid = true; return; }
    entry.container = location;
    for (const [field, child] of Object.entries(value)) addField(entry, field, child, { root: location.root, path: [...location.path, field] });
  };
  for (const [key, value] of Object.entries(config)) {
    const parts = parseKey(key);
    if (!parts) { if (key.startsWith('mcp_servers') || key.startsWith('"mcp_servers"') || key.startsWith("'mcp_servers'")) invalid = true; continue; }
    if (parts[0] !== 'mcp_servers') continue;
    if (parts.length === 1) {
      if (!record(value) || categoryRoot) { invalid = true; continue; }
      categoryRoot = key;
      for (const [name, child] of Object.entries(value)) addTable(name, child, { root: key, path: [name] });
    } else {
      hasDotted = true;
      const entry = server(parts[1]);
      if (!entry) continue;
      if (parts.length === 2) addTable(parts[1], value, { root: key, path: [] });
      else if (parts.length === 3) addField(entry, parts[2], value, { root: key, path: [] });
      else if (fields.has(parts[2])) entry.invalid = true;
    }
  }
  return { servers, invalid, categoryRoot, hasDotted };
}

function setNested(value, path, replacement) {
  if (!path.length) return replacement;
  const [key, ...rest] = path;
  return { ...value, [key]: setNested(value?.[key], rest, replacement) };
}
function replaceField(config, host, name, field, value) {
  const entry = host.servers.get(name);
  const location = entry?.fields.get(field)
    ?? (entry?.container && { root: entry.container.root, path: [...entry.container.path, field] })
    ?? (host.categoryRoot && { root: host.categoryRoot, path: [name, field] });
  if (location) return { ...config, [location.root]: setNested(config[location.root], location.path, value) };
  if (host.hasDotted) return { ...config, [quotePath(['mcp_servers', name, field])]: value };
  return { ...config, mcp_servers: { ...config.mcp_servers, [name]: { ...config.mcp_servers?.[name], [field]: value } } };
}

/**
 * Wraps resolved ordinary stdio MCP launch commands in process-local lifecycle
 * overrides. effectiveConfig must be the trusted same-backend config/read.config.
 * Host overrides win; request fields, permissions and server env/cwd stay intact.
 * This neither changes enabled flags nor proves an already loaded task reloaded.
 * wrappedServers includes existing wrappers with alreadyWrapped: true.
 */
export function prepareMcpLaunch({ message, effectiveConfig, nodeExecutable, gatewayFile, runtimeConfigFile, catalog } = {}) {
  const wrappedServers = [], unsupportedServers = [];
  const unchanged = () => ({ message, changed: false, wrappedServers, unsupportedServers });
  const reject = (serverName, reason, extra = {}) => unsupportedServers.push({ serverName, reason, ...extra });
  if (!record(message) || !['thread/start', 'thread/resume', 'thread/fork'].includes(message.method)) return unchanged();
  if (!record(message.params) || (message.params.config != null && !record(message.params.config))) {
    reject('*', 'HOST_CONFIG_INVALID'); return unchanged();
  }
  if (!record(effectiveConfig) || ![nodeExecutable, gatewayFile, runtimeConfigFile].every(text)) {
    reject('*', 'LAUNCH_CONFIGURATION_INVALID'); return unchanged();
  }
  const host = inspect(message.params.config ?? {}), baseline = inspect(effectiveConfig);
  if (host.invalid || baseline.invalid) { reject('*', 'MCP_CONFIG_AMBIGUOUS'); return unchanged(); }
  const items = Array.isArray(catalog) ? catalog : Array.isArray(catalog?.items) ? catalog.items : [];
  const pluginNames = new Set();
  for (const item of items) {
    const mapping = item?.kind === 'mcp' ? item.configMapping : null;
    if (mapping?.kind === 'plugin-mcp-server') {
      pluginNames.add(mapping.serverName);
      reject(mapping.serverName, 'PLUGIN_SERVER_UNRESOLVED', { pluginKey: mapping.pluginKey });
    } else if (mapping?.kind === 'mcp-server' && !host.servers.has(mapping.serverName) && !baseline.servers.has(mapping.serverName)) {
      reject(mapping.serverName, 'SERVER_CONFIG_UNRESOLVED');
    }
  }
  let config = message.params.config ?? {};
  for (const name of new Set([...baseline.servers.keys(), ...host.servers.keys()])) {
    if (pluginNames.has(name)) continue;
    const base = baseline.servers.get(name), override = host.servers.get(name);
    if (base?.invalid || override?.invalid) { reject(name, 'SERVER_CONFIG_AMBIGUOUS'); continue; }
    const get = key => override?.fields.has(key) ? override.fields.get(key).value : base?.fields.get(key)?.value;
    if (get('enabled') === false) continue;
    if (get('enabled') !== undefined && get('enabled') !== true) { reject(name, 'SERVER_ENABLED_INVALID'); continue; }
    if (get('url') != null || [get('type'), get('transport')].some(value => value != null && value !== 'stdio')) {
      reject(name, 'NON_STDIO_SERVER'); continue;
    }
    const command = get('command'), args = get('args') === undefined ? [] : get('args');
    if (!text(command) || !Array.isArray(args) || !args.every(value => typeof value === 'string' && !value.includes('\0'))) {
      reject(name, 'STDIO_COMMAND_INVALID'); continue;
    }
    const info = { serverName: name, pluginKey: '', configPath: ['mcp_servers', name] };
    if (command === gatewayFile || args[0] === gatewayFile) {
      if (command === nodeExecutable && args[0] === gatewayFile && args[1] === runtimeConfigFile
        && args[2] === name && args[3] === '' && args[4] === '--' && text(args[5])) {
        wrappedServers.push({ ...info, alreadyWrapped: true });
      } else reject(name, 'EXISTING_GATEWAY_CONFIGURATION_UNRECOGNIZED');
      continue;
    }
    if (process.platform === 'win32') {
      if (/\.(?:cmd|bat)$/iu.test(command)) { reject(name, 'BATCH_COMMAND_UNSUPPORTED'); continue; }
      // A bare command can resolve to a .cmd via the backend's PATH/PATHEXT.
      // Node's shell-free spawn cannot execute that file. Do not introduce a
      // command shell or guess the gateway's eventual environment here.
      if (!/[\\/]/u.test(command) && !/\.[^.]+$/u.test(command)) { reject(name, 'BARE_COMMAND_UNRESOLVED'); continue; }
    }
    config = replaceField(config, host, name, 'command', nodeExecutable);
    config = replaceField(config, host, name, 'args', [gatewayFile, runtimeConfigFile, name, '', '--', command, ...args]);
    wrappedServers.push({ ...info, alreadyWrapped: false });
  }
  if (!wrappedServers.some(server => !server.alreadyWrapped)) return unchanged();
  return { message: { ...message, params: { ...message.params, config } }, changed: true, wrappedServers, unsupportedServers };
}
