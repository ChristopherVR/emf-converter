// Public GDI+ DrawDriverString of every printable ASCII glyph of several real fonts at a range of sizes, one
// baseline origin, both grayscale hints: the data for finding which projection arithmetic Windows applies in
// which hinting situation. Output is 40 x 40 8-bit coverage (the red channel of black ink on white).
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class RealGlyphCoverageProbe
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
    static void Check(int status) { if (status != 0) throw new Exception("GDI+ status " + status); }

    // face, style (GDI+ FontStyle bits: 1 bold, 2 italic)
    static readonly object[][] Faces = {
        new object[] { "Arial", 0 }, new object[] { "Arial", 1 }, new object[] { "Arial", 2 },
        new object[] { "Times New Roman", 0 }, new object[] { "Times New Roman", 2 }, new object[] { "Times New Roman", 1 },
        new object[] { "Segoe UI", 0 }, new object[] { "Tahoma", 0 }, new object[] { "Verdana", 0 }, new object[] { "Georgia", 0 },
        new object[] { "Calibri", 0 }, new object[] { "Courier New", 0 }, new object[] { "Comic Sans MS", 0 }, new object[] { "Consolas", 0 },
    };
    static readonly int[] Sizes = { 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24 };

    public static void Run(string dir)
    {
        Directory.CreateDirectory(dir);
        using (var file = File.Create(Path.Combine(dir, "text-real-glyphs.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress))
        using (var writer = new StreamWriter(zip, new UTF8Encoding(false)))
        {
            writer.Write("[");
            bool first = true;
            using (var startup = new Bitmap(1, 1))
            foreach (var face in Faces)
            foreach (int size in Sizes)
            foreach (int hint in new[] { 3, 4 })
            for (int code = 33; code < 127; code++) {
                IntPtr image = IntPtr.Zero, graphics = IntPtr.Zero, family = IntPtr.Zero, font = IntPtr.Zero, brush = IntPtr.Zero;
                try {
                    Check(GdipCreateBitmapFromScan0(40, 40, 0, 0x26200a, IntPtr.Zero, out image));
                    Check(GdipGetImageGraphicsContext(image, out graphics)); Check(GdipGraphicsClear(graphics, -1));
                    Check(GdipSetTextRenderingHint(graphics, hint)); Check(GdipSetTextContrast(graphics, 0));
                    Check(GdipCreateFontFamilyFromName((string)face[0], IntPtr.Zero, out family));
                    Check(GdipCreateFont(family, size, (int)face[1], 2, out font)); Check(GdipCreateSolidFill(unchecked((int)0xff000000), out brush));
                    Check(GdipDrawDriverString(graphics, new[] { (ushort)code }, 1, font, brush, new[] { new PointF(6, 28) }, 1, IntPtr.Zero));
                    var rect = new Rect { w = 40, h = 40 }; Bits bits;
                    Check(GdipBitmapLockBits(image, ref rect, 1, 0x26200a, out bits));
                    var gray = new byte[40 * 40];
                    try {
                        var row = new byte[40 * 4];
                        for (int y = 0; y < 40; y++) { Marshal.Copy(IntPtr.Add(bits.scan, y * bits.stride), row, 0, 160); for (int x = 0; x < 40; x++) gray[y * 40 + x] = row[x * 4 + 2]; }
                    } finally { Check(GdipBitmapUnlockBits(image, ref bits)); }
                    if (!first) writer.Write(',');
                    first = false;
                    writer.Write("{\"face\":\"" + face[0] + "\",\"size\":" + size + ",\"style\":" + face[1] + ",\"hint\":" + hint + ",\"code\":" + code + ",\"gray\":\"" + Convert.ToBase64String(gray) + "\"}");
                } finally {
                    if (graphics != IntPtr.Zero) GdipDeleteGraphics(graphics);
                    if (font != IntPtr.Zero) GdipDeleteFont(font); if (family != IntPtr.Zero) GdipDeleteFontFamily(family);
                    if (brush != IntPtr.Zero) GdipDeleteBrush(brush); if (image != IntPtr.Zero) GdipDisposeImage(image);
                }
            }
            writer.Write("]");
        }
    }
}
