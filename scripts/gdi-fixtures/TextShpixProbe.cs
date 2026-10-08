// Public GDI+ DrawDriverString ClearType captures of the private SHPIX diagnostic fonts (build-shpix-fonts.py).
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class TextShpixProbe
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
        var json = new StringBuilder("[");
        using (var startup = new Bitmap(1, 1))
        foreach (string layout in new[] { "a", "b", "c", "d" }) {
            IntPtr collection = IntPtr.Zero;
            Check(GdipNewPrivateFontCollection(out collection));
            try {
                Check(GdipPrivateAddFontFile(collection, Path.GetFullPath(Path.Combine(dir, "shpix-" + layout + ".ttf"))));
                string name = "Parity Shpix " + layout.ToUpperInvariant();
                foreach (int size in new[] { 12, 16, 24 })
                foreach (int hint in new[] { 3, 5 })
                for (int index = 0; index < 19; index++) {
                    IntPtr image = IntPtr.Zero, graphics = IntPtr.Zero, family = IntPtr.Zero, font = IntPtr.Zero, brush = IntPtr.Zero;
                    try {
                        Check(GdipCreateBitmapFromScan0(64, 64, 0, 0x26200a, IntPtr.Zero, out image));
                        Check(GdipGetImageGraphicsContext(image, out graphics)); Check(GdipGraphicsClear(graphics, -1));
                        Check(GdipSetTextRenderingHint(graphics, hint)); Check(GdipSetTextContrast(graphics, 0));
                        Check(GdipCreateFontFamilyFromName(name, collection, out family));
                        Check(GdipCreateFont(family, size, 0, 2, out font)); Check(GdipCreateSolidFill(unchecked((int)0xff000000), out brush));
                        Check(GdipDrawDriverString(graphics, new[] { (ushort)(0xe000 + index) }, 1, font, brush, new[] { new PointF(8, 48) }, 1, IntPtr.Zero));
                        var rect = new Rect { w = 64, h = 64 }; Bits bits;
                        Check(GdipBitmapLockBits(image, ref rect, 1, 0x26200a, out bits));
                        var bgra = new byte[64 * 64 * 4];
                        try { for (int y = 0; y < 64; y++) Marshal.Copy(IntPtr.Add(bits.scan, y * bits.stride), bgra, y * 64 * 4, 64 * 4); }
                        finally { Check(GdipBitmapUnlockBits(image, ref bits)); }
                        int x0 = 64, y0 = 64, x1 = -1, y1 = -1;
                        for (int y = 0; y < 64; y++) for (int x = 0; x < 64; x++) {
                            int o = (y * 64 + x) * 4;
                            if (bgra[o] != 255 || bgra[o + 1] != 255 || bgra[o + 2] != 255) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
                        }
                        if (x1 < 0) { x0 = y0 = 0; x1 = y1 = -1; }
                        int w = x1 - x0 + 1, h = y1 - y0 + 1;
                        var rgb = new byte[Math.Max(0, w * h * 3)];
                        for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
                            int o = ((y0 + y) * 64 + x0 + x) * 4;
                            rgb[(y * w + x) * 3] = bgra[o + 2]; rgb[(y * w + x) * 3 + 1] = bgra[o + 1]; rgb[(y * w + x) * 3 + 2] = bgra[o];
                        }
                        if (json.Length > 1) json.Append(',');
                        json.Append("{\"layout\":\"").Append(layout).Append("\",\"index\":").Append(index).Append(",\"size\":").Append(size).Append(",\"hint\":").Append(hint)
                            .Append(",\"x\":").Append(x0).Append(",\"y\":").Append(y0).Append(",\"w\":").Append(Math.Max(w, 0)).Append(",\"h\":").Append(Math.Max(h, 0))
                            .Append(",\"rgb\":\"").Append(Convert.ToBase64String(rgb)).Append("\"}");
                    } finally {
                        if (graphics != IntPtr.Zero) GdipDeleteGraphics(graphics);
                        if (font != IntPtr.Zero) GdipDeleteFont(font); if (family != IntPtr.Zero) GdipDeleteFontFamily(family);
                        if (brush != IntPtr.Zero) GdipDeleteBrush(brush); if (image != IntPtr.Zero) GdipDisposeImage(image);
                    }
                }
            } finally { Check(GdipDeletePrivateFontCollection(ref collection)); }
        }
        var data = Encoding.UTF8.GetBytes(json.Append(']').ToString());
        using (var file = File.Create(Path.Combine(dir, "text-shpix.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(data, 0, data.Length);
    }
}
