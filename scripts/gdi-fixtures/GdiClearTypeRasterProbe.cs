// Native GDI ExtTextOut ClearType scan conversion of two program-free private fonts: raster-polygons.ttf (256 random
// triangles and quadrilaterals, build-raster-fonts.py) and cleartype-geometry.ttf (1,070 bars and parallelograms on the
// 1/64-pixel lattice, build-cleartype-geometry-font.py). Nothing is grid-fitted, so the coverage levels are the scan
// converter and the ClearType filter alone. Each glyph is drawn black on white at 32 ppem, ClearType quality, with the
// baseline at (8, 36) of a 40 x 48 canvas.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class GdiClearTypeRasterProbe
{
    [StructLayout(LayoutKind.Sequential)] struct BITMAPINFOHEADER { public int size, width, height; public short planes, bitCount; public int compression, sizeImage, xppm, yppm, clrUsed, clrImportant; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct LOGFONT { public int h, w, esc, orient, weight; public byte italic, underline, strike, charset, outPrec, clipPrec, quality, pitch; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string face; }
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFOHEADER bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern uint SetTextColor(IntPtr dc, uint c);
    [DllImport("gdi32.dll")] static extern int SetBkMode(IntPtr dc, int m);
    [DllImport("gdi32.dll")] static extern uint SetTextAlign(IntPtr dc, uint a);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateFontIndirectW(ref LOGFONT lf);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool ExtTextOutW(IntPtr dc, int x, int y, uint opts, IntPtr rect, string s, uint n, int[] dx);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern int AddFontResourceExW(string file, uint flags, IntPtr reserved);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool RemoveFontResourceExW(string file, uint flags, IntPtr reserved);
    [DllImport("gdi32.dll")] static extern bool GdiFlush();

    public static void Run(string dir)
    {
        Directory.CreateDirectory(dir);
        var fonts = new[] {
            new { file = "raster-polygons.ttf", face = "Parity Raster Polygons", count = 256 },
            new { file = "cleartype-geometry.ttf", face = "Parity ClearType Geometry", count = 1070 },
        };
        var json = new StringBuilder("{\"width\":40,\"height\":48,\"ppem\":32,\"baselineX\":8,\"baselineY\":36,\"captures\":[");
        bool first = true;
        foreach (var f in fonts) {
            string fontFile = Path.GetFullPath(Path.Combine(dir, f.file));
            if (AddFontResourceExW(fontFile, 0x10, IntPtr.Zero) == 0) throw new Exception("AddFontResourceEx failed: " + f.file);
            try {
                int w = 40, h = 48;
                for (int i = 0; i < f.count; i++) {
                    var bmi = new BITMAPINFOHEADER { size = 40, width = w, height = -h, planes = 1, bitCount = 32 };
                    IntPtr bits; IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
                    IntPtr bmp = CreateDIBSection(dc, ref bmi, 0, out bits, IntPtr.Zero, 0);
                    IntPtr oldBmp = SelectObject(dc, bmp);
                    var white = new byte[w * h * 4]; for (int k = 0; k < white.Length; k++) white[k] = 255; Marshal.Copy(white, 0, bits, white.Length);
                    var lf = new LOGFONT { h = -32, weight = 400, charset = 1, quality = 5, face = f.face };
                    IntPtr font = CreateFontIndirectW(ref lf); IntPtr oldFont = SelectObject(dc, font);
                    SetBkMode(dc, 1); SetTextColor(dc, 0); SetTextAlign(dc, 24);
                    ExtTextOutW(dc, 8, 36, 0, IntPtr.Zero, ((char)(0xE000 + i)).ToString(), 1, null);
                    GdiFlush();
                    var bgra = new byte[w * h * 4]; Marshal.Copy(bits, bgra, 0, bgra.Length);
                    var rgb = new byte[w * h * 3];
                    for (int p = 0; p < w * h; p++) { rgb[p * 3] = bgra[p * 4 + 2]; rgb[p * 3 + 1] = bgra[p * 4 + 1]; rgb[p * 3 + 2] = bgra[p * 4]; }
                    SelectObject(dc, oldFont); DeleteObject(font); SelectObject(dc, oldBmp); DeleteObject(bmp); DeleteDC(dc);
                    if (!first) json.Append(','); first = false;
                    json.Append("{\"font\":\"").Append(f.file).Append("\",\"glyph\":").Append(i).Append(",\"rgb\":\"").Append(Convert.ToBase64String(rgb)).Append("\"}");
                }
            } finally { RemoveFontResourceExW(fontFile, 0x10, IntPtr.Zero); }
        }
        json.Append("]}");
        var data = Encoding.UTF8.GetBytes(json.ToString());
        using (var file = File.Create(Path.Combine(dir, "gdi-cleartype-raster.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(data, 0, data.Length);
    }
}
