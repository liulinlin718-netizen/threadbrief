[CmdletBinding()]
param([switch]$PackageChild, [switch]$ValidateOnly)
# Keep this file ASCII for Windows PowerShell 5.1 without a UTF-8 BOM.
$ErrorActionPreference = 'Stop'
# A Node/PowerShell 7 parent can omit Windows modules from PSModulePath.
# Resolve these built-in modules explicitly without changing the environment.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
Import-Module (Join-Path $PSHOME 'Modules\Appx\Appx.psd1') -ErrorAction Stop
$adapterRoot = Join-Path $PSScriptRoot 'native-adapter'
$bridgeExecutable = Join-Path $adapterRoot 'threadbrief-codex.exe'

function Get-CodexProcessState([string]$ExecutablePath) {
  $matching = @()
  $unverified = @()
  # Get-Process works without the WMI/CIM permission required by Win32_Process.
  foreach ($candidate in @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($ExecutablePath)) -ErrorAction SilentlyContinue)) {
    try {
      if ($candidate.HasExited) { continue }
      $candidatePath = $candidate.Path
      if (-not $candidatePath) { $unverified += $candidate.Id }
      elseif ([string]::Equals($candidatePath, $ExecutablePath, [StringComparison]::OrdinalIgnoreCase)) { $matching += $candidate.Id }
    } catch { $unverified += $candidate.Id }
  }
  $reason = if ($matching.Count) { 'Codex is already running. Completely exit Codex before launching ThreadBrief.' }
    elseif ($unverified.Count) { 'A ChatGPT process has an unreadable executable path. Close it before launching ThreadBrief so a duplicate Codex instance cannot be started.' }
    else { $null }
  [pscustomobject]@{ launchAllowed = -not $reason; blockReason = $reason; matchingProcessIds = @($matching); unverifiedProcessIds = @($unverified) }
}

$runtimeFile = Join-Path $adapterRoot 'runtime-config.json'
if (-not (Test-Path -LiteralPath $runtimeFile -PathType Leaf)) { throw 'Run Configure-ThreadBrief.ps1 with a real task UUID, host and account scope first.' }
$config = Get-Content -LiteralPath $runtimeFile -Raw -Encoding UTF8 | ConvertFrom-Json
$appExecutable = $config.desktopExecutable
$dependencies = @($appExecutable, $bridgeExecutable, $config.nodeExecutable, $config.realCodexExecutable,
  $config.currentThreadBinding, (Join-Path $PSScriptRoot 'Start-Panel.ps1'), (Join-Path $PSScriptRoot 'server.mjs'))
foreach ($relative in @('proxy.mjs', 'automatic-panel.mjs', 'capability-catalog.mjs', 'app-tool-mapping.mjs',
  'skill-turn.mjs', 'tool-policy-registration.mjs', 'tool-policy-hook.mjs', 'hook-scope.mjs', 'prompt-scope.mjs', 'child-profile-hook.mjs',
  'mcp-launch-overlay.mjs', 'mcp-gateway.mjs')) { $dependencies += Join-Path $adapterRoot $relative }
foreach ($dependency in $dependencies) {
  if (-not $dependency -or -not (Test-Path -LiteralPath $dependency -PathType Leaf)) { throw "Missing ThreadBrief dependency: $dependency" }
}
$actualHash = (Get-FileHash -LiteralPath $config.realCodexExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
if ($config.realCodexSha256 -notmatch '^[0-9a-fA-F]{64}$' -or $actualHash -ne $config.realCodexSha256.ToLowerInvariant()) {
  throw 'Codex binary changed. Revalidate the adapter before launching ThreadBrief.'
}
$nodeVersion = [string](& $config.nodeExecutable --version)
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) { throw 'Node.js 22 or newer is required.' }
$binding = Get-Content -LiteralPath $config.currentThreadBinding -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $binding.hostId -or -not $binding.accountScope) { throw 'The task binding is missing its host or account scope.' }
if ($config.desktopPackageFamilyName) { Get-Command Invoke-CommandInDesktopPackage -ErrorAction Stop | Out-Null }
$processState = Get-CodexProcessState $appExecutable
if ($ValidateOnly) {
  # Read-only preflight: never starts the panel, package helper or desktop.
  [ordered]@{ validation = 'passed'; launchAllowed = $processState.launchAllowed; blockReason = $processState.blockReason;
    matchingProcessIds = $processState.matchingProcessIds; unverifiedProcessIds = $processState.unverifiedProcessIds;
    powershellVersion = $PSVersionTable.PSVersion.ToString(); nodeVersion = $nodeVersion; checkedFiles = $dependencies.Count;
    realCodexSha256 = $actualHash; bridgeSha256 = (Get-FileHash -LiteralPath $bridgeExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
  } | ConvertTo-Json -Depth 4
  return
}
# Check again in the package child as another desktop may start after dispatch.
if (-not $processState.launchAllowed) { throw $processState.blockReason }

if (-not $PackageChild) {
  # Reusing a running desktop would ignore CODEX_CLI_PATH. Do not terminate any
  # current tasks or run another UI against the same normal data directory.
  & (Join-Path $PSScriptRoot 'Start-Panel.ps1') -NodeExecutable $config.nodeExecutable | Out-Null
  if ($config.desktopPackageFamilyName) {
    if (-not $config.desktopAppId) { throw 'The desktop package application ID is missing. Run Configure-ThreadBrief.ps1 again.' }
    $powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $PSCommandPath + '" -PackageChild'
    Invoke-CommandInDesktopPackage -PackageFamilyName $config.desktopPackageFamilyName -AppId $config.desktopAppId -Command $powershellPath -Args $arguments -PreventBreakaway -ErrorAction Stop
    Write-Output 'ThreadBrief launcher dispatched. Connection status is shown in the task card.'
    exit
  }
}

# Keep the normal UI directory and CODEX_HOME. Only this new process receives
# the executable override; no global environment or Codex config is rewritten.
$startInfo = New-Object Diagnostics.ProcessStartInfo
$startInfo.FileName = $appExecutable
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$startInfo.EnvironmentVariables['CODEX_CLI_PATH'] = $bridgeExecutable
$startInfo.EnvironmentVariables['THREADBRIEF_LAUNCH_KIND'] = 'desktop-threadbrief'
$startInfo.EnvironmentVariables.Remove('THREADBRIEF_NATIVE_MOUNT_PROBE')
New-Item -ItemType Directory -Force -Path (Join-Path $adapterRoot '.runtime') | Out-Null
$startedProcess = [Diagnostics.Process]::Start($startInfo)
$launch = [ordered]@{pid=$startedProcess.Id;startedAt=[datetime]::UtcNow.ToString('o');launchKind='desktop-threadbrief';normalProfileRequested=$true;bridgeExecutable=$bridgeExecutable;note='Automatic mounting is confirmed separately by live bridge/card receipts.'}
[IO.File]::WriteAllText((Join-Path $adapterRoot '.runtime\latest-launch.json'), ($launch | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
