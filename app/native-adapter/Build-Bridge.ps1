[CmdletBinding()]
param([string]$NodeExecutable, [string]$CodexExecutable, [string]$DesktopExecutable, [switch]$ValidateOnly)
# ASCII source; generated JSON is UTF-8 without a BOM for Node and PS 5.1.
$ErrorActionPreference = 'Stop'
$adapterRoot = $PSScriptRoot
$appRoot = Split-Path -Parent $adapterRoot
$expectedHash = 'BE793AB45ADBCBD9FA716DF04CB6BC68EB9E353C6E6AF20886AF45C11ABC2413'
if (-not $NodeExecutable) {
  $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
  if ($nodeCommand) { $NodeExecutable = $nodeCommand.Source }
}
if (-not $NodeExecutable -or -not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) { throw 'Install Node.js 22 or newer on PATH, or pass -NodeExecutable.' }
$NodeExecutable = (Resolve-Path -LiteralPath $NodeExecutable).Path
$nodeVersion = [string](& $NodeExecutable --version)
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) { throw 'Node.js 22 or newer is required.' }

if (-not $CodexExecutable) {
  $cliRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
  $candidates = @(Get-ChildItem -LiteralPath $cliRoot -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'codex.exe' })
  $cliCommand = Get-Command codex.exe -CommandType Application -ErrorAction SilentlyContinue
  if ($cliCommand) { $candidates += $cliCommand.Source }
  foreach ($candidate in @($candidates | Select-Object -Unique)) {
    if ((Test-Path -LiteralPath $candidate -PathType Leaf) -and (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash -eq $expectedHash) { $CodexExecutable = $candidate; break }
  }
}
if (-not $CodexExecutable -or -not (Test-Path -LiteralPath $CodexExecutable -PathType Leaf)) { throw 'The verified Codex CLI was not found. Pass -CodexExecutable for version 0.155.0-alpha.2.6; other builds require adapter revalidation.' }
$CodexExecutable = (Resolve-Path -LiteralPath $CodexExecutable).Path
$actualHash = (Get-FileHash -LiteralPath $CodexExecutable -Algorithm SHA256).Hash
if ($actualHash -ne $expectedHash) { throw 'Codex binary is unverified. Revalidate this adapter before using a different CLI build.' }

Import-Module (Join-Path $PSHOME 'Modules\Appx\Appx.psd1') -ErrorAction Stop
$packages = @(Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending)
$desktopPackage = $null
if ($DesktopExecutable) {
  if (-not (Test-Path -LiteralPath $DesktopExecutable -PathType Leaf)) { throw 'The specified desktop executable does not exist.' }
  $DesktopExecutable = (Resolve-Path -LiteralPath $DesktopExecutable).Path
  foreach ($package in $packages) {
    $packageExecutable = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
    if ([string]::Equals($DesktopExecutable, $packageExecutable, [StringComparison]::OrdinalIgnoreCase)) { $desktopPackage = $package; break }
  }
} else {
  foreach ($package in $packages) {
    $packageExecutable = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
    if (Test-Path -LiteralPath $packageExecutable -PathType Leaf) { $DesktopExecutable = $packageExecutable; $desktopPackage = $package; break }
  }
}
if (-not $DesktopExecutable) { throw 'Install the Codex desktop app, or pass -DesktopExecutable.' }
$desktopAppId = $null
if ($desktopPackage) {
  $manifest = Get-AppxPackageManifest -Package $desktopPackage.PackageFullName
  $application = @($manifest.Package.Applications.Application | Where-Object { ($_.Executable -replace '/', '\') -eq 'app\ChatGPT.exe' }) | Select-Object -First 1
  if (-not $application) { throw 'The Codex package application entry changed. Revalidate the desktop launcher.' }
  $desktopAppId = [string]$application.Id
}
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { $compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'The .NET Framework C# compiler is required.' }
$settings = [ordered]@{
  nodeExecutable = $NodeExecutable
  realCodexExecutable = $CodexExecutable
  realCodexSha256 = $actualHash.ToLowerInvariant()
  desktopExecutable = $DesktopExecutable
  desktopPackageFamilyName = if ($desktopPackage) { $desktopPackage.PackageFamilyName } else { $null }
  desktopAppId = $desktopAppId
  dataDirectory = Join-Path $appRoot 'data'
  currentThreadBinding = Join-Path $appRoot 'current-thread.json'
  evidenceDirectory = Join-Path $adapterRoot '.runtime'
  automaticPanelMount = $true
  mcpExecutionGateway = $true
  toolPolicyHooks = $true
  panelMetadataFile = Join-Path $appRoot '.runtime\server.json'
  nativeEvidenceDirectory = Join-Path $appRoot '.runtime\native-evidence'
}
if ($ValidateOnly) { $settings | ConvertTo-Json -Depth 4; return }
$outputExecutable = Join-Path $adapterRoot 'threadbrief-codex.exe'
& $compiler /nologo /target:exe /optimize+ /reference:System.Web.Extensions.dll "/out:$outputExecutable" (Join-Path $adapterRoot 'CliBridge.cs')
if ($LASTEXITCODE -ne 0) { throw 'Native adapter compilation failed.' }
[IO.File]::WriteAllText((Join-Path $adapterRoot 'runtime-config.json'), ($settings | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
Write-Output $outputExecutable
