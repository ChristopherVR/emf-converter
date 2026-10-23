param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class LinearRampWorldDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[LinearRampWorldDpi]::SetProcessDPIAware() | Out-Null
$destination = if ($OutDir) { $OutDir } else { Join-Path $here '..\..\src\__fixtures__\gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
Add-Type -Path (Join-Path $here 'LinearRampWorldProbe.cs') -ReferencedAssemblies System.Drawing
[LinearRampWorldProbe]::Run($destination)
& (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-linear-ramp-world.json') -Groups 'linear-ramp-world' -Files @((Join-Path $destination 'linear-ramp-world.json.gz'))
