# Standalone native control capture; does not regenerate other fixture groups.
# powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/gdi-fixtures/generate-mapping-extents.ps1
param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
$probeDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$captureDirectory = if ($OutDir) { $OutDir } else { Join-Path $probeDirectory '..\..\src\__fixtures__\gdi' }
$captureDirectory = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $captureDirectory)).Path
Add-Type -Path (Join-Path $probeDirectory 'MappingExtentProbe.cs')
[MappingExtentProbe]::Run((Join-Path $captureDirectory 'mapping-extents.json'))
$captureFiles = @((Join-Path $captureDirectory 'mapping-extents.json'), (Join-Path $captureDirectory 'mapping-extents-large.json'))
& (Join-Path $probeDirectory 'capture-environment.ps1') -OutputPath (Join-Path $captureDirectory 'environment-mapping-extents.json') -Groups 'mapping-extents' -Files $captureFiles
