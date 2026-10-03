// Public GDI+ DrawString placement controls; no native implementation is inspected.
using System;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public static class DrawStringPlacementProbe
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
    [DllImport("gdiplus.dll")] static extern int GdipBitmapLockBits(IntPtr image, ref Rect rect, uint flags, int format, out Bits bits);
    [DllImport("gdiplus.dll")] static extern int GdipBitmapUnlockBits(IntPtr image, ref Bits bits);
    [DllImport("gdiplus.dll")] static extern int GdipDeleteGraphics(IntPtr graphics);
    [DllImport("gdiplus.dll")] static extern int GdipDeleteFont(IntPtr font);
    [DllImport("gdiplus.dll")] static extern int GdipDeleteFontFamily(IntPtr family);
    [DllImport("gdiplus.dll")] static extern int GdipDeleteBrush(IntPtr brush);
    [DllImport("gdiplus.dll")] static extern int GdipDisposeImage(IntPtr image);
    [StructLayout(LayoutKind.Sequential)] struct RectF { public float x, y, w, h; }
    [DllImport("gdiplus.dll", CharSet = CharSet.Unicode)] static extern int GdipDrawString(IntPtr graphics, string text, int length, IntPtr font, ref RectF layout, IntPtr format, IntPtr brush);
    [DllImport("gdiplus.dll")] static extern int GdipCreateStringFormat(int flags, ushort language, out IntPtr format);
    [DllImport("gdiplus.dll")] static extern int GdipStringFormatGetGenericTypographic(out IntPtr format);
    [DllImport("gdiplus.dll")] static extern int GdipDeleteStringFormat(IntPtr format);
    static byte[] Pixels(IntPtr image) {
        var rect = new Rect { w = 64, h = 64 }; Bits bits;
        Check(GdipBitmapLockBits(image, ref rect, 1, 0x26200a, out bits));
        var bytes = new byte[64 * 64 * 4];
        try { for (int y = 0; y < 64; y++) Marshal.Copy(IntPtr.Add(bits.scan, y * bits.stride), bytes, y * 256, 256); }
        finally { Check(GdipBitmapUnlockBits(image, ref bits)); }
        return bytes;
    }
    static void Check(int status) { if (status != 0) throw new Exception("GDI+ status " + status); }

    public static void Run(string directory) {
        string[] faces = { "Arial", "Times New Roman", "Segoe UI", "Arial" };
        int[] sizes = { 16, 22, 12, 40 }, styles = { 0, 2, 1, 1 };
        var output = new StringBuilder("[");
        using (var startup = new Bitmap(1, 1))
        for (int f = 0; f < 4; f++) foreach (int hint in new[] { 3, 4, 5 }) foreach (bool typo in new[] { false, true }) foreach (float phase in new[] { 0f, .25f }) foreach (char code in new[] { 'I', 'g', 'W' }) {
            IntPtr image, graphics, family, font, brush, format;
            Check(GdipCreateBitmapFromScan0(64, 64, 0, 0x26200a, IntPtr.Zero, out image));
            Check(GdipGetImageGraphicsContext(image, out graphics));
            Check(GdipSetTextRenderingHint(graphics, hint)); Check(GdipSetTextContrast(graphics, 0));
            Check(GdipCreateFontFamilyFromName(faces[f], IntPtr.Zero, out family));
            Check(GdipCreateFont(family, sizes[f], styles[f], 2, out font)); Check(GdipCreateSolidFill(unchecked((int)0xff000000), out brush));
            if (typo) Check(GdipStringFormatGetGenericTypographic(out format)); else Check(GdipCreateStringFormat(0, 0, out format));
            try {
                Check(GdipGraphicsClear(graphics, -1));
                var layout = new RectF { x = 8 + phase, y = 16 + phase, w = 1000, h = 1000 };
                Check(GdipDrawString(graphics, code.ToString(), 1, font, ref layout, format, brush));
                var reference = Pixels(image);
                float ascent;
                using (var ff = new FontFamily(faces[f])) ascent = sizes[f] * (float)ff.GetCellAscent((FontStyle)styles[f]) / ff.GetEmHeight((FontStyle)styles[f]);
                for (int k = 0; k < reference.Length; k += 4) { byte blue = reference[k]; reference[k] = reference[k + 2]; reference[k + 2] = blue; }
                if (output.Length > 1) output.Append(',');
                output.Append("{\"face\":\"").Append(faces[f]).Append("\",\"size\":").Append(sizes[f]).Append(",\"style\":").Append(styles[f]).Append(",\"hint\":").Append(hint)
                    .Append(",\"typo\":").Append(typo ? "true" : "false").Append(",\"ascent\":").Append(ascent.ToString(CultureInfo.InvariantCulture))
                    .Append(",\"phase\":").Append(phase.ToString(CultureInfo.InvariantCulture)).Append(",\"code\":").Append((int)code)
                    .Append(",\"rgba\":\"").Append(Convert.ToBase64String(reference)).Append("\"}");
            } finally { GdipDeleteStringFormat(format); GdipDeleteGraphics(graphics); GdipDeleteFont(font); GdipDeleteFontFamily(family); GdipDeleteBrush(brush); GdipDisposeImage(image); }
        }
        using (var file = File.Create(Path.Combine(directory, "text-drawstring-placement.json.gz")))
        using (var gzip = new GZipStream(file, CompressionMode.Compress)) {
            byte[] bytes = Encoding.UTF8.GetBytes(output.Append(']').ToString()); gzip.Write(bytes, 0, bytes.Length);
        }
    }
}
