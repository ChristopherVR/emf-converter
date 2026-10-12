# Native Windows controls for contour-local monochrome dropout decisions.
$ErrorActionPreference = 'Stop'
$captureDirectory = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../src/__fixtures__/gdi')).Path
python (Join-Path $PSScriptRoot 'build-mono-multiple-fonts.py')
if ($LASTEXITCODE -ne 0) { throw 'Multiple-contour font generation failed' }
Add-Type -Path (Join-Path $PSScriptRoot 'MonoStubProbe.cs')
$prefixes = @('mono-multiple', 'mono-multiple-heldout', 'mono-multiple-validation')
foreach ($prefix in $prefixes) {
    [MonoStubProbe]::Run($captureDirectory, $prefix, "$prefix.json.gz", 512,
        [int[]]@(8,12,16,20,24,32,40), [int[]]@(1,4,5))
}
$references = foreach ($prefix in $prefixes) {
    foreach ($mode in @(1,4,5)) { Join-Path $captureDirectory "$prefix-st$mode.ttf" }
    Join-Path $captureDirectory "$prefix.json.gz"
}
& (Join-Path $PSScriptRoot 'capture-environment.ps1') -OutputPath (Join-Path $captureDirectory 'environment-mono-multiple.json') -Groups 'mono-multiple' -Files $references
