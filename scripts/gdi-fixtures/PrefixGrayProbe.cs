// GDI+ DrawDriverString captures of every instruction-prefix variant of a private font built by build-hint-prefix-font.py
// (variant k of glyph j is U+E000 + 256 j + k), for one rendering hint and pixel size, at one origin and contrast. Hand-run:
// the fonts are derived from installed Microsoft fonts and are not committed. Output: a JSON array of
// { code, x, y, w, h, gray } (gray = the red channel of the bounding box of the non-white pixels, base64).
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class PrefixGrayProbe
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
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern int AddFontResourceW(string file);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool RemoveFontResourceW(string file);
    static void Check(int status) { if (status != 0) throw new Exception("GDI+ status " + status); }

    /// <summary>Like <see cref="RunCodes"/> with the font registered for the session (AddFontResource) and looked up by family
    /// name in the system collection instead of a private GDI+ collection.</summary>
    public static void RunCodesSession(string fontFile, string family, int size, int hint, int contrast, int[] codes, string output)
    {
        string full = Path.GetFullPath(fontFile);
        if (AddFontResourceW(full) == 0) throw new Exception("AddFontResource failed");
        try { RunCodes("", family, size, hint, contrast, codes, output); }
        finally { RemoveFontResourceW(full); }
    }

    /// <param name="counts">Number of variants of each glyph, in the order of the build script.</param>
    public static void Run(string fontFile, string family, int size, int hint, int contrast, int[] counts, string output)
    {
        var codes = new System.Collections.Generic.List<int>();
        for (int j = 0; j < counts.Length; j++) for (int k = 0; k < counts[j]; k++) codes.Add(0xe000 + 256 * j + k);
        RunCodes(fontFile, family, size, hint, contrast, codes.ToArray(), output);
    }

    /// <param name="fontFile">A font file added to a private collection, or empty to use the installed family.</param>
    public static void RunCodes(string fontFile, string family, int size, int hint, int contrast, int[] codes, string output)
    {
        var json = new StringBuilder("[");
        using (var startup = new Bitmap(1, 1)) {
            IntPtr collection = IntPtr.Zero;
            if (!string.IsNullOrEmpty(fontFile)) Check(GdipNewPrivateFontCollection(out collection));
            try {
                if (collection != IntPtr.Zero) Check(GdipPrivateAddFontFile(collection, Path.GetFullPath(fontFile)));
                foreach (int code in codes) {
                    IntPtr image = IntPtr.Zero, graphics = IntPtr.Zero, fam = IntPtr.Zero, font = IntPtr.Zero, brush = IntPtr.Zero;
                    try {
                        Check(GdipCreateBitmapFromScan0(64, 64, 0, 0x26200a, IntPtr.Zero, out image));
                        Check(GdipGetImageGraphicsContext(image, out graphics)); Check(GdipGraphicsClear(graphics, -1));
                        Check(GdipSetTextRenderingHint(graphics, hint)); Check(GdipSetTextContrast(graphics, (uint)contrast));
                        Check(GdipCreateFontFamilyFromName(family, collection, out fam));
                        Check(GdipCreateFont(fam, size, 0, 2, out font)); Check(GdipCreateSolidFill(unchecked((int)0xff000000), out brush));
                        Check(GdipDrawDriverString(graphics, new[] { (ushort)code }, 1, font, brush, new[] { new PointF(8, 48) }, 1, IntPtr.Zero));
                        var rect = new Rect { w = 64, h = 64 }; Bits bits;
                        Check(GdipBitmapLockBits(image, ref rect, 1, 0x26200a, out bits));
                        var bgra = new byte[64 * 64 * 4];
                        try { for (int y = 0; y < 64; y++) Marshal.Copy(IntPtr.Add(bits.scan, y * bits.stride), bgra, y * 64 * 4, 64 * 4); }
                        finally { Check(GdipBitmapUnlockBits(image, ref bits)); }
                        var red = new byte[64 * 64];
                        for (int i = 0; i < red.Length; i++) red[i] = bgra[i * 4 + 2];
                        if (json.Length > 1) json.Append(',');
                        json.Append("{\"code\":").Append(code).Append(",\"gray\":\"").Append(Convert.ToBase64String(red)).Append("\"}");
                    } finally {
                        if (graphics != IntPtr.Zero) GdipDeleteGraphics(graphics);
                        if (font != IntPtr.Zero) GdipDeleteFont(font); if (fam != IntPtr.Zero) GdipDeleteFontFamily(fam);
                        if (brush != IntPtr.Zero) GdipDeleteBrush(brush); if (image != IntPtr.Zero) GdipDisposeImage(image);
                    }
                }
            } finally { if (collection != IntPtr.Zero) Check(GdipDeletePrivateFontCollection(ref collection)); }
        }
        File.WriteAllText(output, json.Append(']').ToString());
    }
}
