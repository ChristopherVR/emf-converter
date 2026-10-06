// Public WidenPath/GetPath controls; no native implementation is inspected.
// Dashed geometric pens (stock dash styles and a user style) under unequal axis scales: the widened outline's points
// at native FIX precision, for straight polylines in three directions.
using System;
using System.IO;
using System.Text;
using System.Globalization;
using System.Runtime.InteropServices;

public static class DashedAnisotropicPenProbe
{
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct Brush { public uint style, color; public IntPtr hatch; }
    [StructLayout(LayoutKind.Sequential)] struct Matrix { public float a, b, c, d, x, y; }
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern int SetGraphicsMode(IntPtr dc, int mode);
    [DllImport("gdi32.dll")] static extern bool SetWorldTransform(IntPtr dc, ref Matrix matrix);
    [DllImport("gdi32.dll")] static extern IntPtr ExtCreatePen(uint style, uint width, ref Brush brush, uint count, uint[] styles);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool BeginPath(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool EndPath(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool Polyline(IntPtr dc, Point[] points, int count);
    [DllImport("gdi32.dll")] static extern bool WidenPath(IntPtr dc);
    [DllImport("gdi32.dll")] static extern int GetPath(IntPtr dc, [Out] Point[] points, [Out] byte[] types, int count);

    static readonly uint[] UserStyle = { 6, 3, 2, 3 };

    static Point[] Source(int shape)
    {
        var start = new Point { x = 10, y = 10 };
        if (shape == 0) return new[] { start, new Point { x = 70, y = 10 } };
        if (shape == 1) return new[] { start, new Point { x = 10, y = 70 } };
        return new[] { start, new Point { x = 60, y = 40 } };
    }

    public static void Run(string dir)
    {
        IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
        if (dc == IntPtr.Zero || SetGraphicsMode(dc, 2) == 0) throw new Exception("CreateCompatibleDC/SetGraphicsMode failed");
        var json = new StringBuilder("[");
        try {
            foreach (int width in new[] { 2, 4, 8 })
            foreach (float sx in new[] { .5f, 1f, 2f, 4f })
            foreach (float sy in new[] { .5f, 1f, 2f, 4f })
            foreach (int style in new[] { 1, 2, 3, 4, 7 })
            for (int cap = 0; cap < 3; cap++) for (int shape = 0; shape < 3; shape++) {
                var matrix = new Matrix { a = sx, d = sy };
                if (!SetWorldTransform(dc, ref matrix)) throw new Exception("SetWorldTransform failed");
                var brush = new Brush();
                uint flags = (uint)(0x10000 | cap * 0x100 | style);
                IntPtr pen = style == 7
                    ? ExtCreatePen(flags, (uint)width, ref brush, (uint)UserStyle.Length, UserStyle)
                    : ExtCreatePen(flags, (uint)width, ref brush, 0, null);
                if (pen == IntPtr.Zero) throw new Exception("ExtCreatePen failed");
                IntPtr old = SelectObject(dc, pen);
                try {
                    var source = Source(shape);
                    if (!BeginPath(dc) || !Polyline(dc, source, source.Length) || !EndPath(dc) || !WidenPath(dc))
                        throw new Exception("WidenPath failed");
                    // GetPath returns logical integers. A 1/16 transform reads the already widened device path at native FIX
                    // precision.
                    matrix = new Matrix { a = 1f / 16, d = 1f / 16 };
                    if (!SetWorldTransform(dc, ref matrix)) throw new Exception("SetWorldTransform failed");
                    int n = GetPath(dc, null, null, 0);
                    if (n < 0) throw new Exception("GetPath failed");
                    var points = new Point[n]; var types = new byte[n];
                    if (GetPath(dc, points, types, n) != n) throw new Exception("GetPath failed");
                    if (json.Length > 1) json.Append(',');
                    json.Append("{\"w\":").Append(width).Append(",\"sx\":").Append(sx.ToString(CultureInfo.InvariantCulture))
                        .Append(",\"sy\":").Append(sy.ToString(CultureInfo.InvariantCulture))
                        .Append(",\"cap\":").Append(cap).Append(",\"style\":").Append(style).Append(",\"shape\":").Append(shape).Append(",\"points\":[");
                    for (int i = 0; i < n; i++) {
                        if (i > 0) json.Append(',');
                        json.Append(points[i].x).Append(',').Append(points[i].y).Append(',').Append(types[i]);
                    }
                    json.Append("]}");
                } finally { SelectObject(dc, old); DeleteObject(pen); }
            }
            Directory.CreateDirectory(dir);
            var bytes = Encoding.UTF8.GetBytes(json.Append(']').ToString());
            using (var file = File.Create(Path.Combine(dir, "dashed-pen-axis-scales.json.gz")))
            using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress))
                zip.Write(bytes, 0, bytes.Length);
        } finally { DeleteDC(dc); }
    }
}
