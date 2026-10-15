param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class GrayBlendDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[GrayBlendDpi]::SetProcessDPIAware() | Out-Null
$destination = if ($OutDir) { $OutDir } else { Join-Path $here '..\..\src\__fixtures__\gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
Add-Type -Path (Join-Path $here 'GrayBlendProbe.cs') -ReferencedAssemblies System.Drawing
[GrayBlendProbe]::Run($destination)
& (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-gray-blend.json') -Groups 'gray-blend' -Files @((Join-Path $destination 'gray-blend.json.gz'))
