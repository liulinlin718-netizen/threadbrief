import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { writeDiagnosticJSON } from '../lib/diagnostic-json.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'threadbrief-diagnostic-json-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'threadbrief-diagnostic-json-'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, file: join(root, 'status.json') };
}

test('a Windows sharing conflict preserves the old complete snapshot then publishes the new one', { skip: process.platform !== 'win32' }, async t => {
  const { root, file } = await fixture(t);
  await writeDiagnosticJSON(file, { initialized: false });
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$handle = [IO.File]::Open($env:THREADBRIEF_LOCK_TARGET, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); try { [Console]::WriteLine("locked"); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null } finally { $handle.Dispose() }'],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, THREADBRIEF_LOCK_TARGET: file } });
  const closed = new Promise(resolve => holder.once('close', resolve));
  t.after(async () => { holder.stdin.end(); if (holder.exitCode === null) holder.kill(); await closed; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture file lock was not ready')), 5000);
    holder.once('error', error => { clearTimeout(timer); reject(error); });
    holder.stdout.once('data', bytes => { clearTimeout(timer); try { assert.match(bytes.toString(), /locked/u); resolve(); } catch (error) { reject(error); } });
  });
  let published = false;
  const replacement = writeDiagnosticJSON(file, { initialized: true }).then(() => { published = true; });
  replacement.catch(() => {});
  await delay(100);
  assert.equal(published, false, 'Locked destination was replaced or removed');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { initialized: false });
  holder.stdin.end('\n');
  await replacement; await closed;
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { initialized: true });
  assert.deepEqual(await readdir(root), ['status.json']);
});

test('a persistent replacement failure is bounded and cleans its temporary file without deleting the destination', async t => {
  const { root, file } = await fixture(t);
  await mkdir(file);
  await assert.rejects(writeDiagnosticJSON(file, { initialized: true }));
  assert.equal((await stat(file)).isDirectory(), true);
  assert.deepEqual(await readdir(root), ['status.json']);
});
