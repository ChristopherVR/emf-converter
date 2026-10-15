param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$destination = if ($OutDir) { $OutDir } else { Join-Path $here '..\..\src\__fixtures__\gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
# Private single-instruction fonts (fontTools). HINT_SWEEP_ONLY=all builds every kind; HINT_SWEEP_VECTORS sets the vectors per font.
python (Join-Path $here 'build-hint-sweep-fonts.py') $destination
Add-Type -Path (Join-Path $here 'HintSweepProbe.cs')
[HintSweepProbe]::Run($destination)
& (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-hint-sweep.json') -Groups 'hint-sweep' -Files @((Join-Path $destination 'text-hint-sweep.json.gz'))
