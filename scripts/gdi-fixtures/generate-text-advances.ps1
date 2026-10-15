# Native GDI+ DrawString mean advances of every printable ASCII glyph (TextAdvanceProbe.cs): text-advances.json.gz.
param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class TextAdvanceDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[TextAdvanceDpi]::SetProcessDPIAware() | Out-Null
$destination = if ($OutDir) { $OutDir } else { Join-Path $PSScriptRoot '../../src/__fixtures__/gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
Add-Type -Path (Join-Path $PSScriptRoot 'TextAdvanceProbe.cs') -ReferencedAssemblies System.Drawing
[TextAdvanceProbe]::Run($destination)
& (Join-Path $PSScriptRoot 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-text-advances.json') -Groups 'text-advances' -Files @(
    (Join-Path $destination 'text-advances.json.gz')
)
