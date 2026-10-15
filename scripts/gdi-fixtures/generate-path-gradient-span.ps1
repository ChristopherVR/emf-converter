param([string]$OutDir = '', [switch]$Argb)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class PathGradientSpanDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[PathGradientSpanDpi]::SetProcessDPIAware() | Out-Null
$destination = if ($OutDir) { $OutDir } else { Join-Path $here '..\..\src\__fixtures__\gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
Add-Type -Path (Join-Path $here 'PathGradientSpanProbe.cs') -ReferencedAssemblies System.Drawing
[PathGradientSpanProbe]::Run($destination)
& (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-path-gradient-span.json') -Groups 'path-gradient-span' -Files @((Join-Path $destination 'path-gradient-span.json.gz'))
# -Argb: the per-vertex capture set again onto a straight-alpha Format32bppArgb surface with SourceOver (path-gradient-vertices-argb.json.gz,
# not committed): its opaque captures are byte for byte the premultiplied surface's, so the destination format does not change the arithmetic.
if ($Argb) {
    Add-Type -Path (Join-Path $here 'PathGradientVertexProbe.cs') -ReferencedAssemblies System.Drawing
    [PathGradientVertexProbe]::Dest = 'argb'
    [PathGradientVertexProbe]::Run($destination)
}
