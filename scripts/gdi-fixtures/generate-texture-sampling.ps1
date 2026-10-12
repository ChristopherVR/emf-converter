param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class TextureProbeDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[TextureProbeDpi]::SetProcessDPIAware() | Out-Null
$destination = if ($OutDir) { $OutDir } else { Join-Path $here '..\..\src\__fixtures__\gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
Add-Type -Path (Join-Path $here 'TextureSamplingProbe.cs') -ReferencedAssemblies System.Drawing
[TextureSamplingProbe]::Run($destination)
& (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-texture-sampling.json') -Groups 'texture-sampling' -Files @((Join-Path $destination 'texture-sampling.json.gz'))
