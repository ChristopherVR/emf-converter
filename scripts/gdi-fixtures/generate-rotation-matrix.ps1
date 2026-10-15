param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$destination = if ($OutDir) { $OutDir } else { Join-Path $here '..\..\src\__fixtures__\gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
# Private fonts with points far from the origin (fontTools). ROT_SIZES / ROT_STEP choose the sizes and the angle step,
# ROT_VARIANTS the font variants, ROT_ALL_FONTS=1 builds every variant, ROT_ALL_POINTS=1 keeps every outline point.
python (Join-Path $here 'build-rotation-matrix-font.py') $destination
Add-Type -Path (Join-Path $here 'RotationMatrixProbe.cs') -ReferencedAssemblies System.Core
[RotationMatrixProbe]::Run($destination)
& (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-rotation-matrix.json') -Groups 'rotation-matrix' -Files @((Join-Path $destination 'rotation-matrix.json.gz'))
