param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
$destination = if ($OutDir) { $OutDir } else { Join-Path $PSScriptRoot '../../src/__fixtures__/gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
$privateFont = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../src/__fixtures__/gdi/supplementary.ttf')).Path
Add-Type -Path (Join-Path $PSScriptRoot 'DrawStringAlignmentProbe.cs') -ReferencedAssemblies System.Drawing
$cases = @(
    @($privateFont, 0, 'private'),
    @('Arial', 0, 'arial'),
    @('Arial', 2, 'arial-italic'),
    @('Times New Roman', 2, 'times-italic'),
    @('Segoe UI', 0, 'segoe'),
    @('Courier New', 2, 'courier-italic')
)
$references = @($privateFont)
foreach ($case in $cases) {
    $path = Join-Path $destination ('text-alignment-' + $case[2] + '.json.gz')
    [DrawStringAlignmentProbe]::Run($case[0], [int]$case[1], $path)
    $references += $path
}
& (Join-Path $PSScriptRoot 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-text-alignment.json') -Groups 'text-alignment' -Files $references
