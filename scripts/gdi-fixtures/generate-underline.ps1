# Native GDI+ AntiAlias underline / strike-out bars (fractional bar geometry).
param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class UnderlineDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[UnderlineDpi]::SetProcessDPIAware() | Out-Null
$destination = if ($OutDir) { $OutDir } else { Join-Path $PSScriptRoot '../../src/__fixtures__/gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
Add-Type -Path (Join-Path $PSScriptRoot 'UnderlineProbe.cs') -ReferencedAssemblies System.Drawing
[UnderlineProbe]::Run($destination)
& (Join-Path $PSScriptRoot 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-text-underline.json') -Groups 'text-underline' -Files @((Join-Path $destination 'text-underline.json.gz'))
