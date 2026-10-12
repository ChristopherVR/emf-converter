# Standalone native Bilinear arithmetic controls. Run in Windows PowerShell:
# powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/gdi-fixtures/capture-bilinear.ps1
param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class BilinearProbeDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[BilinearProbeDpi]::SetProcessDPIAware() | Out-Null
$destination = if ($OutDir) { $OutDir } else { Join-Path $PSScriptRoot '../../src/__fixtures__/gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
Add-Type -Path (Join-Path $PSScriptRoot 'BilinearArithmeticProbe.cs') -ReferencedAssemblies System.Drawing
Add-Type -Path (Join-Path $PSScriptRoot 'BilinearIndependentProbe.cs') -ReferencedAssemblies System.Drawing
Add-Type -Path (Join-Path $PSScriptRoot 'BilinearAlphaProbe.cs') -ReferencedAssemblies System.Drawing
Add-Type -Path (Join-Path $PSScriptRoot 'BilinearPhaseProbe.cs') -ReferencedAssemblies System.Drawing
[BilinearArithmeticProbe]::Run($destination)
[BilinearIndependentProbe]::Run($destination)
[BilinearAlphaProbe]::Run($destination)
[BilinearAlphaProbe]::RunTranslucentClamp($destination)
[BilinearPhaseProbe]::Run($destination)
& (Join-Path $PSScriptRoot 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-bilinear-arithmetic.json') -Groups 'bilinear-arithmetic,bilinear-independent,bilinear-alpha,bilinear-phase-ties,bilinear-translucent-clamp' -Files @(
    (Join-Path $destination 'bilinear-arithmetic.json.gz'),
    (Join-Path $destination 'bilinear-independent.json.gz'),
    (Join-Path $destination 'bilinear-alpha.json.gz'),
    (Join-Path $destination 'bilinear-phase-ties.json.gz'),
    (Join-Path $destination 'bilinear-translucent-clamp.json.gz')
)
