import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const app = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const unavailablePowerShell = process.platform !== 'win32' ? 'Windows PowerShell 5.1 requires Windows' : !existsSync(powershell) && 'Windows PowerShell 5.1 is not installed';
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const command = source => run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000 });

test('Windows PowerShell 5.1 parses the actual launcher chain', { skip: unavailablePowerShell }, async () => {
  const { stdout } = await command(`
    $ErrorActionPreference = 'Stop'
    foreach ($name in @('Start-Panel.ps1', 'Start-ThreadBrief-Codex.ps1', 'Configure-ThreadBrief.ps1', 'native-adapter/Build-Bridge.ps1')) {
      $tokens = $null; $errors = $null
      $null = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path ${literal(app)} $name), [ref]$tokens, [ref]$errors)
      if ($errors.Count) { throw ($errors | Out-String) }
    }
    $PSVersionTable.PSVersion.Major
  `);
  assert.equal(stdout.trim(), '5');
});

test('Windows launcher ignores a stale private catalog, then starts, reuses and recovers a panel', { skip: unavailablePowerShell }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'threadbrief-launcher-'));
  const fixture = path.join(root, '\u6d4b\u8bd5 panel');
  const metadataFile = path.join(fixture, '.runtime', 'server.json');
  const binding = { hostId: 'launcher-fixture', accountScope: 'fixture', threadId: randomUUID(), title: '\u6d4b\u8bd5' };
  t.after(async () => {
    let metadata;
    try { metadata = JSON.parse(await readFile(metadataFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (metadata) {
      assert.equal(metadata.threadId, binding.threadId);
      assert.equal(metadata.registryDirectory, path.join(fixture, '.runtime', 'thread-bindings'));
      try { process.kill(metadata.pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith('threadbrief-launcher-'));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await mkdir(path.join(fixture, 'host-probe'), { recursive: true });
  for (const file of ['server.mjs', 'Start-Panel.ps1']) await copyFile(path.join(app, file), path.join(fixture, file));
  for (const directory of ['lib', 'public']) await cp(path.join(app, directory), path.join(fixture, directory), { recursive: true });
  await writeFile(path.join(fixture, 'current-thread.json'), JSON.stringify(binding));
  await writeFile(path.join(fixture, 'host-probe', 'catalog-snapshot.json'), JSON.stringify({ binding, observedAt: '2000-01-01T00:00:00.000Z', items: [
    { id: 'mcp:stale', name: 'Stale MCP', kind: 'mcp', defaultEnabled: true, available: true },
  ] }));
  const launch = () => run(powershell, ['-NoProfile', '-NonInteractive', '-File', path.join(fixture, 'Start-Panel.ps1'), '-Port', '0', '-NodeExecutable', process.execPath], { windowsHide: true, timeout: 15000 });
  const first = await launch();
  assert.equal(first.stderr, '');
  const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
  assert.equal(first.stdout.trim(), metadata.url);
  const health = await (await fetch(new URL('/health', metadata.url))).json();
  assert.equal(health.service, 'ThreadBrief');
  const state = await (await fetch(metadata.url + '/api/state')).json();
  assert.equal(state.thread.id, binding.threadId);
  assert.equal(state.thread.title, binding.title);
  assert.equal(state.config.revision, 0);
  assert.deepEqual(state.catalog, []);
  assert.equal(metadata.nativeEvidenceDirectory, path.join(fixture, '.runtime', 'native-evidence'));
  assert.equal(metadata.bridgeDirectory, path.join(fixture, 'native-adapter', '.runtime'));
  const second = await launch();
  assert.equal(second.stdout.trim(), metadata.url);
  assert.equal(JSON.parse(await readFile(metadataFile, 'utf8')).pid, metadata.pid);
  // A stopped service can leave interrupted runtime metadata. Durable task
  // bindings, including the existing card token, must remain recoverable.
  process.kill(metadata.pid);
  await writeFile(metadataFile, '{"pid":');
  const recovered = await launch();
  assert.equal(recovered.stderr, '');
  const next = JSON.parse(await readFile(metadataFile, 'utf8'));
  assert.equal(recovered.stdout.trim(), next.url);
  assert.notEqual(next.pid, metadata.pid);
  assert.equal(new URL(next.url).pathname, new URL(metadata.url).pathname);
  assert.equal((await (await fetch(next.url + '/api/state')).json()).thread.id, binding.threadId);
});
