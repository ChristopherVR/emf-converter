param([string]$OutDir = '', [switch]$SkipSweep)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class TextureCoordinateDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[TextureCoordinateDpi]::SetProcessDPIAware() | Out-Null
$destination = if ($OutDir) { $OutDir } else { Join-Path $here '..\..\src\__fixtures__\gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
Add-Type -Path (Join-Path $here 'TextureCoordinateProbe.cs') -ReferencedAssemblies System.Drawing
Add-Type -Path (Join-Path $here 'MatrixInvertProbe.cs') -ReferencedAssemblies System.Drawing
Add-Type -Path (Join-Path $here 'ImageCoordinateProbe.cs') -ReferencedAssemblies System.Drawing
Add-Type -Path (Join-Path $here 'ImageLevelProbe.cs') -ReferencedAssemblies System.Drawing
[MatrixInvertProbe]::Run($destination)
[ImageCoordinateProbe]::Run($destination)
[ImageLevelProbe]::Run($destination)
# The texture sweep takes about ten minutes: 16 cases of 65,536 draws.
if (-not $SkipSweep) { [TextureCoordinateProbe]::Run($destination) }
& (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-texture-coordinate.json') -Groups 'texture-coordinate,image-coordinate,image-levels,matrix-invert' -Files @((Join-Path $destination 'texture-coordinate.json.gz'), (Join-Path $destination 'image-coordinate.json.gz'), (Join-Path $destination 'image-levels.json.gz'), (Join-Path $destination 'matrix-invert.json.gz'))
