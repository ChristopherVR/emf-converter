// How does GDI scale a rotated glyph? (`text-rotated-matrix`)
//
// For faces, sizes and angles it sets a rotation as the world transform (GM_ADVANCED), selects a 400-weight
// non-antialiased font of the given em height and asks GetGlyphOutline(GGO_NATIVE) for four glyphs. The returned
// outlines are the rotated, scaled outlines in 1/64 pixel (a TTPOLYGONHEADER / TTPOLYCURVE stream, written as int32
// words); a least-squares fit of the matrix that maps the font-unit outline onto them gives the scaling matrix GDI
// really applies. Output: rotated-glyph-matrix.json.gz, [{face, lfHeight, degrees, glyph, advance, words}].
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Text;

public static class RotatedGlyphMatrixProbe
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

    public static void Run(string dir)
    {
        var configs = new List<object[]>();
        foreach (int h in new[] { -12, -16, -20, -24, -32, -48 })
            foreach (int deg in new[] { 10, 25, 45, 60, 80 })
                configs.Add(new object[] { "Arial", h, deg });
        foreach (string face in new[] { "Times New Roman", "Tahoma", "Segoe UI" })
            foreach (int h in new[] { -16, -20, -28 })
                foreach (int deg in new[] { 25, 60 })
                    configs.Add(new object[] { face, h, deg });
        IntPtr screen = GetDC(IntPtr.Zero);
        IntPtr dc = CreateCompatibleDC(screen);
        var json = new StringBuilder("[");
        bool first = true;
        foreach (var cfg in configs)
        {
            string face = (string)cfg[0]; int h = (int)cfg[1]; int deg = (int)cfg[2];
            double rad = deg * Math.PI / 180.0;
            var xf = new XForm { m11 = (float)Math.Cos(rad), m12 = (float)Math.Sin(rad), m21 = -(float)Math.Sin(rad), m22 = (float)Math.Cos(rad) };
            SetGraphicsMode(dc, 2);
            SetWorldTransform(dc, ref xf);
            var lf = new LogFont { h = h, weight = 400, cs = 1, face = face, q = 3 };
            IntPtr font = CreateFontIndirectW(ref lf);
            IntPtr old = SelectObject(dc, font);
            var one = new Fixed { value = 1 };
            var m = new Mat2 { m11 = one, m22 = one };
            foreach (char c in "Hoae")
            {
                GlyphMetrics gm;
                uint size = GetGlyphOutlineW(dc, c, 2, out gm, 0, null, ref m);
                var buf = new byte[size];
                GetGlyphOutlineW(dc, c, 2, out gm, size, buf, ref m);
                if (!first) json.Append(',');
                first = false;
                json.Append("{\"face\":\"").Append(face).Append("\",\"lfHeight\":").Append(h).Append(",\"degrees\":").Append(deg)
                    .Append(",\"glyph\":\"").Append(c).Append("\",\"advance\":").Append(gm.cx).Append(",\"words\":[");
                for (int i = 0; i < size; i += 4) { if (i > 0) json.Append(','); json.Append(BitConverter.ToInt32(buf, i)); }
                json.Append("]}");
            }
            SelectObject(dc, old); DeleteObject(font);
        }
        json.Append(']');
        DeleteDC(dc);
        using (var file = File.Create(Path.Combine(dir, "rotated-glyph-matrix.json.gz")))
        using (var gz = new GZipStream(file, CompressionLevel.Optimal))
        {
            var bytes = new UTF8Encoding(false).GetBytes(json.ToString());
            gz.Write(bytes, 0, bytes.Length);
        }
    }
}
