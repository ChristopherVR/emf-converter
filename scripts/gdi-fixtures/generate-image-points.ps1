param([string]$OutDir = '', [switch]$SkipNoise, [switch]$SkipPositions)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class ImagePointsDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[ImagePointsDpi]::SetProcessDPIAware() | Out-Null
$destination = if ($OutDir) { $OutDir } else { Join-Path $here '..\..\src\__fixtures__\gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
Add-Type -Path (Join-Path $here 'ImagePointsProbe.cs') -ReferencedAssemblies System.Drawing
$files = @()
if (-not $SkipNoise) { [ImagePointsProbe]::Noise($destination, 'image-points', [ImagePointsProbe]::DefaultNoise); $files += (Join-Path $destination 'image-points.json.gz') }
# The bisection takes about a minute: each query is seven or eight draws of a 300 x 200 surface.
if (-not $SkipPositions) { [ImagePointsProbe]::Positions($destination, 'image-points-positions', [ImagePointsProbe]::DefaultPositions); $files += (Join-Path $destination 'image-points-positions.json.gz') }
& (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-image-points.json') -Groups 'image-points,image-points-positions' -Files $files
