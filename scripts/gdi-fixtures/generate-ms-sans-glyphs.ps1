# Native monochrome glyphs of Microsoft Sans Serif (the face behind MS Shell Dlg) and Times New Roman Italic (round 10, workstream C).
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/gdi-fixtures/generate-ms-sans-glyphs.ps1 [-OutDir <dir>]
#
# GetGlyphOutline(GGO_BITMAP) and GetGlyphOutline(GGO_NATIVE) of U+0020..U+007E of Microsoft Sans Serif at 24 em heights
# (-6 to -72) at NONANTIALIASED_QUALITY (GlyphSheetProbe.cs): ms-sans-glyphs.json.gz, and the GGO_GRAY4_BITMAP of ten of the
# sizes (-11 to -16, -18, -20, -24, -36; GetGlyphOutline ignores the gasp table): ms-sans-glyphs-gray.json.gz, with
# environment-ms-sans-glyphs.json.
# times-italic-glyphs.json.gz: GGO_BITMAP and GGO_NATIVE of < = > ~ j 4 of Times New Roman Italic at 17 em heights (-9 to -72), the glyphs whose
# hmtx left side bearing differs from xMin (< and > by 111 and 113 units, j by 4), which showed that GDI's interpreter leaves the left phantom
# point where scaling put it and rounds the advance (pp2 = pp1 + round(width)).
# It showed that GDI places a bitmap on the whole pixel nearest to the left phantom point a glyph program moved, keeping
# the fraction (the 7 of 11 to 15 px, whose program shifts that point by -28/64 pixel).
param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$destination = if ($OutDir) { $OutDir } else { Join-Path $here '..\..\src\__fixtures__\gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
Add-Type -Path (Join-Path $here 'GlyphSheetProbe.cs')
$chars = -join (32..126 | ForEach-Object { [char]$_ })
$sizes = [int[]]@(-6, -7, -8, -9, -10, -11, -12, -13, -14, -15, -16, -17, -18, -19, -20, -22, -24, -26, -28, -33, -36, -44, -48, -72)
[GlyphSheetProbe]::Run((Join-Path $destination 'ms-sans-glyphs.json.gz'), [string[]]@('Microsoft Sans Serif'), $sizes, 400, 0, $chars)
[GlyphSheetProbe]::BitmapFormat = 5
[GlyphSheetProbe]::Run((Join-Path $destination 'ms-sans-glyphs-gray.json.gz'), [string[]]@('Microsoft Sans Serif'), [int[]]@(-11, -12, -13, -14, -15, -16, -18, -20, -24, -36), 400, 0, $chars)
[GlyphSheetProbe]::BitmapFormat = 1
[GlyphSheetProbe]::Run((Join-Path $destination 'times-italic-glyphs.json.gz'), [string[]]@('Times New Roman'), [int[]]@(-9, -10, -11, -12, -13, -14, -15, -16, -17, -18, -20, -24, -28, -32, -36, -48, -72), 400, 1, '<=>~j4')
& (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-ms-sans-glyphs.json') -Groups 'ms-sans-glyphs' -Files @((Join-Path $destination 'ms-sans-glyphs.json.gz'), (Join-Path $destination 'ms-sans-glyphs-gray.json.gz'), (Join-Path $destination 'times-italic-glyphs.json.gz'))
