# Regenerates the real-GDI/GDI+ ground-truth fixtures under
# src/__fixtures__/gdi/. Windows only (it calls gdi32/GDI+ directly).
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/gdi-fixtures/generate.ps1 [groups]
#
# `groups` is `all` (the default) or a comma-separated list of case groups:
#   rop, gradient, text, pattern, rotation, rop2, image, rotation-affine,
#   text-extra, gdi-raster, emfplus-records, gdiplus-extra, wmf-records,
#   emf-records, halftone, halftone-mixed, halftone-origin, emfplus-effects  (GdiFixtures.cs)
#   pen-transform                            (PenTransformProbe.cs)
#
# Each case writes <name>.emf (or .wmf) plus <name>.png: the same drawing
# calls painted straight onto a 32bpp bitmap by Windows itself, or GDI+'s
# playback of the recorded metafile.
param([string]$Which = 'all', [string]$TablesDir = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
# GetDeviceCaps and enhanced-metafile headers must use the same physical
# coordinates. A DPI-virtualised PowerShell otherwise records a larger frame
# and PlayEnhMetaFile silently scales its reference bitmap on scaled displays.
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class GdiFixtureDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[GdiFixtureDpi]::SetProcessDPIAware() | Out-Null
$out = Join-Path $here '..\..\src\__fixtures__\gdi'
$outDir = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $out)).Path
$generationStarted = [DateTime]::UtcNow
function Complete-Fixtures {
    param([string]$Directory = $outDir)
    $files = @(Get-ChildItem -LiteralPath $Directory -File | Where-Object {
        $_.LastWriteTimeUtc -ge $generationStarted -and $_.Name -notlike 'environment-*.json'
    } | ForEach-Object { $_.FullName })
    $name = 'environment-' + ($Which -replace '[^a-zA-Z0-9-]', '-') + '.json'
    & (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $Directory $name) -Groups $Which -Files $files
}
if ($Which -eq 'illuminant-cubes') {
    if (!$TablesDir) { throw 'Pass a temporary output directory for the cubes' }
    Add-Type -Path (Join-Path $here 'HalftoneColorProbe.cs')
    $destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $TablesDir)).Path
    [HalftoneColorProbe]::IlluminantCubes($destination)
    return
}
if ($Which -eq 'miter-limit-probe') {
    Add-Type -Path (Join-Path $here 'MiterProbe.cs')
    [MiterProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'image-effect-expanded-blur') {
    Add-Type -Path (Join-Path $here 'ExpandedBlurProbe.cs') -ReferencedAssemblies System.Drawing
    [ExpandedBlurProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'image-effect-narrow-blur') {
    Add-Type -Path (Join-Path $here 'NarrowBlurProbe.cs') -ReferencedAssemblies System.Drawing
    [NarrowBlurProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'gradient-blend-probe') {
    Add-Type -Path (Join-Path $here 'GradientProbe.cs') -ReferencedAssemblies System.Drawing
    [GradientProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'text-origin-phases' -or $Which -eq 'text-origin-vertical-phases') {
    Add-Type -Path (Join-Path $here 'TextOriginPhaseProbe.cs') -ReferencedAssemblies System.Drawing
    if ($Which -eq 'text-origin-phases') { [TextOriginPhaseProbe]::Run($outDir) }
    else { [TextOriginPhaseProbe]::Vertical($outDir) }
    Complete-Fixtures
    return
}
if ($Which -eq 'text-drawstring-placement') {
    Add-Type -Path (Join-Path $here 'DrawStringPlacementProbe.cs') -ReferencedAssemblies System.Drawing
    [DrawStringPlacementProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'text-coverage' -or $Which -eq 'text-cleartype-coverage') {
    Add-Type -Path (Join-Path $here 'TextCoverageProbe.cs') -ReferencedAssemblies System.Drawing
    if ($Which -eq 'text-coverage') { [TextCoverageProbe]::Run($outDir) }
    else { [TextCoverageProbe]::ClearType($outDir) }
    Complete-Fixtures
    return
}
if ($Which -eq 'playback-extents') {
    Add-Type -Path (Join-Path $here 'PlaybackExtentProbe.cs') -ReferencedAssemblies System.Drawing
    $cases = Get-Content -LiteralPath (Join-Path $outDir 'playback-extents.json') -Raw | ConvertFrom-Json
    foreach ($case in $cases) {
        $success = [PlaybackExtentProbe]::Capture($outDir, $case.name, $case.w, $case.h, $case.ox, $case.oy, $case.plus)
        if ($success -ne $case.playbackSucceeded) { throw "Unexpected native playback status: $($case.name)" }
    }
    $files = @((Join-Path $outDir 'playback-extents.json')) + @($cases | ForEach-Object {
        Join-Path $outDir ($_.name + '.emf')
        Join-Path $outDir ($_.name + '.png')
        Join-Path $outDir ($_.name + '.extent.png')
    })
    & (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $outDir 'environment-playback-extents.json') -Groups $Which -Files $files
    return
}
if ($Which -eq 'focus-contours') {
    Add-Type -Path (Join-Path $here 'FocusContourProbe.cs') -ReferencedAssemblies System.Drawing
    [FocusContourProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'bezier-flatten') {
    Add-Type -Path (Join-Path $here 'BezierFlattenProbe.cs') -ReferencedAssemblies System.Drawing
    [BezierFlattenProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'wide-pen-axis-directions') {
    Add-Type -Path (Join-Path $here 'AnisotropicPenDirectionProbe.cs')
    [AnisotropicPenDirectionProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'wide-pen-axis-probe') {
    Add-Type -Path (Join-Path $here 'AnisotropicPenProbe.cs')
    [AnisotropicPenProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'path-gradient-focus' -or $Which -eq 'halftone-transitions') {
    if ($Which -eq 'path-gradient-focus') {
        Add-Type -Path (Join-Path $here 'PathGradientFocusProbe.cs') -ReferencedAssemblies System.Drawing
        [PathGradientFocusProbe]::Run($outDir)
    } else {
        Add-Type -Path (Join-Path $here 'HalftoneTransitionProbe.cs')
        [HalftoneTransitionProbe]::Run($outDir)
    }
    Complete-Fixtures
    return
}
if ($Which -eq 'image-codecs' -or $Which -eq 'image-codecs-extra' -or $Which -eq 'image-codecs-advanced') {
    Add-Type -Path (Join-Path $here 'CodecProbe.cs') -ReferencedAssemblies System.Drawing
    if ($Which -eq 'image-codecs-advanced') {
        python (Join-Path $here 'codec-advanced.py') $outDir
        if ($LASTEXITCODE -ne 0) { throw 'Advanced TIFF encoding failed (requires Python and Pillow >= 10.2)' }
        [CodecProbe]::AdvancedReferences($outDir)
    } elseif ($Which -eq 'image-codecs-extra') { [CodecProbe]::CompressionVariants($outDir) } else { [CodecProbe]::Run($outDir) }
    Complete-Fixtures
    return
}
if ($Which -eq 'path-probe' -or $Which -eq 'wide-path-probe' -or $Which -eq 'wide-outline-probe' -or $Which -eq 'flat-pen-probe' -or $Which -eq 'arc-path-probe' -or $Which -eq 'curve-widen-probe' -or $Which -eq 'curve-dash-probe') {
    Add-Type -Path (Join-Path $here 'PathProbe.cs')
    if ($Which -eq 'wide-path-probe') { [PathProbe]::Wide($outDir) } elseif ($Which -eq 'flat-pen-probe') { [PathProbe]::FlatVectors($outDir) } elseif ($Which -eq 'arc-path-probe') { [PathProbe]::ArcPaths($outDir) } elseif ($Which -eq 'curve-widen-probe') { [PathProbe]::CurveWiden($outDir) } elseif ($Which -eq 'curve-dash-probe') { [PathProbe]::CurveDash($outDir) } elseif ($Which -eq 'wide-outline-probe') { [PathProbe]::Outline($outDir) } else { [PathProbe]::Run($outDir) }
    Complete-Fixtures
    return
}
if ($Which -eq 'image-effect-sharpen' -or $Which -eq 'image-effect-large-blur' -or $Which -eq 'image-effect-hue' -or $Which -eq 'image-effect-tint' -or $Which -eq 'image-effect-tables' -or $Which -eq 'image-effects') {
    Add-Type -Path (Join-Path $here 'ImageEffectProbe.cs') -ReferencedAssemblies System.Drawing
    if ($Which -eq 'image-effect-sharpen') {
        [ImageEffectProbe]::SharpenSweep($outDir)
        [ImageEffectProbe]::SharpenAmounts($outDir)
        [ImageEffectProbe]::BlurDimensions($outDir)
    } elseif ($Which -eq 'image-effect-large-blur') {
        [ImageEffectProbe]::LargeBlur($outDir)
        [ImageEffectProbe]::NoiseBlur($outDir)
    } elseif ($Which -eq 'image-effect-hue') {
        [ImageEffectProbe]::HueSweep($outDir)
    } elseif ($Which -eq 'image-effect-tint') {
        [ImageEffectProbe]::TintSweep($outDir)
    } elseif ($Which -eq 'image-effect-tables') {
        if (!$TablesDir) { throw 'Pass a temporary output directory for the native tables' }
        $destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $TablesDir)).Path
        [ImageEffectProbe]::CurveSweep($destination)
        [ImageEffectProbe]::LevelsSweep($destination)
        Complete-Fixtures -Directory $destination
    } else {
        [ImageEffectProbe]::Run($outDir)
        [ImageEffectProbe]::BalanceSweep($outDir)
    }
    if ($Which -ne 'image-effect-tables') { Complete-Fixtures }
    return
}

$known = @('all', 'rop', 'gradient', 'text', 'pattern', 'rotation', 'rop2', 'image', 'rotation-affine',
	'text-extra', 'text-c1', 'pen-axis-scales', 'gdi-raster', 'emfplus-records', 'gdiplus-extra', 'wmf-records', 'emf-records',
	'halftone', 'halftone-mixed', 'halftone-origin', 'halftone-mixed-probe', 'color-adjustment-controls', 'illuminant-charts', 'illuminant-tables', 'halftone-dither', 'wmf-insideframe-curves', 'wmf-roundrect-corners', 'emf-insideframe', 'emfplus-effects', 'pen-transform')
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
Complete-Fixtures
