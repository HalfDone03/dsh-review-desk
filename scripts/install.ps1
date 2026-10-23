#Requires -Version 5.1
<#
.SYNOPSIS
    Install dsh-review-desk into a DSH profile.

.DESCRIPTION
    Adds the package as a file: dependency, appends it to dsh.profile.bundles,
    and materialises node_modules with the pnpm bundled inside DSH.

    Quit DeepSeekRuntime before running this script: pnpm rewrites node_modules
    and can fail on files the running app holds open.

.PARAMETER ProfileDir
    DSH profile directory. Defaults to %DSH_HOME%\profiles\desktop.

.PARAMETER DryRun
    Print the plan and exit without writing.

.PARAMETER SkipPnpm
    Only edit package.json; run pnpm install yourself.
#>
[CmdletBinding()]
param(
    [string]$ProfileDir = (Join-Path $env:DSH_HOME 'profiles\desktop'),
    [switch]$DryRun,
    [switch]$SkipPnpm
)

$ErrorActionPreference = 'Stop'
$packageName = 'dsh-review-desk'
$packageRoot = Split-Path -Parent $PSScriptRoot

function Step($m) { Write-Host "==> $m" }

foreach ($relative in @('package.json', 'cordis.patch.yml', 'lib\index.js', 'bin\DshReviewDesktop.exe')) {
    $full = Join-Path $packageRoot $relative
    if (-not (Test-Path -LiteralPath $full)) { throw "package incomplete: missing $full" }
}

if ([string]::IsNullOrWhiteSpace($ProfileDir)) { throw 'profile dir is empty; pass -ProfileDir' }
$manifestPath = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "not a DSH profile: $manifestPath" }

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($null -eq $manifest.dependencies) {
    $manifest | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
}
if ($null -eq $manifest.dsh -or $null -eq $manifest.dsh.profile) {
    throw "profile manifest has no dsh.profile: $manifestPath"
}
if ($null -eq $manifest.dsh.profile.bundles) {
    $manifest.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @()
}

$dependencySpec = 'file:' + ($packageRoot -replace '\\', '/')
$bundles = @($manifest.dsh.profile.bundles)
$needsDependency = ($null -eq $manifest.dependencies.PSObject.Properties[$packageName]) -or
    ($manifest.dependencies.PSObject.Properties[$packageName].Value -ne $dependencySpec)
$needsBundle = -not ($bundles -contains $packageName)

Step "package: $packageRoot"
Step "profile: $ProfileDir"
Step "dependency: $packageName -> $dependencySpec"
Step "bundle: $(if ($needsBundle) { 'append' } else { 'unchanged' })"

if (-not $needsDependency -and -not $needsBundle) {
    Step 'already registered'
    exit 0
}
if ($DryRun) { Step 'dry run'; exit 0 }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$manifestPath.bak-$stamp"
Copy-Item -LiteralPath $manifestPath -Destination $backup -Force
Step "backup: $backup"

try {
    $manifest.dependencies | Add-Member -NotePropertyName $packageName -NotePropertyValue $dependencySpec -Force
    if ($needsBundle) { $manifest.dsh.profile.bundles = @($bundles + $packageName) }
    $json = $manifest | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText($manifestPath, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding $false))
} catch {
    Copy-Item -LiteralPath $backup -Destination $manifestPath -Force
    throw "install failed; restored package.json: $($_.Exception.Message)"
}

if ($SkipPnpm) {
    Step 'pnpm skipped; run pnpm install before starting DSH'
    exit 0
}

$runtime = Join-Path $env:DSH_HOME 'dsh-runtimes\dsh-primary-runtime\dependencies'
$node = Join-Path $runtime 'node\bin\node.exe'
$pnpm = Join-Path $runtime 'pnpm\bin\pnpm.cjs'
if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $pnpm)) {
    Step 'bundled pnpm not found; run pnpm install --dir <profile> manually'
    exit 0
}

Step 'pnpm install (bundled)'
& $node $pnpm install --dir $ProfileDir
if ($LASTEXITCODE -ne 0) {
    Copy-Item -LiteralPath $backup -Destination $manifestPath -Force
    throw "pnpm install failed (exit $LASTEXITCODE); restored package.json"
}

if (-not (Test-Path -LiteralPath (Join-Path $ProfileDir "node_modules\$packageName\package.json"))) {
    Copy-Item -LiteralPath $backup -Destination $manifestPath -Force
    throw 'node_modules link missing after pnpm install; restored package.json'
}

Step 'installed. Restart DeepSeekRuntime, then use /review-desk prepare in a session.'
