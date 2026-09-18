// Runs only in the isolated package diagnostic. No model turns, auth reads,
// config changes or calls to tools other than the discovered native panel tool.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { openThreadBindings } from '../lib/thread-bindings.mjs';

export async function probeNativeMount({ rpc, config, runId, automaticPanel }) {
  const output = path.join(config.evidenceDirectory, 'package-diagnostic', `native-mount-${runId}.json`);
  const report = { runId, status: 'running', modelTurns: 0, productionConfigModified: false, startedAt: new Date().toISOString() };
  let ownThreadId;
  const save = async () => { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2)); };
  const result = response => {
    if (response.error) throw Object.assign(new Error('Native probe RPC rejected'), { code: response.error.code });
    return response.result;
  };
  const catalog = async threadId => {
    const servers = [];
    let cursor;
    for (let page = 0; page < 5; page++) {
      const response = result(await rpc.call('mcpServerStatus/list', { ...(threadId ? { threadId } : {}), detail: 'toolsAndAuthOnly', limit: 100, ...(cursor ? { cursor } : {}) }));
      for (const server of response.data) servers.push({
        name: server.name, pluginId: server.pluginId, runtimeStatus: server.runtimeStatus,
        toolNames: Object.values(server.tools).map(tool => tool.name),
        panelTool: Object.values(server.tools).find(tool => tool.name === 'open_in_codex')?.name ?? null,
      });
      cursor = response.nextCursor;
      if (!cursor) return servers;
    }
    throw Object.assign(new Error('Probe catalog pagination limit'), { code: 'CATALOG_LIMIT' });
  };
  try {
    await save();
    report.globalCatalog = await catalog();
    const native = report.globalCatalog.find(server => server.panelTool && (server.name === 'codex_app' || server.pluginId?.startsWith('codex-app-tools@')));
    if (!native) {
      report.status = 'native-panel-tool-not-in-global-catalog';
      return;
    }
    // Durable fixture history exists only in the isolated diagnostic CODEX_HOME.
    // The native UI must be able to read it; no user-owned task is changed.
    const started = result(await rpc.call('thread/start', { ephemeral: false, cwd: path.dirname(config.currentThreadBinding), sandbox: 'read-only', approvalPolicy: 'never' }));
    ownThreadId = started.thread.id;
    report.threadId = ownThreadId;
    report.ephemeral = started.thread.ephemeral;
    report.threadCatalog = await catalog(ownThreadId);
    report.status = report.threadCatalog.some(server => server.name === native.name && server.panelTool)
      ? 'native-panel-tool-discovered-for-fixture' : 'native-panel-tool-not-in-thread-catalog';
    if (report.status !== 'native-panel-tool-discovered-for-fixture') return;
    // A single fixed user fixture item lets native readThread hydrate its task.
    // This is explicit test data, never an injected instruction in a real task.
    result(await rpc.call('thread/inject_items', { threadId: ownThreadId, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ThreadBrief isolated panel fixture. No model turn is requested.' }] }] }));
    const before = result(await rpc.call('thread/read', { threadId: ownThreadId, includeTurns: true }));
    const historyHash = value => createHash('sha256').update(JSON.stringify(value.thread.turns)).digest('hex');
    report.historyBefore = historyHash(before);
    const ownHome = path.resolve(process.env.CODEX_HOME);
    const rolloutPath = before.thread.path;
    const relativeRollout = path.relative(ownHome, rolloutPath || '');
    if (!relativeRollout || relativeRollout.startsWith('..') || path.isAbsolute(relativeRollout)) throw Object.assign(new Error('Fixture rollout outside isolated home'), { code: 'FIXTURE_SCOPE' });
    const rolloutHash = async () => createHash('sha256').update(await readFile(rolloutPath)).digest('hex');
    report.rolloutBefore = await rolloutHash();
    const appRoot = path.dirname(config.currentThreadBinding);
    const binding = JSON.parse(await readFile(config.currentThreadBinding, 'utf8'));
    const panel = JSON.parse(await readFile(path.join(appRoot, '.runtime', 'server.json'), 'utf8'));
    const origin = new URL(panel.url).origin;
    if (new URL(origin).hostname !== '127.0.0.1' || !panel.registryDirectory) throw Object.assign(new Error('Panel registry unavailable'), { code: 'PANEL_NOT_READY' });
    const registry = await openThreadBindings({ directory: panel.registryDirectory, binding });
    const record = await registry.register({ threadId: ownThreadId, title: 'ThreadBrief native mount fixture' });
    const url = `${origin}/panel/${record.token}`;
    report.panelUrl = url;
    const automatic = automaticPanel ? await automaticPanel.mount({ threadId: ownThreadId, title: 'ThreadBrief native mount fixture' }) : null;
    report.automaticModuleUsed = Boolean(automaticPanel);
    if (automatic) report.automaticOutcome = automatic;
    const called = automatic ? { isError: !automatic.accepted, structuredContent: automatic, content: [] } : result(await rpc.call('mcpServer/tool/call', {
      threadId: ownThreadId, server: native.name, tool: 'open_in_codex',
      arguments: { target: { type: 'browser', url }, placement: 'right', threadId: ownThreadId },
      _meta: { thread_id: ownThreadId, threadId: ownThreadId },
    }));
    report.toolIsError = called.isError === true;
    // This one known local UI call returns panel status, not user/auth content.
    report.panelResult = called.structuredContent ?? called.content.filter(item => item.type === 'text').map(item => item.text.slice(0, 2000));
    const after = result(await rpc.call('thread/read', { threadId: ownThreadId, includeTurns: true }));
    report.historyAfter = historyHash(after);
    report.historyUnchanged = report.historyBefore === report.historyAfter;
    report.rolloutAfter = await rolloutHash();
    report.rolloutBytesUnchanged = report.rolloutBefore === report.rolloutAfter;
    report.status = called.isError ? 'native-panel-tool-returned-error' : 'native-panel-tool-call-succeeded';
    if (!called.isError && report.threadCatalog.find(server => server.name === native.name)?.toolNames.includes('navigate_to_codex_page')) {
      const navigation = result(await rpc.call('mcpServer/tool/call', {
        threadId: ownThreadId, server: native.name, tool: 'navigate_to_codex_page',
        arguments: { threadId: ownThreadId }, _meta: { thread_id: ownThreadId, threadId: ownThreadId },
      }));
      report.fixtureNavigationIsError = navigation.isError === true;
      report.fixtureNavigationResult = navigation.structuredContent ?? navigation.content.filter(item => item.type === 'text').map(item => item.text.slice(0, 1000));
      for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        const state = await (await fetch(`${url}/api/state`, { headers: { 'X-ThreadBrief-Token': record.token } })).json();
        if (state.integration?.mount?.status === 'page-observed') { report.browserPageObserved = true; break; }
      }
      report.browserPageObserved ??= false;
    }
  } catch (error) {
    report.status = 'probe-failed'; report.errorCode = error.code ?? 'PROBE_ERROR';
  } finally {
    if (ownThreadId) {
      try { result(await rpc.call('thread/unsubscribe', { threadId: ownThreadId })); report.fixtureUnsubscribed = true; }
      catch { report.fixtureUnsubscribed = false; }
    }
    report.finishedAt = new Date().toISOString();
    await save();
  }
}
