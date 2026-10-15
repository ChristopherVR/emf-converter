param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class GrayGlyphDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[GrayGlyphDpi]::SetProcessDPIAware() | Out-Null
$destination = if ($OutDir) { $OutDir } else { Join-Path $here '..\..\src\__fixtures__\gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
Add-Type -Path (Join-Path $here 'GrayGlyphProbe.cs') -ReferencedAssemblies System.Drawing
[GrayGlyphProbe]::Run($destination)
& (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-gray-glyphs.json') -Groups 'gray-glyphs' -Files @((Join-Path $destination 'gdi-gray-glyphs.json.gz'))
