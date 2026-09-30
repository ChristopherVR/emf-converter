# Regenerates the real-GDI/GDI+ ground-truth fixtures under
# src/__fixtures__/gdi/. Windows only (it calls gdi32/GDI+ directly).
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/gdi-fixtures/generate.ps1 [groups]
#
# `groups` is `all` (the default) or a comma-separated list of case groups:
#   rop, gradient, text, pattern, rotation, rop2, image, rotation-affine,
#   text-extra, gdi-raster, emfplus-records, gdiplus-extra, wmf-records,
#   emf-records, halftone, halftone-mixed, emfplus-effects  (GdiFixtures.cs)
#   pen-transform                            (PenTransformProbe.cs)
#
# Each case writes <name>.emf (or .wmf) plus <name>.png: the same drawing
# calls painted straight onto a 32bpp bitmap by Windows itself, or GDI+'s
# playback of the recorded metafile.
param([string]$Which = 'all', [string]$TablesDir = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here '..\..\src\__fixtures__\gdi'
$outDir = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $out)).Path
if ($Which -eq 'image-codecs') {
    Add-Type -Path (Join-Path $here 'CodecProbe.cs') -ReferencedAssemblies System.Drawing
    [CodecProbe]::Run($outDir)
    return
}
if ($Which -eq 'path-probe') {
    Add-Type -Path (Join-Path $here 'PathProbe.cs')
    [PathProbe]::Run($outDir)
    return
}
if ($Which -eq 'image-effect-tables' -or $Which -eq 'image-effects') {
    Add-Type -Path (Join-Path $here 'ImageEffectProbe.cs') -ReferencedAssemblies System.Drawing
    if ($Which -eq 'image-effect-tables') {
        if (!$TablesDir) { throw 'Pass a temporary output directory for the native tables' }
        $destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $TablesDir)).Path
        [ImageEffectProbe]::CurveSweep($destination)
        [ImageEffectProbe]::LevelsSweep($destination)
    } else {
        [ImageEffectProbe]::Run($outDir)
        [ImageEffectProbe]::BalanceSweep($outDir)
    }
    return
}

$known = @('all', 'rop', 'gradient', 'text', 'pattern', 'rotation', 'rop2', 'image', 'rotation-affine',
	'text-extra', 'gdi-raster', 'emfplus-records', 'gdiplus-extra', 'wmf-records', 'emf-records',
	'halftone', 'halftone-mixed', 'emfplus-effects', 'pen-transform')
$groups = @($Which -split '[,\s]+' | Where-Object { $_ })
if ($groups.Count -eq 0) { $groups = @('all') }
foreach ($g in $groups) {
	if ($known -notcontains $g) { throw "Unknown case group '$g'. Known groups: $($known -join ', ')" }
}

$fixtureGroups = @($groups | Where-Object { $_ -ne 'pen-transform' })
if ($fixtureGroups.Count -gt 0) {
	$src = Get-Content -Raw (Join-Path $here 'GdiFixtures.cs')
	Add-Type -TypeDefinition $src -ReferencedAssemblies System.Drawing
	foreach ($g in $fixtureGroups) {
		Write-Host "GdiFixtures: $g"
		[GdiFixtures]::Run($outDir, $g)
	}
}
if ($groups -contains 'all' -or $groups -contains 'pen-transform') {
	Write-Host 'PenTransformProbe'
	Add-Type -Path (Join-Path $here 'PenTransformProbe.cs') -ReferencedAssemblies System.Drawing
	[PenTransformProbe]::Run($outDir)
}
Write-Host "Fixtures written to $outDir"
