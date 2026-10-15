param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$destination = if ($OutDir) { $OutDir } else { Join-Path $here '..\..\src\__fixtures__\gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
# GetGlyphOutline GGO_BITMAP and GGO_NATIVE of the glyphs of the rotated-text fixtures ("Tg" and "Escape" with digits) at the
# sizes and angles the fixtures use, plus the diagonals (45, 135, 225, 315 degrees) where edges pass through pixel centres.
$env:GLYPH_CHARS = 'TgEscap0123456789'
$env:GLYPH_HEIGHTS = '-13,-16,-20'
$env:GLYPH_DEGREES = '25,30,45,120,135,160,225,300,315'
$env:GLYPH_OUTPUT = 'rotated-glyph-bitmaps-small.json.gz'
Add-Type -Path (Join-Path $here 'TextRotatedPlacementProbe.cs') -ReferencedAssemblies System.Core
[TextRotatedPlacementProbe]::RunGlyphs($destination)
& (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-rotated-bitmaps.json') -Groups 'rotated-bitmaps' -Files @((Join-Path $destination 'rotated-glyph-bitmaps-small.json.gz'))
