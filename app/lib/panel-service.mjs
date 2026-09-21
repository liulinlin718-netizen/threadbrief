import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { ThreadStore } from './store.mjs';
import { openThreadBindings } from './thread-bindings.mjs';
import { readNativeEvidence } from './native-evidence.mjs';

const publicDirectory = new URL('../public/', import.meta.url);
const staticFiles = new Map([
  ['/assets/panel.js', ['panel.js', 'text/javascript; charset=utf-8']],
  ['/assets/panel.css', ['panel.css', 'text/css; charset=utf-8']],
]);
function problem(status, message, code) { return Object.assign(new Error(message), { status, code }); }
function equal(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
async function jsonBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw problem(415, '需要 JSON 请求');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 160000) throw problem(413, '内容过长');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch { throw problem(400, '无效 JSON'); }
}

// A binding is supplied by the local launcher. Browser input cannot select another thread.
export async function createPanelService({ binding, dataDirectory, evidenceDirectory, catalog = [], port = 0, panelToken, registryDirectory, nativeEvidenceDirectory, bridgeDirectory }) {
  if (!binding || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(binding.threadId)) throw new TypeError('A real thread UUID is required');
  if (!binding.hostId || !binding.accountScope) throw new TypeError('An explicit host and account scope is required');
  const scope = { hostId: binding.hostId, accountScope: binding.accountScope, threadId: binding.threadId };
  const store = new ThreadStore(dataDirectory);
  // Validates namespace before accepting traffic; does not create default configuration.
  await store.get(scope);
  if (panelToken !== undefined && !/^[A-Za-z0-9_-]{32}$/.test(panelToken)) throw new TypeError('Invalid local panel token');
  const registry = registryDirectory ? await openThreadBindings({ directory: registryDirectory, binding }) : null;
  const registration = registry ? await registry.register({ threadId: binding.threadId, title: binding.title }, { token: panelToken }) : null;
  const token = registration?.token ?? panelToken ?? randomBytes(24).toString('base64url');
  const base = `/panel/${token}`;
  let origin;
  const primary = { binding, scope, visible: null, catalog: catalog.map(entry => ({ ...entry, control: 'preference-only' })) };
  const contexts = new Map([[token, primary]]);
  async function contextForToken(candidate) {
    if (!registry && equal(candidate, token)) return primary;
    const registered = registry ? await registry.lookup(candidate) : null;
    if (!registered) return null;
    let context = contexts.get(candidate);
    if (context && context.scope.threadId !== registered.threadId) throw new TypeError('Panel binding changed its task identity');
    if (!context) {
      const registeredScope = { hostId: registered.hostId, accountScope: registered.accountScope, threadId: registered.threadId };
      await store.get(registeredScope);
      context = { binding: registered, scope: registeredScope, visible: null, catalog: [] };
      contexts.set(candidate, context);
    }
    context.binding = registered;
    return context;
  }
  async function state(context = primary) {
    const { binding, scope, visible, catalog: safeCatalog } = context;
    const config = await store.get(scope);
    const versionHistory = await store.sharedVersionHistory(scope);
    const native = await readNativeEvidence(nativeEvidenceDirectory, scope, { bridgeDirectory });
    const live = native?.live === true;
    const failedKinds = new Set(native?.evidence?.catalogFailedKinds || []);
    const currentCatalog = live ? native.evidence.catalog.map(entry => {
      if (native.catalogFresh && !failedKinds.has(entry.kind)) return entry;
      const reason = failedKinds.has(entry.kind) ? '此类目录读取失败 · 保留旧快照，当前运行状态未知' : '目录旧快照 · 当前运行状态未知';
      return { ...entry, effective: null, reason, source: `${entry.source} · 旧快照` };
    }) : safeCatalog;
    const integration = {
      context: { status: 'not-connected', label: '宿主未接入 · 人设仅保存于本地' },
      capabilities: { status: 'not-connected', label: '未接通实际能力控制' },
      mount: { status: visible ? 'page-observed' : 'waiting', label: visible ? '页面已加载 · 自动挂载待接入' : '等待面板加载' },
    };
    if (live) {
      const evidence = native.evidence;
      if (native.bridge.profileOverlay && ['ready', 'accepted'].includes(evidence.profileStatus)) {
        integration.context = { status: 'connected', label: '宿主已接通 · 后续轮次读取任务配置' };
        if (evidence.profileStatus === 'accepted' && evidence.profileRevision === config.revision) integration.context = { status: 'accepted', label: '宿主已接受本版本 · 模型消费未确认' };
      } else if (evidence.profileStatus === 'error') integration.context = { status: 'error', label: '人设请求未被接受 · 本地配置已保留' };
      const capabilityLabels = {
        'catalog-observed': '目录已连接 · 执行控制未确认',
        'pending-reload': '任务选择等待宿主自然恢复后应用',
        'partially-prepared': '部分任务选择已准备 · 仍有未支持项',
      };
      if (capabilityLabels[evidence.capabilityStatus]) integration.capabilities = { status: evidence.capabilityStatus, label: capabilityLabels[evidence.capabilityStatus] };
      else if (evidence.capabilityStatus === 'enforced') integration.capabilities = native.bridge.capabilityEnforcement
        ? { status: 'connected', label: '任务能力执行控制已接通' }
        : { status: 'catalog-observed', label: '目录已连接 · 执行控制未确认' };
      if (!native.catalogFresh) integration.capabilities = { status: 'catalog-stale', label: '目录旧快照 · 当前运行状态未知' };
      else if (failedKinds.size) integration.capabilities = { status: 'catalog-partial', label: '部分目录读取失败 · 对应运行状态未知' };
      if (evidence.toolPolicyStatus === 'error') integration.capabilities = { status: 'error', label: '能力控制暂不可用' };
      else if (native.bridge.toolPolicyHooks && evidence.toolPolicyStatus === 'observed') integration.capabilities = { status: 'connected', label: 'MCP 与插件执行校验已运行' };
      else if (native.bridge.toolPolicyHooks && evidence.toolPolicyStatus === 'registered') integration.capabilities = { status: 'registered', label: 'MCP 与插件执行校验已注册' };
      if (evidence.mountStatus === 'queued') integration.mount = { status: 'native-queued', label: '宿主已排队打开本任务面板' };
      else if (evidence.mountStatus === 'opened') integration.mount = { status: 'native-opened', label: '宿主已打开本任务面板' };
      else if (evidence.mountStatus === 'error') integration.mount = { status: 'error', label: '宿主打开面板失败 · 可重试' };
      if (visible) integration.mount = { status: 'page-observed', label: '卡片页面已加载 · 宿主连接在线' };
    } else if (native) {
      integration.context.label = '宿主连接未确认 · 人设仅保存于本地';
      integration.capabilities.label = '宿主状态已过期 · 执行控制未确认';
      integration.mount = { status: visible ? 'page-observed' : 'waiting', label: visible ? '页面已加载 · 宿主连接未确认' : '等待宿主重新连接' };
    }
    return {
      thread: { id: binding.threadId, title: binding.title || '当前任务', hostId: binding.hostId },
      config,
      catalog: currentCatalog.map(entry => ({ ...entry, desired: config.overrides[entry.id] || 'inherit', effective: live ? entry.effective : null,
        ...(['mcp', 'plugin'].includes(entry.kind) && live && (native?.bridge?.toolPolicyHooks || native.evidence.toolPolicyStatus === 'error') && native.evidence.toolPolicyStatus ? {
          executionPolicy: native.evidence.toolPolicyStatus,
          reason: native.evidence.toolPolicyStatus === 'error'
            ? '宿主暂时无法运行本任务的能力控制；偏好仍可编辑和保存'
            : '开关在本任务工具执行前校验；不修改全局开关或工具定义',
        } : {}),
        ...(entry.kind === 'skill' && native?.bridge?.skillTurnInput && live ? {
          inclusion: config.overrides[entry.id] === 'on'
            ? native.evidence.skillInputRevision === config.revision && native.evidence.skillInputIds?.includes(entry.id) ? 'accepted' : 'next-turn'
            : config.overrides[entry.id] === 'off' ? 'stopped' : 'inherit',
        } : {}),
      })),
      integration,
      ...versionHistory,
      notice: live ? native.catalogFresh && !failedKinds.size
        ? '本任务目录来自已连接宿主。目录观测、已保存的选择和执行控制分别显示；排队打开面板不代表配置已经生效。'
        : '宿主连接仍在线；目录包含旧快照或读取失败项，当前运行状态未知。桥接层会自动重试实时目录，已知任务偏好仍可编辑。'
        : safeCatalog.length
        ? '目录来自本机配置快照；当前任务的执行状态未确认。开关只保存任务偏好。MCP / 应用目录尚未接入。'
        : '任务配置可保存、重开和回滚。宿主尚未提供此任务的能力目录或执行接口，保存不等于实际生效。',
    };
  }
  function headers(response, mime = 'application/json; charset=utf-8') {
    response.setHeader('Content-Type', mime);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  }
  const server = createServer(async (request, response) => {
    headers(response);
    try {
      if (request.headers.host !== new URL(origin).host) throw problem(403, '无效本机地址');
      if (request.headers.origin && request.headers.origin !== origin) throw problem(403, '拒绝跨站请求');
      if (request.headers['sec-fetch-site'] === 'cross-site') throw problem(403, '拒绝跨站请求');
      const url = new URL(request.url, origin);
      if (url.pathname === '/health' && request.method === 'GET') {
        response.end(JSON.stringify({ service: 'ThreadBrief', version: '0.3.2' })); return;
      }
      if (staticFiles.has(url.pathname) && request.method === 'GET') {
        const [file, mime] = staticFiles.get(url.pathname);
        headers(response, mime);
        response.end(await readFile(new URL(file, publicDirectory))); return;
      }
      const parts = url.pathname.split('/');
      const context = parts[1] === 'panel' ? await contextForToken(parts[2] || '') : null;
      if (!context) throw problem(404, '面板地址无效或已失效');
      const { scope } = context;
      const suffix = url.pathname.slice(`/panel/${parts[2]}`.length);
      if ((suffix === '' || suffix === '/') && request.method === 'GET') {
        headers(response, 'text/html; charset=utf-8');
        response.end(await readFile(new URL('index.html', publicDirectory))); return;
      }
      let result;
      if (suffix === '/api/state' && request.method === 'GET') result = await state(context);
      else if (suffix === '/api/history' && request.method === 'GET') {
        result = await store.sharedVersionHistory(scope);
      } else if (['/api/history/rename', '/api/history/delete'].includes(suffix) && request.method === 'POST') {
        const body = await jsonBody(request);
        const input = { expectedRevision: body.expectedRevision, expectedHistoryRevision: body.expectedHistoryRevision, targetRevision: body.targetRevision, name: body.name };
        if (suffix === '/api/history/rename') await store.renameSharedVersion(scope, input);
        else await store.deleteSharedVersion(scope, input);
        result = await state(context);
      } else if (suffix === '/api/config' && request.method === 'PUT') {
        const body = await jsonBody(request);
        await store.save(scope, { expectedRevision: body.expectedRevision, persona: body.persona, background: body.background, overrides: body.overrides });
        result = await state(context);
      } else if (suffix === '/api/rollback' && request.method === 'POST') {
        const body = await jsonBody(request);
        await store.restoreSharedVersion(scope, { expectedRevision: body.expectedRevision, targetRevision: body.targetRevision });
        result = await state(context);
      } else if (suffix === '/api/visible' && request.method === 'POST') {
        const body = await jsonBody(request);
        if (![body.width, body.height].every(n => Number.isSafeInteger(n) && n > 0 && n < 20000) || !['visible', 'hidden'].includes(body.visibility)) throw problem(400, '无效显示回执');
        const visible = { threadId: scope.threadId, receivedAt: new Date().toISOString(), width: body.width, height: body.height, visibility: body.visibility, userAgent: (request.headers['user-agent'] || '').slice(0,400) };
        context.visible = visible;
        if (evidenceDirectory) {
          await mkdir(path.join(evidenceDirectory, 'panel-visible'), { recursive: true });
          await writeFile(path.join(evidenceDirectory, 'panel-visible', `${scope.threadId}.json`), JSON.stringify(visible, null, 2));
          if (context === primary) await writeFile(path.join(evidenceDirectory, 'panel-visible.json'), JSON.stringify(visible, null, 2));
          await appendFile(path.join(evidenceDirectory, 'panel-visible.ndjson'), JSON.stringify(visible) + '\n');
        }
        result = { received: true, evidence: 'page-loaded-only' };
      } else throw problem(404, '接口不存在');
      response.end(JSON.stringify(result));
    } catch (error) {
      response.statusCode = error.status || (['REVISION_CONFLICT', 'HISTORY_CONFLICT'].includes(error.code) ? 409 : error.code === 'REVISION_NOT_FOUND' ? 404 : error.code === 'LOCK_TIMEOUT' ? 503 : error instanceof TypeError || error.code === 'VALIDATION_ERROR' ? 400 : 500);
      response.end(JSON.stringify({ error: response.statusCode === 500 ? '本地存储暂时不可用，请重试；草稿尚未提交' : error.message, code: error.code || 'REQUEST_FAILED' }));
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, store, scope, registry, url: origin + base, origin, state, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
