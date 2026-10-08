// Which cell heights does a horizontal world-transform stretch re-grid-fit? (`text-stretch-hinting`)
//
// Native playback of a recorded GM_COMPATIBLE text record draws the text through diag(eyScale / exScale, 1)
// (about 1.000558 on a 3840 x 2160 display at 150%), and some faces answer a stretch that small by switching
// their grid-fitting off (`text-playback-hinting`: nine of the 57 Segoe UI cell heights). This probe measures the
// reaction without rasterising: for every face and every signed lfHeight from 8 to 72 it sets the world transform
// diag(sx, 1) (GM_ADVANCED) on a memory DC, asks GetGlyphOutline(GGO_NATIVE) for 23 glyphs and records, for each
// stretch in `steps`, whether the outlines differ from the unstretched ones (a 64-bit FNV-1a hash of the bytes).
// Output: text-stretch-hinting.json.gz, {steps, faces: [{face, heights: {"<lfHeight>": "<0/1 per step>"}}]}, and
// text-stretch-outlines.json (raw GGO_NATIVE words of a few Segoe UI glyphs, stretched and not).
// The step list is 1 + k * 1e-4 for k = -40..40 followed by the playback ratio of the committed recordings.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Text;

public static class StretchHintingProbe
{
    [StructLayout(LayoutKind.Sequential)] struct XForm { public float m11, m12, m21, m22, dx, dy; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct LogFont { public int h, w, esc, ori, weight; public byte it, ul, so, cs, op, cp, q, pf; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string face; }
    [StructLayout(LayoutKind.Sequential)] struct Fixed { public short fract; public short value; }
    [StructLayout(LayoutKind.Sequential)] struct Mat2 { public Fixed m11, m12, m21, m22; }
    [StructLayout(LayoutKind.Sequential)] struct GlyphMetrics { public uint bw, bh; public int ox, oy; public short cx, cy; }
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern int SetGraphicsMode(IntPtr dc, int mode);
    [DllImport("gdi32.dll")] static extern bool SetWorldTransform(IntPtr dc, ref XForm xform);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateFontIndirectW(ref LogFont lf);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern uint GetGlyphOutlineW(IntPtr dc, uint ch, uint fmt, out GlyphMetrics gm, uint size, byte[] buf, ref Mat2 m);

    const string Glyphs = "HnoemgaRSWAVtfi1kbuvsXx";

    static string Signature(IntPtr dc, string face, int h, float sx)
    {
        var xf = new XForm { m11 = sx, m22 = 1f };
        SetGraphicsMode(dc, 2);
        SetWorldTransform(dc, ref xf);
        var lf = new LogFont { h = h, weight = 400, cs = 1, face = face, q = 3 };
        IntPtr font = CreateFontIndirectW(ref lf);
        IntPtr old = SelectObject(dc, font);
        var one = new Fixed { value = 1 };
        var m = new Mat2 { m11 = one, m22 = one };
        ulong hash = 1469598103934665603UL;
        foreach (char c in Glyphs)
        {
            GlyphMetrics gm;
            uint size = GetGlyphOutlineW(dc, c, 2, out gm, 0, null, ref m);
            if (size == 0xffffffff) { hash = (hash ^ 0xff) * 1099511628211UL; continue; }
            var buf = new byte[size];
            GetGlyphOutlineW(dc, c, 2, out gm, size, buf, ref m);
            for (int i = 0; i < size; i++) { hash ^= buf[i]; hash *= 1099511628211UL; }
            hash = (hash ^ (ulong)(ushort)gm.cx) * 1099511628211UL;
        }
        SelectObject(dc, old); DeleteObject(font);
        return hash.ToString("x");
    }

    public static void Run(string dir)
    {
        string[] faces = {
            "Segoe UI", "Segoe UI Semibold", "Segoe UI Light", "Calibri", "Consolas", "Candara", "Corbel", "Constantia",
            "Arial", "Tahoma", "Times New Roman", "Courier New", "Verdana", "Georgia", "Trebuchet MS", "Lucida Console",
            "Microsoft Sans Serif", "Comic Sans MS",
        };
        var steps = new List<double>();
        for (int k = -40; k <= 40; k++) steps.Add(1.0 + k * 1e-4);
        steps.Add(1.00055838);
        IntPtr screen = GetDC(IntPtr.Zero);
        IntPtr dc = CreateCompatibleDC(screen);
        var json = new StringBuilder("{\"glyphs\":\"" + Glyphs + "\",\"steps\":[");
        for (int i = 0; i < steps.Count; i++) { if (i > 0) json.Append(','); json.Append(steps[i].ToString("R", CultureInfo.InvariantCulture)); }
        json.Append("],\"faces\":[");
        for (int f = 0; f < faces.Length; f++)
        {
            if (f > 0) json.Append(',');
            json.Append("{\"face\":\"").Append(faces[f]).Append("\",\"heights\":{");
            bool first = true;
            for (int sign = 1; sign >= -1; sign -= 2)
            {
                // Em heights are measured for the faces the playback sheets cover.
                if (sign < 0 && f > 3 && f != 8) continue;
                for (int h = 8; h <= 72; h++)
                {
                    int lfHeight = sign * h;
                    string baseline = Signature(dc, faces[f], lfHeight, 1f);
                    var bits = new StringBuilder();
                    foreach (double s in steps) bits.Append(Signature(dc, faces[f], lfHeight, (float)s) != baseline ? '1' : '0');
                    if (!first) json.Append(',');
                    first = false;
                    json.Append('"').Append(lfHeight).Append("\":\"").Append(bits).Append('"');
                }
            }
            json.Append("}}");
        }
        json.Append("]}");
        // A few raw GGO_NATIVE outlines (int32 words of the TTPOLYGONHEADER / TTPOLYCURVE stream) of Segoe UI at cell
        // heights that do (24, 40, 56) and do not (25, 33) react, unstretched and stretched, to pin the mechanism:
        // the stretched outline equals the unhinted one, which the interpreter reproduces when the font's
        // `prep` is told the glyph is stretched.
        var outlines = new StringBuilder("[");
        bool firstOutline = true;
        foreach (int lfHeight in new[] { 24, 25, 33, 40, 56 })
        foreach (double stretch in new[] { 1.0, 1.0002, 1.000558 })
        foreach (char c in "Hnog")
        {
            var xf = new XForm { m11 = (float)stretch, m22 = 1f };
            SetGraphicsMode(dc, 2);
            SetWorldTransform(dc, ref xf);
            var lf = new LogFont { h = lfHeight, weight = 400, cs = 1, face = "Segoe UI", q = 3 };
            IntPtr font = CreateFontIndirectW(ref lf);
            IntPtr old = SelectObject(dc, font);
            var one = new Fixed { value = 1 };
            var m = new Mat2 { m11 = one, m22 = one };
            GlyphMetrics gm;
            uint size = GetGlyphOutlineW(dc, c, 2, out gm, 0, null, ref m);
            var buf = new byte[size];
            GetGlyphOutlineW(dc, c, 2, out gm, size, buf, ref m);
            SelectObject(dc, old); DeleteObject(font);
            if (!firstOutline) outlines.Append(',');
            firstOutline = false;
            outlines.Append("{\"face\":\"Segoe UI\",\"lfHeight\":").Append(lfHeight).Append(",\"stretch\":").Append(stretch.ToString("R", CultureInfo.InvariantCulture))
                .Append(",\"glyph\":\"").Append(c).Append("\",\"advance\":").Append(gm.cx).Append(",\"words\":[");
            for (int i = 0; i < size; i += 4) { if (i > 0) outlines.Append(','); outlines.Append(BitConverter.ToInt32(buf, i)); }
            outlines.Append("]}");
        }
        outlines.Append(']');
        File.WriteAllText(Path.Combine(dir, "text-stretch-outlines.json"), outlines.ToString(), new UTF8Encoding(false));
        DeleteDC(dc);
        using (var file = File.Create(Path.Combine(dir, "text-stretch-hinting.json.gz")))
        using (var gz = new GZipStream(file, CompressionLevel.Optimal))
        {
            var bytes = new UTF8Encoding(false).GetBytes(json.ToString());
            gz.Write(bytes, 0, bytes.Length);
        }
    }
}
