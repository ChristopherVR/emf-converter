# GGO_GRAY4_BITMAP and GGO_NATIVE of every glyph the textx-*-aa size and style sheets draw (round 11, workstream B).
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/gdi-fixtures/generate-gray-sheet-glyphs.ps1 [-OutDir <dir>]
#
# Writes gray-sheet-glyphs.json.gz (the same captures as mono-sheet-glyphs.json.gz, ANTIALIASED_QUALITY and the 17-level
# bitmap) and environment-gray-sheet-glyphs.json. Needs the installed Arial, Times New Roman, Courier New, Segoe UI and Tahoma.
param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class GraySheetDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[GraySheetDpi]::SetProcessDPIAware() | Out-Null
$destination = if ($OutDir) { $OutDir } else { Join-Path $here '..\..\src\__fixtures__\gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
Add-Type -Path (Join-Path $here 'MonoSheetGlyphProbe.cs')
[MonoSheetGlyphProbe]::Run($destination, 'gray-sheet-glyphs.json.gz', 4, 5)
& (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-gray-sheet-glyphs.json') -Groups 'gray-sheet-glyphs' -Files @((Join-Path $destination 'gray-sheet-glyphs.json.gz'))
