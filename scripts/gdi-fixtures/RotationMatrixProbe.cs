// The scaling matrix GDI applies to a rotated glyph, read off private fonts whose points sit far from the origin
// (`text-rotation-matrix`, build-rotation-matrix-font.py). For each font variant, ppem and angle it reads
// GetGlyphOutline(GGO_NATIVE) of a glyph under (a) a GM_ADVANCED world rotation and (b) lfEscapement = lfOrientation,
// and stores the outline points in 1/64 pixel. Output: rotation-matrix.json.gz,
// [{variant, mode, ppem, degrees, glyph, step, points: [[x, y], ...]}], where `points` holds every `step`-th point of
// the glyph (always the first and the last). Environment: ROT_SIZES (comma list for the axisint font), ROT_STEP (degrees),
// ROT_VARIANTS (comma list of variants to run), ROT_ALL_POINTS=1 (every point).
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

public static class RotationMatrixProbe
{
    [StructLayout(LayoutKind.Sequential)] struct Fixed { public ushort fract; public short value; }
    [StructLayout(LayoutKind.Sequential)] struct Mat { public Fixed xx, xy, yx, yy; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct Metrics { public uint blackX, blackY; public Point origin; public short incX, incY; }
    [StructLayout(LayoutKind.Sequential)] struct XForm { public float m11, m12, m21, m22, dx, dy; }
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern int AddFontResourceEx(string file, uint flags, IntPtr reserved);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool RemoveFontResourceEx(string file, uint flags, IntPtr reserved);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateFont(int height, int width, int escape, int orientation, int weight, uint italic, uint underline, uint strike, uint charset, uint outprec, uint clipprec, uint quality, uint pitch, string face);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
    [DllImport("gdi32.dll")] static extern int SetGraphicsMode(IntPtr dc, int mode);
    [DllImport("gdi32.dll")] static extern bool SetWorldTransform(IntPtr dc, ref XForm xform);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern int GetTextFace(IntPtr dc, int n, StringBuilder face);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern uint GetGlyphOutline(IntPtr dc, uint ch, uint format, out Metrics gm, uint len, byte[] buf, ref Mat mat);

    class Job { public string variant; public uint glyph; public int[] sizes; public int every; }

    /// <summary>The points of a GGO_NATIVE buffer in 1/64 pixel (the FIXED words are 26.6 values scaled by 1024).</summary>
    static List<int[]> Points(byte[] d)
    {
        var points = new List<int[]>();
        int i = 0;
        while (i + 16 <= d.Length)
        {
            int cb = BitConverter.ToInt32(d, i);
            int end = i + cb;
            points.Add(new[] { BitConverter.ToInt32(d, i + 8) / 1024, BitConverter.ToInt32(d, i + 12) / 1024 });
            i += 16;
            while (i < end)
            {
                int n = BitConverter.ToUInt16(d, i + 2);
                i += 4;
                for (int k = 0; k < n; k++, i += 8)
                    points.Add(new[] { BitConverter.ToInt32(d, i) / 1024, BitConverter.ToInt32(d, i + 4) / 1024 });
            }
        }
        return points;
    }

    public static void Run(string dir)
    {
        var json = new StringBuilder("[");
        int[] sizes = (Environment.GetEnvironmentVariable("ROT_SIZES") ?? "9,10,11,12,13,14,15,16,17,18,19,20,24,28,32,36,40,44,48").Split(',').Select(int.Parse).ToArray();
        int step = int.Parse(Environment.GetEnvironmentVariable("ROT_STEP") ?? "5");
        string only = Environment.GetEnvironmentVariable("ROT_VARIANTS");
        bool all = Environment.GetEnvironmentVariable("ROT_ALL_POINTS") == "1";
        // variant -> (glyph to read, sizes, every n-th point). axisint: points 1700 to 1938 units along the x axis of a
        // 2048-unit em with head.flags bit 3; plain: a 64-unit em without the flag and points 468 em away.
        var jobs = new[]
        {
            new Job { variant = "axisint", glyph = 4, sizes = sizes, every = 8 },
            new Job { variant = "plain", glyph = 0, sizes = new[] { 20, 28 }, every = 1 },
        };
        foreach (var job in jobs)
        {
            if (only != null && !only.Split(',').Contains(job.variant)) continue;
            string path = Path.Combine(dir, "rotation-matrix-" + job.variant + ".ttf");
            string family = "Parity Rotation Matrix " + job.variant;
            if (AddFontResourceEx(path, 16, IntPtr.Zero) == 0) throw new Exception("Private font load failed: " + path);
            IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
            try
            {
                foreach (string mode in new[] { "world", "escapement" })
                foreach (int size in job.sizes)
                for (int deg = 0; deg < 360; deg += step)
                {
                    IntPtr font;
                    SetGraphicsMode(dc, 2);
                    if (mode == "world")
                    {
                        double rad = deg * Math.PI / 180.0;
                        var xf = new XForm { m11 = (float)Math.Cos(rad), m12 = (float)Math.Sin(rad), m21 = -(float)Math.Sin(rad), m22 = (float)Math.Cos(rad) };
                        SetWorldTransform(dc, ref xf);
                        font = CreateFont(-size, 0, 0, 0, 400, 0, 0, 0, 1, 4, 0, 0, 0, family);
                    }
                    else
                    {
                        var identity = new XForm { m11 = 1, m22 = 1 };
                        SetWorldTransform(dc, ref identity);
                        font = CreateFont(-size, 0, deg * 10, deg * 10, 400, 0, 0, 0, 1, 4, 0, 0, 0, family);
                    }
                    IntPtr old = SelectObject(dc, font);
                    var face = new StringBuilder(100);
                    GetTextFace(dc, 100, face);
                    if (face.ToString() != family) throw new Exception("Font fallback: " + face);
                    var m = new Mat();
                    m.xx.value = m.yy.value = 1;
                    Metrics gm;
                    uint len = GetGlyphOutline(dc, 0xE000 + job.glyph, 2, out gm, 0, null, ref m);
                    if (len != 0xFFFFFFFF)
                    {
                        var data = new byte[len];
                        GetGlyphOutline(dc, 0xE000 + job.glyph, 2, out gm, len, data, ref m);
                        var points = Points(data);
                        int every = all ? 1 : job.every;
                        if (json.Length > 1) json.Append(',');
                        json.Append("{\"variant\":\"").Append(job.variant).Append("\",\"mode\":\"").Append(mode).Append("\",\"ppem\":").Append(size)
                            .Append(",\"degrees\":").Append(deg).Append(",\"glyph\":").Append(job.glyph).Append(",\"step\":").Append(every).Append(",\"points\":[");
                        bool firstPoint = true;
                        for (int k = 0; k < points.Count; k++)
                        {
                            if (k % every != 0 && k != points.Count - 1) continue;
                            if (!firstPoint) json.Append(',');
                            firstPoint = false;
                            json.Append('[').Append(points[k][0]).Append(',').Append(points[k][1]).Append(']');
                        }
                        json.Append("]}");
                    }
                    SelectObject(dc, old);
                    DeleteObject(font);
                }
            }
            finally
            {
                DeleteDC(dc);
                RemoveFontResourceEx(path, 16, IntPtr.Zero);
            }
        }
        byte[] bytes = new UTF8Encoding(false).GetBytes(json.Append(']').ToString());
        using (var file = File.Create(Path.Combine(dir, "rotation-matrix.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress))
            zip.Write(bytes, 0, bytes.Length);
    }
}
