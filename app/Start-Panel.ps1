param([int]$Port = 6300, [string]$NodeExecutable)
# Keep this launcher ASCII: Windows PowerShell 5.1 reads BOM-less files as ANSI.
$ErrorActionPreference = 'Stop'
$panelRoot = $PSScriptRoot
$runtimeDir = Join-Path $panelRoot '.runtime'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$runtimeConfig = Join-Path $panelRoot 'native-adapter\runtime-config.json'
if (-not $NodeExecutable -and (Test-Path -LiteralPath $runtimeConfig)) {
  $NodeExecutable = (Get-Content -LiteralPath $runtimeConfig -Raw -Encoding UTF8 | ConvertFrom-Json).nodeExecutable
}
if (-not $NodeExecutable) {
  $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
  if ($nodeCommand) { $NodeExecutable = $nodeCommand.Source }
}
if (-not $NodeExecutable -or -not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) { throw 'Node.js 22 or newer is required. Install it on PATH or pass -NodeExecutable.' }
$nodePath = (Resolve-Path -LiteralPath $NodeExecutable).Path
$nodeVersion = [string](& $nodePath --version)
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) { throw 'Node.js 22 or newer is required.' }
$serverScript = Join-Path $panelRoot 'server.mjs'
$bindingFile = Join-Path $panelRoot 'current-thread.json'
if (-not (Test-Path -LiteralPath $bindingFile -PathType Leaf)) { throw 'Run Configure-ThreadBrief.ps1 with a real task UUID, host and account scope first.' }
$metadataFile = Join-Path $runtimeDir 'server.json'
if (Test-Path -LiteralPath $metadataFile) {
  try {
    $metadata = Get-Content -LiteralPath $metadataFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $origin = ([uri]$metadata.url).GetLeftPart([System.UriPartial]::Authority)
    $health = Invoke-RestMethod -Uri ($origin + '/health') -TimeoutSec 2
    if ($health.service -eq 'ThreadBrief') {
      Write-Output $metadata.url
      exit 0
    }
  } catch { }
}
$arguments = @('"' + $serverScript + '"', '--binding', '"' + $bindingFile + '"', '--port', $Port, '--native-evidence', '"' + (Join-Path $runtimeDir 'native-evidence') + '"', '--bridge-directory', '"' + (Join-Path $panelRoot 'native-adapter\.runtime') + '"')
$launchedPanel = Start-Process -FilePath $nodePath -ArgumentList $arguments -WorkingDirectory $panelRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDir 'server.stdout.log') -RedirectStandardError (Join-Path $runtimeDir 'server.stderr.log') -PassThru
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Milliseconds 100
  if (Test-Path -LiteralPath $metadataFile) {
    try {
      $metadata = Get-Content -LiteralPath $metadataFile -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($metadata.pid -ne $launchedPanel.Id) { continue }
      $origin = ([uri]$metadata.url).GetLeftPart([System.UriPartial]::Authority)
      $health = Invoke-RestMethod -Uri ($origin + '/health') -TimeoutSec 1
      if ($health.service -eq 'ThreadBrief') { Write-Output $metadata.url; exit 0 }
    } catch { }
  }
}
throw 'Panel startup failed. See .runtime/server.stderr.log. If the port is occupied, use -Port 6301.'
