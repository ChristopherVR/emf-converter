param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class AlignmentShapingDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[AlignmentShapingDpi]::SetProcessDPIAware() | Out-Null
$destination = if ($OutDir) { $OutDir } else { Join-Path $here '..\..\src\__fixtures__\gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
Add-Type -Path (Join-Path $here 'DrawStringShapingGuardProbe.cs') -ReferencedAssemblies System.Drawing
$capture = Join-Path $destination 'text-alignment-shaping.json.gz'
[DrawStringShapingGuardProbe]::Run('Arial', 0, $capture)
& (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-text-alignment-shaping.json') -Groups 'text-alignment-shaping' -Files @($capture)
