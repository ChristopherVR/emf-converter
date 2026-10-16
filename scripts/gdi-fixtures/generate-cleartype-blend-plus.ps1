# Native GDI+ ClearType blend arithmetic over flat backgrounds (see ClearTypeBlendPlusProbe.cs).
param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class ClearTypeBlendPlusDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[ClearTypeBlendPlusDpi]::SetProcessDPIAware() | Out-Null
$destination = if ($OutDir) { $OutDir } else { Join-Path $PSScriptRoot '../../src/__fixtures__/gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
Add-Type -Path (Join-Path $PSScriptRoot 'ClearTypeBlendPlusProbe.cs') -ReferencedAssemblies System.Drawing
[ClearTypeBlendPlusProbe]::Run($destination)
& (Join-Path $PSScriptRoot 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-text-cleartype-blend-plus.json') -Groups 'text-cleartype-blend-plus' -Files @((Join-Path $destination 'text-cleartype-blend-plus.json.gz'))
