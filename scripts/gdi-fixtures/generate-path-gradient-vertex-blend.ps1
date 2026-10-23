param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class PathGradientVertexBlendDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[PathGradientVertexBlendDpi]::SetProcessDPIAware() | Out-Null
$destination = if ($OutDir) { $OutDir } else { Join-Path $here '..\..\src\__fixtures__\gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
Add-Type -Path (Join-Path $here 'PathGradientVertexBlendProbe.cs') -ReferencedAssemblies System.Drawing
[PathGradientVertexBlendProbe]::Run($destination)
& (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-path-gradient-vertex-blend.json') -Groups 'path-gradient-vertex-blend' -Files @((Join-Path $destination 'path-gradient-vertex-blend.json.gz'))
