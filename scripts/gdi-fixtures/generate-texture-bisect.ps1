param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class TextureBisectDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[TextureBisectDpi]::SetProcessDPIAware() | Out-Null
$destination = if ($OutDir) { $OutDir } else { Join-Path $here '..\..\src\__fixtures__\gdi' }
$destination = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $destination)).Path
Add-Type -Path (Join-Path $here 'TextureBisectProbe.cs') -ReferencedAssemblies System.Drawing
# Case = "m0,m1,m2,m3,ty,x0,columns,width". Each set takes a second or two: the bisection is a few hundred small fills.
# 1. The recorded fixtures' 0.3 scale at fill starts 0 to 16 (60 columns).
$starts = 0,1,2,3,4,5,6,7,8,9,12,16
[TextureBisectProbe]::Run($destination, 'texture-bisect-scale03', (($starts | ForEach-Object { "0.3,0,0,0.3,1,$_,60,$(160 - $_)" }) -join ';'))
# 2. Scales with an exactly representable or round inverse at fill starts 0, 2 and 8.
$scaleCases = foreach ($m in '0.5','0.25','0.4','0.2','0.6','0.125') { foreach ($x in 0,2,8) { "$m,0,0,$m,1,$x,60,$(160 - $x)" } }
[TextureBisectProbe]::Run($destination, 'texture-bisect-scales', ($scaleCases -join ';'))
# 3. Seventy scales (40 isotropic and 30 anisotropic, 0.1 to 2.5, from System.Random(12345)) with the fill start at u of about 26.
$randomSpec = '0.2602,0,0,0.2602,1,7,40,193;0.2684,0,0,0.2684,1,7,40,193;1.9594,0,0,1.9594,1,51,40,149;1.3267,0,0,1.3267,1,35,40,165;2.014,0,0,2.014,1,53,40,147;2.0855,0,0,2.0855,1,55,40,145;0.4983,0,0,0.4983,1,13,40,187;1.8667,0,0,1.8667,1,49,40,151;0.7245,0,0,0.7245,1,19,40,181;1.3144,0,0,1.3144,1,35,40,165;0.6527,0,0,0.6527,1,17,40,183;1.0291,0,0,1.0291,1,27,40,173;0.6184,0,0,0.6184,1,17,40,183;0.1499,0,0,0.1499,1,4,40,196;0.4236,0,0,0.4236,1,12,40,188;1.878,0,0,1.878,1,49,40,151;0.5682,0,0,0.5682,1,15,40,185;2.2289,0,0,2.2289,1,58,40,142;2.1666,0,0,2.1666,1,57,40,143;0.9613,0,0,0.9613,1,25,40,175;0.3489,0,0,0.3489,1,10,40,190;1.371,0,0,1.371,1,36,40,164;0.961,0,0,0.961,1,25,40,175;1.798,0,0,1.798,1,47,40,153;1.4931,0,0,1.4931,1,39,40,161;1.5893,0,0,1.5893,1,42,40,158;1.858,0,0,1.858,1,49,40,151;1.8949,0,0,1.8949,1,50,40,150;1.051,0,0,1.051,1,28,40,172;0.6886,0,0,0.6886,1,18,40,182;1.7472,0,0,1.7472,1,46,40,154;0.6053,0,0,0.6053,1,16,40,184;1.3421,0,0,1.3421,1,35,40,165;1.2649,0,0,1.2649,1,33,40,167;0.7067,0,0,0.7067,1,19,40,181;1.9499,0,0,1.9499,1,51,40,149;0.1062,0,0,0.1062,1,3,40,197;1.2614,0,0,1.2614,1,33,40,167;1.1751,0,0,1.1751,1,31,40,169;1.2675,0,0,1.2675,1,33,40,167;1.8078,0,0,1.183,1,48,40,152;0.7479,0,0,0.7793,1,20,40,180;1.6246,0,0,0.8075,1,43,40,157;0.9869,0,0,2.1464,1,26,40,174;0.5216,0,0,2.1453,1,14,40,186;1.6465,0,0,1.578,1,43,40,157;1.1597,0,0,1.2921,1,31,40,169;0.1722,0,0,1.3892,1,5,40,195;1.8074,0,0,0.2614,1,47,40,153;2.3336,0,0,0.5247,1,61,40,139;0.3275,0,0,1.1034,1,9,40,191;0.9157,0,0,0.1359,1,24,40,176;2.0672,0,0,0.1473,1,54,40,146;2.187,0,0,1.8534,1,57,40,143;1.9432,0,0,0.9737,1,51,40,149;1.8718,0,0,1.8068,1,49,40,151;1.1538,0,0,0.9991,1,30,40,170;1.6535,0,0,1.6659,1,43,40,157;0.7231,0,0,0.2817,1,19,40,181;0.2734,0,0,0.7857,1,8,40,192;0.7024,0,0,2.2116,1,19,40,181;1.4733,0,0,1.4057,1,39,40,161;1.5422,0,0,0.2692,1,41,40,159;1.9457,0,0,0.15,1,51,40,149;1.1927,0,0,1.8175,1,32,40,168;0.2425,0,0,2.3448,1,7,40,193;1.4278,0,0,0.7504,1,38,40,162;1.04,0,0,0.8044,1,28,40,172;0.3673,0,0,0.712,1,10,40,190;1.2121,0,0,1.5772,1,32,40,168'
[TextureBisectProbe]::Run($destination, 'texture-bisect-random', $randomSpec)
# 4. Enlargements (the JPEG playbacks draw a 7.03x one), fill start 0.
$upCases = foreach ($m in '2','2.6','3','4','5','6','7','7.027','8','10','16','2.3','1.55','1.37','0.9') { "$m,0,0,$m,1,0,40,160" }
[TextureBisectProbe]::Run($destination, 'texture-bisect-upscale', ($upCases -join ';'))
$files = 'texture-bisect-scale03','texture-bisect-scales','texture-bisect-random','texture-bisect-upscale' | ForEach-Object { Join-Path $destination "$_.json.gz" }
& (Join-Path $here 'capture-environment.ps1') -OutputPath (Join-Path $destination 'environment-texture-bisect.json') -Groups 'texture-bisect' -Files $files
