# Native straight/curved and signed-coordinate dropout controls, plus an
# independently seeded holdout. Requires Python fontTools and Windows GDI.
# powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/gdi-fixtures/generate-mono-stubs.ps1
param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
$captureDirectory = if ($OutDir) { $OutDir } else { Join-Path $PSScriptRoot '../../src/__fixtures__/gdi' }
$captureDirectory = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $captureDirectory)).Path
python (Join-Path $PSScriptRoot 'build-mono-stub-fonts.py') --seed 20261012 --out-dir $captureDirectory
if ($LASTEXITCODE -ne 0) { throw 'Independent font generation failed' }
python (Join-Path $PSScriptRoot 'build-mono-stub-fonts.py') --seed 20261013 --out-dir $captureDirectory --prefix mono-stub-heldout
if ($LASTEXITCODE -ne 0) { throw 'Holdout font generation failed' }
Add-Type -Path (Join-Path $PSScriptRoot 'MonoStubProbe.cs')
[MonoStubProbe]::Run($captureDirectory)
[MonoStubProbe]::Run($captureDirectory, 'mono-stub-heldout', 'mono-stubs-heldout.json.gz')
Add-Type -Path (Join-Path $PSScriptRoot 'MonoCondensedProbe.cs')
[MonoCondensedProbe]::Run($captureDirectory)
$references = @('mono-stub-st1.ttf', 'mono-stub-st5.ttf', 'mono-stub-heldout-st1.ttf', 'mono-stub-heldout-st5.ttf', 'mono-stubs.json.gz', 'mono-stubs-heldout.json.gz', 'mono-condensed.json.gz') | ForEach-Object { Join-Path $captureDirectory $_ }
& (Join-Path $PSScriptRoot 'capture-environment.ps1') -OutputPath (Join-Path $captureDirectory 'environment-mono-stubs.json') -Groups 'mono-stubs,mono-stubs-heldout,mono-condensed' -Files $references
