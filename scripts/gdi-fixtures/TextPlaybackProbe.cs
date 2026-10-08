// Why does native playback of a recorded text sheet differ from the same text drawn directly, in glyph shape
// and not in advance? (`textx-segoeui-cell-mono`: 989 pixels at the 36 and 56 cell-height lines.)
//
// For each face, height sign and quality this draws one sheet, a line per height with `TextOutW`, three ways:
//   - recorded into a metafile DC (`<name>.emf`, the dx array Windows stores comes from the recording DC),
//   - painted straight onto a 32bpp DIB (`<name>.direct.png`), and
//   - the recording played back onto an identical DIB (`<name>.png`).
// `text-playback-hinting.json` lists, per sheet and height, the pixels that differ between the direct drawing and
// the playback. The mechanism: a GM_COMPATIBLE EMR_EXTTEXTOUTW stores exScale and eyScale (hundredths of a
// millimetre per device pixel, 23.3203125 and 23.33333 here), and playback draws the text through the world
// transform diag(eyScale / exScale, 1) (1.000558 here). The probe re-draws the Segoe UI cell sheet glyph by
// glyph under that transform ("stretched") and counts the pixels that still differ from playback, then sweeps
// the horizontal factor from 1 + 5e-6 upward and records, per height, the first factor that changes the
// drawing: Segoe UI hints a cell height differently once that factor passes a height-specific threshold, which
// is why only some heights differ. The committed `textx-segoeui-cell-mono` pair is re-drawn the same way.
// Output files are committed captures; see the README.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class TextPlaybackProbe
{
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] struct XForm { public float m11, m12, m21, m22, dx, dy; }
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
    [DllImport("gdi32.dll")] static extern int SetGraphicsMode(IntPtr dc, int mode);
    [DllImport("gdi32.dll")] static extern bool SetWorldTransform(IntPtr dc, ref XForm xform);
    [DllImport("gdi32.dll")] static extern int GetDeviceCaps(IntPtr dc, int index);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateFontIndirectW(ref LogFont lf);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool TextOutW(IntPtr dc, int x, int y, string s, int n);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool ExtTextOutW(IntPtr dc, int x, int y, uint options, IntPtr rect, string s, int n, int[] dx);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateEnhMetaFileW(IntPtr dc, string file, ref Rect frame, string desc);
    [DllImport("gdi32.dll")] static extern IntPtr CloseEnhMetaFile(IntPtr dc);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetEnhMetaFileW(string file);
    [DllImport("gdi32.dll")] static extern bool PlayEnhMetaFile(IntPtr dc, IntPtr metafile, ref Rect rect);
    [DllImport("gdi32.dll")] static extern bool DeleteEnhMetaFile(IntPtr metafile);

    const string Sample = "Hamburgefonstiv AVWX";
    const int Width = 720;

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

    static void SavePng(string path, byte[] px, int w, int h)
    {
        using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
        {
            var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            var copy = (byte[])px.Clone();
            for (int i = 3; i < copy.Length; i += 4) copy[i] = 255;
            Marshal.Copy(copy, 0, data.Scan0, copy.Length);
            bmp.UnlockBits(data);
            bmp.Save(path, ImageFormat.Png);
        }
    }

    /** dx arrays of every EMR_EXTTEXTOUTW record, in order, and the exScale / eyScale of the first. */
    static List<int[]> RecordedAdvances(string emf, out float exScale, out float eyScale)
    {
        var bytes = File.ReadAllBytes(emf);
        var result = new List<int[]>();
        exScale = eyScale = 0;
        for (int o = 0; o < bytes.Length;)
        {
            int type = BitConverter.ToInt32(bytes, o), size = BitConverter.ToInt32(bytes, o + 4);
            if (type == 84)
            {
                if (result.Count == 0) { exScale = BitConverter.ToSingle(bytes, o + 28); eyScale = BitConverter.ToSingle(bytes, o + 32); }
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

    static int Count(byte[] a, byte[] b, int w, int y0, int y1)
    {
        int n = 0;
        for (int y = Math.Max(0, y0); y <= y1; y++) for (int x = 0; x < w; x++)
        {
            int k = (y * w + x) * 4;
            if (a[k] != b[k] || a[k + 1] != b[k + 1] || a[k + 2] != b[k + 2]) n++;
        }
        return n;
    }

    static int LineHeight(int size) { return (int)(Math.Abs(size) * 1.35) + 3; }
    static int Top(int baseline, int size) { return baseline - (int)(Math.Abs(size) * 1.05) - 1; }
    static int Bottom(int baseline, int size, int height) { return Math.Min(height - 1, baseline + (int)(Math.Abs(size) * 0.3) + 2); }

    /** Draws every line of the sheet; `ys` receives each line's baseline. */
    static void Sheet(IntPtr dc, string face, byte quality, int[] heights, int[] ys)
    {
        SetBkMode(dc, 1); SetTextColor(dc, 0); SetTextAlign(dc, 24);
        int y = 3, line = 0;
        foreach (int s in heights)
        {
            y += (int)(Math.Abs(s) * 1.05) + 1;
            var lf = new LogFont { h = s, weight = 400, cs = 1, face = face, q = quality };
            IntPtr font = CreateFontIndirectW(ref lf);
            IntPtr old = SelectObject(dc, font);
            TextOutW(dc, 4, y, Sample, Sample.Length);
            SelectObject(dc, old); DeleteObject(font);
            ys[line++] = y;
            y += (int)(Math.Abs(s) * 0.3) + 2;
        }
    }

    /**
     * The same sheet drawn glyph by glyph at the recorded advances under the world transform diag(sx, 1) in
     * GM_ADVANCED. `layout` gives each line's baseline (null: computed as `Sheet` does).
     */
    static byte[] Stretched(IntPtr screen, int w, int h, string face, byte quality, string text, int x0, int[] heights, List<int[]> dxs, float sx, int[] ys)
    {
        using (var s = new Surface(screen, w, h))
        {
            SetBkMode(s.Dc, 1); SetTextColor(s.Dc, 0); SetTextAlign(s.Dc, 24);
            SetGraphicsMode(s.Dc, 2);
            var xf = new XForm { m11 = sx, m22 = 1f };
            SetWorldTransform(s.Dc, ref xf);
            int y = 3, line = 0;
            foreach (int size in heights)
            {
                y += (int)(Math.Abs(size) * 1.05) + 1;
                var lf = new LogFont { h = size, weight = 400, cs = 1, face = face, q = quality };
                IntPtr font = CreateFontIndirectW(ref lf);
                IntPtr old = SelectObject(s.Dc, font);
                int pen = x0;
                for (int i = 0; i < text.Length; i++) { ExtTextOutW(s.Dc, pen, y, 0, IntPtr.Zero, text.Substring(i, 1), 1, null); pen += dxs[line][i]; }
                SelectObject(s.Dc, old); DeleteObject(font);
                ys[line++] = y;
                y += (int)(Math.Abs(size) * 0.3) + 2;
            }
            return s.Pixels();
        }
    }

    static string Floats(float v) { return v.ToString("R", CultureInfo.InvariantCulture); }

    public static void Run(string dir)
    {
        var sheets = new List<object[]> {
            new object[] { "Segoe UI", "segoeui", 1, (byte)3 }, new object[] { "Segoe UI", "segoeui", -1, (byte)3 },
            new object[] { "Segoe UI", "segoeui", 1, (byte)4 },
            new object[] { "Arial", "arial", 1, (byte)3 }, new object[] { "Tahoma", "tahoma", 1, (byte)3 },
            new object[] { "Times New Roman", "times", 1, (byte)3 }, new object[] { "Courier New", "cour", 1, (byte)3 },
        };
        var json = new StringBuilder("{\"sheets\":[");
        IntPtr screen = GetDC(IntPtr.Zero);
        try
        {
            double mx = GetDeviceCaps(screen, 4) * 100.0 / GetDeviceCaps(screen, 8), my = GetDeviceCaps(screen, 6) * 100.0 / GetDeviceCaps(screen, 10);
            bool firstSheet = true;
            foreach (var sheet in sheets)
            {
                string face = (string)sheet[0], tag = (string)sheet[1]; int sign = (int)sheet[2]; byte q = (byte)sheet[3];
                var heights = new List<int>();
                for (int s = 8; s <= 64; s++) heights.Add(sign * s);
                int height = 6; foreach (int s in heights) height += LineHeight(s);
                string name = "textpb-" + tag + (sign > 0 ? "-cell" : "-em") + "-q" + q;
                var frame = new Rect { right = (int)Math.Round(Width * mx), bottom = (int)Math.Round(height * my) };
                var ys = new int[heights.Count];
                string emfPath = Path.Combine(dir, name + ".emf");
                IntPtr mdc = CreateEnhMetaFileW(screen, emfPath, ref frame, null);
                Sheet(mdc, face, q, heights.ToArray(), ys);
                IntPtr meta = CloseEnhMetaFile(mdc);
                byte[] direct, played;
                using (var d = new Surface(screen, Width, height)) { Sheet(d.Dc, face, q, heights.ToArray(), ys); direct = d.Pixels(); }
                using (var p = new Surface(screen, Width, height))
                {
                    var rect = new Rect { right = Width, bottom = height };
                    PlayEnhMetaFile(p.Dc, meta, ref rect);
                    played = p.Pixels();
                }
                DeleteEnhMetaFile(meta);
                SavePng(Path.Combine(dir, name + ".direct.png"), direct, Width, height);
                SavePng(Path.Combine(dir, name + ".png"), played, Width, height);

                // The stretched re-drawing and the threshold sweep, for the Segoe UI cell sheets.
                float exScale, eyScale;
                var dxs = RecordedAdvances(emfPath, out exScale, out eyScale);
                float ratio = eyScale / exScale;
                int[] stretchedDiff = null, firstChange = null;
                if (sign > 0 && face == "Segoe UI")
                {
                    var arr = heights.ToArray();
                    var ys2 = new int[arr.Length];
                    var px = Stretched(screen, Width, height, face, q, Sample, 4, arr, dxs, ratio, ys2);
                    stretchedDiff = new int[arr.Length];
                    for (int i = 0; i < arr.Length; i++) stretchedDiff[i] = Count(px, played, Width, Top(ys[i], arr[i]), Bottom(ys[i], arr[i], height));
                    if (q == 3)
                    {
                        var baseline = Stretched(screen, Width, height, face, q, Sample, 4, arr, dxs, 1f, ys2);
                        firstChange = new int[arr.Length];
                        for (int k = 1; k <= 400; k++)
                        {
                            float f = (float)(1.0 + k * 5e-6);
                            var swept = Stretched(screen, Width, height, face, q, Sample, 4, arr, dxs, f, ys2);
                            for (int i = 0; i < arr.Length; i++)
                                if (firstChange[i] == 0 && Count(swept, baseline, Width, Top(ys[i], arr[i]), Bottom(ys[i], arr[i], height)) > 0) firstChange[i] = k;
                        }
                    }
                }
                if (!firstSheet) json.Append(',');
                firstSheet = false;
                json.Append("{\"name\":\"").Append(name).Append("\",\"face\":\"").Append(face).Append("\",\"quality\":").Append(q).Append(",\"width\":").Append(Width).Append(",\"height\":").Append(height)
                    .Append(",\"exScale\":").Append(Floats(exScale)).Append(",\"eyScale\":").Append(Floats(eyScale)).Append(",\"stretch\":").Append(Floats(ratio)).Append(",\"lines\":[");
                for (int i = 0; i < heights.Count; i++)
                {
                    int diff = Count(direct, played, Width, Top(ys[i], heights[i]), Bottom(ys[i], heights[i], height));
                    if (i > 0) json.Append(',');
                    json.Append("{\"height\":").Append(heights[i]).Append(",\"baseline\":").Append(ys[i]).Append(",\"differing\":").Append(diff);
                    if (stretchedDiff != null) json.Append(",\"stretchedDiffering\":").Append(stretchedDiff[i]);
                    if (firstChange != null) json.Append(",\"firstChangeMicro\":").Append(firstChange[i] * 5);
                    json.Append('}');
                }
                json.Append("]}");
            }
            json.Append("],\"original\":");
            json.Append(Original(dir, screen));
            json.Append('}');
        }
        finally { ReleaseDC(IntPtr.Zero, screen); }
        File.WriteAllText(Path.Combine(dir, "text-playback-hinting.json"), json.ToString(), new UTF8Encoding(false));
    }

    /** The committed `textx-segoeui-cell-mono` recording (read from `dir`), drawn directly, stretched and played back. */
    static string Original(string dir, IntPtr screen)
    {
        string emf = Path.Combine(dir, "textx-segoeui-cell-mono.emf");
        if (!File.Exists(emf)) return "null";
        const string text = "Hamburgefonstiv 0123 AVWX &@%$";
        int[] sizes = { 9, 10, 12, 14, 16, 18, 20, 23, 26, 30, 36, 44, 56 };
        int h = 6; foreach (int s in sizes) h += (int)(s * 1.35) + 3;
        float exScale, eyScale;
        var dxs = RecordedAdvances(emf, out exScale, out eyScale);
        byte[] played, direct, stretched;
        using (var sc = new Surface(screen, 480, h))
        {
            IntPtr meta = GetEnhMetaFileW(emf);
            var rect = new Rect { right = 480, bottom = h };
            PlayEnhMetaFile(sc.Dc, meta, ref rect);
            DeleteEnhMetaFile(meta);
            played = sc.Pixels();
        }
        var ys = new int[sizes.Length];
        direct = Stretched(screen, 480, h, "Segoe UI", 3, text, 4, sizes, dxs, 1f, ys);
        stretched = Stretched(screen, 480, h, "Segoe UI", 3, text, 4, sizes, dxs, eyScale / exScale, ys);
        return "{\"width\":480,\"height\":" + h + ",\"directVsPlayback\":" + Count(direct, played, 480, 0, h - 1) + ",\"stretchedVsPlayback\":" + Count(stretched, played, 480, 0, h - 1) + "}";
    }
}
