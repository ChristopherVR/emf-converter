param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class ImagePointsBisectDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[ImagePointsBisectDpi]::SetProcessDPIAware() | Out-Null
$destination = if ($OutDir) { $OutDir } else { Join-Path $here '..\..\src\__fixtures__\gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
Add-Type -Path (Join-Path $here 'ImagePointsBisectProbe.cs') -ReferencedAssemblies System.Drawing
# Case = "sw,sh,srcW,srcH,x0,y0,x1,y1,y2,row,columns". 1. The JPEG playbacks' geometry (a 7.03x enlargement).
[ImagePointsBisectProbe]::Run($destination, 'image-points-bisect-jpeg', [ImagePointsBisectProbe]::DefaultSpec)
