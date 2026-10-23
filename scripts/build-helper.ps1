$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root "helper\DshReviewDesktop.cs"
$outDir = Join-Path $root "bin"
$out = Join-Path $outDir "DshReviewDesktop.exe"

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path -LiteralPath $csc)) {
    throw "找不到 .NET Framework 4.8 csc.exe: $csc"
}

& $csc /nologo /target:exe /platform:x64 `
    /r:System.Windows.Forms.dll `
    /r:System.Drawing.dll `
    /out:$out `
    $source

if ($LASTEXITCODE -ne 0) {
    throw "编译失败，exit=$LASTEXITCODE"
}

Write-Host "OK $out"
