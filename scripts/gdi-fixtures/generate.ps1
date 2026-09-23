# Regenerates the real-GDI/GDI+ ground-truth fixtures under
# src/__fixtures__/gdi/. Windows only (it calls gdi32/GDI+ directly).
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/gdi-fixtures/generate.ps1 [all|rop|gradient|text]
#
# Each case writes <name>.emf (or .wmf) plus <name>.png: the same drawing
# calls painted straight onto a 32bpp bitmap by Windows itself.
param([string]$Which = 'all')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here '..\..\src\__fixtures__\gdi'
$src = Get-Content -Raw (Join-Path $here 'GdiFixtures.cs')
Add-Type -TypeDefinition $src -ReferencedAssemblies System.Drawing
[GdiFixtures]::Run((Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $out)).Path, $Which)
Write-Host "Fixtures written to $out"
