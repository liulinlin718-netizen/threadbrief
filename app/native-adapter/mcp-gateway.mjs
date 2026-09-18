// Transparent stdio MCP gateway. Launch only through a process-scoped MCP
// config; it never rewrites installed plugins, authentication, or global config.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { ThreadStore } from '../lib/store.mjs';
import { relayJsonLines, CONSUME_FRAME } from './framing.mjs';
import { evaluateMcpPolicy } from './mcp-policy.mjs';

const args = process.argv.slice(2), separator = args.indexOf('--');
if (separator !== 3 || args.length < 5) throw new Error('Expected runtime config, server name, plugin key, --, command, arguments');
const [configFile, serverName, pluginKey] = args;
const config = JSON.parse(await readFile(configFile, 'utf8'));
const authority = JSON.parse(await readFile(config.currentThreadBinding, 'utf8'));
const store = new ThreadStore(config.dataDirectory);
const child = spawn(args[4], args.slice(5), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env } });
child.stderr.pipe(process.stderr);
let closed = false, closing = false, cleanupTimer;
function killOwnedTree() {
  if (closed || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== 'win32' || !Number.isInteger(child.pid)) { child.kill(); return; }
  // Production descendants also belong to CliBridge's kill-on-close JobObject.
  // Only this still-live child PID is eligible; never enumerate other processes.
  const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
    ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  killer.once('error', () => child.kill());
  killer.once('close', code => { if (code !== 0 && !closed) child.kill(); });
}
function stopBackend(force = false) {
  closing = true;
  child.stdin.end();
  if (force) { clearTimeout(cleanupTimer); killOwnedTree(); }
  else if (!cleanupTimer) cleanupTimer = setTimeout(killOwnedTree, 2000);
}
const backendClosed = new Promise(resolve => child.once('close', code => {
  closed = true; closing = true; clearTimeout(cleanupTimer);
  process.exitCode ??= code ?? 70;
  // A backend can fail before the host closes stdin. Do not leave the gateway
  // waiting forever for another host message after its only backend is gone.
  process.stdin.destroy(); resolve();
}));
child.on('error', () => {
  process.stderr.write('ThreadBrief MCP backend could not start.\n'); process.exitCode = 70;
});
child.stdin.on('error', () => { if (!closing) { process.exitCode = 70; stopBackend(true); } });
process.stdout.on('error', () => { process.exitCode = 70; stopBackend(true); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  process.exitCode = signal === 'SIGINT' ? 130 : 143; stopBackend(true);
});
async function deny(message, decision) {
  // JSON-RPC notifications must not receive a synthetic id:null response.
  if (!Object.hasOwn(message, 'id')) return;
  const bytes = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
    isError: true, content: [{ type: 'text', text: decision.reason === 'TASK_CAPABILITY_DISABLED'
      ? 'This capability is disabled in this task card. The tool was not executed.'
      : 'The task capability policy could not be verified. The tool was not executed.' }],
  } }) + '\n';
  if (!process.stdout.write(bytes)) await once(process.stdout, 'drain');
}
const input = (async () => {
  try {
    await relayJsonLines(process.stdin, child.stdin, async message => {
      let decision;
      try { decision = await evaluateMcpPolicy({ message, serverName, pluginKey, authority, store }); }
      catch { decision = { allowed: false, reason: 'TASK_CONFIGURATION_UNAVAILABLE' }; }
      if (decision.allowed) return null;
      await deny(message, decision);
      return CONSUME_FRAME;
    });
    if (!closed) stopBackend();
  } catch {
    if (!closing) { process.exitCode = 70; stopBackend(true); }
  }
})();
// Buffer complete frames before emitting them. A direct .pipe can place a local
// denial in the middle of a split backend response, corrupting the MCP stream.
const output = relayJsonLines(child.stdout, process.stdout).catch(() => {
  process.exitCode = 70; stopBackend(true);
});
await Promise.all([input, output, backendClosed]);
