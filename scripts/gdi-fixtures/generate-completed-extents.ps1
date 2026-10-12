# Capture only the newly validated margins; preserve all older native references.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class CompletedExtentDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[CompletedExtentDpi]::SetProcessDPIAware() | Out-Null
Add-Type -Path (Join-Path $PSScriptRoot 'PlaybackExtentProbe.cs') -ReferencedAssemblies System.Drawing
$directory = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../src/__fixtures__/gdi')).Path
$names = @('compat-playback-mx-r34-geo5', 'compat-playback-mxy-r34-geo5', 'emfrec-cliprgn-mapped')
$cases = Get-Content -LiteralPath (Join-Path $directory 'playback-extents.json') -Raw | ConvertFrom-Json
$references = @((Join-Path $directory 'playback-extents.json'))
foreach ($name in $names) {
    $case = @($cases | Where-Object { $_.name -eq $name })
    if ($case.Count -ne 1) { throw "Missing extent case: $name" }
    $case = $case[0]
    # Keep the original native device grid: negative recorded control points
    # in mx-r34-geo5 do not paint ink above y=0 and must not translate playback.
    if (-not [PlaybackExtentProbe]::Capture($directory, $name, $case.w, $case.h, 0, 0, $false)) {
        throw "Native playback failed: $name"
    }
    foreach ($suffix in @('.emf', '.png', '.extent.png')) { $references += Join-Path $directory ($name + $suffix) }
}
& (Join-Path $PSScriptRoot 'capture-environment.ps1') -OutputPath (Join-Path $directory 'environment-completed-extents.json') -Groups 'completed-extents' -Files $references
