// GDI GetGlyphOutline GGO_GRAY4_BITMAP and GGO_NATIVE (hinted outline) data of real fonts at many sizes (ANTIALIASED_QUALITY
// font, identity matrix): the data for comparing the converter's grayscale glyph rasterizer with what GDI hands
// ExtTextOut, per glyph and per size.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class GrayGlyphProbe
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct LOGFONT
    {
        public int lfHeight, lfWidth, lfEscapement, lfOrientation, lfWeight;
        public byte lfItalic, lfUnderline, lfStrikeOut, lfCharSet, lfOutPrecision, lfClipPrecision, lfQuality, lfPitchAndFamily;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string lfFaceName;
    }
    [StructLayout(LayoutKind.Sequential)] struct Fixed { public short fract; public short value; }
    [StructLayout(LayoutKind.Sequential)] struct Mat { public Fixed a, b, c, d; }
    [StructLayout(LayoutKind.Sequential)] struct Pt { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct Metrics { public uint w, h; public Pt origin; public short incX, incY; }
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateFontIndirectW(ref LOGFONT lf);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern uint GetGlyphOutlineW(IntPtr dc, uint ch, uint format, out Metrics gm, uint len, byte[] buf, ref Mat mat);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr w);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr w, IntPtr dc);

    static readonly string[] Faces = { "Arial", "Times New Roman", "Tahoma", "Segoe UI", "Courier New" };
    static readonly int[] Sizes = { 18, 24, 32, 48, 72 };

    public static void Run(string dir)
    {
        Directory.CreateDirectory(dir);
        IntPtr screen = GetDC(IntPtr.Zero);
        IntPtr dc = CreateCompatibleDC(screen);
        var mat = new Mat(); mat.a.value = 1; mat.d.value = 1;
        using (var file = File.Create(Path.Combine(dir, "gdi-gray-glyphs.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress))
        using (var writer = new StreamWriter(zip, new UTF8Encoding(false)))
        {
            writer.Write("[");
            bool first = true;
            foreach (string face in Faces)
            foreach (int size in Sizes)
            foreach (int weight in new[] { 400 })
            {
                var lf = new LOGFONT { lfHeight = -size, lfWeight = weight, lfCharSet = 1, lfQuality = 4, lfFaceName = face };
                IntPtr font = CreateFontIndirectW(ref lf);
                IntPtr old = SelectObject(dc, font);
                for (uint code = 33; code < 127; code++)
                    foreach (uint format in new uint[] { 5, 2 })
                    {
                        Metrics gm;
                        uint len = GetGlyphOutlineW(dc, code, format, out gm, 0, null, ref mat);
                        if (len == 0xFFFFFFFF) continue;
                        var data = new byte[len];
                        if (len > 0 && GetGlyphOutlineW(dc, code, format, out gm, len, data, ref mat) != len) continue;
                        if (!first) writer.Write(',');
                        first = false;
                        writer.Write("{\"face\":\"" + face + "\",\"size\":" + size + ",\"weight\":" + weight + ",\"code\":" + code + ",\"format\":" + format
                            + ",\"w\":" + gm.w + ",\"h\":" + gm.h + ",\"x\":" + gm.origin.x + ",\"y\":" + gm.origin.y + ",\"inc\":" + gm.incX
                            + ",\"data\":\"" + Convert.ToBase64String(data) + "\"}");
                    }
                SelectObject(dc, old); DeleteObject(font);
            }
            writer.Write("]");
        }
        DeleteDC(dc); ReleaseDC(IntPtr.Zero, screen);
    }
}
