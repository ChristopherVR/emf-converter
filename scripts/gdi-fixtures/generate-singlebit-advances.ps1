# Native GDI+ SingleBitPerPixel DrawString advance accumulation (see SingleBitAdvanceProbe.cs).
param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class SingleBitAdvanceDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[SingleBitAdvanceDpi]::SetProcessDPIAware() | Out-Null
$destination = if ($OutDir) { $OutDir } else { Join-Path $PSScriptRoot '../../src/__fixtures__/gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
Add-Type -Path (Join-Path $PSScriptRoot 'SingleBitAdvanceProbe.cs') -ReferencedAssemblies System.Drawing
[SingleBitAdvanceProbe]::Run($destination)
& (Join-Path $PSScriptRoot 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-text-singlebit-advances.json') -Groups 'text-singlebit-advances' -Files @((Join-Path $destination 'text-singlebit-advances.json.gz'))
