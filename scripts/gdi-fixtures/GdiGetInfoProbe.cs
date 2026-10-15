// What native GETINFO reports to a glyph program, per rasterizer: GDI ExtTextOut at ClearType, natural, default, draft,
// antialiased and non-antialiased quality, and GDI+ DrawDriverString at SingleBitPerPixelGridFit, SingleBitPerPixel, AntiAliasGridFit, AntiAlias and ClearTypeGridFit, for the private
// diagnostic font getinfo-a.ttf (build-getinfo-font.py). Each glyph raises its stem by a pixel when one GETINFO bit is set.
// Captures are 48 x 64 RGB at 20 ppem with the baseline at (8, 48); `rows` is the number of ink rows (the stem is
// 11 or 12 rows tall without the move, one more with it).
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class GdiGetInfoProbe
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

    [StructLayout(LayoutKind.Sequential)] struct Rect { public int x, y, w, h; }
    [StructLayout(LayoutKind.Sequential)] struct Bits { public uint w, h; public int stride, format; public IntPtr scan; public UIntPtr reserved; }
    [DllImport("gdiplus.dll")] static extern int GdipCreateBitmapFromScan0(int w, int h, int stride, int format, IntPtr scan, out IntPtr image);
    [DllImport("gdiplus.dll")] static extern int GdipGetImageGraphicsContext(IntPtr image, out IntPtr graphics);
    [DllImport("gdiplus.dll")] static extern int GdipGraphicsClear(IntPtr graphics, int argb);
    [DllImport("gdiplus.dll")] static extern int GdipSetTextRenderingHint(IntPtr graphics, int hint);
    [DllImport("gdiplus.dll")] static extern int GdipSetTextContrast(IntPtr graphics, uint contrast);
    [DllImport("gdiplus.dll", CharSet = CharSet.Unicode)] static extern int GdipCreateFontFamilyFromName(string name, IntPtr collection, out IntPtr family);
    [DllImport("gdiplus.dll")] static extern int GdipCreateFont(IntPtr family, float size, int style, int unit, out IntPtr font);
    [DllImport("gdiplus.dll")] static extern int GdipCreateSolidFill(int argb, out IntPtr brush);
    [DllImport("gdiplus.dll")] static extern int GdipDrawDriverString(IntPtr graphics, ushort[] text, int length, IntPtr font, IntPtr brush, PointF[] positions, int options, IntPtr matrix);
    [DllImport("gdiplus.dll")] static extern int GdipBitmapLockBits(IntPtr image, ref Rect rect, uint flags, int format, out Bits bits);
    [DllImport("gdiplus.dll")] static extern int GdipBitmapUnlockBits(IntPtr image, ref Bits bits);
    [DllImport("gdiplus.dll")] static extern int GdipDeleteGraphics(IntPtr graphics);
    [DllImport("gdiplus.dll")] static extern int GdipDeleteFont(IntPtr font);
    [DllImport("gdiplus.dll")] static extern int GdipDeleteFontFamily(IntPtr family);
    [DllImport("gdiplus.dll")] static extern int GdipDeleteBrush(IntPtr brush);
    [DllImport("gdiplus.dll")] static extern int GdipDisposeImage(IntPtr image);
    [DllImport("gdiplus.dll")] static extern int GdipNewPrivateFontCollection(out IntPtr collection);
    [DllImport("gdiplus.dll", CharSet = CharSet.Unicode)] static extern int GdipPrivateAddFontFile(IntPtr collection, string filename);
    [DllImport("gdiplus.dll")] static extern int GdipDeletePrivateFontCollection(ref IntPtr collection);
    static void Check(int status) { if (status != 0) throw new Exception("GDI+ status " + status); }

    const int W = 48, H = 64;

    static void Append(StringBuilder json, ref bool first, string api, int mode, int size, int index, byte[] rgb)
    {
        int x0 = W, y0 = H, x1 = -1, y1 = -1;
        for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) { int o = (y * W + x) * 3; if (rgb[o] != 255 || rgb[o + 1] != 255 || rgb[o + 2] != 255) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
        int cw = Math.Max(0, x1 - x0 + 1), ch = Math.Max(0, y1 - y0 + 1);
        var crop = new byte[cw * ch * 3];
        for (int y = 0; y < ch; y++) for (int x = 0; x < cw; x++) { int o = ((y0 + y) * W + x0 + x) * 3; int p = (y * cw + x) * 3; crop[p] = rgb[o]; crop[p + 1] = rgb[o + 1]; crop[p + 2] = rgb[o + 2]; }
        if (!first) json.Append(','); first = false;
        json.Append("{\"api\":\"").Append(api).Append("\",\"mode\":").Append(mode).Append(",\"size\":").Append(size).Append(",\"index\":").Append(index)
            .Append(",\"x\":").Append(x0).Append(",\"y\":").Append(y0).Append(",\"w\":").Append(cw).Append(",\"h\":").Append(ch).Append(",\"rgb\":\"").Append(Convert.ToBase64String(crop)).Append("\"}");
    }

    public static void Run(string dir)
    {
        Directory.CreateDirectory(dir);
        string fontFile = Path.GetFullPath(Path.Combine(dir, "getinfo-a.ttf"));
        const int count = 21;
        var json = new StringBuilder("[");
        bool first = true;
        if (AddFontResourceExW(fontFile, 0x10, IntPtr.Zero) == 0) throw new Exception("AddFontResourceEx failed");
        try {
            foreach (int size in new[] { 20, 14 }) foreach (int quality in new[] { 0, 3, 4, 5, 6 }) for (int i = 0; i < count; i++) {
                var bmi = new BITMAPINFOHEADER { size = 40, width = W, height = -H, planes = 1, bitCount = 32 };
                IntPtr bits; IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
                IntPtr bmp = CreateDIBSection(dc, ref bmi, 0, out bits, IntPtr.Zero, 0);
                IntPtr oldBmp = SelectObject(dc, bmp);
                var white = new byte[W * H * 4]; for (int k = 0; k < white.Length; k++) white[k] = 255; Marshal.Copy(white, 0, bits, white.Length);
                var lf = new LOGFONT { h = -size, weight = 400, charset = 1, quality = (byte)quality, face = "Parity GetInfo A" };
                IntPtr font = CreateFontIndirectW(ref lf); IntPtr oldFont = SelectObject(dc, font);
                SetBkMode(dc, 1); SetTextColor(dc, 0); SetTextAlign(dc, 24);
                ExtTextOutW(dc, 8, 48, 0, IntPtr.Zero, ((char)(0xE000 + i)).ToString(), 1, null);
                GdiFlush();
                var bgra = new byte[W * H * 4]; Marshal.Copy(bits, bgra, 0, bgra.Length);
                var rgb = new byte[W * H * 3];
                for (int p = 0; p < W * H; p++) { rgb[p * 3] = bgra[p * 4 + 2]; rgb[p * 3 + 1] = bgra[p * 4 + 1]; rgb[p * 3 + 2] = bgra[p * 4]; }
                SelectObject(dc, oldFont); DeleteObject(font); SelectObject(dc, oldBmp); DeleteObject(bmp); DeleteDC(dc);
                Append(json, ref first, "gdi", quality, size, i, rgb);
            }
        } finally { RemoveFontResourceExW(fontFile, 0x10, IntPtr.Zero); }
        using (var startup = new Bitmap(1, 1)) {
            IntPtr collection = IntPtr.Zero;
            Check(GdipNewPrivateFontCollection(out collection));
            try {
                Check(GdipPrivateAddFontFile(collection, fontFile));
                foreach (int size in new[] { 20, 14 }) foreach (int hint in new[] { 1, 2, 3, 4, 5 }) for (int i = 0; i < count; i++) {
                    IntPtr image = IntPtr.Zero, graphics = IntPtr.Zero, family = IntPtr.Zero, font = IntPtr.Zero, brush = IntPtr.Zero;
                    try {
                        Check(GdipCreateBitmapFromScan0(W, H, 0, 0x26200a, IntPtr.Zero, out image));
                        Check(GdipGetImageGraphicsContext(image, out graphics)); Check(GdipGraphicsClear(graphics, -1));
                        Check(GdipSetTextRenderingHint(graphics, hint)); Check(GdipSetTextContrast(graphics, 0));
                        Check(GdipCreateFontFamilyFromName("Parity GetInfo A", collection, out family));
                        Check(GdipCreateFont(family, size, 0, 2, out font)); Check(GdipCreateSolidFill(unchecked((int)0xff000000), out brush));
                        Check(GdipDrawDriverString(graphics, new[] { (ushort)(0xe000 + i) }, 1, font, brush, new[] { new PointF(8, 48) }, 1, IntPtr.Zero));
                        var rect = new Rect { w = W, h = H }; Bits bits;
                        Check(GdipBitmapLockBits(image, ref rect, 1, 0x26200a, out bits));
                        var bgra = new byte[W * H * 4];
                        try { for (int y = 0; y < H; y++) Marshal.Copy(IntPtr.Add(bits.scan, y * bits.stride), bgra, y * W * 4, W * 4); }
                        finally { Check(GdipBitmapUnlockBits(image, ref bits)); }
                        var rgb = new byte[W * H * 3];
                        for (int p = 0; p < W * H; p++) { rgb[p * 3] = bgra[p * 4 + 2]; rgb[p * 3 + 1] = bgra[p * 4 + 1]; rgb[p * 3 + 2] = bgra[p * 4]; }
                        Append(json, ref first, "gdiplus", hint, size, i, rgb);
                    } finally {
                        if (graphics != IntPtr.Zero) GdipDeleteGraphics(graphics);
                        if (font != IntPtr.Zero) GdipDeleteFont(font); if (family != IntPtr.Zero) GdipDeleteFontFamily(family);
                        if (brush != IntPtr.Zero) GdipDeleteBrush(brush); if (image != IntPtr.Zero) GdipDisposeImage(image);
                    }
                }
            } finally { Check(GdipDeletePrivateFontCollection(ref collection)); }
        }
        json.Append(']');
        var data = Encoding.UTF8.GetBytes(json.ToString());
        using (var file = File.Create(Path.Combine(dir, "gdi-getinfo.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(data, 0, data.Length);
    }
}
