import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as immediate } from 'node:timers/promises';
import { createAutomaticPanel } from './automatic-panel.mjs';

const A = '01a0afe2-8696-7d20-91d0-da753fa10c26';
const B = '01a0afe2-8696-7d20-91d0-da753fa10c27';
const token = 'A'.repeat(32);
const server = {
  name: 'codex_app', pluginId: 'codex-app-tools@openai-bundled', runtimeStatus: 'connected',
  tools: { open_in_codex: { name: 'open_in_codex', inputSchema: { privateFixture: true } } },
  authStatus: 'irrelevant',
};
const ack = (threadId = A, status = 'queued') => ({ result: { isError: false, content: [{ type: 'text', text: JSON.stringify({ status, threadId }) }] } });
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture({ call, register, onObservation, onCatalog, isToolAllowed } = {}) {
  const calls = [], registrations = [], observations = [], catalogs = [];
  const panel = createAutomaticPanel({
    panelOrigin: 'http://127.0.0.1:4310',
    isToolAllowed,
    rpc: { async call(method, params) {
      calls.push({ method, params });
      return call ? call(method, params) : method === 'mcpServerStatus/list'
        ? { result: { data: [server], nextCursor: null } } : ack(params.threadId);
    } },
    registry: { async register(value) {
      registrations.push(value);
      return register ? register(value) : { ...value, token };
    } },
    onObservation: value => { observations.push(value); return onObservation?.(value); },
    onCatalog: value => { catalogs.push(value); return onCatalog?.(value); },
  });
  return { panel, calls, registrations, observations, catalogs };
}

test('native queued acknowledgement uses exact same-task metadata and token URL without claiming visibility', async () => {
  const f = fixture();
  assert.deepEqual(await f.panel.mount({ threadId: A, title: 'Task A' }), { threadId: A, status: 'queued', accepted: true, visible: null });
  assert.deepEqual(f.calls, [
    { method: 'mcpServerStatus/list', params: { threadId: A, detail: 'toolsAndAuthOnly', limit: 100 } },
    { method: 'mcpServer/tool/call', params: {
      threadId: A, server: 'codex_app', tool: 'open_in_codex', _meta: { thread_id: A, threadId: A },
      arguments: { threadId: A, placement: 'right', target: { type: 'browser', url: `http://127.0.0.1:4310/panel/${token}` } },
    } },
  ]);
  assert.deepEqual(f.registrations, [{ threadId: A, title: 'Task A' }]);
  assert.deepEqual(f.catalogs, [{ threadId: A, servers: [{ name: 'codex_app', pluginId: server.pluginId, runtimeStatus: 'connected', toolNames: ['open_in_codex'] }] }]);
  assert.equal(JSON.stringify(f.observations).includes(token), false);
});

test('in-flight requests collapse; accepted tasks deduplicate independently', async () => {
  const gate = defer();
  const f = fixture({ call: async (method, params) => {
    if (method === 'mcpServerStatus/list') { await gate.promise; return { result: { data: [server], nextCursor: null } }; }
    return ack(params.threadId);
  } });
  const first = f.panel.mount({ threadId: A });
  assert.equal(first, f.panel.mount({ threadId: A }));
  gate.resolve();
  await first;
  await f.panel.mount({ threadId: A });
  assert.equal(f.calls.length, 2);
  await f.panel.mount({ threadId: B });
  assert.equal(f.calls.length, 4);
});

test('observe defers work beyond the response relay and only accepts successful real lifecycle IDs', async () => {
  const f = fixture();
  for (const method of ['thread/start', 'thread/resume', 'thread/fork']) {
    assert.equal(f.panel.observe({ method, response: { result: { thread: { id: A, name: 'Real name', preview: 'Never use message text' } } } }), true);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.panel.observe({ method: 'turn/start', response: { result: { thread: { id: A } } } }), false);
  assert.equal(f.panel.observe({ method: 'thread/start', response: { error: { code: -1 }, result: { thread: { id: A } } } }), false);
  assert.equal(f.panel.observe({ method: 'thread/start', response: { result: { thread: { id: 'pending:task' } } } }), false);
  await immediate();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.registrations, [{ threadId: A, title: 'Real name' }]);
  assert.equal((await f.panel.mount({ threadId: 'fake' })).status, 'ignored');
  assert.equal(f.calls.length, 2);
});

test('every real task gets a card while a same-named foreign tool is never called', async () => {
  for (const changed of [{ name: 'other' }, { pluginId: null }, { pluginId: 'foreign@marketplace' }, { runtimeStatus: 'disconnected' }, { tools: { x: { name: 'different' } } }]) {
    const f = fixture({ call: () => ({ result: { data: [{ ...server, ...changed }], nextCursor: null } }) });
    assert.equal((await f.panel.mount({ threadId: A })).status, 'unavailable');
    assert.equal(f.calls.length, 1);
    assert.equal(f.registrations.length, 1);
  }
});

test('automatic mounting obeys the task switch and can retry after re-enabling', async () => {
  let allowed = false;
  const f = fixture({ isToolAllowed: async request => {
    assert.deepEqual(request, { threadId: A, server: 'codex_app', tool: 'open_in_codex' });
    return allowed;
  } });
  assert.equal((await f.panel.mount({ threadId: A })).reason, 'TASK_CAPABILITY_DISABLED');
  assert.equal(f.calls.some(call => call.method === 'mcpServer/tool/call'), false);
  allowed = true;
  assert.equal((await f.panel.mount({ threadId: A })).accepted, true);
  assert.equal(f.calls.filter(call => call.method === 'mcpServer/tool/call').length, 1);
});

test('a turn can wait for the complete fresh catalog before applying a saved off switch', async () => {
  const gate = defer();
  let completed = false;
  const f = fixture({ onCatalog: async () => { await gate.promise; completed = true; } });
  const refresh = f.panel.refreshCatalog({ threadId: A, waitForObserver: true });
  await immediate();
  assert.equal(completed, false);
  gate.resolve();
  assert.equal(await refresh, true);
  assert.equal(completed, true);
});

test('catalog pagination is thread scoped and all pages are reused for sanitized observation', async () => {
  const f = fixture({ call: (method, params) => method !== 'mcpServerStatus/list' ? ack() : {
    result: params.cursor ? { data: [server], nextCursor: null } : { data: [{ ...server, name: 'other' }], nextCursor: 'next' },
  } });
  assert.equal((await f.panel.mount({ threadId: A })).accepted, true);
  assert.equal(f.calls[1].params.threadId, A);
  assert.equal(f.calls[1].params.cursor, 'next');
  assert.equal(f.catalogs[0].servers.length, 2);
  assert.equal(JSON.stringify(f.catalogs).includes('inputSchema'), false);
  assert.equal(JSON.stringify(f.catalogs).includes('authStatus'), false);
});

test('MCP errors, rejected envelopes and ambiguous acknowledgements cannot become success', async () => {
  const invalid = [
    { error: { code: -1 } },
    { result: { ...ack().result, isError: true } },
    ack(B), ack(A, 'error'),
    { result: { content: [{ type: 'text', text: 'queued' }] } },
    { result: { content: [{ type: 'text', text: '{"status":"queued"}' }] } },
    { result: { ...ack().result, structuredContent: { status: 'opened', threadId: A } } },
  ];
  for (const response of invalid) {
    const f = fixture({ call: method => method === 'mcpServerStatus/list' ? { result: { data: [server] } } : response });
    const observed = await f.panel.mount({ threadId: A });
    assert.equal(observed.accepted, false);
    assert.equal(observed.status, 'failed');
    assert.equal(observed.visible, null);
  }
});

test('failure retries on a later lifecycle and structured opened is reported separately', async () => {
  let attempts = 0;
  const f = fixture({ call: method => {
    if (method === 'mcpServerStatus/list') return { result: { data: [server] } };
    if (++attempts === 1) throw new Error('Do not publish this arbitrary error text');
    return { result: { content: [], structuredContent: { status: 'opened', threadId: A } } };
  } });
  assert.equal((await f.panel.mount({ threadId: A })).accepted, false);
  f.panel.observe({ method: 'thread/resume', response: { result: { thread: { id: A } } } });
  await immediate();
  assert.deepEqual(f.observations.at(-1), { threadId: A, status: 'opened', accepted: true, visible: true });
  assert.equal(JSON.stringify(f.observations).includes('arbitrary error'), false);
});

test('native discovery can retry later and arbitrary rejection values remain safe observations', async () => {
  let stage = 0;
  const f = fixture({ call: method => {
    if (method === 'mcpServerStatus/list') return { result: { data: stage ? [server] : [] } };
    if (stage === 1) throw null;
    return { result: { ...ack().result, structuredContent: { status: 'queued', threadId: A } } };
  } });
  assert.equal((await f.panel.mount({ threadId: A })).status, 'unavailable');
  stage = 1;
  assert.equal((await f.panel.mount({ threadId: A })).reason, 'PANEL_REQUEST_FAILED');
  stage = 2;
  assert.equal((await f.panel.mount({ threadId: A })).status, 'queued');
});

test('observer errors are isolated, registry mismatches and repeated cursor fail closed', async () => {
  const f = fixture({ onObservation: () => { throw new Error('observer'); }, onCatalog: async () => { throw new Error('observer'); } });
  assert.equal((await f.panel.mount({ threadId: A })).accepted, true);
  const wrong = fixture({ register: () => ({ threadId: B, token }) });
  assert.equal((await wrong.panel.mount({ threadId: A })).reason, 'BINDING_INVALID');
  assert.equal(wrong.calls.length, 0);
  const loop = fixture({ call: () => ({ result: { data: [], nextCursor: 'repeat' } }) });
  assert.equal((await loop.panel.mount({ threadId: A })).reason, 'CATALOG_INVALID');
  assert.equal(loop.calls.length, 2);
});

test('remote URLs and panel URLs with embedded credentials are rejected before any RPC', () => {
  for (const panelOrigin of ['https://example.com', 'http://user:password@127.0.0.1:4310', 'http://127.0.0.1:4310/panel/secret']) {
    assert.throws(() => createAutomaticPanel({ panelOrigin, rpc: { call() {} }, registry: { register() {} } }), /local panel origin/);
  }
});
