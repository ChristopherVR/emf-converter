// tmAscent / tmDescent of a font realised with a rotation (`text-rotated-metrics`): TA_TOP and TA_BOTTOM place rotated text
// by them. For Arial, Times New Roman, Tahoma, Courier New and Segoe UI at lfHeight -8 to -60 and lfEscapement 0, 90, 180,
// 270, 25, 45, 160 and 300 degrees (GM_ADVANCED, lfOrientation equal to lfEscapement) GetTextMetrics is read.
// Output: rotated-text-metrics.json.gz, [{face, h, deg, asc, desc, height, il}].
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class RotatedMetricsProbe
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct LogFont { public int h, w, esc, ori, weight; public byte it, ul, so, cs, op, cp, q, pf; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string face; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct TextMetric { public int height, ascent, descent, internalLeading, externalLeading, aveCharWidth, maxCharWidth, weight, overhang, dax, day; public ushort firstChar, lastChar, defaultChar, breakChar; public byte italic, underlined, struckOut, pitchAndFamily, charSet; }
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr w);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
    [DllImport("gdi32.dll")] static extern int SetGraphicsMode(IntPtr dc, int m);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateFontIndirectW(ref LogFont lf);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool GetTextMetricsW(IntPtr dc, out TextMetric tm);

    public static void Run(string dir)
    {
        var json = new StringBuilder("[");
        bool first = true;
        IntPtr dc = CreateCompatibleDC(GetDC(IntPtr.Zero));
        SetGraphicsMode(dc, 2);
        foreach (string face in new[] { "Arial", "Times New Roman", "Tahoma", "Courier New", "Segoe UI" })
        for (int h = 8; h <= 60; h++)
        foreach (int deg in new[] { 0, 90, 180, 270, 25, 45, 160, 300 })
        {
            var lf = new LogFont { h = -h, weight = 400, cs = 1, face = face, q = 3, esc = deg * 10, ori = deg * 10 };
            IntPtr f = CreateFontIndirectW(ref lf);
            IntPtr old = SelectObject(dc, f);
            TextMetric tm;
            GetTextMetricsW(dc, out tm);
            if (!first) json.Append(',');
            first = false;
            json.Append("{\"face\":\"" + face + "\",\"h\":" + (-h) + ",\"deg\":" + deg + ",\"asc\":" + tm.ascent + ",\"desc\":" + tm.descent + ",\"height\":" + tm.height + ",\"il\":" + tm.internalLeading + "}");
            SelectObject(dc, old);
            DeleteObject(f);
        }
        DeleteDC(dc);
        byte[] bytes = new UTF8Encoding(false).GetBytes(json.Append(']').ToString());
        using (var file = File.Create(Path.Combine(dir, "rotated-text-metrics.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress))
            zip.Write(bytes, 0, bytes.Length);
    }
}
