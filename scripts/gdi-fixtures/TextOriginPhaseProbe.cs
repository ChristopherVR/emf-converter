// Public GDI+ DrawDriverString: baseline origins avoid DrawString layout.
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class TextOriginPhaseProbe
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

    public static void Run(string dir)
    {
        int[] hints = { 3, 4, 5 }; string filename = "text-origin-phases.json.gz";
        Directory.CreateDirectory(dir);
        var json = new StringBuilder("[");
        string[] faces = { "Arial", "Times New Roman", "Segoe UI", "Arial" };
        int[] sizes = { 16, 22, 12, 40 }, styles = { 0, 2, 1, 1 };
        // Creating a managed bitmap starts the public GDI+ session.
        using (var startup = new Bitmap(1, 1))
        for (int f = 0; f < faces.Length; f++)
        foreach (int hint in hints) foreach (int contrast in new[] { 0 })
        foreach (char character in new[] { 'I', 'g', 'v' })
        for (int qx = 0; qx < 64; qx++) for (int qy = 0; qy < 1; qy++) {
            IntPtr image = IntPtr.Zero, graphics = IntPtr.Zero, family = IntPtr.Zero, font = IntPtr.Zero, brush = IntPtr.Zero;
            try {
                Check(GdipCreateBitmapFromScan0(64, 64, 0, 0x26200a, IntPtr.Zero, out image));
                Check(GdipGetImageGraphicsContext(image, out graphics)); Check(GdipGraphicsClear(graphics, -1));
                Check(GdipSetTextRenderingHint(graphics, hint)); Check(GdipSetTextContrast(graphics, (uint)contrast));
                Check(GdipCreateFontFamilyFromName(faces[f], IntPtr.Zero, out family));
                Check(GdipCreateFont(family, sizes[f], styles[f], 2, out font)); Check(GdipCreateSolidFill(unchecked((int)0xff000000), out brush));
                Check(GdipDrawDriverString(graphics, new[] { (ushort)character }, 1, font, brush, new[] { new PointF(8 + qx / 64f, 48 + qy / 4f) }, 1, IntPtr.Zero));
                var rect = new Rect { w = 64, h = 64 }; Bits bits;
                Check(GdipBitmapLockBits(image, ref rect, 1, 0x26200a, out bits));
                var rgba = new byte[64 * 64 * 4];
                try {
                    for (int y = 0; y < 64; y++) Marshal.Copy(IntPtr.Add(bits.scan, y * bits.stride), rgba, y * 64 * 4, 64 * 4);
                    for (int i = 0; i < rgba.Length; i += 4) { byte b = rgba[i]; rgba[i] = rgba[i + 2]; rgba[i + 2] = b; }
                } finally { Check(GdipBitmapUnlockBits(image, ref bits)); }
                if (json.Length > 1) json.Append(',');
                json.Append("{\"face\":\"").Append(faces[f]).Append("\",\"size\":").Append(sizes[f]).Append(",\"style\":").Append(styles[f])
                    .Append(",\"hint\":").Append(hint).Append(",\"contrast\":").Append(contrast).Append(",\"code\":").Append((int)character)
                    .Append(",\"qx\":").Append(qx).Append(",\"qy\":").Append(qy).Append(",\"rgba\":\"").Append(Convert.ToBase64String(rgba)).Append("\"}");
            } finally {
                if (graphics != IntPtr.Zero) GdipDeleteGraphics(graphics);
                if (font != IntPtr.Zero) GdipDeleteFont(font); if (family != IntPtr.Zero) GdipDeleteFontFamily(family);
                if (brush != IntPtr.Zero) GdipDeleteBrush(brush); if (image != IntPtr.Zero) GdipDisposeImage(image);
            }
        }
        var data = Encoding.UTF8.GetBytes(json.Append(']').ToString());
        using (var file = File.Create(Path.Combine(dir, filename)))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(data, 0, data.Length);
    }
}
