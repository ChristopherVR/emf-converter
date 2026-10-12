param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$destination = if ($OutDir) { $OutDir } else { Join-Path $here '../../src/__fixtures__/gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
$privateFont = (Resolve-Path -LiteralPath (Join-Path $here '../../src/__fixtures__/gdi/supplementary.ttf')).Path
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class AlignmentScaleDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[AlignmentScaleDpi]::SetProcessDPIAware() | Out-Null
Add-Type -Path (Join-Path $here 'DrawStringScaledAlignmentProbe.cs') -ReferencedAssemblies System.Drawing
$cases = @(
    @($privateFont, 0, $false, 'private'),
    @('Arial', 0, $false, 'arial'),
    @($privateFont, 0, $true, 'heldout-private'),
    @('Arial', 0, $true, 'heldout-arial'),
    @('Courier New', 2, $true, 'heldout-courier-italic')
)
$references = @($privateFont)
foreach ($case in $cases) {
    $path = Join-Path $destination ('text-alignment-scale-' + $case[3] + '.json.gz')
    [DrawStringScaledAlignmentProbe]::Run($case[0], [int]$case[1], [bool]$case[2], $path)
    $references += $path
}
& (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-text-alignment-scale.json') -Groups 'text-alignment-scale' -Files $references
