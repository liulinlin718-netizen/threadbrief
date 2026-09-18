import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const launcher = fileURLToPath(new URL('../Start-ThreadBrief-Codex.ps1', import.meta.url));
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const unavailablePowerShell = process.platform !== 'win32' ? 'Windows PowerShell 5.1 requires Windows' : !existsSync(powershell) && 'Windows PowerShell 5.1 is not installed';
const psLiteral = value => `'${value.replaceAll("'", "''")}'`;
function ps(...args) {
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', ...args], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout.trim());
}

test('configured Windows installation reports read-only launch preflight', { skip: unavailablePowerShell }, t => {
  const runtimeFile = fileURLToPath(new URL('./runtime-config.json', import.meta.url));
  if (!existsSync(runtimeFile)) {
    t.skip('Run Configure-ThreadBrief.ps1 and Build-Bridge.ps1 to check an installed Codex; fresh source checkouts contain no machine runtime config');
    return;
  }
  const result = ps('-Command', `
    $tokens = $null; $errors = $null
    foreach ($file in @(${psLiteral(launcher)}, ${psLiteral(path.join(path.dirname(launcher), 'Start-Panel.ps1'))})) {
      [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors) | Out-Null
      if ($errors.Count) { throw ($errors | Out-String) }
    }
    & ${psLiteral(launcher)} -ValidateOnly
  `);
  assert.match(result.powershellVersion, /^5\.1\./u);
  assert.equal(result.validation, 'passed');
  assert.match(result.realCodexSha256, /^[0-9a-f]{64}$/u);
  assert.match(result.bridgeSha256, /^[0-9a-f]{64}$/u);
  assert.ok(result.checkedFiles >= 17);
  // The actual current desktop is inspected; this test never invokes launch mode.
  if (result.matchingProcessIds.length || result.unverifiedProcessIds.length) {
    assert.equal(result.launchAllowed, false); assert.ok(result.blockReason);
  } else { assert.equal(result.launchAllowed, true); }
});

test('duplicate detection checks exact executable paths and fails closed for unreadable paths', { skip: unavailablePowerShell }, () => {
  const result = ps('-Command', `
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile(${psLiteral(launcher)}, [ref]$tokens, [ref]$errors)
    $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-CodexProcessState' }, $false)
    . ([scriptblock]::Create($definition.Extent.Text))
    function Get-Process { [CmdletBinding()] param([string]$Name) $script:Processes }
    $target = 'C:\\Fixture\\Codex\\ChatGPT.exe'
    $script:Processes = @([pscustomobject]@{ Id = 1; HasExited = $false; Path = $target.ToUpperInvariant() })
    $exact = Get-CodexProcessState $target
    $script:Processes = @([pscustomobject]@{ Id = 2; HasExited = $false; Path = 'C:\\Other\\ChatGPT.exe' })
    $other = Get-CodexProcessState $target
    $script:Processes = @([pscustomobject]@{ Id = 3; HasExited = $false; Path = $null })
    $unknown = Get-CodexProcessState $target
    $script:Processes = @([pscustomobject]@{ Id = 4; HasExited = $true; Path = $target })
    $exited = Get-CodexProcessState $target
    [ordered]@{ exact = $exact; other = $other; unknown = $unknown; exited = $exited } | ConvertTo-Json -Depth 4
  `);
  assert.equal(result.exact.launchAllowed, false); assert.deepEqual(result.exact.matchingProcessIds, [1]);
  assert.equal(result.other.launchAllowed, true);
  assert.equal(result.unknown.launchAllowed, false); assert.deepEqual(result.unknown.unverifiedProcessIds, [3]);
  assert.equal(result.exited.launchAllowed, true);
});

test('launcher is ASCII and all local module dependencies parse without executing them', async () => {
  const bytes = await readFile(launcher);
  assert.ok(bytes.every(value => value < 128), 'BOM-less launcher must remain ASCII for PowerShell 5.1');
  const pending = [new URL('./proxy.mjs', import.meta.url), new URL('../server.mjs', import.meta.url)];
  const visited = new Set();
  while (pending.length) {
    const url = pending.pop(); if (visited.has(url.href)) continue; visited.add(url.href);
    const source = await readFile(url, 'utf8');
    const parsed = spawnSync(process.execPath, ['--check', fileURLToPath(url)], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.ifError(parsed.error); assert.equal(parsed.status, 0, `${url.pathname}: ${parsed.stderr}`);
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]+\.mjs)['"]/gu)) pending.push(new URL(match[1], url));
  }
  assert.ok(visited.size > 20, `Only ${visited.size} dependencies were checked`);
});
