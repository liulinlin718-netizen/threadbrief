import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMcpPolicy, mcpCapabilityId } from './mcp-policy.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const authority = { hostId: 'fixture', accountScope: 'fixture' };
const call = threadId => ({ id: 1, method: 'tools/call', params: { name: 'constant', _meta: { threadId, sessionId: A } } });

test('MCP execution policy follows task ID even when two agents share a session', async () => {
  const id = mcpCapabilityId('fixture'), profiles = new Map([[A, { revision: 1, overrides: { [id]: 'off' } }]]);
  const store = { get: async scope => profiles.get(scope.threadId) || { revision: 0, overrides: {} } };
  const evaluate = message => evaluateMcpPolicy({ message, serverName: 'fixture', authority, store });
  assert.equal((await evaluate(call(A))).allowed, false);
  assert.equal((await evaluate(call(B))).allowed, true);
  profiles.set(A, { revision: 2, overrides: { [id]: 'on' } });
  assert.equal((await evaluate(call(A))).allowed, true);
  assert.equal((await evaluate(call(undefined))).reason, 'TASK_ID_REQUIRED');
});

test('plugin off closes its MCP children without changing their saved preferences', async () => {
  const pluginKey = 'fixture@local', id = mcpCapabilityId('fixture', pluginKey);
  const profile = { revision: 1, overrides: { [id]: 'on', [`plugin:${pluginKey}`]: 'off' } };
  const before = structuredClone(profile);
  assert.equal((await evaluateMcpPolicy({ message: call(A), serverName: 'fixture', pluginKey, authority, store: { get: async () => profile } })).allowed, false);
  assert.deepEqual(profile, before);
});

test('discovery and untouched calls remain transparent without changing tool schemas', async () => {
  assert.deepEqual(await evaluateMcpPolicy({ message: { method: 'tools/list' } }), { allowed: true });
  const message = call(A), before = structuredClone(message);
  assert.equal((await evaluateMcpPolicy({ message, serverName: 'fixture', authority, store: { get: async () => ({ revision: 0, overrides: {} }) } })).allowed, true);
  assert.deepEqual(message, before);
});

test('model arguments cannot supply or override the backend task metadata', async () => {
  const id = mcpCapabilityId('fixture');
  const store = { get: async scope => ({ revision: 1, overrides: scope.threadId === A ? { [id]: 'off' } : {} }) };
  const message = call(A);
  message.params.arguments = { _meta: { threadId: B }, threadId: B, sessionId: B };
  assert.equal((await evaluateMcpPolicy({ message, serverName: 'fixture', authority, store })).allowed, false);
  delete message.params._meta;
  assert.equal((await evaluateMcpPolicy({ message, serverName: 'fixture', authority, store })).reason, 'TASK_ID_REQUIRED');
});

async function gatewayFixture(t, source) {
  const directory = await mkdtemp(path.join(tmpdir(), 'threadbrief-mcp-gateway-'));
  const binding = path.join(directory, 'binding.json'), config = path.join(directory, 'config.json');
  const backend = path.join(directory, 'backend.cjs');
  await writeFile(binding, JSON.stringify(authority));
  await writeFile(config, JSON.stringify({ currentThreadBinding: binding, dataDirectory: path.join(directory, 'data') }));
  await writeFile(backend, source);
  const child = spawn(process.execPath, [fileURLToPath(new URL('./mcp-gateway.mjs', import.meta.url)), config, 'fixture', '', '--', process.execPath, backend],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', stderr = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => {});
  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Gateway did not exit: ${stderr}`)); }, 12000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, output, stderr }); });
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed.catch(() => {});
    const resolved = path.resolve(directory), expectedParent = path.resolve(tmpdir());
    assert.equal(path.dirname(resolved), expectedParent);
    assert.ok(path.basename(resolved).startsWith('threadbrief-mcp-gateway-'));
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { child, closed };
}

test('gateway preserves split discovery frames while emitting a concurrent denial', async t => {
  const response = ' { "jsonrpc" : "2.0", "id" : "discovery", "result" : { "tools" : [] } } \r\n';
  const fixture = await gatewayFixture(t, `
    process.stdin.once('data', () => {
      const frame = ${JSON.stringify(response)};
      process.stdout.write(frame.slice(0, 24));
      process.stderr.write('partial-frame-ready\\n');
      setTimeout(() => process.stdout.write(frame.slice(24)), 300);
    });
    process.stdin.resume();
  `);
  fixture.child.stderr.on('data', chunk => {
    if (chunk.toString().includes('partial-frame-ready')) {
      fixture.child.stdin.end(JSON.stringify({ id: 'blocked', method: 'tools/call', params: { name: 'fixture' } }) + '\n'
        + JSON.stringify({ method: 'tools/call', params: { name: 'fixture' } }) + '\n');
    }
  });
  fixture.child.stdin.write('{ "id": "discovery", "method": "tools/list" }\r\n');
  const result = await fixture.closed;
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.output.includes(response), 'Backend response retains its exact whitespace and CRLF');
  const frames = result.output.trim().split(/\r?\n/u).map(line => JSON.parse(line));
  assert.equal(frames.length, 2); assert.equal(frames.find(frame => frame.id === 'blocked').result.isError, true);
  assert.deepEqual(frames.find(frame => frame.id === 'discovery').result.tools, []);
});

test('gateway reaps a backend that ignores stdin EOF within its bounded grace period', async t => {
  const fixture = await gatewayFixture(t, `
    process.stdout.write(JSON.stringify({ method: 'fixture/pid', params: { pid: process.pid } }) + '\\n');
    process.stdin.resume();
    setInterval(() => {}, 1000);
  `);
  fixture.child.stdin.end();
  const result = await fixture.closed;
  const frame = result.output.trim().split(/\r?\n/u).map(line => JSON.parse(line)).find(value => value.method === 'fixture/pid');
  assert.ok(frame?.params.pid, 'Fixture backend started');
  assert.throws(() => process.kill(frame.params.pid, 0), { code: 'ESRCH' });
});

test('gateway drains output and exits if backend closes while host stdin stays open', async t => {
  const fixture = await gatewayFixture(t, `
    process.stdout.write(JSON.stringify({ id: 1, result: { text: 'x'.repeat(180000) } }) + '\\n', () => process.exit(7));
  `);
  fixture.child.stdin.write('{"id":1,"method":"tools/list"}\n');
  const result = await fixture.closed;
  assert.equal(result.code, 7); assert.equal(JSON.parse(result.output).result.text.length, 180000);
});
