# Native hinting and scan-conversion controls for GDI's monochrome text (round 7, workstream H).
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/gdi-fixtures/generate-mono-hinting.ps1 [-OutDir <dir>]
#
# Requires Python with fontTools (generated CC0 fonts) and Windows GDI. It writes, next to the other fixtures:
#   freedom-*.ttf (15 generated CC0 fonts), freedom-hinting.json.gz
#       GetGlyphOutline(GGO_NATIVE) of the hinted outline after one interpreter primitive: a move along x and y
#       with the freedom vector off the projection vector (movement, mdrp, mirp, mdrpmin), freedom vector equal to
#       the projection vector however it was set (eqmdrp, eqmirp, sepmdrp, perpmirp), the vectors SPVTL/SFVTL/SDPVTL
#       leave (vec06 ... vec87), and ISECT (isect). build-freedom-fonts.py describes each program.
#   curve-ovals.ttf, curve-ovals.json.gz
#       program-free ovals of four quadratic arcs at 32 ppem (one font unit is one 26.6 unit): GGO_BITMAP of each.
#   mono-sheet-glyphs.json.gz
#       GGO_BITMAP and GGO_NATIVE of every glyph the textx-*-mono size and style sheets draw (MonoSheetGlyphProbe.cs),
#       five faces, so a residual of those sheets can be told apart as hinting (the outline differs) or scan
#       conversion (it does not). Needs the installed Arial, Times New Roman, Courier New, Segoe UI and Tahoma.
#   environment-mono-hinting.json   the usual manifest.
#
# The instruction-prefix fonts (PrefixHintProbe.cs + build-hint-prefix-font.py) are derived from installed Microsoft
# fonts and are not committed: run them by hand as described in the README ("Monochrome hinting controls").
param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
$captureDirectory = if ($OutDir) { $OutDir } else { Join-Path $PSScriptRoot '../../src/__fixtures__/gdi' }
$captureDirectory = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $captureDirectory)).Path
$work = Join-Path ([IO.Path]::GetTempPath()) ('mono-hinting-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $work | Out-Null

python (Join-Path $PSScriptRoot 'build-freedom-fonts.py') $captureDirectory
if ($LASTEXITCODE -ne 0) { throw 'Freedom font generation failed' }
python (Join-Path $PSScriptRoot 'build-curve-fonts.py') $work 1024 11 oval
if ($LASTEXITCODE -ne 0) { throw 'Curve font generation failed' }
Copy-Item (Join-Path $work 'curves.ttf') (Join-Path $captureDirectory 'curve-ovals.ttf') -Force

Add-Type -Path (Join-Path $PSScriptRoot 'PrefixHintProbe.cs')
Add-Type -Path (Join-Path $PSScriptRoot 'MonoSheetGlyphProbe.cs')
$title = (Get-Culture).TextInfo

function Read-Gz($path) {
    $stream = [IO.File]::OpenRead($path)
    try {
        $gz = New-Object IO.Compression.GZipStream($stream, [IO.Compression.CompressionMode]::Decompress)
        $reader = New-Object IO.StreamReader($gz)
        return $reader.ReadToEnd() | ConvertFrom-Json
    } finally { $stream.Dispose() }
}

# 1. interpreter primitives
$plans = [ordered]@{
    movement = '-16,-23,-32,-41'; mdrp = '-16,-23,-32,-41'; mirp = '-16,-23,-32,-41'; mdrpmin = '-16,-23,-32,-41'
    eqmdrp = '-12,-16,-23,-32,-41'; eqmirp = '-12,-16,-23,-32,-41'; sepmdrp = '-12,-16,-23,-32,-41'; perpmirp = '-12,-16,-23,-32,-41'
    vec06 = '-16'; vec07 = '-16'; vec08 = '-16'; vec09 = '-16'; vec86 = '-16'; vec87 = '-16'
    isect = '-12,-17,-23,-32'
}
$merged = [ordered]@{}
foreach ($kind in $plans.Keys) {
    $font = Join-Path $captureDirectory "freedom-$kind.ttf"
    $sizes = [int[]]($plans[$kind] -split ',' | ForEach-Object { [int]$_ })
    $widths = [int[]]($sizes | ForEach-Object { 0 })
    $out = Join-Path $work "$kind.json.gz"
    [PrefixHintProbe]::Run($font, "Parity Freedom $($title.ToTitleCase($kind))", $sizes, $widths, 1, 3, $out)
    # keep only what the regression test reads: size, glyph variant and the hinted outline
    $records = New-Object System.Collections.ArrayList
    foreach ($c in (Read-Gz $out)) {
        if ($c.glyph -eq 0 -and $c.variant -lt $(if ($kind -eq 'isect') { 240 } else { 36 })) { [void]$records.Add([ordered]@{ size = $c.size; variant = $c.variant; native = $c.native }) }
    }
    $merged[$kind] = $records.ToArray()
}
$json = $merged | ConvertTo-Json -Depth 5 -Compress
$bytes = [Text.Encoding]::UTF8.GetBytes($json)
$target = Join-Path $captureDirectory 'freedom-hinting.json.gz'
$file = [IO.File]::Create($target)
try { $zip = New-Object IO.Compression.GZipStream($file, [IO.Compression.CompressionMode]::Compress); $zip.Write($bytes, 0, $bytes.Length); $zip.Dispose() } finally { $file.Dispose() }

# 2. ovals
[PrefixHintProbe]::Run((Join-Path $captureDirectory 'curve-ovals.ttf'), 'Parity Curves', [int[]]@(-32), [int[]]@(0), 4, 3, (Join-Path $captureDirectory 'curve-ovals.json.gz'))

# 3. real-font sheet glyphs
[MonoSheetGlyphProbe]::Run($captureDirectory, 'mono-sheet-glyphs.json.gz')

$references = @(Get-ChildItem -LiteralPath $captureDirectory -Filter 'freedom-*.ttf') + @(Get-Item (Join-Path $captureDirectory 'freedom-hinting.json.gz'), (Join-Path $captureDirectory 'curve-ovals.ttf'), (Join-Path $captureDirectory 'curve-ovals.json.gz'), (Join-Path $captureDirectory 'mono-sheet-glyphs.json.gz'))
& (Join-Path $PSScriptRoot 'capture-environment.ps1') -OutputPath (Join-Path $captureDirectory 'environment-mono-hinting.json') -Groups 'mono-hinting' -Files ($references | ForEach-Object { $_.FullName })
Remove-Item -Recurse -Force $work
