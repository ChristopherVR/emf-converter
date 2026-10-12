param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
& python (Join-Path $here 'build-courier-geometry-fonts.py')
if ($LASTEXITCODE -ne 0) { throw 'Private font generation failed' }
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class CourierGeometryDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[CourierGeometryDpi]::SetProcessDPIAware() | Out-Null
$fixtures = (Resolve-Path -LiteralPath (Join-Path $here '..\..\src\__fixtures__\gdi')).Path
$destination = if ($OutDir) { $OutDir } else { $fixtures }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
Add-Type -Path (Join-Path $here 'CourierGeometryProbe.cs') -ReferencedAssemblies System.Drawing
[CourierGeometryProbe]::RunPrivate($destination, (Join-Path $fixtures 'courier-geometry.ttf'), 'Courier New', 'courier-geometry.json.gz')
[CourierGeometryProbe]::RunPrivate($destination, (Join-Path $fixtures 'courier-geometry-renamed.ttf'), 'Parity Courier', 'courier-geometry-renamed.json.gz')
& (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-courier-geometry.json') -Groups 'courier-geometry,courier-geometry-renamed' -Files @(
    (Join-Path $destination 'courier-geometry.json.gz'), (Join-Path $destination 'courier-geometry-renamed.json.gz'),
    (Join-Path $fixtures 'courier-geometry.ttf'), (Join-Path $fixtures 'courier-geometry-renamed.ttf'))
