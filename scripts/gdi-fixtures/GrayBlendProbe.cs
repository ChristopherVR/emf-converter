// GDI grayscale (ANTIALIASED_QUALITY) text over backgrounds: records the output of one fixed
// glyph sheet for many text colours, backgrounds and background modes, so the blend
// f(coverage, text, background) can be recovered per channel.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class GrayBlendProbe
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct LOGFONT
    {
        public int lfHeight, lfWidth, lfEscapement, lfOrientation, lfWeight;
        public byte lfItalic, lfUnderline, lfStrikeOut, lfCharSet, lfOutPrecision, lfClipPrecision, lfQuality, lfPitchAndFamily;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string lfFaceName;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct BITMAPINFOHEADER { public int size, width, height; public short planes, bitCount; public int compression, sizeImage, xppm, yppm, clrUsed, clrImportant; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int l, t, r, b; }
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFOHEADER bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateFontIndirectW(ref LOGFONT lf);
    [DllImport("gdi32.dll")] static extern int SetBkMode(IntPtr dc, int mode);
    [DllImport("gdi32.dll")] static extern int SetBkColor(IntPtr dc, int c);
    [DllImport("gdi32.dll")] static extern int SetTextColor(IntPtr dc, int c);
    [DllImport("gdi32.dll")] static extern bool GdiFlush();
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool TextOutW(IntPtr dc, int x, int y, string s, int n);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool ExtTextOutW(IntPtr dc, int x, int y, uint options, ref RECT r, string s, uint n, int[] dx);
    [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx, cy; }
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool GetTextExtentPoint32W(IntPtr dc, string s, int n, out SIZE size);
    [DllImport("gdi32.dll")] static extern IntPtr CreateSolidBrush(int c);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr w);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr w, IntPtr dc);
    [DllImport("user32.dll")] static extern int FillRect(IntPtr dc, ref RECT r, IntPtr brush);

    const int W = 120, H = 72, SplitX = 60;
    static string Text = "Ag@a";

    static byte[] Draw(IntPtr mdc, IntPtr bits, IntPtr font, int fg, int bg, int surface, int mode)
    {
        return Draw(mdc, bits, font, fg, bg, surface, mode, new RECT { l = 0, t = 0, r = W, b = H });
    }

    // mode 6: ETO_OPAQUE with `rect`; mode 7: the same rectangle filled with FillRect and the text drawn TRANSPARENT.
    static byte[] Draw(IntPtr mdc, IntPtr bits, IntPtr font, int fg, int bg, int surface, int mode, RECT rect)
    {
        var all = new RECT { l = 0, t = 0, r = W, b = H };
        IntPtr br = CreateSolidBrush(surface);
        FillRect(mdc, ref all, br); DeleteObject(br);
        SetBkMode(mdc, mode == 1 || mode == 5 ? 2 : 1); SetBkColor(mdc, bg); SetTextColor(mdc, fg);
        IntPtr old = SelectObject(mdc, font);
        var left = new RECT { l = 0, t = 0, r = SplitX, b = H };
        if (mode == 2) ExtTextOutW(mdc, 4, 4, 2, ref all, Text, (uint)Text.Length, null); // ETO_OPAQUE: the rectangle is filled with the background colour
        else if (mode == 3) ExtTextOutW(mdc, 4, 4, 2, ref left, Text, (uint)Text.Length, null); // ETO_OPAQUE over the left part of the glyphs only
        else if (mode == 4) ExtTextOutW(mdc, 4, 4, 4, ref all, Text, (uint)Text.Length, null); // ETO_CLIPPED alone, TRANSPARENT mode
        else if (mode == 5) ExtTextOutW(mdc, 4, 4, 4, ref left, Text, (uint)Text.Length, null); // OPAQUE mode, ETO_CLIPPED to the left part
        else if (mode == 6) ExtTextOutW(mdc, 4, 4, 2, ref rect, Text, (uint)Text.Length, null);
        else if (mode == 7) { IntPtr fb = CreateSolidBrush(bg); FillRect(mdc, ref rect, fb); DeleteObject(fb); TextOutW(mdc, 4, 4, Text, Text.Length); }
        else TextOutW(mdc, 4, 4, Text, Text.Length);
        SelectObject(mdc, old);
        GdiFlush();
        var raw = new byte[W * H * 4]; Marshal.Copy(bits, raw, 0, raw.Length);
        var rgb = new byte[W * H * 3];
        for (int i = 0; i < W * H; i++) { rgb[i * 3] = raw[i * 4 + 2]; rgb[i * 3 + 1] = raw[i * 4 + 1]; rgb[i * 3 + 2] = raw[i * 4]; }
        return rgb;
    }

    static int Rgb(int r, int g, int b) { return r | (g << 8) | (b << 16); }

    static readonly byte[] Levels = { 255, 255, 240, 233, 225, 217, 208, 199, 189, 178, 167, 154, 140, 124, 104, 77, 0 };

    // The coverage level (0..16) of every pixel of the glyph sheet: its grey in the black-on-white sheet.
    static int[] Coverage(IntPtr mdc, IntPtr bits, IntPtr font)
    {
        byte[] reference = Draw(mdc, bits, font, 0, Rgb(255, 255, 255), Rgb(255, 255, 255), 0);
        var level = new int[W * H];
        for (int i = 0; i < W * H; i++) level[i] = Array.IndexOf(Levels, reference[i * 3]);
        return level;
    }

    // Grey text on a grey background for the given values: the output per coverage level k (one byte at
    // [(si * n + di) * 17 + k]); `mixed` counts pixels of one level whose outputs differ (never seen).
    static byte[] Grid(IntPtr mdc, IntPtr bits, IntPtr font, int[] level, int[] values, int mode, out int mixed)
    {
        int n = values.Length;
        var table = new byte[n * n * 17]; var seen = new bool[n * n * 17];
        mixed = 0;
        for (int si = 0; si < n; si++) for (int di = 0; di < n; di++)
        {
            int s = values[si], d = values[di];
            byte[] rgb = Draw(mdc, bits, font, Rgb(s, s, s), Rgb(d, d, d), Rgb(d, d, d), mode);
            int o = (si * n + di) * 17;
            for (int i = 0; i < W * H; i++)
            {
                int k = level[i]; if (k < 0) continue;
                byte v = rgb[i * 3];
                if (!seen[o + k]) { seen[o + k] = true; table[o + k] = v; }
                else if (table[o + k] != v) mixed++;
            }
        }
        return table;
    }

    // Where ETO_OPAQUE text switches between the two blends: each rectangle edge swept across the text cell
    // (x 4 to 4 + width, y 4 to 4 + height) with the other three edges well outside it. For each rectangle the
    // glyph pixels inside it (coverage 2..15) are compared with an OPAQUE-mode drawing and with the same
    // rectangle filled and the text drawn TRANSPARENT.
    static string Sweep(IntPtr mdc, IntPtr bits, IntPtr font, int[] level)
    {
        SIZE size; IntPtr old = SelectObject(mdc, font); GetTextExtentPoint32W(mdc, Text, Text.Length, out size); SelectObject(mdc, old);
        int x0 = 4, y0 = 4, x1 = 4 + size.cx, y1 = 4 + size.cy;
        int fg = Rgb(40, 90, 200), bg = Rgb(230, 190, 60);
        byte[] opaqueRef = Draw(mdc, bits, font, fg, bg, bg, 1);
        var sb = new StringBuilder("{\"cx\":" + size.cx + ",\"cy\":" + size.cy + ",\"configs\":[");
        bool first = true;
        for (int edge = 0; edge < 4; edge++)
            for (int delta = -4; delta <= 4; delta++)
            {
                var r = new RECT { l = x0 - 8, t = y0 - 8, r = x1 + 8, b = y1 + 8 };
                if (edge == 0) r.l = x0 + delta; else if (edge == 1) r.t = y0 + delta; else if (edge == 2) r.r = x1 + delta; else r.b = y1 + delta;
                byte[] eto = Draw(mdc, bits, font, fg, bg, Rgb(10, 120, 30), 6, r);
                byte[] fill = Draw(mdc, bits, font, fg, bg, Rgb(10, 120, 30), 7, r);
                int nOpaque = 0, nTransparent = 0, nBoth = 0, total = 0;
                for (int y = Math.Max(0, r.t); y < Math.Min(H, r.b); y++)
                    for (int x = Math.Max(0, r.l); x < Math.Min(W, r.r); x++)
                    {
                        int i = y * W + x; if (level[i] < 2 || level[i] > 15) continue;
                        bool a = eto[i * 3] == opaqueRef[i * 3] && eto[i * 3 + 1] == opaqueRef[i * 3 + 1] && eto[i * 3 + 2] == opaqueRef[i * 3 + 2];
                        bool b = eto[i * 3] == fill[i * 3] && eto[i * 3 + 1] == fill[i * 3 + 1] && eto[i * 3 + 2] == fill[i * 3 + 2];
                        total++; if (a && !b) nOpaque++; else if (b && !a) nTransparent++; else if (a && b) nBoth++;
                    }
                if (!first) sb.Append(','); first = false;
                sb.Append("{\"edge\":" + edge + ",\"delta\":" + delta + ",\"opaque\":" + nOpaque + ",\"transparent\":" + nTransparent + ",\"both\":" + nBoth + ",\"total\":" + total + "}");
            }
        return sb.Append("]}").ToString();
    }

    // The same sweep for other strings and fonts: the smallest rectangle edge positions that still take the opaque path,
    // relative to the text cell and to the ink of the string (its black-on-white pixels).
    static string SweepFonts(IntPtr mdc, IntPtr bits)
    {
        var specs = new object[][] {
            new object[] { "Arial", -40, 400, 0, "Ag@a" }, new object[] { "Arial", -40, 400, 1, "fjWf" }, new object[] { "Times New Roman", -32, 400, 1, "ffjVV" },
            new object[] { "Arial", -24, 700, 0, "il" }, new object[] { "Tahoma", -20, 400, 0, "gyQ" }, new object[] { "Courier New", -20, 400, 0, "Wi" },
            new object[] { "Arial", -30, 400, 0, "AVA" }, new object[] { "Segoe UI", -24, 400, 1, "fTj" },
        };
        var sb = new StringBuilder("[");
        bool firstSpec = true;
        foreach (var s in specs)
        {
            var lf = new LOGFONT { lfHeight = (int)s[1], lfWeight = (int)s[2], lfItalic = (byte)(int)s[3], lfCharSet = 1, lfQuality = 4, lfFaceName = (string)s[0] };
            IntPtr font = CreateFontIndirectW(ref lf);
            Text = (string)s[4];
            byte[] white = Draw(mdc, bits, font, 0, Rgb(255, 255, 255), Rgb(255, 255, 255), 0);
            int inkL = W, inkR = -1, inkT = H, inkB = -1;
            for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) if (white[(y * W + x) * 3] != 255) { inkL = Math.Min(inkL, x); inkR = Math.Max(inkR, x); inkT = Math.Min(inkT, y); inkB = Math.Max(inkB, y); }
            var level = new int[W * H];
            for (int i = 0; i < W * H; i++) level[i] = Array.IndexOf(Levels, white[i * 3]);
            string one = Sweep(mdc, bits, font, level);
            if (!firstSpec) sb.Append(','); firstSpec = false;
            sb.Append("{\"face\":\"" + s[0] + "\",\"height\":" + s[1] + ",\"italic\":" + s[3] + ",\"weight\":" + s[2] + ",\"text\":\"" + s[4] + "\",\"inkL\":" + inkL + ",\"inkR\":" + inkR + ",\"inkT\":" + inkT + ",\"inkB\":" + inkB + ",\"sweep\":" + one + "}");
            DeleteObject(font);
        }
        Text = "Ag@a";
        return sb.Append("]").ToString();
    }

    static string B64(byte[] data) { return Convert.ToBase64String(data); }

    public static void Run(string dir)
    {
        Directory.CreateDirectory(dir);
        IntPtr screen = GetDC(IntPtr.Zero);
        IntPtr mdc = CreateCompatibleDC(screen);
        var bmi = new BITMAPINFOHEADER { size = 40, width = W, height = -H, planes = 1, bitCount = 32 };
        IntPtr bits; IntPtr dib = CreateDIBSection(screen, ref bmi, 0, out bits, IntPtr.Zero, 0);
        IntPtr oldBmp = SelectObject(mdc, dib);
        var lf = new LOGFONT { lfHeight = -40, lfWeight = 400, lfCharSet = 1, lfQuality = 4, lfFaceName = "Arial" };
        IntPtr font = CreateFontIndirectW(ref lf);
        int[] level = Coverage(mdc, bits, font);
        var cov = new byte[W * H]; for (int i = 0; i < cov.Length; i++) cov[i] = (byte)Math.Max(0, level[i]);
        // GRAY_GRID=full samples every grey (investigation); the committed capture uses every third grey.
        int step = Environment.GetEnvironmentVariable("GRAY_GRID") == "full" ? 1 : 3;
        var values = new System.Collections.Generic.List<int>();
        for (int v = 0; v < 256; v += step) values.Add(v);
        if (values[values.Count - 1] != 255) values.Add(255);
        int mixedT, mixedO;
        byte[] transparent = Grid(mdc, bits, font, level, values.ToArray(), 0, out mixedT);
        byte[] opaque = Grid(mdc, bits, font, level, values.ToArray(), 1, out mixedO);
        var json = new StringBuilder("{\"width\":" + W + ",\"height\":" + H + ",\"face\":\"Arial\",\"size\":40,\"coverage\":\"" + B64(cov) + "\",\"values\":[" + string.Join(",", values) + "]");
        json.Append(",\"mixed\":" + (mixedT + mixedO) + ",\"transparent\":\"" + B64(transparent) + "\",\"opaque\":\"" + B64(opaque) + "\",\"cases\":[");
        // modes: 0 TRANSPARENT, 1 OPAQUE background mode, 2 TRANSPARENT with an ETO_OPAQUE rectangle (surface differs), 3 the same
        // with a rectangle over the left half of the glyphs only, 4 ETO_CLIPPED alone, 5 OPAQUE mode clipped to the left half.
        var rnd = new Random(7);
        bool first = true;
        for (int mode = 0; mode < 6; mode++)
            for (int i = 0; i < 80; i++)
            {
                int[] c = { rnd.Next(256), rnd.Next(256), rnd.Next(256), rnd.Next(256), rnd.Next(256), rnd.Next(256) };
                int surface = (mode == 2 || mode == 3 || mode == 5) ? Rgb(c[0] ^ 0x55, c[1] ^ 0x55, c[2] ^ 0x55) : Rgb(c[3], c[4], c[5]);
                byte[] rgb = Draw(mdc, bits, font, Rgb(c[0], c[1], c[2]), Rgb(c[3], c[4], c[5]), surface, mode);
                // Only the pixels with coverage 2..15 blend; 0, 1 and 16 are the backdrop and the text colour.
                var picked = new System.Collections.Generic.List<byte>();
                for (int p = 0; p < W * H; p++) if (level[p] >= 2 && level[p] <= 15) { picked.Add(rgb[p * 3]); picked.Add(rgb[p * 3 + 1]); picked.Add(rgb[p * 3 + 2]); }
                if (!first) json.Append(',');
                first = false;
                json.Append("{\"mode\":" + mode + ",\"fg\":[" + c[0] + "," + c[1] + "," + c[2] + "],\"bg\":[" + c[3] + "," + c[4] + "," + c[5] + "],\"rgb\":\"" + B64(picked.ToArray()) + "\"}");
            }
        json.Append("],\"sweep\":" + Sweep(mdc, bits, font, level) + ",\"sweeps\":" + SweepFonts(mdc, bits) + "}");
        DeleteObject(font);
        SelectObject(mdc, oldBmp); DeleteObject(dib); DeleteDC(mdc); ReleaseDC(IntPtr.Zero, screen);
        var data = Encoding.UTF8.GetBytes(json.ToString());
        using (var file = File.Create(Path.Combine(dir, "gray-blend.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(data, 0, data.Length);
    }
}
