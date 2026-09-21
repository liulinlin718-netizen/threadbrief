import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, mkdir, writeFile, rename, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ThreadStore } from '../lib/store.mjs';
import { relayJsonLines, CONSUME_FRAME } from './framing.mjs';
import { prepareTurn, createAcceptedReceipt } from './request-overlay.mjs';
import { readAcceptedReceipt, writeAcceptedReceipt } from './receipt-ledger.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(path.join(directory, 'runtime-config.json'), 'utf8'));
const args = process.argv.slice(2);
const serverMode = args.includes('app-server') && !args.some(value => ['--help', '-h', 'generate-json-schema', 'generate-ts', 'daemon'].includes(value));
const desktopIntegration = config.automaticPanelMount === true
  && ['desktop-threadbrief', 'desktop-package-diagnostic'].includes(process.env.THREADBRIEF_LAUNCH_KIND);
let hookRegistration, prepareHookTrust;
if (serverMode && desktopIntegration && config.toolPolicyHooks === true) {
  const hooks = await import('./tool-policy-registration.mjs');
  prepareHookTrust = hooks.prepareToolPolicyTrust;
  hookRegistration = hooks.prepareToolPolicyHookArgs({ args, nodeExecutable: config.nodeExecutable,
    hookFile: path.join(directory, 'tool-policy-hook.mjs'), runtimeConfigFile: path.join(directory, 'runtime-config.json'),
    promptHookFile: path.join(directory, 'child-profile-hook.mjs'),
  });
}
const evidenceDirectory = config.evidenceDirectory;
const pending = new Map();
let stopped = false;
let initialized = false;
let heartbeat;
const idKey = value => JSON.stringify(value);
async function atomicJSON(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, file);
}
async function audit(event, extra = {}) {
  // Never log prompts, tool arguments, raw RPC, environment, auth or output text.
  await mkdir(evidenceDirectory, { recursive: true });
  await appendFile(path.join(evidenceDirectory, `bridge-${process.pid}.ndjson`), JSON.stringify({ event, at: new Date().toISOString(), pid: process.pid, ...extra }) + '\n');
}
async function fingerprint(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
if (serverMode && await fingerprint(config.realCodexExecutable) !== config.realCodexSha256.toLowerCase()) {
  throw new Error('Codex binary changed; rebuild and revalidate the adapter before use');
}
const child = spawn(config.realCodexExecutable, hookRegistration?.args ?? args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env } });
const childClosed = new Promise(resolve => child.once('close', code => resolve(code ?? 70)));
child.on('error', error => { process.stderr.write(`ThreadBrief backend launch failed: ${error.code || 'unknown'}\n`); process.exitCode = 70; });
child.stderr.pipe(process.stderr);
if (!serverMode) {
  process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout);
  childClosed.then(code => process.exit(code));
} else {
  const binding = JSON.parse(await readFile(config.currentThreadBinding, 'utf8'));
  const store = new ThreadStore(config.dataDirectory);
  const probeRunId = process.env.THREADBRIEF_NATIVE_MOUNT_PROBE;
  const probeEnabled = process.env.THREADBRIEF_LAUNCH_KIND === 'desktop-package-diagnostic'
    && /^[0-9a-f-]{36}$/i.test(probeRunId || '');
  const integrationEnabled = desktopIntegration;
  const internalRpc = integrationEnabled || probeEnabled ? (await import('./internal-rpc.mjs')).createInternalRpc({
    write: bytes => child.stdin.write(bytes),
    methods: ['mcpServerStatus/list', 'thread/start', 'thread/read', 'thread/inject_items', 'thread/unsubscribe', 'mcpServer/tool/call', 'skills/list', 'plugin/installed', 'app/installed', 'config/read', 'hooks/list'],
    timeoutMs: 15000,
  }) : null;
  let probeStarted = false;
  const startProbe = () => {
    if (!probeEnabled || probeStarted) return;
    probeStarted = true;
    // The desktop may omit an `initialized` notification. A successful
    // initialize response is the authoritative readiness acknowledgement.
    setImmediate(() => import('./native-mount-probe.mjs').then(module => module.probeNativeMount({
      rpc: internalRpc, config, runId: probeRunId, automaticPanel,
    })).catch(error => audit('native-mount-probe-failed', { code: error.code || 'PROBE_ERROR' })));
  };
  const scopeForThread = threadId => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(threadId)
    ? { hostId: binding.hostId, accountScope: binding.accountScope, threadId } : null;
  let automaticPanel, prepareCapabilities, prepareSkills, prepareMcpLaunch, mcpId, readCatalog, evaluateToolPolicy, recordHookScope, recordPromptScope, evidenceWriter, evidenceReader;
  const taskEvidence = new Map();
  const taskCatalogs = new Map();
  const taskCwds = new Map();
  const taskParents = new Map();
  const promptHookTasks = new Set();
  const trustedHookSources = new Set();
  const catalogRefreshes = new Set();
  const catalogRefreshedAt = new Map();
  const observeThread = thread => {
    if (!scopeForThread(thread?.id || '')) return;
    if (typeof thread.cwd === 'string') taskCwds.set(thread.id, thread.cwd);
    const parent = thread.source?.subAgent?.thread_spawn?.parent_thread_id;
    taskParents.set(thread.id, thread.threadSource === 'subagent' && scopeForThread(parent || '')
      && thread.parentThreadId === parent ? parent : null);
  };
  const updateEvidence = async (threadId, patch = {}) => {
    if (!evidenceWriter || !scopeForThread(threadId)) return;
    const value = { ...taskEvidence.get(threadId), ...patch, bridgePid: process.pid };
    taskEvidence.set(threadId, value);
    await evidenceWriter(config.nativeEvidenceDirectory, scopeForThread(threadId), value);
  };
  if (integrationEnabled) {
    try {
      const panel = JSON.parse(await readFile(config.panelMetadataFile, 'utf8'));
      if (panel.hostId !== binding.hostId || panel.accountScope !== binding.accountScope || !panel.registryDirectory) throw new Error('Panel scope mismatch');
      const { openThreadBindings } = await import('../lib/thread-bindings.mjs');
      const registry = await openThreadBindings({ directory: panel.registryDirectory, binding });
      const { createAutomaticPanel } = await import('./automatic-panel.mjs');
      const { readCapabilityCatalog } = await import('./capability-catalog.mjs');
      readCatalog = readCapabilityCatalog;
      ({ prepareSkillTurn: prepareSkills } = await import('./skill-turn.mjs'));
      if (hookRegistration?.enabled) {
        ({ evaluateScopedToolPolicy: evaluateToolPolicy } = await import('./tool-policy-hook.mjs'));
        ({ recordHookScope } = await import('./hook-scope.mjs'));
        if (hookRegistration.promptHook?.enabled) ({ recordPromptScope } = await import('./prompt-scope.mjs'));
      }
      if (config.mcpExecutionGateway === true) {
        ({ prepareMcpLaunch } = await import('./mcp-launch-overlay.mjs'));
        ({ mcpCapabilityId: mcpId } = await import('./mcp-policy.mjs'));
      }
      ({ prepareCapabilityOverlay: prepareCapabilities } = await import('./capability-overlay.mjs'));
      ({ writeNativeEvidence: evidenceWriter, readNativeEvidence: evidenceReader } = await import('../lib/native-evidence.mjs'));
      automaticPanel = createAutomaticPanel({ rpc: internalRpc, registry, panelOrigin: new URL(panel.url).origin,
        isToolAllowed: async ({ threadId, server, tool }) => !evaluateToolPolicy || !await evaluateToolPolicy({
          scope: scopeForThread(threadId), toolName: `mcp__${server}__${tool}`, config, store,
        }),
        onObservation: outcome => updateEvidence(outcome.threadId, { mountStatus: outcome.accepted ? outcome.status : 'error', profileStatus: taskEvidence.get(outcome.threadId)?.profileStatus || 'ready' }),
        onCatalog: async ({ threadId, servers }) => {
          if (!taskCwds.has(threadId)) {
            const read = await internalRpc.call('thread/read', { threadId, includeTurns: false });
            if (!read.error && read.result?.thread?.id === threadId) observeThread(read.result.thread);
          }
          const catalog = await readCapabilityCatalog({ rpc: internalRpc, scope: scopeForThread(threadId), cwd: taskCwds.get(threadId) || path.dirname(config.currentThreadBinding), servers });
          taskCatalogs.set(threadId, catalog);
          await updateEvidence(threadId, { catalog: catalog.items, catalogObservedAt: new Date().toISOString(), catalogFailedKinds: catalog.failures.map(kind => ({ skills: 'skill', plugins: 'plugin', apps: 'app' })[kind]), capabilityStatus: taskEvidence.get(threadId)?.capabilityStatus || 'catalog-observed', profileStatus: taskEvidence.get(threadId)?.profileStatus || 'ready' });
        },
      });
    } catch (error) {
      await audit('automatic-panel-setup-unavailable', { code: error.code || 'PANEL_SETUP' });
    }
  }
  const statusFile = path.join(evidenceDirectory, `bridge-${process.pid}.json`);
  let statusTail = Promise.resolve();
  const writeStatus = () => {
    const snapshot = {
    schemaVersion: 1, pid: process.pid, backendPid: child.pid, initialized, stopped,
    launchKind: process.env.THREADBRIEF_LAUNCH_KIND || 'standalone',
    updatedAt: new Date().toISOString(), hostId: binding.hostId, accountScope: binding.accountScope,
    profileOverlay: true, skillTurnInput: Boolean(prepareSkills), childProfileHook: Boolean(recordPromptScope), toolPolicyHooks: Boolean(hookRegistration?.enabled), capabilityEnforcement: false, automaticPanelMount: Boolean(automaticPanel),
    };
    const write = statusTail.then(() => atomicJSON(statusFile, snapshot));
    statusTail = write.catch(() => {});
    return write;
  };
  await audit('bridge-started', { backendPid: child.pid });
  await writeStatus();
  heartbeat = setInterval(() => {
    writeStatus().catch(() => {});
    for (const threadId of taskEvidence.keys()) {
      updateEvidence(threadId).catch(() => {});
      if (automaticPanel && !catalogRefreshes.has(threadId) && Date.now() - (catalogRefreshedAt.get(threadId) || 0) >= 15_000) {
        catalogRefreshes.add(threadId);
        automaticPanel.refreshCatalog({ threadId, waitForObserver: true })
          .then(refreshed => { if (refreshed) catalogRefreshedAt.set(threadId, Date.now()); })
          .finally(() => catalogRefreshes.delete(threadId));
      }
    }
  }, 10000);
  heartbeat.unref();
  const input = relayJsonLines(process.stdin, child.stdin, async message => {
    internalRpc?.observeClient(message);
    if (message.method === 'initialized') startProbe();
    if (message.method === 'initialize' && message.id !== undefined) pending.set(idKey(message.id), { kind: 'initialize' });
    if (message.method === 'mcpServer/tool/call' && evaluateToolPolicy) {
      const decision = await evaluateToolPolicy({ scope: scopeForThread(message.params?.threadId),
        toolName: `mcp__${message.params?.server}__${message.params?.tool}`, mcpCall: { server: message.params?.server, tool: message.params?.tool }, config, store,
      });
      if (decision) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, result: {
          isError: true, content: [{ type: 'text', text: decision.hookSpecificOutput.permissionDecisionReason }],
        } }) + '\n');
        return CONSUME_FRAME;
      }
    }
    if (automaticPanel && ['thread/start', 'thread/resume', 'thread/fork'].includes(message.method) && message.id !== undefined) {
      let plan, launchPlan, hookPlan;
      const cwd = message.params?.cwd || taskCwds.get(message.params?.threadId);
      if (hookRegistration?.enabled) {
        try {
          const inventory = await internalRpc.call('hooks/list', { ...(cwd ? { cwds: [cwd] } : {}) });
          if (!inventory.error) hookPlan = prepareHookTrust({ message, inventory: inventory.result, registration: hookRegistration });
        } catch { await audit('tool-policy-registration-unavailable'); }
      }
      if (prepareMcpLaunch && !hookPlan?.ready) {
        try {
          const response = await internalRpc.call('config/read', { ...(cwd ? { cwd } : {}), includeLayers: false });
          if (!response.error) launchPlan = prepareMcpLaunch({ message, effectiveConfig: response.result?.config,
            nodeExecutable: config.nodeExecutable, gatewayFile: path.join(directory, 'mcp-gateway.mjs'),
            runtimeConfigFile: path.join(directory, 'runtime-config.json'), catalog: taskCatalogs.get(message.params?.threadId),
          });
        } catch { await audit('mcp-gateway-setup-unavailable'); }
      }
      const lifecycleMessage = hookPlan?.ready ? hookPlan.message : launchPlan?.message ?? message;
      if (message.method === 'thread/resume') {
        const threadId = message.params?.threadId;
        let catalog = taskCatalogs.get(threadId);
        if (!catalog && scopeForThread(threadId || '')) {
          const saved = await evidenceReader(config.nativeEvidenceDirectory, scopeForThread(threadId), { bridgeDirectory: evidenceDirectory });
          // Expired runtime evidence is not proof of enforcement, but its exact
          // locally observed config mappings remain usable for this same scope.
          if (saved?.evidence) { catalog = { scope: saved.evidence.scope, items: saved.evidence.catalog }; taskCatalogs.set(threadId, catalog); }
        }
        const scope = scopeForThread(threadId || '');
        let profile;
        try { profile = scope ? await store.get(scope) : null; }
        catch {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32001,
            message: 'ThreadBrief could not read this task card. Restore its local configuration and retry.', data: { code: 'PROFILE_READ_FAILED' },
          } }) + '\n');
          return CONSUME_FRAME;
        }
        // A card's skill off stops automatic invocation; disabling the native
        // loader here would prevent a later on from working without a reload.
        const gated = new Set((launchPlan?.wrappedServers || []).map(server => mcpId(server.serverName, server.pluginKey)));
        const resumeStore = profile ? { get: async () => ({ ...profile,
          overrides: Object.fromEntries(Object.entries(profile.overrides).filter(([id]) => !id.startsWith('skill:') && !gated.has(id)
            && !(hookPlan?.ready && /^(?:mcp|plugin|app):/u.test(id)))),
        }) } : store;
        plan = await prepareCapabilities({ message: lifecycleMessage, store: resumeStore, scopeForThread, catalog });
      }
      pending.set(idKey(message.id), { kind: 'lifecycle', method: message.method, plan, launchPlan, hookPlan });
      if (plan?.changed) {
        await updateEvidence(message.params.threadId, { capabilityStatus: plan.unsupportedCapabilities.length ? 'partially-prepared' : 'pending-reload', capabilityRevision: plan.prepared.revision });
        return plan.message;
      }
      if (launchPlan?.changed) return lifecycleMessage;
      if (hookPlan?.changed) return lifecycleMessage;
    }
    if (message.method !== 'turn/start') return null;
    if (automaticPanel && scopeForThread(message.params?.threadId || '')) setImmediate(() => automaticPanel.mount({ threadId: message.params.threadId }));
    const scope = scopeForThread(message.params?.threadId || '');
    let plan, skillPlan, profile;
    try {
      // One immutable profile snapshot per turn. A concurrent panel save must
      // not mix persona and capability choices from different revisions.
      profile = scope ? await store.get(scope) : null;
      // Official subagent turns can originate inside the backend. One prompt
      // hook owns their profile for both internal follow-ups and direct input,
      // avoiding duplicate persona/skill text through two input paths.
      if (scope && recordPromptScope && promptHookTasks.has(scope.threadId)) {
        if (!taskParents.has(scope.threadId)) {
          const read = await internalRpc.call('thread/read', { threadId: scope.threadId, includeTurns: false });
          if (!read.error && read.result?.thread?.id === scope.threadId) observeThread(read.result.thread);
        }
        if (taskParents.get(scope.threadId)) return null;
      }
      if (automaticPanel && scope && Object.entries(profile.overrides).some(([id, mode]) => mode === 'off' && /^(?:mcp|plugin|app):/u.test(id))) {
        await automaticPanel.refreshCatalog({ threadId: scope.threadId, waitForObserver: true });
      }
      const turnStore = { get: async () => profile };
      const acceptedReceipt = scope ? await readAcceptedReceipt(path.join(evidenceDirectory, 'receipts'), scope) : null;
      plan = await prepareTurn({ message, store: turnStore, scopeForThread, acceptedReceipt });
      if (plan.status !== 'unsupported' && prepareSkills && scope) {
        let catalog = taskCatalogs.get(scope.threadId);
        if (!catalog && Object.entries(profile.overrides).some(([id, mode]) => id.startsWith('skill:') && mode === 'on')) {
          let cwd = message.params.cwd || taskCwds.get(scope.threadId);
          if (!cwd) {
            const read = await internalRpc.call('thread/read', { threadId: scope.threadId, includeTurns: false });
            if (!read.error && read.result?.thread?.id === scope.threadId) cwd = read.result.thread.cwd;
          }
          if (cwd) {
            catalog = await readCatalog({ rpc: internalRpc, scope, cwd, servers: [] });
            taskCatalogs.set(scope.threadId, catalog);
          }
        }
        skillPlan = prepareSkills({ message: plan.message, profile, scope, catalog });
        if (skillPlan.status === 'unsupported') plan = { status: 'unsupported', reason: 'SKILL_SELECTION_UNAVAILABLE', unsupportedCapabilities: skillPlan.unsupportedCapabilities };
      }
    } catch {
      plan = { status: 'unsupported', reason: 'PROFILE_READ_FAILED' };
    }
    if (plan.status === 'unsupported') {
      await audit('profile-preparation-failed', { threadId: scope?.threadId, reason: plan.reason });
      // Reject just this request: a broken task card must never terminate the
      // shared backend or interrupt unrelated tasks.
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null,
        error: { code: -32001, message: 'ThreadBrief could not apply this task configuration. The turn was not started; restore the task card and retry.', data: { code: plan.reason,
          ...(plan.unsupportedCapabilities?.length ? { capabilities: plan.unsupportedCapabilities } : {}),
        } },
      }) + '\n');
      await updateEvidence(scope?.threadId, { profileStatus: 'error' });
      return CONSUME_FRAME;
    }
    if (plan.unsupportedCapabilities?.length) await audit('capability-preferences-present', { threadId: scope?.threadId, count: plan.unsupportedCapabilities.length });
    if (plan.changed || skillPlan?.changed) {
      pending.set(idKey(message.id), { kind: 'overlay', prepared: plan.prepared, skillPlan, scope, revision: profile.revision });
      if (plan.changed) await audit('profile-request-prepared', { threadId: scope.threadId, revision: plan.prepared.revision, mode: plan.prepared.mode });
      return skillPlan?.message ?? plan.message;
    }
    return null;
  }).then(() => { internalRpc?.close(); child.stdin.end(); });
  const output = relayJsonLines(child.stdout, process.stdout, async message => {
    const consumed = internalRpc?.consume(message);
    if (consumed) return consumed;
    if (recordHookScope && message.method === 'hook/started') {
      const receipt = await recordHookScope({ notification: message, directory: path.join(evidenceDirectory, 'hook-scopes'), authority: binding })
        .catch(() => { void audit('hook-scope-recording-failed', { threadId: message.params?.threadId }).catch(() => {}); });
      if (receipt && automaticPanel) setImmediate(() => automaticPanel.mount({ threadId: receipt.scope.threadId }));
    }
    if (recordPromptScope && message.method === 'hook/started' && message.params?.run?.eventName === 'userPromptSubmit') {
      const receipt = await recordPromptScope({ notification: message, directory: path.join(evidenceDirectory, 'prompt-scopes'), authority: binding })
        .catch(() => { void audit('prompt-scope-recording-failed', { threadId: message.params?.threadId }).catch(() => {}); });
      if (receipt && automaticPanel) setImmediate(() => automaticPanel.mount({ threadId: receipt.scope.threadId }));
    }
    if (recordHookScope && message.method === 'hook/completed' && trustedHookSources.has(message.params?.run?.sourcePath)
      && message.params.run.eventName === 'preToolUse'
      && ['completed', 'blocked', 'failed'].includes(message.params?.run?.status)) {
      await updateEvidence(message.params.threadId, { toolPolicyStatus: message.params.run.status === 'failed' ? 'error' : 'observed' });
    }
    if (recordPromptScope && message.method === 'hook/completed' && trustedHookSources.has(message.params?.run?.sourcePath)
      && message.params.run.eventName === 'userPromptSubmit' && ['completed', 'blocked', 'failed'].includes(message.params.run.status)) {
      if (message.params.run.status === 'failed') promptHookTasks.delete(message.params.threadId);
      else promptHookTasks.add(message.params.threadId);
      if (taskParents.get(message.params.threadId)) await updateEvidence(message.params.threadId, {
        profileStatus: message.params.run.status === 'completed' ? 'ready' : 'error',
      });
    }
    if (automaticPanel && message.method === 'thread/started' && message.params?.thread) {
      const thread = message.params.thread;
      observeThread(thread);
      automaticPanel.observe({ method: 'thread/start', response: { result: { thread } } });
    }
    const item = message.params?.item;
    if (automaticPanel && message.method === 'item/completed' && item?.type === 'collabAgentToolCall'
      && item.tool === 'spawnAgent' && item.status === 'completed' && item.senderThreadId === message.params.threadId
      && Array.isArray(item.receiverThreadIds)) {
      for (const threadId of item.receiverThreadIds) if (scopeForThread(threadId)) {
        setImmediate(() => automaticPanel.mount({ threadId }));
      }
    }
    if (message.method === 'thread/closed') taskEvidence.delete(message.params?.threadId);
    const request = message.id === undefined ? null : pending.get(idKey(message.id));
    if (!request || message.method) return null;
    pending.delete(idKey(message.id));
    if (request.kind === 'initialize' && message.result && !message.error) {
      initialized = true; await writeStatus(); await audit('app-server-initialized');
      startProbe();
    }
    if (request.kind === 'lifecycle' && message.result?.thread && !message.error) {
      const thread = message.result.thread;
      if (request.hookPlan?.ready) {
        const source = request.hookPlan.key.slice(0, request.hookPlan.key.lastIndexOf(':pre_tool_use:'));
        trustedHookSources.add(source);
        if (request.hookPlan.ownHooks?.some(hook => hook.eventName === 'userPromptSubmit')) promptHookTasks.add(thread.id);
        await updateEvidence(thread.id, { toolPolicyStatus: 'registered' });
      }
      observeThread(thread);
      if (taskCatalogs.has(thread.id)) setImmediate(() => automaticPanel.refreshCatalog({ threadId: thread.id }));
      automaticPanel.observe({ method: request.method, response: message });
    }
    if (request.kind === 'overlay') {
      if (message.error) await audit('profile-request-rejected', { threadId: request.scope.threadId, revision: request.revision, code: message.error.code });
      else if (request.prepared) {
        const receipt = createAcceptedReceipt({ prepared: request.prepared, response: message });
        await writeAcceptedReceipt(path.join(evidenceDirectory, 'receipts'), receipt);
        await store.recordObservation(receipt.scope, { event: 'accepted', status: 'accepted', revision: receipt.revision, turnId: receipt.turnId, detail: 'turn/start accepted the untrusted profile context; model consumption is not verified' });
        await audit('profile-request-accepted', { threadId: receipt.scope.threadId, revision: receipt.revision, turnId: receipt.turnId });
        await updateEvidence(receipt.scope.threadId, { profileStatus: 'accepted', profileRevision: receipt.revision });
      }
      if (!message.error && request.skillPlan?.changed && message.result?.turn?.id) {
        await audit('skill-input-accepted', { threadId: request.scope.threadId, revision: request.revision, count: request.skillPlan.appendedCapabilities.length });
        await updateEvidence(request.scope.threadId, { skillInputRevision: request.revision, skillInputIds: request.skillPlan.appendedCapabilities.map(item => item.id) });
      }
    }
    return null;
  });
  const shutdown = async code => {
    if (stopped) return;
    stopped = true; clearInterval(heartbeat);
    internalRpc?.close();
    await writeStatus().catch(() => {});
    process.exit(code);
  };
  Promise.all([input, output]).catch(async error => {
    await audit('bridge-failed', { code: error.code || 'BRIDGE_ERROR' }).catch(() => {});
    process.stderr.write(`ThreadBrief bridge stopped: ${error.code || 'request preparation/transport failure'}\n`);
    child.kill(); await shutdown(70);
  });
  childClosed.then(code => output.then(() => shutdown(code))).catch(() => process.exit(70));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
}
