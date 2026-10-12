# Public native DrawString/DrawDriverString layout diagnostics and mixed-string pixel controls.
param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class DrawStringAdvanceDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[DrawStringAdvanceDpi]::SetProcessDPIAware() | Out-Null
$destination = if ($OutDir) { $OutDir } else { Join-Path $PSScriptRoot '../../src/__fixtures__/gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
Add-Type -Path (Join-Path $PSScriptRoot 'DrawStringAdvanceProbe.cs') -ReferencedAssemblies System.Drawing
[DrawStringAdvanceProbe]::Mixed($destination)
[DrawStringAdvanceProbe]::Run($destination)
& (Join-Path $PSScriptRoot 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-text-drawstring-advances.json') -Groups 'text-drawstring-advances,text-drawstring-mixed' -Files @(
    (Join-Path $destination 'text-drawstring-advances.json.gz'),
    (Join-Path $destination 'text-drawstring-mixed.json.gz')
)
