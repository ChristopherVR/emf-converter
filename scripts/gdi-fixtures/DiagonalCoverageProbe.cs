// Public GDI+ DrawDriverString: baseline origins avoid DrawString layout.
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class DiagonalCoverageProbe
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

    [DllImport("gdiplus.dll")] static extern int GdipNewPrivateFontCollection(out IntPtr collection);
    [DllImport("gdiplus.dll", CharSet = CharSet.Unicode)] static extern int GdipPrivateAddFontFile(IntPtr collection, string filename);
    [DllImport("gdiplus.dll")] static extern int GdipDeletePrivateFontCollection(ref IntPtr collection);
    public static void Run(string dir) {
        var json = new StringBuilder("[");
        using (var startup = new Bitmap(1, 1))
        foreach (string kind in new[] { "movement", "projection", "vectors" }) {
            IntPtr collection = IntPtr.Zero;
            Check(GdipNewPrivateFontCollection(out collection));
            try {
                Check(GdipPrivateAddFontFile(collection, Path.GetFullPath(Path.Combine(dir, "diagonal-" + kind + ".ttf"))));
                string name = "Parity Diagonal " + char.ToUpperInvariant(kind[0]) + kind.Substring(1);
                int width = kind == "vectors" ? 384 : 96, height = kind == "vectors" ? 128 : 96;
                float originX = kind == "vectors" ? 288 : 48, originY = kind == "vectors" ? 64 : 48;
                foreach (int size in new[] { 16, 23, 32, 41 })
                foreach (int hint in new[] { 1, 3, 4, 5 })
                for (int index = 1; index <= 36; index++) {
                    IntPtr image = IntPtr.Zero, graphics = IntPtr.Zero, family = IntPtr.Zero, font = IntPtr.Zero, brush = IntPtr.Zero;
                    try {
                        Check(GdipCreateBitmapFromScan0(width, height, 0, 0x26200a, IntPtr.Zero, out image));
                        Check(GdipGetImageGraphicsContext(image, out graphics)); Check(GdipGraphicsClear(graphics, -1));
                        Check(GdipSetTextRenderingHint(graphics, hint)); Check(GdipSetTextContrast(graphics, 0));
                        Check(GdipCreateFontFamilyFromName(name, collection, out family));
                        Check(GdipCreateFont(family, size, 0, 2, out font)); Check(GdipCreateSolidFill(unchecked((int)0xff000000), out brush));
                        Check(GdipDrawDriverString(graphics, new[] { (ushort)(0xe000 + index - 1) }, 1, font, brush,
                            new[] { new PointF(originX, originY) }, 1, IntPtr.Zero));
                        var rect = new Rect { w = width, h = height }; Bits bits;
                        Check(GdipBitmapLockBits(image, ref rect, 1, 0x26200a, out bits));
                        var rgba = new byte[width * height * 4];
                        try {
                            for (int y = 0; y < height; y++) Marshal.Copy(IntPtr.Add(bits.scan, y * bits.stride), rgba, y * width * 4, width * 4);
                            for (int i = 0; i < rgba.Length; i += 4) { byte b = rgba[i]; rgba[i] = rgba[i + 2]; rgba[i + 2] = b; }
                        } finally { Check(GdipBitmapUnlockBits(image, ref bits)); }
                        if (json.Length > 1) json.Append(',');
                        json.Append("{\"kind\":\"").Append(kind).Append("\",\"size\":").Append(size).Append(",\"hint\":").Append(hint)
                            .Append(",\"index\":").Append(index).Append(",\"width\":").Append(width).Append(",\"height\":").Append(height)
                            .Append(",\"x\":").Append((int)originX).Append(",\"y\":").Append((int)originY)
                            .Append(",\"rgba\":\"").Append(Convert.ToBase64String(rgba)).Append("\"}");
                    } finally {
                        if (graphics != IntPtr.Zero) GdipDeleteGraphics(graphics);
                        if (font != IntPtr.Zero) GdipDeleteFont(font); if (family != IntPtr.Zero) GdipDeleteFontFamily(family);
                        if (brush != IntPtr.Zero) GdipDeleteBrush(brush); if (image != IntPtr.Zero) GdipDisposeImage(image);
                    }
                }
            } finally { Check(GdipDeletePrivateFontCollection(ref collection)); }
        }
        var data = Encoding.UTF8.GetBytes(json.Append(']').ToString());
        using (var file = File.Create(Path.Combine(dir, "text-diagonal-coverage.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(data, 0, data.Length);
    }
}