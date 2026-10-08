// Public GDI+ DrawDriverString ClearType glyphs across ppem sizes and font styles: the size-specific
// tweaks of the Monotype-hinted faces (Arial, Times New Roman, Tahoma) only show at some sizes.
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class TextClearTypeSizeProbe
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

    // Each capture is stored cropped to the rectangle that holds all non-white pixels of its 64 x 64 canvas
    // (origin 8, 48), as base64 RGB, so the file stays small.
    public static void Run(string dir)
    {
        Directory.CreateDirectory(dir);
        var json = new StringBuilder("[");
        string[] faces = { "Arial", "Arial", "Arial", "Times New Roman", "Times New Roman", "Times New Roman", "Tahoma", "Tahoma", "Segoe UI", "Segoe UI" };
        int[] styles = { 0, 1, 2, 0, 1, 2, 0, 1, 0, 1 };
        int[] sizes = { 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 24 };
        string characters = "BDEHILPRTUOSCaegnotfkvxy0124789";
        using (var startup = new Bitmap(1, 1))
        for (int f = 0; f < faces.Length; f++)
        foreach (int size in sizes)
        foreach (char character in characters) {
            IntPtr image = IntPtr.Zero, graphics = IntPtr.Zero, family = IntPtr.Zero, font = IntPtr.Zero, brush = IntPtr.Zero;
            try {
                Check(GdipCreateBitmapFromScan0(64, 64, 0, 0x26200a, IntPtr.Zero, out image));
                Check(GdipGetImageGraphicsContext(image, out graphics)); Check(GdipGraphicsClear(graphics, -1));
                Check(GdipSetTextRenderingHint(graphics, 5)); Check(GdipSetTextContrast(graphics, 0));
                Check(GdipCreateFontFamilyFromName(faces[f], IntPtr.Zero, out family));
                Check(GdipCreateFont(family, size, styles[f], 2, out font)); Check(GdipCreateSolidFill(unchecked((int)0xff000000), out brush));
                Check(GdipDrawDriverString(graphics, new[] { (ushort)character }, 1, font, brush, new[] { new PointF(8, 48) }, 1, IntPtr.Zero));
                var rect = new Rect { w = 64, h = 64 }; Bits bits;
                Check(GdipBitmapLockBits(image, ref rect, 1, 0x26200a, out bits));
                var bgra = new byte[64 * 64 * 4];
                try {
                    for (int y = 0; y < 64; y++) Marshal.Copy(IntPtr.Add(bits.scan, y * bits.stride), bgra, y * 64 * 4, 64 * 4);
                } finally { Check(GdipBitmapUnlockBits(image, ref bits)); }
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
                json.Append("{\"face\":\"").Append(faces[f]).Append("\",\"style\":").Append(styles[f]).Append(",\"size\":").Append(size)
                    .Append(",\"code\":").Append((int)character).Append(",\"x\":").Append(x0).Append(",\"y\":").Append(y0)
                    .Append(",\"w\":").Append(Math.Max(w, 0)).Append(",\"h\":").Append(Math.Max(h, 0)).Append(",\"rgb\":\"").Append(Convert.ToBase64String(rgb)).Append("\"}");
            } finally {
                if (graphics != IntPtr.Zero) GdipDeleteGraphics(graphics);
                if (font != IntPtr.Zero) GdipDeleteFont(font); if (family != IntPtr.Zero) GdipDeleteFontFamily(family);
                if (brush != IntPtr.Zero) GdipDeleteBrush(brush); if (image != IntPtr.Zero) GdipDisposeImage(image);
            }
        }
        var data = Encoding.UTF8.GetBytes(json.Append(']').ToString());
        using (var file = File.Create(Path.Combine(dir, "text-cleartype-sizes.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(data, 0, data.Length);
    }
}
