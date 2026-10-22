param([string]$OutDir = '', [switch]$Argb, [switch]$Centre, [switch]$MidCentre)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class PathGradientSpanDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[PathGradientSpanDpi]::SetProcessDPIAware() | Out-Null
$destination = if ($OutDir) { $OutDir } else { Join-Path $here '..\..\src\__fixtures__\gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
Add-Type -Path (Join-Path $here 'PathGradientSpanProbe.cs') -ReferencedAssemblies System.Drawing
if ($MidCentre) {
    # Round 10: the vertex-to-vertex edge with the centre colour swept (path-gradient-edge-stage-mid-centre.json.gz).
    [PathGradientSpanProbe]::RunEdgesMidCentre($destination)
    & (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-path-gradient-edge-mid-centre.json') -Groups 'path-gradient-edge-mid-centre' -Files @((Join-Path $destination 'path-gradient-edge-stage-mid-centre.json.gz'))
    return
}
if ($Centre) {
    # Round 9: the span measured from the centre colour and the three kinds of edge (path-gradient-flat-grid*.json.gz, path-gradient-edge-stage*.json.gz).
    [PathGradientSpanProbe]::RunGrid($destination)
    [PathGradientSpanProbe]::RunGridColors($destination, 192, 64, 128, 255, 'path-gradient-flat-grid-neg.json.gz')
    [PathGradientSpanProbe]::RunEdges($destination)
    [PathGradientSpanProbe]::RunEdgesX($destination)
    [PathGradientSpanProbe]::RunEdgesMid($destination)
    $files = @('path-gradient-flat-grid.json.gz', 'path-gradient-flat-grid-neg.json.gz', 'path-gradient-edge-stage.json.gz', 'path-gradient-edge-stage-x.json.gz', 'path-gradient-edge-stage-mid.json.gz') | ForEach-Object { Join-Path $destination $_ }
    & (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-path-gradient-centre.json') -Groups 'path-gradient-centre' -Files $files
    return
}
[PathGradientSpanProbe]::Run($destination)
& (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-path-gradient-span.json') -Groups 'path-gradient-span' -Files @((Join-Path $destination 'path-gradient-span.json.gz'))
# -Argb: the per-vertex capture set again onto a straight-alpha Format32bppArgb surface with SourceOver (path-gradient-vertices-argb.json.gz,
# not committed): its opaque captures are byte for byte the premultiplied surface's, so the destination format does not change the arithmetic.
if ($Argb) {
    Add-Type -Path (Join-Path $here 'PathGradientVertexProbe.cs') -ReferencedAssemblies System.Drawing
    [PathGradientVertexProbe]::Dest = 'argb'
    [PathGradientVertexProbe]::Run($destination)
}
