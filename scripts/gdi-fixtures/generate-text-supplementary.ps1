# Build the CC0 font with build-supplementary-font.py first. Windows PowerShell.
param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
$destination = if ($OutDir) { $OutDir } else { Join-Path $PSScriptRoot '../../src/__fixtures__/gdi' }
$destination = (Resolve-Path -LiteralPath $destination).Path
Add-Type -Path (Join-Path $PSScriptRoot 'TextSupplementaryProbe.cs') -ReferencedAssemblies System.Drawing
[TextSupplementaryProbe]::Run($destination)
& (Join-Path $PSScriptRoot 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-text-supplementary.json') -Groups 'text-supplementary' -Files @(
    (Join-Path $destination 'supplementary.ttf'),
    (Join-Path $destination 'text-supplementary.json.gz')
)
