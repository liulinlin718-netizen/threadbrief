const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{32}$/;
const LIFECYCLE = new Set(['thread/start', 'thread/resume', 'thread/fork']);
const NATIVE_PLUGIN = 'codex-app-tools@openai-bundled';
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const INTERNAL_REASON = Symbol('panelFailureReason');
const fail = code => Object.assign(new Error(code), { [INTERNAL_REASON]: code });

function rpcResult(response) {
  if (!isRecord(response) || response.error != null || !isRecord(response.result)) throw fail('RPC_REJECTED');
  return response.result;
}

// Only the native tool's explicit acknowledgement is authoritative. A successful
// JSON-RPC envelope, text mentioning "queued", or an MCP isError is not one.
function panelAcknowledgement(result, threadId) {
  if (result.isError === true) throw fail('TOOL_ERROR');
  const candidates = [];
  if (isRecord(result.structuredContent)) candidates.push(result.structuredContent);
  for (const block of Array.isArray(result.content) ? result.content : []) {
    if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length > 8192) continue;
    try {
      const value = JSON.parse(block.text);
      if (isRecord(value)) candidates.push(value);
    } catch { /* Non-JSON text is never accepted as evidence of a mount. */ }
  }
  const acknowledgements = candidates.filter(value => Object.hasOwn(value, 'status'));
  if (!acknowledgements.length) throw fail('ACKNOWLEDGEMENT_MISSING');
  if (acknowledgements.some(value => !['queued', 'opened'].includes(value.status)
    || value.threadId !== threadId)) throw fail('ACKNOWLEDGEMENT_INVALID');
  const status = acknowledgements[0].status;
  if (acknowledgements.some(value => value.status !== status)) throw fail('ACKNOWLEDGEMENT_CONFLICT');
  return status;
}

function localPanelOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('A local panel origin is required');
  }
  return url.origin;
}

// Trusted backend-only integration. Observe only matched successful backend
// responses; mount() callers must supply an ID obtained from the real backend.
// This module never starts a task/turn, alters messages or tool schemas, or reads
// host secrets. Success deduplication lasts for this adapter process only.
export function createAutomaticPanel({ rpc, registry, panelOrigin, onObservation, onCatalog, isToolAllowed }) {
  if (typeof rpc?.call !== 'function' || typeof registry?.register !== 'function') {
    throw new TypeError('An RPC client and task registry are required');
  }
  const origin = localPanelOrigin(panelOrigin);
  const inFlight = new Map();
  const accepted = new Map();
  const publish = (callback, value) => {
    // Evidence consumers are not awaited and cannot fail opening or the relay.
    if (typeof callback !== 'function') return;
    try { Promise.resolve(callback(value)).catch(() => {}); } catch { /* Observer only. */ }
  };

  async function readCatalog(threadId) {
    const servers = [];
    const cursors = new Set();
    let cursor;
    for (let page = 0; page < 5; page++) {
      const result = rpcResult(await rpc.call('mcpServerStatus/list', {
        threadId, detail: 'toolsAndAuthOnly', limit: 100, ...(cursor ? { cursor } : {}),
      }));
      if (!Array.isArray(result.data)) throw fail('CATALOG_INVALID');
      for (const server of result.data) {
        if (!isRecord(server) || typeof server.name !== 'string' || !isRecord(server.tools)) throw fail('CATALOG_INVALID');
        servers.push(Object.freeze({
          name: server.name,
          pluginId: typeof server.pluginId === 'string' ? server.pluginId : null,
          runtimeStatus: typeof server.runtimeStatus === 'string' ? server.runtimeStatus : null,
          toolNames: Object.freeze(Object.values(server.tools).filter(tool => typeof tool?.name === 'string').map(tool => tool.name)),
          ...(server.name === 'codex_apps' ? { appTools: Object.freeze(Object.values(server.tools).filter(tool => typeof tool?.name === 'string'
            && typeof tool?._meta?.connector_id === 'string').map(tool => Object.freeze({
              name: tool.name, connectorId: tool._meta.connector_id.trim(),
              connectorName: [tool._meta.connector_name, tool._meta.connector_display_name].find(value => typeof value === 'string' && value.trim())?.trim() ?? null,
            }))) } : {}),
        }));
      }
      if (result.nextCursor == null) return Object.freeze(servers);
      if (typeof result.nextCursor !== 'string' || !result.nextCursor || cursors.has(result.nextCursor)) throw fail('CATALOG_INVALID');
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw fail('CATALOG_LIMIT');
  }

  async function attempt({ threadId, title }) {
    let outcome;
    try {
      // Every observed task gets its own durable card, including tasks where
      // the native UI tool is unavailable or deliberately switched off.
      const record = await registry.register({ threadId, ...(title === undefined ? {} : { title }) });
      if (record?.threadId !== threadId || typeof record.token !== 'string' || !TOKEN.test(record.token)) throw fail('BINDING_INVALID');
      const servers = await readCatalog(threadId);
      publish(onCatalog, Object.freeze({ threadId, servers }));
      const native = servers.find(server => server.name === 'codex_app'
        && server.pluginId === NATIVE_PLUGIN && server.runtimeStatus === 'connected'
        && server.toolNames.includes('open_in_codex'));
      if (!native) {
        outcome = { threadId, status: 'unavailable', accepted: false, visible: null, reason: 'NATIVE_TOOL_UNAVAILABLE' };
      } else if (isToolAllowed && !await isToolAllowed({ threadId, server: 'codex_app', tool: 'open_in_codex' })) {
        outcome = { threadId, status: 'unavailable', accepted: false, visible: null, reason: 'TASK_CAPABILITY_DISABLED' };
      } else {
        const result = rpcResult(await rpc.call('mcpServer/tool/call', {
          threadId, server: 'codex_app', tool: 'open_in_codex',
          _meta: { thread_id: threadId, threadId },
          arguments: {
            threadId, placement: 'right',
            target: { type: 'browser', url: `${origin}/panel/${record.token}` },
          },
        }));
        const status = panelAcknowledgement(result, threadId);
        // queued means accepted by the task action queue, not visibly mounted.
        outcome = { threadId, status, accepted: true, visible: status === 'opened' ? true : null };
      }
    } catch (error) {
      // Never propagate or log tool output, token URLs, RPC bodies or error text.
      outcome = { threadId, status: 'failed', accepted: false, visible: null, reason: error?.[INTERNAL_REASON] || 'PANEL_REQUEST_FAILED' };
    }
    const observation = Object.freeze(outcome);
    if (observation.accepted) accepted.set(threadId, observation);
    publish(onObservation, observation);
    return observation;
  }

  function mount({ threadId, title } = {}) {
    if (typeof threadId !== 'string' || !UUID.test(threadId)) {
      return Promise.resolve(Object.freeze({ status: 'ignored', accepted: false, visible: null, reason: 'INVALID_THREAD_ID' }));
    }
    if (accepted.has(threadId)) return Promise.resolve(accepted.get(threadId));
    if (inFlight.has(threadId)) return inFlight.get(threadId);
    const pending = attempt({ threadId, title }).finally(() => { inFlight.delete(threadId); });
    inFlight.set(threadId, pending);
    return pending;
  }

  function observe({ method, response } = {}) {
    if (!LIFECYCLE.has(method) || !isRecord(response) || response.error != null) return false;
    const thread = response.result?.thread;
    if (typeof thread?.id !== 'string' || !UUID.test(thread.id)) return false;
    // Do not take the preview field: it may contain private user message text.
    const title = typeof thread.name === 'string' && thread.name.length <= 500
      && !/[\u0000-\u001f\u007f]/u.test(thread.name) ? thread.name : undefined;
    setImmediate(() => { void mount({ threadId: thread.id, title }); });
    return true;
  }

  async function refreshCatalog({ threadId, waitForObserver = false } = {}) {
    if (!UUID.test(threadId || '')) return false;
    try {
      const observation = Object.freeze({ threadId, servers: await readCatalog(threadId) });
      if (waitForObserver && onCatalog) await onCatalog(observation);
      else publish(onCatalog, observation);
      return true;
    } catch { return false; }
  }
  return { mount, observe, refreshCatalog };
}
