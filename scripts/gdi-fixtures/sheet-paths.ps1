# Native GetPath / WidenPath of the Arc..RoundRect (and optionally LineTo) records of recorded sheets played back.
#   powershell.exe -NoProfile -File scripts/gdi-fixtures/sheet-paths.ps1 -Emf a.emf[,b.emf] -OutFile out.json [-Widen] [-Lines]
param([string[]]$Emf, [string]$OutFile, [switch]$Widen, [switch]$Lines)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -Path (Join-Path $here 'CompatPlaybackProbe.cs') -ReferencedAssemblies System.Drawing
$parts = @()
foreach ($f in ($Emf -join ',').Split(',')) { $parts += '"' + (Split-Path -Leaf $f).Replace('.emf', '') + '":' + [CompatPlaybackProbe]::SheetPaths((Resolve-Path $f).Path, [bool]$Widen, [bool]$Lines) }
[IO.File]::WriteAllText($OutFile, '{' + ($parts -join ',') + '}')
