// How does GDI draw a raster (.fon) face for bold, italic, underline, strike-out and lfWidth?
//
// Each case selects a non-antialiased raster font into a memory DC over a 32 bpp DIB, draws "Hgy. a" with TextOutW at
// (16, 8) (TA_TOP | TA_LEFT), and records GetTextMetrics, the text extent, the advance of each character and the black
// pixels of the bitmap as strings of '#' and '.', cropped to the rows and columns holding ink. Spaces are drawn too ("  "
// cases) so the decoration lines show without glyph pixels. Output: raster-styles.json.gz.
using System;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Text;

public static class RasterStyleProbe
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct LogFont { public int h, w, esc, ori, weight; public byte it, ul, so, cs, op, cp, q, pf; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string face; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct TextMetric { public int tmHeight, tmAscent, tmDescent, tmInternalLeading, tmExternalLeading, tmAveCharWidth, tmMaxCharWidth, tmWeight, tmOverhang, tmDigitizedAspectX, tmDigitizedAspectY; public ushort tmFirstChar, tmLastChar, tmDefaultChar, tmBreakChar; public byte tmItalic, tmUnderlined, tmStruckOut, tmPitchAndFamily, tmCharSet; }
    [StructLayout(LayoutKind.Sequential)] struct Size { public int cx, cy; }
    [StructLayout(LayoutKind.Sequential)] struct BitmapInfoHeader { public int size, width, height; public short planes, bits; public int compression, sizeImage, xppm, yppm, used, important; }
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern int SetBkMode(IntPtr dc, int mode);
    [DllImport("gdi32.dll")] static extern uint SetTextColor(IntPtr dc, uint color);
    [DllImport("gdi32.dll")] static extern uint SetTextAlign(IntPtr dc, uint mode);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateFontIndirectW(ref LogFont lf);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool GetTextMetricsW(IntPtr dc, out TextMetric tm);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool GetTextExtentPoint32W(IntPtr dc, string s, int n, out Size size);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool GetCharWidth32W(IntPtr dc, uint first, uint last, int[] widths);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool TextOutW(IntPtr dc, int x, int y, string s, int n);
    [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BitmapInfoHeader bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);

    const int W = 200, H = 120;

    public static void Run(string dir)
    {
        string[] faces = { "Courier", "MS Sans Serif", "MS Serif", "Small Fonts", "System", "Terminal", "Fixedsys" };
        int[] heights = { -8, -11, -13, -16, -20, -24, -33 };
        IntPtr screen = GetDC(IntPtr.Zero);
        IntPtr dc = CreateCompatibleDC(screen);
        var bmi = new BitmapInfoHeader { size = 40, width = W, height = -H, planes = 1, bits = 32 };
        IntPtr bits;
        IntPtr dib = CreateDIBSection(screen, ref bmi, 0, out bits, IntPtr.Zero, 0);
        IntPtr oldBmp = SelectObject(dc, dib);
        SetBkMode(dc, 1);
        SetTextColor(dc, 0);
        SetTextAlign(dc, 0);
        var json = new StringBuilder("{\"logPixelsX\":");
        json.Append(GetDeviceCaps(screen)).Append(",\"cases\":[");
        bool first = true;
        foreach (string face in faces)
        foreach (int h in heights)
        {
            for (int style = 0; style < 16; style++)
            {
                int weight = (style & 1) != 0 ? 700 : 400;
                bool italic = (style & 2) != 0, underline = (style & 4) != 0, strike = (style & 8) != 0;
                foreach (string text in new[] { "Hgy. a", "   ", "H", "y", "g" })
                    Emit(json, ref first, dc, bits, face, h, weight, italic, underline, strike, 0, text);
            }
            // lfWidth: a narrower and a wider width than the face's, plain, bold and italic.
            foreach (int w in new[] { 4, 7, 12, 20 })
                foreach (int style in new[] { 0, 1, 2, 4 })
                    Emit(json, ref first, dc, bits, face, h, (style & 1) != 0 ? 700 : 400, (style & 2) != 0, (style & 4) != 0, false, w, "Hgy. a");
        }
        json.Append("]}");
        SelectObject(dc, oldBmp);
        DeleteObject(dib);
        DeleteDC(dc);
        ReleaseDC(IntPtr.Zero, screen);
        using (var file = File.Create(Path.Combine(dir, "raster-styles.json.gz")))
        using (var gz = new GZipStream(file, CompressionLevel.Optimal))
        {
            var bytes = new UTF8Encoding(false).GetBytes(json.ToString());
            gz.Write(bytes, 0, bytes.Length);
        }
    }

    [DllImport("gdi32.dll")] static extern int GetDeviceCaps(IntPtr dc, int index);
    static int GetDeviceCaps(IntPtr screen) { return GetDeviceCaps(screen, 88); }

    static void Emit(StringBuilder json, ref bool first, IntPtr dc, IntPtr bits, string face, int h, int weight, bool italic, bool underline, bool strike, int width, string text)
    {
        var lf = new LogFont { h = h, w = width, weight = weight, it = (byte)(italic ? 1 : 0), ul = (byte)(underline ? 1 : 0), so = (byte)(strike ? 1 : 0), cs = 1, face = face, q = 3 };
        IntPtr font = CreateFontIndirectW(ref lf);
        IntPtr old = SelectObject(dc, font);
        var white = new int[W * H];
        for (int i = 0; i < white.Length; i++) white[i] = unchecked((int)0xFFFFFFFF);
        Marshal.Copy(white, 0, bits, white.Length);
        TextMetric t;
        GetTextMetricsW(dc, out t);
        Size size;
        GetTextExtentPoint32W(dc, text, text.Length, out size);
        var adv = new int[text.Length];
        for (int i = 0; i < text.Length; i++) { var one = new int[1]; GetCharWidth32W(dc, text[i], text[i], one); adv[i] = one[0]; }
        TextOutW(dc, 16, 8, text, text.Length);
        var px = new int[W * H];
        Marshal.Copy(bits, px, 0, px.Length);
        int minX = W, maxX = -1, minY = H, maxY = -1;
        for (int y = 0; y < H; y++) for (int x = 0; x < W; x++)
            if ((px[y * W + x] & 0xFFFFFF) != 0xFFFFFF) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
        if (!first) json.Append(',');
        first = false;
        json.Append("{\"face\":\"").Append(face).Append("\",\"height\":").Append(h).Append(",\"weight\":").Append(weight)
            .Append(",\"italic\":").Append(italic ? 1 : 0).Append(",\"underline\":").Append(underline ? 1 : 0).Append(",\"strike\":").Append(strike ? 1 : 0)
            .Append(",\"width\":").Append(width).Append(",\"text\":\"").Append(text).Append("\",\"tm\":{\"height\":").Append(t.tmHeight).Append(",\"ascent\":").Append(t.tmAscent)
            .Append(",\"internalLeading\":").Append(t.tmInternalLeading).Append(",\"aveCharWidth\":").Append(t.tmAveCharWidth).Append(",\"maxCharWidth\":").Append(t.tmMaxCharWidth)
            .Append(",\"overhang\":").Append(t.tmOverhang).Append(",\"weight\":").Append(t.tmWeight).Append("},\"extent\":").Append(size.cx).Append(",\"advances\":[").Append(string.Join(",", Array.ConvertAll(adv, a => a.ToString()))).Append("],\"originX\":16,\"originY\":8,\"minX\":").Append(minX).Append(",\"minY\":").Append(minY).Append(",\"rows\":[");
        for (int y = minY; y <= maxY && minY <= maxY; y++)
        {
            if (y > minY) json.Append(',');
            json.Append('"');
            for (int x = minX; x <= maxX; x++) json.Append((px[y * W + x] & 0xFFFFFF) != 0xFFFFFF ? '#' : '.');
            json.Append('"');
        }
        json.Append("]}");
        SelectObject(dc, old);
        DeleteObject(font);
    }
}
