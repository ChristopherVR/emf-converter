// Why do the clipped text references differ from native playback of their own recordings?
//
// A `GdiCase` text sheet is drawn twice: into the metafile DC (the recording) and straight onto a 32bpp
// DIB (the reference PNG). This probe re-draws the sheet layout of `TxSizeSheet` onto a DIB two ways
//   A: `TextOutW`, no advance array (what the reference PNG holds), and
//   B: `ExtTextOutW` with the advance array (dx) recorded in the committed EMF,
// plays the committed EMF back onto an identical DIB (C) and counts differing pixels over the whole
// 480-wide surface. B == C and A != C shows that the recording stored advances that the direct drawing
// did not use. It also writes, per size, the direct advance of every glyph (GetCharWidth32 on the DIB DC)
// next to the recorded dx. Output: text-recorded-advance.json (committed capture, see the README).
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class RecordedAdvanceProbe
{
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct LogFont { public int h, w, esc, ori, weight; public byte it, ul, so, cs, op, cp, q, pf; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string face; }
    [StructLayout(LayoutKind.Sequential)] struct BitmapInfo { public int size, width, height; public short planes, depth; public int compression, bytes, x, y, colors, important; }
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("user32.dll")] static extern int FillRect(IntPtr dc, ref Rect rect, IntPtr brush);
    [DllImport("gdi32.dll")] static extern IntPtr CreateSolidBrush(int color);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BitmapInfo info, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool GdiFlush();
    [DllImport("gdi32.dll")] static extern int SetBkMode(IntPtr dc, int mode);
    [DllImport("gdi32.dll")] static extern int SetTextColor(IntPtr dc, int color);
    [DllImport("gdi32.dll")] static extern uint SetTextAlign(IntPtr dc, uint align);
    [DllImport("gdi32.dll")] static extern int SetMapMode(IntPtr dc, int mode);
    [DllImport("gdi32.dll")] static extern bool SetWindowExtEx(IntPtr dc, int x, int y, IntPtr old);
    [DllImport("gdi32.dll")] static extern bool SetViewportExtEx(IntPtr dc, int x, int y, IntPtr old);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateFontIndirectW(ref LogFont lf);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool TextOutW(IntPtr dc, int x, int y, string s, int n);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool ExtTextOutW(IntPtr dc, int x, int y, uint options, IntPtr rect, string s, int n, int[] dx);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool GetCharWidth32W(IntPtr dc, uint first, uint last, [Out] int[] widths);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetEnhMetaFileW(string file);
    [DllImport("gdi32.dll")] static extern bool PlayEnhMetaFile(IntPtr dc, IntPtr metafile, ref Rect rect);
    [DllImport("gdi32.dll")] static extern bool DeleteEnhMetaFile(IntPtr metafile);

    const string Sample = "Hamburgefonstiv 0123 AVWX &@%$";

    sealed class Surface : IDisposable
    {
        public IntPtr Dc, Bitmap, Bits, Old; public int W, H;
        public Surface(IntPtr screen, int w, int h)
        {
            W = w; H = h;
            var info = new BitmapInfo { size = 40, width = w, height = -h, planes = 1, depth = 32 };
            Dc = CreateCompatibleDC(screen);
            Bitmap = CreateDIBSection(screen, ref info, 0, out Bits, IntPtr.Zero, 0);
            Old = SelectObject(Dc, Bitmap);
            var white = CreateSolidBrush(0xffffff);
            var all = new Rect { right = w, bottom = h };
            FillRect(Dc, ref all, white);
            DeleteObject(white);
        }
        public byte[] Pixels() { GdiFlush(); var b = new byte[W * H * 4]; Marshal.Copy(Bits, b, 0, b.Length); return b; }
        public void Dispose() { SelectObject(Dc, Old); DeleteObject(Bitmap); DeleteDC(Dc); }
    }

    /** dx arrays of every EMR_EXTTEXTOUTW record, in order. */
    static List<int[]> RecordedAdvances(string emf)
    {
        var bytes = File.ReadAllBytes(emf);
        var result = new List<int[]>();
        for (int o = 0; o < bytes.Length;)
        {
            int type = BitConverter.ToInt32(bytes, o), size = BitConverter.ToInt32(bytes, o + 4);
            if (type == 84)
            {
                int n = BitConverter.ToInt32(bytes, o + 44), offDx = BitConverter.ToInt32(bytes, o + 72);
                var dx = new int[n];
                for (int i = 0; i < n; i++) dx[i] = BitConverter.ToInt32(bytes, o + offDx + 4 * i);
                result.Add(dx);
            }
            if (type == 14) break;
            o += size;
        }
        return result;
    }

    static int Count(byte[] a, byte[] b)
    {
        int n = 0;
        for (int i = 0; i < a.Length; i += 4)
            if (a[i] != b[i] || a[i + 1] != b[i + 1] || a[i + 2] != b[i + 2]) n++;
        return n;
    }

    static LogFont Font(string face, int height, byte quality)
    {
        return new LogFont { h = height, weight = 400, cs = 1, face = face, q = quality };
    }

    static string F(int[] v) { return "[" + string.Join(",", v) + "]"; }

    /** Draws the `TxSizeSheet` layout; `recorded` null draws with TextOutW, otherwise ExtTextOutW with those advances. */
    static void Sheet(IntPtr dc, string face, byte quality, int[] sizes, List<int[]> recorded, List<int[]> directWidths)
    {
        SetBkMode(dc, 1); SetTextColor(dc, 0); SetTextAlign(dc, 24);
        int y = 3, line = 0;
        foreach (int s in sizes)
        {
            y += (int)(Math.Abs(s) * 1.05) + 1;
            var lf = Font(face, s, quality);
            IntPtr font = CreateFontIndirectW(ref lf);
            IntPtr old = SelectObject(dc, font);
            if (directWidths != null)
            {
                var w = new int[Sample.Length];
                for (int i = 0; i < w.Length; i++) { var one = new int[1]; GetCharWidth32W(dc, Sample[i], Sample[i], one); w[i] = one[0]; }
                directWidths.Add(w);
            }
            if (recorded == null) TextOutW(dc, 4, y, Sample, Sample.Length);
            else ExtTextOutW(dc, 4, y, 0, IntPtr.Zero, Sample, Sample.Length, recorded[line]);
            SelectObject(dc, old); DeleteObject(font);
            y += (int)(Math.Abs(s) * 0.3) + 2;
            line++;
        }
    }

    static int SheetHeight(int[] sizes)
    {
        int h = 6;
        foreach (int s in sizes) h += (int)(Math.Abs(s) * 1.35) + 3;
        return h;
    }

    public static void Run(string dir)
    {
        int[] sizes = { -8, -9, -10, -11, -12, -13, -14, -15, -16, -18, -20, -22, -24, -28, -32, -36, -48, -72 };
        int[] cellSizes = { 9, 10, 12, 14, 16, 18, 20, 23, 26, 30, 36, 44, 56 };
        var cases = new object[][] {
            new object[] { "textx-arial-q0-default", "Arial", (byte)0, sizes },
            new object[] { "textx-arial-q1-draft", "Arial", (byte)1, sizes },
            new object[] { "textx-arial-q2-proof", "Arial", (byte)2, sizes },
            new object[] { "textx-arial-cleartype", "Arial", (byte)5, sizes },
            new object[] { "textx-arial-ctnatural", "Arial", (byte)6, sizes },
            new object[] { "textx-segoeui-cell-mono", "Segoe UI", (byte)3, cellSizes },
        };
        var json = new StringBuilder("[");
        IntPtr screen = GetDC(IntPtr.Zero);
        try
        {
            foreach (var c in cases)
            {
                string name = (string)c[0], face = (string)c[1]; byte quality = (byte)c[2]; int[] sz = (int[])c[3];
                int h = SheetHeight(sz);
                string emf = Path.Combine(dir, name + ".emf");
                var recorded = RecordedAdvances(emf);
                var direct = new List<int[]>();
                var antialiased = new List<int[]>();
                using (var sq = new Surface(screen, 480, h)) { Sheet(sq.Dc, face, 3, sz, null, antialiased); }
                byte[] a, b, d, played;
                // The same direct drawing under a 1:1 MM_ANISOTROPIC mapping, as PlayEnhMetaFile sets up.
                using (var sd = new Surface(screen, 480, h)) { SetMapMode(sd.Dc, 8); SetWindowExtEx(sd.Dc, 480, h, IntPtr.Zero); SetViewportExtEx(sd.Dc, 480, h, IntPtr.Zero); Sheet(sd.Dc, face, quality, sz, null, null); d = sd.Pixels(); }
                using (var sa = new Surface(screen, 480, h)) { Sheet(sa.Dc, face, quality, sz, null, direct); a = sa.Pixels(); }
                using (var sb = new Surface(screen, 480, h)) { Sheet(sb.Dc, face, quality, sz, recorded, null); b = sb.Pixels(); }
                using (var sc = new Surface(screen, 480, h))
                {
                    IntPtr meta = GetEnhMetaFileW(emf);
                    var rect = new Rect { right = 480, bottom = h };
                    PlayEnhMetaFile(sc.Dc, meta, ref rect);
                    DeleteEnhMetaFile(meta);
                    played = sc.Pixels();
                }
                string reference = Path.Combine(dir, name + ".png");
                int vsRef = -1;
                using (var bmp = new Bitmap(reference))
                {
                    var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                    var refBytes = new byte[bmp.Width * bmp.Height * 4];
                    Marshal.Copy(data.Scan0, refBytes, 0, refBytes.Length);
                    bmp.UnlockBits(data);
                    if (bmp.Width == 480 && bmp.Height == h) vsRef = Count(a, refBytes);
                }
                int differing = 0, glyphs = 0, differingFromAntialiased = 0;
                for (int i = 0; i < direct.Count; i++) for (int j = 0; j < direct[i].Length; j++)
                {
                    glyphs++;
                    if (direct[i][j] != recorded[i][j]) differing++;
                    if (antialiased[i][j] != recorded[i][j]) differingFromAntialiased++;
                }
                if (json.Length > 1) json.Append(',');
                json.Append("{\"name\":\"").Append(name).Append("\",\"height\":").Append(h)
                    .Append(",\"directVsReferencePng\":").Append(vsRef)
                    .Append(",\"directVsPlayback\":").Append(Count(a, played))
                    .Append(",\"directAnisotropicVsPlayback\":").Append(Count(d, played))
                    .Append(",\"directVsDirectWithRecordedAdvances\":").Append(Count(a, b)).Append(",\"directWithRecordedAdvancesVsPlayback\":").Append(Count(b, played))
                    .Append(",\"glyphs\":").Append(glyphs).Append(",\"glyphsWhoseAdvanceDiffers\":").Append(differing).Append(",\"glyphsWhoseAdvanceDiffersFromAntialiasedWidths\":").Append(differingFromAntialiased)
                    .Append(",\"lines\":[");
                for (int i = 0; i < direct.Count; i++)
                {
                    if (i > 0) json.Append(',');
                    json.Append("{\"size\":").Append(sz[i]).Append(",\"direct\":").Append(F(direct[i])).Append(",\"recorded\":").Append(F(recorded[i])).Append('}');
                }
                json.Append("]}");
            }
        }
        finally { ReleaseDC(IntPtr.Zero, screen); }
        json.Append(']');
        File.WriteAllText(Path.Combine(dir, "text-recorded-advance.json"), json.ToString(), new UTF8Encoding(false));
    }
}
