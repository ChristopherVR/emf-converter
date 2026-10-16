param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$destination = if ($OutDir) { $OutDir } else { Join-Path $here '..\..\src\__fixtures__\gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
# Reads rotation-matrix-plain.ttf (built by build-rotation-matrix-font.py, committed next to the captures) from the destination.
# ESC_SIZE (pixels, default 64) and ESC_STEP (tenths of a degree, default 1) change the sweep.
Add-Type -Path (Join-Path $here 'EscapementAngleProbe.cs') -ReferencedAssemblies System.Core
[EscapementAngleProbe]::Run($destination)
& (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-escapement-angles.json') -Groups 'escapement-angles' -Files @((Join-Path $destination 'escapement-angles.json.gz'))
