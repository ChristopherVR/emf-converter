// Where does GDI put each glyph of rotated, non-antialiased text? (`text-rotated-placement`)
//
// A string is drawn with TextOutW into a white 32bpp DIB, once per prefix ("E", "Es", "Esc", ...). The layout of a
// prefix is the layout of the whole string up to that glyph, so the ink pixels a longer prefix adds over the
// shorter one are exactly the pixels of the added glyph at its native device origin. For every capture the ink of
// the full string is stored as [x, y, k] with k the index of the first prefix that painted the pixel (pixels
// covered by an earlier glyph keep that glyph's index). Rotation is requested either as LOGFONT escapement and
// orientation (mode "esc") or as a world rotation under GM_ADVANCED (mode "world"). The device advance of each
// character (GetCharWidth32) is stored beside the pixels.
// Output: rotated-placement.json.gz, [{face, lfHeight, degrees, mode, align, x, y, text, widths, pixels}].
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Text;

public static class TextRotatedPlacementProbe
{
    [StructLayout(LayoutKind.Sequential)] struct XForm { public float m11, m12, m21, m22, dx, dy; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct LogFont { public int h, w, esc, ori, weight; public byte it, ul, so, cs, op, cp, q, pf; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string face; }
    [StructLayout(LayoutKind.Sequential)]
    struct BitmapInfoHeader { public int size, width, height; public short planes, bitCount; public int compression, sizeImage, xppm, yppm, clrUsed, clrImportant; }
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern int SetGraphicsMode(IntPtr dc, int mode);
    [DllImport("gdi32.dll")] static extern bool SetWorldTransform(IntPtr dc, ref XForm xform);
    [DllImport("gdi32.dll")] static extern int SetBkMode(IntPtr dc, int mode);
    [DllImport("gdi32.dll")] static extern uint SetTextAlign(IntPtr dc, uint align);
    [DllImport("gdi32.dll")] static extern uint SetTextColor(IntPtr dc, uint color);
    [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BitmapInfoHeader bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateFontIndirectW(ref LogFont lf);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool TextOutW(IntPtr dc, int x, int y, string s, int n);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool ExtTextOutW(IntPtr dc, int x, int y, uint options, IntPtr rect, string s, int n, int[] dx);

    // useDx draws with ExtTextOut and the character widths as the Dx array, as a played-back metafile does (GDI records the rounded widths).
    static void Out(IntPtr dc, int x, int y, string s, int[] widths, bool useDx)
    {
        if (useDx)
        {
            var dx = new int[s.Length];
            Array.Copy(widths, dx, s.Length);
            ExtTextOutW(dc, x, y, 0, IntPtr.Zero, s, s.Length, dx);
        }
        else TextOutW(dc, x, y, s, s.Length);
    }
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool GetCharWidth32W(IntPtr dc, uint first, uint last, out int width);

    const int Size = 420;

    static void Clear(IntPtr bits)
    {
        var white = new byte[Size * Size * 4];
        for (int i = 0; i < white.Length; i++) white[i] = 255;
        Marshal.Copy(white, 0, bits, white.Length);
    }

    [StructLayout(LayoutKind.Sequential)] struct Fixed { public short fract; public short value; }
    [StructLayout(LayoutKind.Sequential)] struct Mat2 { public Fixed m11, m12, m21, m22; }
    [StructLayout(LayoutKind.Sequential)] struct GlyphMetrics { public uint bw, bh; public int ox, oy; public short cx, cy; }
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern uint GetGlyphOutlineW(IntPtr dc, uint ch, uint fmt, out GlyphMetrics gm, uint size, byte[] buf, ref Mat2 m);

    /// <summary>
    /// The rotated glyph as GDI draws it, separated from placement: for each glyph the 1-bit GGO_BITMAP bitmap (with its black
    /// box, origin and advance) and the GGO_NATIVE outline (1/64 pixel words) of the same glyph under the same rotation.
    /// Output: rotated-glyph-bitmaps.json.gz, [{face, lfHeight, degrees, mode, glyph, bw, bh, ox, oy, cx, cy, rows, words}] where
    /// rows is the bitmap as hex (each row padded to 4 bytes, top row first).
    /// </summary>
    public static void RunGlyphs(string dir)
    {
        IntPtr screen = GetDC(IntPtr.Zero);
        IntPtr dc = CreateCompatibleDC(screen);
        var json = new StringBuilder("[");
        bool first = true;
        string glyphs = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789&@%$";
        var one = new Fixed { value = 1 };
        var ident = new Mat2 { m11 = one, m22 = one };
        foreach (string face in new[] { "Arial", "Times New Roman", "Tahoma", "Courier New" })
        foreach (int h in new[] { -9, -12, -16, -20, -28, -40 })
        foreach (int deg in new[] { 5, 10, 25, 30, 45, 60, 85, 100, 135, 170, 200, 225, 300, 350 })
        foreach (string mode in new[] { "esc", "world" })
        {
            if (mode == "world" && (face != "Arial" || (h != -16 && h != -28))) continue;
            var lf = new LogFont { h = h, weight = 400, cs = 1, face = face, q = 3 };
            SetGraphicsMode(dc, 2);
            double rad = -deg * Math.PI / 180.0;
            XForm xf = mode == "world"
                ? new XForm { m11 = (float)Math.Cos(rad), m12 = (float)Math.Sin(rad), m21 = -(float)Math.Sin(rad), m22 = (float)Math.Cos(rad) }
                : new XForm { m11 = 1, m22 = 1 };
            SetWorldTransform(dc, ref xf);
            if (mode == "esc") { lf.esc = deg * 10; lf.ori = deg * 10; }
            IntPtr font = CreateFontIndirectW(ref lf);
            IntPtr old = SelectObject(dc, font);
            foreach (char c in glyphs)
            {
                GlyphMetrics gm;
                uint size = GetGlyphOutlineW(dc, c, 1, out gm, 0, null, ref ident);
                var bmp = size == 0xFFFFFFFF ? new byte[0] : new byte[size];
                if (size != 0xFFFFFFFF && size > 0) GetGlyphOutlineW(dc, c, 1, out gm, size, bmp, ref ident);
                GlyphMetrics gn;
                uint nsize = GetGlyphOutlineW(dc, c, 2, out gn, 0, null, ref ident);
                var nat = new byte[nsize == 0xFFFFFFFF ? 0 : nsize];
                if (nsize != 0xFFFFFFFF && nsize > 0) GetGlyphOutlineW(dc, c, 2, out gn, nsize, nat, ref ident);
                if (!first) json.Append(',');
                first = false;
                json.Append("{\"face\":\"").Append(face).Append("\",\"lfHeight\":").Append(h).Append(",\"degrees\":").Append(deg)
                    .Append(",\"mode\":\"").Append(mode).Append("\",\"glyph\":\"").Append(c == '"' ? "\\\"" : c.ToString()).Append("\",\"bw\":").Append(gm.bw).Append(",\"bh\":").Append(gm.bh)
                    .Append(",\"ox\":").Append(gm.ox).Append(",\"oy\":").Append(gm.oy).Append(",\"cx\":").Append(gm.cx).Append(",\"cy\":").Append(gm.cy)
                    .Append(",\"rows\":\"").Append(BitConverter.ToString(bmp).Replace("-", "")).Append("\",\"words\":[");
                for (int i = 0; i + 4 <= nat.Length; i += 4) { if (i > 0) json.Append(','); json.Append(BitConverter.ToInt32(nat, i)); }
                json.Append("]}");
            }
            SelectObject(dc, old); DeleteObject(font);
        }
        json.Append(']');
        DeleteDC(dc);
        using (var file = File.Create(Path.Combine(dir, "rotated-glyph-bitmaps.json.gz")))
        using (var gz = new GZipStream(file, CompressionLevel.Optimal))
        {
            var bytes = new UTF8Encoding(false).GetBytes(json.ToString());
            gz.Write(bytes, 0, bytes.Length);
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct TextMetric
    {
        public int height, ascent, descent, internalLeading, externalLeading, aveCharWidth, maxCharWidth, weight, overhang, digitizedAspectX, digitizedAspectY;
        public ushort firstChar, lastChar, defaultChar, breakChar;
        public byte italic, underlined, struckOut, pitchAndFamily, charSet;
    }
    [StructLayout(LayoutKind.Sequential)] struct Size2 { public int cx, cy; }
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool GetTextMetricsW(IntPtr dc, out TextMetric tm);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool GetTextExtentPoint32W(IntPtr dc, string s, int n, out Size2 size);

    /// <summary>
    /// Rotated text under every TA_* alignment: one TextOutW of the whole string per configuration (the prefix trick does not
    /// work, because alignment depends on the whole string). Stores the ink pixels, the character widths, GetTextExtentPoint32
    /// and the TEXTMETRIC ascent/descent of the rotated font. Output: rotated-alignment.json.gz,
    /// [{face, lfHeight, degrees, mode, align, x, y, text, widths, extentCx, extentCy, ascent, descent, height, pixels}].
    /// </summary>
    public static void RunAligned(string dir, bool useDx = false)
    {
        IntPtr screen = GetDC(IntPtr.Zero);
        IntPtr dc = CreateCompatibleDC(screen);
        var bmi = new BitmapInfoHeader { size = 40, width = Size, height = -Size, planes = 1, bitCount = 32 };
        IntPtr bits;
        IntPtr bmp = CreateDIBSection(screen, ref bmi, 0, out bits, IntPtr.Zero, 0);
        SelectObject(dc, bmp);
        SetBkMode(dc, 1);
        SetTextColor(dc, 0);
        var json = new StringBuilder("[");
        bool first = true;
        var rows = new byte[Size * Size * 4];
        uint[] aligns = { 0, 8, 24, 2, 2 | 8, 2 | 24, 6, 6 | 8, 6 | 24 };
        foreach (string face in new[] { "Arial", "Times New Roman" })
        foreach (int h in new[] { -13, -20, -28 })
        foreach (int deg in new[] { 10, 25, 45, 60, 135, 160, 225, 300 })
        foreach (string mode in new[] { "esc", "world" })
        foreach (uint align in aligns)
        foreach (string text in new[] { "Tg25 Hq", "Wide jumbo 7" })
        {
            int x = 210, y = 210;
            var lf = new LogFont { h = h, weight = 400, cs = 1, face = face, q = 3 };
            if (mode == "esc") { lf.esc = deg * 10; lf.ori = deg * 10; }
            SetGraphicsMode(dc, 2);
            double rad = -deg * Math.PI / 180.0;
            var xf = mode == "world"
                ? new XForm { m11 = (float)Math.Cos(rad), m12 = (float)Math.Sin(rad), m21 = -(float)Math.Sin(rad), m22 = (float)Math.Cos(rad), dx = x, dy = y }
                : new XForm { m11 = 1, m22 = 1 };
            SetWorldTransform(dc, ref xf);
            SetTextAlign(dc, align);
            IntPtr font = CreateFontIndirectW(ref lf);
            IntPtr old = SelectObject(dc, font);
            var widths = new int[text.Length];
            for (int i = 0; i < text.Length; i++) GetCharWidth32W(dc, text[i], text[i], out widths[i]);
            TextMetric tm; GetTextMetricsW(dc, out tm);
            Size2 ext; GetTextExtentPoint32W(dc, text, text.Length, out ext);
            Clear(bits);
            if (mode == "world") Out(dc, 0, 0, text, widths, useDx); else Out(dc, x, y, text, widths, useDx);
            Marshal.Copy(bits, rows, 0, rows.Length);
            SelectObject(dc, old); DeleteObject(font);
            if (!first) json.Append(',');
            first = false;
            json.Append("{\"face\":\"").Append(face).Append("\",\"lfHeight\":").Append(h).Append(",\"degrees\":").Append(deg)
                .Append(",\"mode\":\"").Append(mode).Append("\",\"align\":").Append(align).Append(",\"x\":").Append(x).Append(",\"y\":").Append(y)
                .Append(",\"text\":\"").Append(text).Append("\",\"widths\":[").Append(string.Join(",", widths)).Append("],\"extentCx\":").Append(ext.cx)
                .Append(",\"extentCy\":").Append(ext.cy).Append(",\"ascent\":").Append(tm.ascent).Append(",\"descent\":").Append(tm.descent)
                .Append(",\"height\":").Append(tm.height).Append(",\"pixels\":[");
            bool firstPixel = true;
            for (int p = 0; p < Size * Size; p++)
            {
                if (rows[p * 4] == 255 && rows[p * 4 + 1] == 255 && rows[p * 4 + 2] == 255) continue;
                if (!firstPixel) json.Append(',');
                firstPixel = false;
                json.Append(p % Size).Append(',').Append(p / Size);
            }
            json.Append("]}");
        }
        json.Append(']');
        DeleteObject(bmp);
        DeleteDC(dc);
        using (var file = File.Create(Path.Combine(dir, useDx ? "rotated-alignment-dx.json.gz" : "rotated-alignment.json.gz")))
        using (var gz = new GZipStream(file, CompressionLevel.Optimal))
        {
            var bytes = new UTF8Encoding(false).GetBytes(json.ToString());
            gz.Write(bytes, 0, bytes.Length);
        }
    }

    public static void Run(string dir, bool useDx = false)
    {
        IntPtr screen = GetDC(IntPtr.Zero);
        IntPtr dc = CreateCompatibleDC(screen);
        var bmi = new BitmapInfoHeader { size = 40, width = Size, height = -Size, planes = 1, bitCount = 32 };
        IntPtr bits;
        IntPtr bmp = CreateDIBSection(screen, ref bmi, 0, out bits, IntPtr.Zero, 0);
        SelectObject(dc, bmp);
        SetBkMode(dc, 1);
        SetTextColor(dc, 0);
        var json = new StringBuilder("[");
        bool first = true;
        string text = "Escape 120 Hgq";
        var rows = new byte[Size * Size * 4];
        var seen = new int[Size * Size];
        foreach (string face in new[] { "Arial", "Times New Roman" })
        foreach (int h in new[] { -9, -13, -16, -20, -28 })
        foreach (int deg in new[] { 0, 10, 25, 30, 45, 60, 90, 120, 135, 170, 180, 200, 225, 270, 315, 345 })
        foreach (string mode in new[] { "esc", "world" })
        foreach (uint align in new uint[] { 24 })
        {
            if (mode == "world" && deg == 0) continue;
            int x = 210, y = 210;
            var lf = new LogFont { h = h, weight = 400, cs = 1, face = face, q = 3 };
            if (mode == "esc") { lf.esc = deg * 10; lf.ori = deg * 10; }
            SetGraphicsMode(dc, 2);
            double rad = -deg * Math.PI / 180.0;
            var xf = mode == "world"
                ? new XForm { m11 = (float)Math.Cos(rad), m12 = (float)Math.Sin(rad), m21 = -(float)Math.Sin(rad), m22 = (float)Math.Cos(rad), dx = x, dy = y }
                : new XForm { m11 = 1, m22 = 1 };
            SetWorldTransform(dc, ref xf);
            SetTextAlign(dc, align);
            IntPtr font = CreateFontIndirectW(ref lf);
            IntPtr old = SelectObject(dc, font);
            var widths = new int[text.Length];
            for (int i = 0; i < text.Length; i++) GetCharWidth32W(dc, text[i], text[i], out widths[i]);
            Array.Clear(seen, 0, seen.Length);
            for (int i = 0; i < Size * Size; i++) seen[i] = -1;
            for (int k = 1; k <= text.Length; k++)
            {
                Clear(bits);
                if (mode == "world") Out(dc, 0, 0, text.Substring(0, k), widths, useDx); else Out(dc, x, y, text.Substring(0, k), widths, useDx);
                Marshal.Copy(bits, rows, 0, rows.Length);
                for (int p = 0; p < Size * Size; p++)
                    if (seen[p] < 0 && (rows[p * 4] != 255 || rows[p * 4 + 1] != 255 || rows[p * 4 + 2] != 255)) seen[p] = k - 1;
            }
            SelectObject(dc, old); DeleteObject(font);
            if (!first) json.Append(',');
            first = false;
            json.Append("{\"face\":\"").Append(face).Append("\",\"lfHeight\":").Append(h).Append(",\"degrees\":").Append(deg)
                .Append(",\"mode\":\"").Append(mode).Append("\",\"align\":").Append(align).Append(",\"x\":").Append(x).Append(",\"y\":").Append(y)
                .Append(",\"text\":\"").Append(text).Append("\",\"widths\":[").Append(string.Join(",", widths)).Append("],\"pixels\":[");
            bool firstPixel = true;
            for (int p = 0; p < Size * Size; p++)
            {
                if (seen[p] < 0) continue;
                if (!firstPixel) json.Append(',');
                firstPixel = false;
                json.Append(p % Size).Append(',').Append(p / Size).Append(',').Append(seen[p]);
            }
            json.Append("]}");
        }
        json.Append(']');
        DeleteObject(bmp);
        DeleteDC(dc);
        using (var file = File.Create(Path.Combine(dir, useDx ? "rotated-placement-dx.json.gz" : "rotated-placement.json.gz")))
        using (var gz = new GZipStream(file, CompressionLevel.Optimal))
        {
            var bytes = new UTF8Encoding(false).GetBytes(json.ToString());
            gz.Write(bytes, 0, bytes.Length);
        }
    }
}
