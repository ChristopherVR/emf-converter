// Public GDI+ DrawDriverString of the program-free glyphs of raster-polygons.ttf and raster-bars.ttf
// (build-raster-fonts.py): nothing is grid-fitted, so the grayscale bitmaps isolate scan conversion.
// 64 x 64 8-bit coverage per capture (the red channel of black ink on white), origin (8, 48).
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class RasterPolygonProbe
{
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

    public static void Run(string dir)
    {
        int[] ppems = { 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 24, 28, 32, 33, 34, 36, 40 };
        Capture(dir, "raster-polygons.ttf", "Parity Raster Polygons", 256, ppems, "text-raster-polygons.json.gz", new[] { 3, 4 });
        foreach (int st in new[] { 0, 1, 4, 5 })
            Capture(dir, "raster-polygons-st" + st + ".ttf", "Parity Raster Polygons ST" + st, 256, ppems, "text-raster-polygons-st" + st + ".json.gz", new[] { 4 });
    }

    public static void Bars(string dir)
    {
        Capture(dir, "raster-bars.ttf", "Parity Raster Bars", 272, new[] { 32 }, "text-raster-bars.json.gz", new[] { 3, 4 });
    }

    static void Capture(string dir, string fontFile, string familyName, int count, int[] sizes, string outName, int[] hints)
    {
        Directory.CreateDirectory(dir);
        IntPtr collection = IntPtr.Zero;
        using (var startup = new Bitmap(1, 1))
        {
            Check(GdipNewPrivateFontCollection(out collection));
            try {
                Check(GdipPrivateAddFontFile(collection, Path.GetFullPath(Path.Combine(dir, fontFile))));
                using (var file = File.Create(Path.Combine(dir, outName)))
                using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress))
                using (var writer = new StreamWriter(zip, new UTF8Encoding(false)))
                {
                    writer.Write("[");
                    bool first = true;
                    foreach (int size in sizes)
                    foreach (int hint in hints)
                    for (int index = 0; index < count; index++) {
                        IntPtr image = IntPtr.Zero, graphics = IntPtr.Zero, family = IntPtr.Zero, font = IntPtr.Zero, brush = IntPtr.Zero;
                        try {
                            Check(GdipCreateBitmapFromScan0(64, 64, 0, 0x26200a, IntPtr.Zero, out image));
                            Check(GdipGetImageGraphicsContext(image, out graphics)); Check(GdipGraphicsClear(graphics, -1));
                            Check(GdipSetTextRenderingHint(graphics, hint)); Check(GdipSetTextContrast(graphics, 0));
                            Check(GdipCreateFontFamilyFromName(familyName, collection, out family));
                            Check(GdipCreateFont(family, size, 0, 2, out font)); Check(GdipCreateSolidFill(unchecked((int)0xff000000), out brush));
                            Check(GdipDrawDriverString(graphics, new[] { (ushort)(0xe000 + index) }, 1, font, brush, new[] { new PointF(8, 48) }, 1, IntPtr.Zero));
                            var rect = new Rect { w = 64, h = 64 }; Bits bits;
                            Check(GdipBitmapLockBits(image, ref rect, 1, 0x26200a, out bits));
                            var gray = new byte[64 * 64];
                            try {
                                var row = new byte[64 * 4];
                                for (int y = 0; y < 64; y++) { Marshal.Copy(IntPtr.Add(bits.scan, y * bits.stride), row, 0, 256); for (int x = 0; x < 64; x++) gray[y * 64 + x] = row[x * 4 + 2]; }
                            } finally { Check(GdipBitmapUnlockBits(image, ref bits)); }
                            if (!first) writer.Write(',');
                            first = false;
                            writer.Write("{\"size\":" + size + ",\"hint\":" + hint + ",\"index\":" + index + ",\"gray\":\"" + Convert.ToBase64String(gray) + "\"}");
                        } finally {
                            if (graphics != IntPtr.Zero) GdipDeleteGraphics(graphics);
                            if (font != IntPtr.Zero) GdipDeleteFont(font); if (family != IntPtr.Zero) GdipDeleteFontFamily(family);
                            if (brush != IntPtr.Zero) GdipDeleteBrush(brush); if (image != IntPtr.Zero) GdipDisposeImage(image);
                        }
                    }
                    writer.Write("]");
                }
            } finally { Check(GdipDeletePrivateFontCollection(ref collection)); }
        }
    }
}
