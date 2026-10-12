# Native ClearType baselines across faces/styles/sizes, with heldout mixed strings.
param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class DrawStringBaselineDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[DrawStringBaselineDpi]::SetProcessDPIAware() | Out-Null
$destination = if ($OutDir) { $OutDir } else { Join-Path $PSScriptRoot '../../src/__fixtures__/gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
Add-Type -Path (Join-Path $PSScriptRoot 'DrawStringBaselineProbe.cs') -ReferencedAssemblies System.Drawing
[DrawStringBaselineProbe]::Run($destination)
& (Join-Path $PSScriptRoot 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-text-drawstring-baseline.json') -Groups 'text-drawstring-baseline' -Files @((Join-Path $destination 'text-drawstring-baseline.json.gz'))
