param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class TranslucentClampDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[TranslucentClampDpi]::SetProcessDPIAware() | Out-Null
$destination = if ($OutDir) { $OutDir } else { Join-Path $here '..\..\src\__fixtures__\gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
Add-Type -Path (Join-Path $here 'TranslucentClampProbe.cs') -ReferencedAssemblies System.Drawing
[TranslucentClampProbe]::Run($destination)
& (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-translucent-clamp.json') -Groups 'translucent-clamp-surfaces' -Files @((Join-Path $destination 'translucent-clamp-surfaces.json.gz'))
