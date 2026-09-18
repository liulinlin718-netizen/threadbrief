[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$ThreadId,
  [Parameter(Mandatory=$true)][string]$HostId,
  [Parameter(Mandatory=$true)][string]$AccountScope,
  [string]$Title = 'ThreadBrief',
  [string]$NodeExecutable,
  [string]$CodexExecutable,
  [string]$DesktopExecutable,
  [switch]$ValidateOnly
)
# Explicit task identity only: never infer the current task from local history.
$ErrorActionPreference = 'Stop'
$taskGuid = [guid]::Empty
if (-not [guid]::TryParseExact($ThreadId, 'D', [ref]$taskGuid) -or $taskGuid -eq [guid]::Empty) { throw 'Pass a real Codex task UUID as -ThreadId.' }
if ([string]::IsNullOrWhiteSpace($HostId) -or [string]::IsNullOrWhiteSpace($AccountScope)) { throw 'HostId and AccountScope must be explicit and nonempty.' }
$buildArguments = @{ NodeExecutable=$NodeExecutable; CodexExecutable=$CodexExecutable; DesktopExecutable=$DesktopExecutable; ValidateOnly=$ValidateOnly }
& (Join-Path $PSScriptRoot 'native-adapter\Build-Bridge.ps1') @buildArguments
if ($ValidateOnly) { return }
$binding = [ordered]@{ threadId=$taskGuid.ToString(); title=$Title; hostId=$HostId; accountScope=$AccountScope }
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'current-thread.json'), ($binding | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
Write-Output 'Configured. Use Start-ThreadBrief-Codex.ps1 -ValidateOnly to check the launcher.'
