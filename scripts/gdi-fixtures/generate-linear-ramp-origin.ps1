param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class LinearRampOriginDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[LinearRampOriginDpi]::SetProcessDPIAware() | Out-Null
$destination = if ($OutDir) { $OutDir } else { Join-Path $here '..\..\src\__fixtures__\gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
Add-Type -Path (Join-Path $here 'LinearRampOriginProbe.cs') -ReferencedAssemblies System.Drawing
[LinearRampOriginProbe]::Run($destination)
& (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-linear-ramp-origin.json') -Groups 'linear-ramp-origin' -Files @((Join-Path $destination 'linear-ramp-origin.json.gz'))
