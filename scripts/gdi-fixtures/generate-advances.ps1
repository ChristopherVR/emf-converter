# Native integer advance widths (round 10, workstream C).
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/gdi-fixtures/generate-advances.ps1 [-OutDir <dir>]
#
# Requires Python with fontTools (generated CC0 fonts) and Windows GDI. Writes, next to the other fixtures:
#   gdi-advances.json.gz          GetCharWidth32 and GGO_METRICS of U+0020..U+00FF of Arial, Times New Roman, Courier New,
#                                 Segoe UI and Tahoma at every em height -6..-128 and cell height 6..96 (GdiAdvanceProbe.cs)
#   parity-advance-{linear,hinted,program}.ttf, advance-font-{linear,hinted,program}.json.gz
#                                 program-free fonts whose glyph i has the advance i of 2048 units, GetCharWidth32 of every
#                                 glyph at -6..-200 (AdvanceFontProbe.cs, build-advance-fonts.py): the rounding of a scaled
#                                 advance without any hinting; "linear" clears head.flags bit 4, "hinted" sets it, "program"
#                                 sets it and gives every glyph a one-instruction program
#   environment-advances.json     the usual manifest.
param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$destination = if ($OutDir) { $OutDir } else { Join-Path $here '..\..\src\__fixtures__\gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
python (Join-Path $here 'build-advance-fonts.py') $destination
if ($LASTEXITCODE -ne 0) { throw 'Advance font generation failed' }
Add-Type -Path (Join-Path $here 'GdiAdvanceProbe.cs')
Add-Type -Path (Join-Path $here 'AdvanceFontProbe.cs')
[GdiAdvanceProbe]::Run((Join-Path $destination 'gdi-advances.json.gz'), 400, 0)
foreach ($kind in @('linear', 'hinted', 'program')) {
    $title = (Get-Culture).TextInfo.ToTitleCase($kind)
    [AdvanceFontProbe]::Run((Join-Path $destination "parity-advance-$kind.ttf"), "Parity Advance $title", (Join-Path $destination "advance-font-$kind.json.gz"), 6, 200)
}
$files = @('gdi-advances.json.gz') + @('linear', 'hinted', 'program' | ForEach-Object { "parity-advance-$_.ttf"; "advance-font-$_.json.gz" })
& (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-advances.json') -Groups 'advances' -Files ($files | ForEach-Object { Join-Path $destination $_ })
