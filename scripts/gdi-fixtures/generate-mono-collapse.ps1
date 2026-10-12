# Native per-phase collapsed-box controls; Python fontTools and Windows GDI.
$ErrorActionPreference = 'Stop'
$captureDirectory = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../src/__fixtures__/gdi')).Path
python (Join-Path $PSScriptRoot 'build-mono-collapse-fonts.py')
if ($LASTEXITCODE -ne 0) { throw 'Collapsed-box font generation failed' }
Add-Type -Path (Join-Path $PSScriptRoot 'MonoStubProbe.cs')
[MonoStubProbe]::Run($captureDirectory, 'mono-collapse', 'mono-collapse.json.gz', 5120, [int[]]@(32))
[MonoStubProbe]::Run($captureDirectory, 'mono-unit-stem', 'mono-unit-stem.json.gz', 1, [int[]]@(10))
$references = @('mono-collapse-st1.ttf', 'mono-collapse-st5.ttf', 'mono-collapse.json.gz',
    'mono-unit-stem-st1.ttf', 'mono-unit-stem-st5.ttf', 'mono-unit-stem.json.gz') | ForEach-Object { Join-Path $captureDirectory $_ }
& (Join-Path $PSScriptRoot 'capture-environment.ps1') -OutputPath (Join-Path $captureDirectory 'environment-mono-collapse.json') -Groups 'mono-collapse' -Files $references
