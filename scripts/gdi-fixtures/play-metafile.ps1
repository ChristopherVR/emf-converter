# Plays committed fixture metafiles back with native PlayEnhMetaFile into a white 32bpp surface of the size of their
# reference PNG and writes `<name>.playback.png` next to them. Most text sheets' references are direct drawings, so
# a text record whose recorded advances differ from a direct drawing's (ETO_GLYPH_INDEX runs, rotated text) differs from
# them; the playback PNG is what a converter that plays the records back has to match.
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/gdi-fixtures/play-metafile.ps1 -Names textx-eto-mono [-OutDir <dir>]
param([Parameter(Mandatory = $true)][string[]]$Names, [string]$OutDir = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Drawing; using System.Drawing.Imaging;
public static class PlayMetafile {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int l, t, r, b; }
  [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetEnhMetaFileW(string f);
  [DllImport("gdi32.dll")] static extern bool PlayEnhMetaFile(IntPtr dc, IntPtr h, ref RECT r);
  [DllImport("gdi32.dll")] static extern bool DeleteEnhMetaFile(IntPtr h);
  public static void Run(string emf, string png, int w, int h) {
    using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(bmp)) {
        g.Clear(Color.White);
        IntPtr dc = g.GetHdc();
        IntPtr hemf = GetEnhMetaFileW(emf);
        var r = new RECT { l = 0, t = 0, r = w, b = h };
        PlayEnhMetaFile(dc, hemf, ref r);
        DeleteEnhMetaFile(hemf);
        g.ReleaseHdc(dc);
      }
      bmp.Save(png, ImageFormat.Png);
    }
  }
}
'@
$fixtures = (Resolve-Path (Join-Path $PSScriptRoot '../../src/__fixtures__/gdi')).Path
$out = if ($OutDir) { (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force $OutDir)).Path } else { $fixtures }
foreach ($name in $Names) {
    $image = [System.Drawing.Image]::FromFile((Join-Path $fixtures "$name.png"))
    $w = $image.Width; $h = $image.Height; $image.Dispose()
    [PlayMetafile]::Run((Join-Path $fixtures "$name.emf"), (Join-Path $out "$name.playback.png"), $w, $h)
}
