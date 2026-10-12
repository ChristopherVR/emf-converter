param([string]$OutDir = '', [switch]$Renamed)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class CourierGrayDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[CourierGrayDpi]::SetProcessDPIAware() | Out-Null
$destination = if ($OutDir) { $OutDir } else { Join-Path $here '..\..\src\__fixtures__\gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
Add-Type -Path (Join-Path $here 'CourierGrayProbe.cs') -ReferencedAssemblies System.Drawing
[CourierGrayProbe]::Run($destination)
& (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-courier-gray-phases.json') -Groups 'courier-gray-phases' -Files @((Join-Path $destination 'courier-gray-phases.json.gz'))
if ($Renamed) {
    # fontTools is a capture-time dependency, as for the other private probes.
    # The copied font is a local diagnostic input and is never bundled.
    $privateFont = Join-Path $here '..\..\.scratch\courier-private\parity-courier.ttf'
    & python (Join-Path $here 'build-courier-private.py') (Join-Path $env:WINDIR 'Fonts\cour.ttf') $privateFont
    if ($LASTEXITCODE -ne 0) { throw 'Private font generation failed' }
    [CourierGrayProbe]::RunPrivate($destination, (Resolve-Path -LiteralPath $privateFont).Path)
    & (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-courier-gray-renamed.json') -Groups 'courier-gray-renamed' -Files @((Join-Path $destination 'courier-gray-renamed.json.gz'), $privateFont)
}
