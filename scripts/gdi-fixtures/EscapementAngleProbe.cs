// The rotation GDI applies for lfEscapement, read at every tenth of a degree (`escapement-angles`): the private font
// `rotation-matrix-plain.ttf` (64 units per em, no head.flags bit 3, glyph E000 = (0,0), (30000,0), (0,30000), 468 em out)
// is selected at 64 pixels with lfEscapement = lfOrientation = tenths, so GetGlyphOutline(GGO_NATIVE) shows the image of the
// two unit vectors to a relative 5e-7 (1/64 pixel over 30,000 pixels). Output: escapement-angles.json.gz,
// [{tenths, mode, points: [[x, y], ...]}] in 1/64 pixel; `mode` is "escapement" or "world" (a GM_ADVANCED world rotation
// by the same angle with float elements, for comparison).
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class EscapementAngleProbe
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
        int size = int.Parse(Environment.GetEnvironmentVariable("ESC_SIZE") ?? "64");
        int step = int.Parse(Environment.GetEnvironmentVariable("ESC_STEP") ?? "1");
        string path = Path.Combine(dir, "rotation-matrix-plain.ttf");
        string family = "Parity Rotation Matrix plain";
        if (AddFontResourceEx(path, 16, IntPtr.Zero) == 0) throw new Exception("Private font load failed: " + path);
        IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
        var json = new StringBuilder("[");
        try
        {
            foreach (string mode in new[] { "escapement", "world" })
            for (int tenths = 0; tenths < 3600; tenths += step)
            {
                IntPtr font;
                SetGraphicsMode(dc, 2);
                if (mode == "world")
                {
                    double rad = tenths / 10.0 * Math.PI / 180.0;
                    var xf = new XForm { m11 = (float)Math.Cos(rad), m12 = (float)Math.Sin(rad), m21 = -(float)Math.Sin(rad), m22 = (float)Math.Cos(rad) };
                    SetWorldTransform(dc, ref xf);
                    font = CreateFont(-size, 0, 0, 0, 400, 0, 0, 0, 1, 4, 0, 0, 0, family);
                }
                else
                {
                    var identity = new XForm { m11 = 1, m22 = 1 };
                    SetWorldTransform(dc, ref identity);
                    font = CreateFont(-size, 0, tenths, tenths, 400, 0, 0, 0, 1, 4, 0, 0, 0, family);
                }
                IntPtr old = SelectObject(dc, font);
                var face = new StringBuilder(100);
                GetTextFace(dc, 100, face);
                if (face.ToString() != family) throw new Exception("Font fallback: " + face);
                var m = new Mat();
                m.xx.value = m.yy.value = 1;
                Metrics gm;
                uint len = GetGlyphOutline(dc, 0xE000, 2, out gm, 0, null, ref m);
                if (len != 0xFFFFFFFF)
                {
                    var data = new byte[len];
                    GetGlyphOutline(dc, 0xE000, 2, out gm, len, data, ref m);
                    var points = Points(data);
                    if (json.Length > 1) json.Append(',');
                    json.Append("{\"tenths\":").Append(tenths).Append(",\"mode\":\"").Append(mode).Append("\",\"points\":[");
                    for (int k = 0; k < points.Count; k++)
                    {
                        if (k > 0) json.Append(',');
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
        byte[] bytes = new UTF8Encoding(false).GetBytes(json.Append(']').ToString());
        using (var file = File.Create(Path.Combine(dir, "escapement-angles.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress))
            zip.Write(bytes, 0, bytes.Length);
    }
}
