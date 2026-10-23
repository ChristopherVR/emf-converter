param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class PathGradientClipDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[PathGradientClipDpi]::SetProcessDPIAware() | Out-Null
$destination = if ($OutDir) { $OutDir } else { Join-Path $here '..\..\src\__fixtures__\gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
Add-Type -Path (Join-Path $here 'PathGradientClipProbe.cs') -ReferencedAssemblies System.Drawing
[PathGradientClipProbe]::Run($destination)
& (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-path-gradient-clip.json') -Groups 'path-gradient-clip' -Files @((Join-Path $destination 'path-gradient-clip.json.gz'))
