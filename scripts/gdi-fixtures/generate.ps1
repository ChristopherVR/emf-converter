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
# Standalone probe modes (run separately from drawing groups):
#   path-probe, wide-path-probe, wide-outline-probe, flat-pen-probe,
#   arc-path-probe, wmf-scaled-path-probe, emf-scaled-path-probe,
#   curve-widen-probe, curve-dash-probe, arc-cap-sweep-probe,
#   miter-limit-probe, gradient-blend-probe, chord-sweep-probe,
#   scaled-cap-sweep-probe, scaled-line-caps-probe, scaled-pen-widths-probe,
#   emf-roundrect-wide-probe, emf-roundrect-mode-probe, compat-playback-probe, dash-lengthened-probe, chord-closing-probe,
#   dash-neighbourhood-probe, text-recorded-advance, text-coverage,
#   text-cleartype-coverage, text-origin-phases, text-origin-vertical-phases,
#   text-drawstring-placement, text-diagonal-hinting, text-diagonal-coverage,
#   text-opcode-hinting, text-opcode-coverage, text-vector-stage-hinting,
#   text-vector-stage-coverage, text-signed-diagonal, path-gradient-steps,
#   path-gradient-vertices, path-gradient-rotated, path-gradient-focus-shapes,
#   path-gradient-ties, path-gradient-colors, path-gradient-focus,
#   focus-contours, redeye-independent, vertical-focus-line, playback-extents,
#   bicubic-copy, hq-arithmetic, hq-rotated, hq-axis, hq-half-shift,
#   halftone-fractional-kernel, halftone-run-2d, halftone-run-phase,
#   halftone-kernel, halftone-arrangement, halftone-selection, halftone-boundary,
#   roundrect-half-fix-translation, roundrect-half-fix, bicubic-phases,
#   bicubic-arithmetic, bicubic-independent, wide-pen-axis-probe,
#   wide-pen-axis-directions, dashed-pen-axis-probe, general-matrix-pen-probe,
#   nib-matrix-pen-probe, rotated-pen-vector-probe, bezier-flatten,
#   illuminant-cubes, image-codecs, image-codecs-extra, image-codecs-advanced,
#   image-codecs-cmyk-lut, image-codecs-arithmetic, image-effects,
#   image-effect-sharpen, image-effect-large-blur, image-effect-expanded-blur,
#   image-effect-narrow-blur, image-effect-hue, image-effect-tint,
#   image-effect-tables, icm-cmyk-probe, icm-cmyk-srgb16, icm-cmyk-translate16
#
# Each case writes <name>.emf (or .wmf) plus <name>.png: the same drawing
# calls painted straight onto a 32bpp bitmap by Windows itself, or GDI+'s
# playback of the recorded metafile.
param([string]$Which = 'all', [string]$TablesDir = '', [string]$PlaybackCase = '', [switch]$PlaybackOpen, [string]$OutDir = '', [switch]$DpiUnaware)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
# GetDeviceCaps and enhanced-metafile headers must use the same physical
# coordinates. A DPI-virtualised PowerShell otherwise records a larger frame
# and PlayEnhMetaFile silently scales its reference bitmap on scaled displays.
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class GdiFixtureDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
# -DpiUnaware keeps the process DPI-virtualised (96 dpi, a 3840 x 2160 display at 150% reports 2560 x 1440), the environment the
# oldest text references were captured in; the raster-face mapper chooses its sizes by the device dpi.
if (-not $DpiUnaware) { [GdiFixtureDpi]::SetProcessDPIAware() | Out-Null }
$out = if ($OutDir) { $OutDir } else { Join-Path $here '..\..\src\__fixtures__\gdi' }
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
if ($Which -eq 'chord-closing-probe' -or $Which -eq 'dash-neighbourhood-probe' -or $Which -eq 'dash-cut-tie-probe' -or $Which -eq 'dash-lengthened-probe' -or $Which -eq 'scaled-dash-cap-probe' -or $Which -eq 'curve-end-reversal-probe' -or $Which -eq 'tiny-final-segment-probe') {
    Add-Type -Path (Join-Path $here 'PathProbe.cs')
    if ($Which -eq 'chord-closing-probe') { [PathProbe]::ChordClosing($outDir) } elseif ($Which -eq 'dash-cut-tie-probe') { [PathProbe]::DashCutTies($outDir) } elseif ($Which -eq 'dash-lengthened-probe') { [PathProbe]::DashLengthened($outDir) } elseif ($Which -eq 'scaled-dash-cap-probe') { [PathProbe]::ScaledDashCaps($outDir) } elseif ($Which -eq 'curve-end-reversal-probe') { [PathProbe]::CurveEndReversal($outDir) } elseif ($Which -eq 'tiny-final-segment-probe') { [PathProbe]::TinyFinalSegmentLines($outDir) } else { [PathProbe]::CurveDashNeighbourhood($outDir) }
    Complete-Fixtures
    return
}
if ($Which -eq 'emf-roundrect-mode-probe') {
    Add-Type -Path (Join-Path $here 'RoundRectModeProbe.cs') -ReferencedAssemblies System.Drawing
    [RoundRectModeProbe]::Run($outDir)
    [RoundRectModeProbe]::Paths($outDir)
    [RoundRectModeProbe]::PlayExisting($outDir, 'emfrec-path-widen')
    Complete-Fixtures
    return
}
if ($Which -eq 'compat-playback-probe') {
    Add-Type -Path (Join-Path $here 'CompatPlaybackProbe.cs') -ReferencedAssemblies System.Drawing
    [CompatPlaybackProbe]::Run($outDir)
    [CompatPlaybackProbe]::RectSweep($outDir)
    Complete-Fixtures
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
if ($Which -eq 'text-recorded-advance') {
    Add-Type -Path (Join-Path $here 'RecordedAdvanceProbe.cs') -ReferencedAssemblies System.Drawing
    [RecordedAdvanceProbe]::Run($outDir)
    $names = 'textx-arial-q0-default', 'textx-arial-q1-draft', 'textx-arial-q2-proof', 'textx-arial-cleartype', 'textx-arial-ctnatural', 'textx-segoeui-cell-mono'
    $files = @(Join-Path $outDir 'text-recorded-advance.json') + @($names | ForEach-Object { Join-Path $outDir ($_ + '.emf'); Join-Path $outDir ($_ + '.png') })
    & (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $outDir 'environment-text-recorded-advance.json') -Groups $Which -Files $files
    return
}
if ($Which -eq 'text-raster-mapper') {
    Add-Type -Path (Join-Path $here 'RasterMapperProbe.cs') -ReferencedAssemblies System.Drawing
    [RasterMapperProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'text-playback-hinting') {
    Add-Type -Path (Join-Path $here 'TextPlaybackProbe.cs') -ReferencedAssemblies System.Drawing
    [TextPlaybackProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'playback-extents') {
    Add-Type -Path (Join-Path $here 'PlaybackExtentProbe.cs') -ReferencedAssemblies System.Drawing
    $cases = Get-Content -LiteralPath (Join-Path $outDir 'playback-extents.json') -Raw | ConvertFrom-Json
    # Candidates whose native playback does not reproduce the original overlap:
    # kept as `.wide.png` evidence of how far Windows paints, never as references.
    $open = Get-Content -LiteralPath (Join-Path $outDir 'playback-extents-open.json') -Raw | ConvertFrom-Json
    if ($PlaybackCase -and $PlaybackOpen) {
        $case = @($open | Where-Object { $_.name -eq $PlaybackCase })
        if ($case.Count -ne 1) { throw "Unknown open playback case: $PlaybackCase" }
        $case = $case[0]
        [void][PlaybackExtentProbe]::Capture($outDir, $case.name, $case.w, $case.h, $case.ox, $case.oy, $false, $false, $false, '.wide.png')
        return
    }
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
    foreach ($case in $open) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $MyInvocation.MyCommand.Path playback-extents -PlaybackCase $case.name -PlaybackOpen
        if ($LASTEXITCODE -ne 0) { throw "Open playback capture failed: $($case.name)" }
    }
    $files = @((Join-Path $outDir 'playback-extents.json'), (Join-Path $outDir 'playback-extents-open.json')) + @($cases | ForEach-Object {
        Join-Path $outDir ($_.name + '.emf')
        Join-Path $outDir ($_.name + '.png')
        Join-Path $outDir ($_.name + '.extent.png')
    }) + @($open | ForEach-Object {
        Join-Path $outDir ($_.name + '.emf')
        Join-Path $outDir ($_.name + '.png')
        Join-Path $outDir ($_.name + '.wide.png')
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
if ($Which -eq 'path-gradient-steps') {
    Add-Type -Path (Join-Path $here 'PathGradientStepProbe.cs') -ReferencedAssemblies System.Drawing
    [PathGradientStepProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'path-gradient-vertices') {
    Add-Type -Path (Join-Path $here 'PathGradientVertexProbe.cs') -ReferencedAssemblies System.Drawing
    [PathGradientVertexProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'path-gradient-rotated') {
    Add-Type -Path (Join-Path $here 'PathGradientRotateProbe.cs') -ReferencedAssemblies System.Drawing
    [PathGradientRotateProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'path-gradient-focus-shapes') {
    Add-Type -Path (Join-Path $here 'PathGradientFocusShapeProbe.cs') -ReferencedAssemblies System.Drawing
    [PathGradientFocusShapeProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'path-gradient-ties') {
    Add-Type -Path (Join-Path $here 'PathGradientTieProbe.cs') -ReferencedAssemblies System.Drawing
    [PathGradientTieProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'path-gradient-edges') {
    Add-Type -Path (Join-Path $here 'PathGradientEdgeProbe.cs') -ReferencedAssemblies System.Drawing
    [PathGradientEdgeProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'path-gradient-focus-small') {
    Add-Type -Path (Join-Path $here 'PathGradientFocusSmallProbe.cs') -ReferencedAssemblies System.Drawing
    [PathGradientFocusSmallProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'path-gradient-tiles') {
    Add-Type -Path (Join-Path $here 'PathGradientTileProbe.cs') -ReferencedAssemblies System.Drawing
    [PathGradientTileProbe]::Run($outDir)
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
if ($Which -eq 'hq-rotated') {
    Add-Type -Path (Join-Path $here 'HighQualityRotatedProbe.cs') -ReferencedAssemblies System.Drawing
    [HighQualityRotatedProbe]::Run($outDir)
    Add-Type -Path (Join-Path $here 'HighQualityRotatedFineProbe.cs') -ReferencedAssemblies System.Drawing
    [HighQualityRotatedFineProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'hq-half-shift') {
    Add-Type -Path (Join-Path $here 'HighQualityHalfShiftProbe.cs') -ReferencedAssemblies System.Drawing
    [HighQualityHalfShiftProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'hq-axis') {
    Add-Type -Path (Join-Path $here 'HighQualityAxisProbe.cs') -ReferencedAssemblies System.Drawing
    [HighQualityAxisProbe]::Run($outDir)
    Add-Type -Path (Join-Path $here 'HighQualityAxisNoiseProbe.cs') -ReferencedAssemblies System.Drawing
    [HighQualityAxisNoiseProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'hq-phases') {
    Add-Type -Path (Join-Path $here 'HighQualityPhaseProbe.cs') -ReferencedAssemblies System.Drawing
    [HighQualityPhaseProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'hq-wrap') {
    Add-Type -Path (Join-Path $here 'HighQualityWrapProbe.cs') -ReferencedAssemblies System.Drawing
    [HighQualityWrapProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'hq-reductions') {
    Add-Type -Path (Join-Path $here 'HighQualityReductionProbe.cs') -ReferencedAssemblies System.Drawing
    [HighQualityReductionProbe]::Run($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'hq-cubic-weights') {
    Add-Type -Path (Join-Path $here 'HighQualityCubicWeightProbe.cs') -ReferencedAssemblies System.Drawing
    # The designed source rows come from `bun scripts/gdi-fixtures/generate-hq-cubic-source.ts <TablesDir>/hq-cubic-weights-source.bin`.
    if (!$TablesDir) { throw 'Pass -TablesDir, the directory holding hq-cubic-weights-source.bin' }
    [HighQualityCubicWeightProbe]::Run($outDir, (Resolve-Path -LiteralPath $TablesDir).Path)
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
if ($Which -eq 'halftone-boundary') {
    # Batch HALFTONE StretchBlt/StretchDIBits probe: runs every <name>.hbin in -TablesDir (see
    # HalftoneBoundaryProbe.cs for the format) and writes <name>.hout next to it.
    # generate-halftone-boundary.ts writes the inputs, calls this mode and builds the capture.
    if (!$TablesDir) { throw 'Pass the directory holding <name>.hbin files (written by generate-halftone-boundary.ts)' }
    Add-Type -Path (Join-Path $here 'HalftoneBoundaryProbe.cs')
    $dir = (Resolve-Path -LiteralPath $TablesDir).Path
    foreach ($input in Get-ChildItem -LiteralPath $dir -Filter *.hbin) {
        [HalftoneBoundaryProbe]::Run($input.FullName, (Join-Path $dir ($input.BaseName + '.hout')))
    }
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
if ($Which -eq 'redeye-stages') {
    Add-Type -Path (Join-Path $here 'RedEyeStageProbe.cs') -ReferencedAssemblies System.Drawing
    [RedEyeStageProbe]::Run($outDir)
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
if ($Which -eq 'general-matrix-pen-probe') {
    Add-Type -Path (Join-Path $here 'GeneralMatrixPenProbe.cs')
    [GeneralMatrixPenProbe]::Run($outDir)
    [GeneralMatrixPenProbe]::RunJoins($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'nib-matrix-pen-probe') {
    Add-Type -Path (Join-Path $here 'NibMatrixPenProbe.cs')
    [NibMatrixPenProbe]::Run($outDir)
    [NibMatrixPenProbe]::RunAngles($outDir)
    Complete-Fixtures
    return
}
if ($Which -eq 'rotated-pen-vector-probe') {
    Add-Type -Path (Join-Path $here 'RotatedPenVectorProbe.cs')
    [RotatedPenVectorProbe]::Run($outDir)
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
if ($Which -eq 'icm-cmyk-probe') {
    if (!$TablesDir) { throw 'Pass the directory holding <name>.ink files (raw C,M,Y,K ink bytes; see the R1 export script)' }
    Add-Type -Path (Join-Path $here 'IcmProbe.cs')
    $dir = (Resolve-Path -LiteralPath $TablesDir).Path
    foreach ($ink in Get-ChildItem -LiteralPath $dir -Filter *.ink) {
        foreach ($intent in 0, 1) { [IcmProbe]::RunXyz($ink.FullName, (Join-Path $dir ($ink.BaseName + '.xyz' + $intent)), 'C:\Windows\System32\spool\drivers\color\RSWOP.icm', $intent, 3) }
        [IcmProbe]::RunSrgb16($ink.FullName, (Join-Path $dir ($ink.BaseName + '.srgb16')), 'C:\Windows\System32\spool\drivers\color\RSWOP.icm', 0, 3)
        [IcmProbe]::Run($ink.FullName, (Join-Path $dir ('icm-' + $ink.BaseName)), 'C:\Windows\System32\spool\drivers\color\RSWOP.icm')
    }
    return
}
if ($Which -eq 'icm-cmyk-srgb16') {
    # Lightweight variant of icm-cmyk-probe: only the 16-bit best-mode sRGB translation, for large input files.
    if (!$TablesDir) { throw 'Pass the directory holding <name>.ink files' }
    Add-Type -Path (Join-Path $here 'IcmProbe.cs')
    $dir = (Resolve-Path -LiteralPath $TablesDir).Path
    foreach ($ink in Get-ChildItem -LiteralPath $dir -Filter *.ink) {
        [IcmProbe]::RunSrgb16($ink.FullName, (Join-Path $dir ($ink.BaseName + '.srgb16')), 'C:\Windows\System32\spool\drivers\color\RSWOP.icm', 0, 3)
        [IcmProbe]::RunSrgb8($ink.FullName, (Join-Path $dir ($ink.BaseName + '.srgb8')), 'C:\Windows\System32\spool\drivers\color\RSWOP.icm')
    }
    return
}
if ($Which -eq 'icm-cmyk-translate16') {
    # 16-bit CMYK input through TranslateColors: every <name>.cmyk16 file (little-endian 16-bit C, M, Y, K words per sample)
    # becomes <name>.rgb16t (16-bit R, G, B words per sample). Needs a 64-bit PowerShell for the 16-byte COLOR records.
    if (!$TablesDir) { throw 'Pass the directory holding <name>.cmyk16 files' }
    Add-Type -Path (Join-Path $here 'IcmProbe.cs')
    $dir = (Resolve-Path -LiteralPath $TablesDir).Path
    foreach ($ink in Get-ChildItem -LiteralPath $dir -Filter *.cmyk16) {
        [IcmProbe]::RunTranslate16($ink.FullName, (Join-Path $dir ($ink.BaseName + '.rgb16t')), 'C:\Windows\System32\spool\drivers\color\RSWOP.icm', 3)
    }
    return
}
if ($Which -eq 'image-codecs-cmyk-lut') {
    if (!$TablesDir) { throw 'Pass the directory written by cmyk-lut-inputs.py' }
    Add-Type -Path (Join-Path $here 'CodecProbe.cs') -ReferencedAssemblies System.Drawing
    [CodecProbe]::DecodeDirectory((Resolve-Path -LiteralPath $TablesDir).Path)
    return
}
if ($Which -eq 'image-codecs-arithmetic') {
    # Encodes the arithmetic JPEG variants (arith-jpeg-encoder.ts) and has GDI+ decode each one; -PlaybackCase takes
    # a comma-separated list of variant names whose EMF+ DrawImage playback is recorded too.
    bun (Join-Path $here 'arith-jpeg-encoder.ts') $outDir
    if ($LASTEXITCODE -ne 0) { throw 'arith-jpeg-encoder.ts failed' }
    Add-Type -Path (Join-Path $here 'CodecProbe.cs') -ReferencedAssemblies System.Drawing
    [CodecProbe]::ArithmeticReferences($outDir)
    if ($PlaybackCase) { [CodecProbe]::ArithmeticPlayback($outDir, @($PlaybackCase -split ',' | ForEach-Object { 'arith-' + $_ })) }
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
if ($Which -eq 'path-probe' -or $Which -eq 'wide-path-probe' -or $Which -eq 'wide-outline-probe' -or $Which -eq 'flat-pen-probe' -or $Which -eq 'arc-path-probe' -or $Which -eq 'curve-widen-probe' -or $Which -eq 'curve-dash-probe' -or $Which -eq 'arc-cap-sweep-probe' -or $Which -eq 'chord-sweep-probe' -or $Which -eq 'scaled-cap-sweep-probe' -or $Which -eq 'scaled-line-caps-probe' -or $Which -eq 'scaled-pen-widths-probe' -or $Which -eq 'emf-roundrect-wide-probe' -or $Which -eq 'wmf-scaled-path-probe' -or $Which -eq 'emf-scaled-path-probe') {
    Add-Type -Path (Join-Path $here 'PathProbe.cs')
    if ($Which -eq 'emf-scaled-path-probe') { [PathProbe]::EmfScaledPaths($outDir) } elseif ($Which -eq 'wmf-scaled-path-probe') { [PathProbe]::WmfScaledPaths($outDir) } elseif ($Which -eq 'wide-path-probe') { [PathProbe]::Wide($outDir) } elseif ($Which -eq 'flat-pen-probe') { [PathProbe]::FlatVectors($outDir) } elseif ($Which -eq 'arc-path-probe') { [PathProbe]::ArcPaths($outDir) } elseif ($Which -eq 'curve-widen-probe') { [PathProbe]::CurveWiden($outDir) } elseif ($Which -eq 'curve-dash-probe') { [PathProbe]::CurveDash($outDir) } elseif ($Which -eq 'arc-cap-sweep-probe') { [PathProbe]::ArcCapSweep($outDir) } elseif ($Which -eq 'chord-sweep-probe') { [PathProbe]::ChordSweep($outDir) } elseif ($Which -eq 'scaled-cap-sweep-probe') { [PathProbe]::ScaledCapSweep($outDir) } elseif ($Which -eq 'scaled-line-caps-probe') { [PathProbe]::ScaledLineCaps($outDir) } elseif ($Which -eq 'scaled-pen-widths-probe') { [PathProbe]::ScaledPenWidths($outDir) } elseif ($Which -eq 'emf-roundrect-wide-probe') { [PathProbe]::EmfRoundRectWide($outDir) } elseif ($Which -eq 'wide-outline-probe') { [PathProbe]::Outline($outDir) } else { [PathProbe]::Run($outDir) }
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
	'halftone', 'halftone-mixed', 'halftone-origin', 'halftone-mixed-probe', 'color-adjustment-controls', 'illuminant-charts', 'illuminant-tables', 'halftone-dither', 'wmf-insideframe-curves', 'emfplus-pens', 'wmf-roundrect-corners', 'emf-insideframe', 'emfplus-effects', 'pen-transform')
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
