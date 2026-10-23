#Requires -Version 5.1
<#
.SYNOPSIS
    Uninstall dsh-review-desk from a DSH profile.

.DESCRIPTION
    Removes the file: dependency and the bundle entry, then runs the bundled
    pnpm install so node_modules matches package.json.

    User data (state, audit, Edge profile) is kept unless -PurgeData is given.

.PARAMETER ProfileDir
    DSH profile directory. Defaults to %DSH_HOME%\profiles\desktop.

.PARAMETER DryRun
    Print the plan and exit without writing.

.PARAMETER SkipPnpm
    Only edit package.json; run pnpm install yourself.

.PARAMETER PurgeData
    Also close the desk and delete %LOCALAPPDATA%\dsh-review-desk.
#>
[CmdletBinding()]
param(
    [string]$ProfileDir = (Join-Path $env:DSH_HOME 'profiles\desktop'),
    [switch]$DryRun,
    [switch]$SkipPnpm,
    [switch]$PurgeData
)

$ErrorActionPreference = 'Stop'
$packageName = 'dsh-review-desk'
$packageRoot = Split-Path -Parent $PSScriptRoot

function Step($m) { Write-Host "==> $m" }

if ([string]::IsNullOrWhiteSpace($ProfileDir)) { throw 'profile dir is empty; pass -ProfileDir' }
$manifestPath = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "not a DSH profile: $manifestPath" }

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$hasDependency = $null -ne $manifest.dependencies -and $null -ne $manifest.dependencies.PSObject.Properties[$packageName]
$bundles = if ($null -ne $manifest.dsh -and $null -ne $manifest.dsh.profile) { @($manifest.dsh.profile.bundles) } else { @() }
$hasBundle = $bundles -contains $packageName

Step "package: $packageRoot"
Step "profile: $ProfileDir"
Step "dependency: $(if ($hasDependency) { 'remove' } else { 'absent' })"
Step "bundle: $(if ($hasBundle) { 'remove' } else { 'absent' })"
Step "purge data: $PurgeData"

if ($DryRun) { Step 'dry run'; exit 0 }

if ($hasDependency -or $hasBundle) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = "$manifestPath.bak-$stamp"
    Copy-Item -LiteralPath $manifestPath -Destination $backup -Force
    Step "backup: $backup"

    try {
        if ($hasDependency) { $manifest.dependencies.PSObject.Properties.Remove($packageName) }
        if ($null -ne $manifest.dsh -and $null -ne $manifest.dsh.profile) {
            $manifest.dsh.profile.bundles = @($bundles | Where-Object { $_ -ne $packageName })
        }
        $json = $manifest | ConvertTo-Json -Depth 12
        [System.IO.File]::WriteAllText($manifestPath, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding $false))
    } catch {
        Copy-Item -LiteralPath $backup -Destination $manifestPath -Force
        throw "uninstall failed; restored package.json: $($_.Exception.Message)"
    }

    if (-not $SkipPnpm) {
        $runtime = Join-Path $env:DSH_HOME 'dsh-runtimes\dsh-primary-runtime\dependencies'
        $node = Join-Path $runtime 'node\bin\node.exe'
        $pnpm = Join-Path $runtime 'pnpm\bin\pnpm.cjs'
        if (Test-Path -LiteralPath $node -and Test-Path -LiteralPath $pnpm) {
            Step 'pnpm install (bundled)'
            & $node $pnpm install --dir $ProfileDir
            if ($LASTEXITCODE -ne 0) {
                Copy-Item -LiteralPath $backup -Destination $manifestPath -Force
                throw "pnpm install failed (exit $LASTEXITCODE); restored package.json"
            }
        } else {
            Step 'bundled pnpm not found; run pnpm install --dir <profile> manually'
        }
    }
}

if ($PurgeData) {
    $local = [IO.Path]::GetFullPath($env:LOCALAPPDATA)
    $dataDir = [IO.Path]::GetFullPath((Join-Path $local 'dsh-review-desk'))
    if ((Split-Path -Parent $dataDir) -ne $local -or (Split-Path -Leaf $dataDir) -ne 'dsh-review-desk') {
        throw "refusing to purge unexpected path: $dataDir"
    }

    $helper = Join-Path $packageRoot 'bin\DshReviewDesktop.exe'
    if (Test-Path -LiteralPath $helper) {
        Step 'close review desk'
        & $helper close --state (Join-Path $dataDir 'state.txt') | Out-Null
    }
    if (Test-Path -LiteralPath $dataDir) {
        Step "delete: $dataDir"
        Remove-Item -LiteralPath $dataDir -Recurse -Force
    }
}

Step 'uninstalled. Restart DeepSeekRuntime.'
