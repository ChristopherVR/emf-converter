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
param([string]$Which = 'all', [string]$TablesDir = '', [string]$PlaybackCase = '')
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
    # Private diagnostic fonts are capture inputs even when they were not regenerated.
    $fontFilter = if ($Which -like 'text-signed-diagonal*') { 'signed-diagonal-*.ttf' } elseif ($Which -like 'text-diagonal*') { 'diagonal-*.ttf' } elseif ($Which -like 'text-opcode*') { 'opcode-*.ttf' } elseif ($Which -like 'text-vector-stage*') { 'vector-stage-*.ttf' } else { $null }
    if ($fontFilter) {
        $files += @(Get-ChildItem -LiteralPath $Directory -File -Filter $fontFilter | ForEach-Object { $_.FullName })
        $files = @($files | Sort-Object -Unique)
    }
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
    if ($PlaybackCase) {
        $case = @($cases | Where-Object { $_.name -eq $PlaybackCase })
        if ($case.Count -ne 1) { throw "Unknown expanded playback case: $PlaybackCase" }
        $case = $case[0]
        $success = [PlaybackExtentProbe]::Capture($outDir, $case.name, $case.w, $case.h, $case.ox, $case.oy, $case.plus, ($case.nativeFrame -eq $true), ($case.recordPlayback -eq $true))
        if ($success -ne $case.playbackSucceeded) { throw "Unexpected native playback status: $($case.name)" }
        return
    }
    # Native replay depends on earlier playback in the process for some old
    # recordings. Give every reference the same fresh-process initial state.
    foreach ($case in $cases) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $MyInvocation.MyCommand.Path playback-extents -PlaybackCase $case.name
        if ($LASTEXITCODE -ne 0) { throw "Expanded playback capture failed: $($case.name)" }
    }
    $files = @((Join-Path $outDir 'playback-extents.json')) + @($cases | ForEach-Object {
        Join-Path $outDir ($_.name + '.emf')
        Join-Path $outDir ($_.name + '.png')
        Join-Path $outDir ($_.name + '.extent.png')
    })
    & (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $outDir 'environment-playback-extents.json') -Groups $Which -Files $files
    return
}
if ($Which -eq 'path-gradient-colors') {
    Add-Type -Path (Join-Path $here 'PathGradientColorProbe.cs') -ReferencedAssemblies System.Drawing
    [PathGradientColorProbe]::Run($outDir)
    Add-Type -Path (Join-Path $here 'PathGradientAlphaProbe.cs') -ReferencedAssemblies System.Drawing
    [PathGradientAlphaProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'bicubic-copy') {
    Add-Type -Path (Join-Path $here 'BicubicCopyProbe.cs') -ReferencedAssemblies System.Drawing
    [BicubicCopyProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'hq-arithmetic') {
    Add-Type -Path (Join-Path $here 'HighQualityArithmeticProbe.cs') -ReferencedAssemblies System.Drawing
    [HighQualityArithmeticProbe]::Run($outDir)
    Add-Type -Path (Join-Path $here 'HighQualityIndependentProbe.cs') -ReferencedAssemblies System.Drawing
    [HighQualityIndependentProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'halftone-fractional-kernel') {
    Add-Type -Path (Join-Path $here 'HalftoneFractionalKernelProbe.cs')
    [HalftoneFractionalKernelProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'halftone-run-2d') {
    Add-Type -Path (Join-Path $here 'HalftoneRun2DProbe.cs')
    [HalftoneRun2DProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'halftone-run-phase') {
    Add-Type -Path (Join-Path $here 'HalftoneRunPhaseProbe.cs')
    [HalftoneRunPhaseProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'text-opcode-hinting') {
    Add-Type -Path (Join-Path $here 'OpcodeHintProbe.cs')
    [OpcodeHintProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'text-opcode-coverage') {
    Add-Type -Path (Join-Path $here 'OpcodeCoverageProbe.cs') -ReferencedAssemblies System.Drawing
    [OpcodeCoverageProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'text-vector-stage-hinting') {
    Add-Type -Path (Join-Path $here 'VectorStageHintProbe.cs')
    [VectorStageHintProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'text-vector-stage-coverage') {
    Add-Type -Path (Join-Path $here 'VectorStageCoverageProbe.cs') -ReferencedAssemblies System.Drawing
    [VectorStageCoverageProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'text-signed-diagonal' -or $Which -eq 'text-signed-diagonal-hinting' -or $Which -eq 'text-signed-diagonal-coverage') {
    if ($Which -ne 'text-signed-diagonal-coverage') {
        Add-Type -Path (Join-Path $here 'SignedDiagonalHintProbe.cs')
        [SignedDiagonalHintProbe]::Run($outDir)
    }
    if ($Which -ne 'text-signed-diagonal-hinting') {
        Add-Type -Path (Join-Path $here 'SignedDiagonalCoverageProbe.cs') -ReferencedAssemblies System.Drawing
        [SignedDiagonalCoverageProbe]::Run($outDir)
    }
    Complete-Fixtures
    return
}
if ($Which -eq 'text-diagonal-coverage') {
    Add-Type -Path (Join-Path $here 'DiagonalCoverageProbe.cs') -ReferencedAssemblies System.Drawing
    [DiagonalCoverageProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'text-diagonal-hinting') {
    Add-Type -Path (Join-Path $here 'DiagonalHintProbe.cs')
    [DiagonalHintProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'bicubic-phases') {
    Add-Type -Path (Join-Path $here 'BicubicPhaseProbe.cs') -ReferencedAssemblies System.Drawing
    [BicubicPhaseProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'bicubic-arithmetic' -or $Which -eq 'bicubic-independent') {
    if ($Which -eq 'bicubic-arithmetic') {
        Add-Type -Path (Join-Path $here 'BicubicArithmeticProbe.cs') -ReferencedAssemblies System.Drawing
        [BicubicArithmeticProbe]::Run($outDir)
    } else {
        Add-Type -Path (Join-Path $here 'BicubicIndependentProbe.cs') -ReferencedAssemblies System.Drawing
        [BicubicIndependentProbe]::Run($outDir)
    }
    Complete-Fixtures
    return
}
if ($Which -eq 'halftone-kernel') {
    Add-Type -Path (Join-Path $here 'HalftoneKernelProbe.cs')
    [HalftoneKernelProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'halftone-arrangement') {
    Add-Type -Path (Join-Path $here 'HalftoneArrangementProbe.cs')
    [HalftoneArrangementProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'halftone-selection') {
    Add-Type -Path (Join-Path $here 'HalftoneSelectionProbe.cs')
    [HalftoneSelectionProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'roundrect-half-fix-translation') {
    Add-Type -Path (Join-Path $here 'HalfFixRoundRectTranslationProbe.cs')
    [HalfFixRoundRectTranslationProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'roundrect-half-fix') {
    Add-Type -Path (Join-Path $here 'HalfFixRoundRectProbe.cs')
    [HalfFixRoundRectProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'redeye-independent') {
    Add-Type -Path (Join-Path $here 'RedEyeCorrectionProbe.cs') -ReferencedAssemblies System.Drawing
    [RedEyeCorrectionProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'vertical-focus-line') {
    Add-Type -Path (Join-Path $here 'VerticalFocusLineProbe.cs') -ReferencedAssemblies System.Drawing
    [VerticalFocusLineProbe]::Run($outDir)
    Complete-Fixtures
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
if ($Which -eq 'dashed-pen-axis-probe') {
    Add-Type -Path (Join-Path $here 'DashedAnisotropicPenProbe.cs')
    [DashedAnisotropicPenProbe]::Run($outDir)
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
if ($Which -eq 'path-probe' -or $Which -eq 'wide-path-probe' -or $Which -eq 'wide-outline-probe' -or $Which -eq 'flat-pen-probe' -or $Which -eq 'arc-path-probe' -or $Which -eq 'curve-widen-probe' -or $Which -eq 'curve-dash-probe' -or $Which -eq 'wmf-scaled-path-probe' -or $Which -eq 'emf-scaled-path-probe') {
    Add-Type -Path (Join-Path $here 'PathProbe.cs')
    if ($Which -eq 'emf-scaled-path-probe') { [PathProbe]::EmfScaledPaths($outDir) } elseif ($Which -eq 'wmf-scaled-path-probe') { [PathProbe]::WmfScaledPaths($outDir) } elseif ($Which -eq 'wide-path-probe') { [PathProbe]::Wide($outDir) } elseif ($Which -eq 'flat-pen-probe') { [PathProbe]::FlatVectors($outDir) } elseif ($Which -eq 'arc-path-probe') { [PathProbe]::ArcPaths($outDir) } elseif ($Which -eq 'curve-widen-probe') { [PathProbe]::CurveWiden($outDir) } elseif ($Which -eq 'curve-dash-probe') { [PathProbe]::CurveDash($outDir) } elseif ($Which -eq 'wide-outline-probe') { [PathProbe]::Outline($outDir) } else { [PathProbe]::Run($outDir) }
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
