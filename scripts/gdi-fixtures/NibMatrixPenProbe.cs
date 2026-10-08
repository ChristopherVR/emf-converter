// Public WidenPath/GetPath controls; no native implementation is inspected.
// Solid and dashed geometric pens under rotation, skew and mixed world transforms: the widened outline's points at
// native FIX precision, for straight polylines in four shapes.
using System;
using System.IO;
using System.Text;
using System.Globalization;
using System.Runtime.InteropServices;

public static class NibMatrixPenProbe
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

    // a, b, c, d of the world transform (x' = a x + c y, y' = b x + d y).
    static readonly float[] Matrices = {
        .8660254f, .5f, -.5f, .8660254f,
        .7071068f, .7071068f, -.7071068f, .7071068f,
        1.5f, 0f, 0f, 1.5f,
        1f, 0f, .5f, 1f,
        1f, .5f, 0f, 1f,
        1.7320508f, 1f, -.5f, .8660254f,
        2f, 0f, 1f, 1f,
        1.5f, -1.5f, 1f, 1f,
        1f, 0f, 0f, 1f,
        2f, 0f, 0f, 1f,
        1f, 0f, 0f, 3f,
    };
    static readonly uint[] UserStyle = { 6, 3, 2, 3 };

    static Point[] Source(int shape)
    {
        var p = new Point { x = 20, y = 20 };
        if (shape == 0) return new[] { p, p };
        return new[] { p, new Point { x = 21, y = 20 } };
    }

    public static void Run(string dir)
    {
        IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
        if (dc == IntPtr.Zero || SetGraphicsMode(dc, 2) == 0) throw new Exception("CreateCompatibleDC/SetGraphicsMode failed");
        var json = new StringBuilder("[");
        try {
            for (int m = 0; m < Matrices.Length / 4; m++)
            foreach (int width in new[] { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 20, 24, 32 })
            foreach (int style in new[] { 0 })
            for (int cap = 0; cap < 1; cap++) for (int shape = 0; shape < 2; shape++) {
                var matrix = new Matrix { a = Matrices[m * 4], b = Matrices[m * 4 + 1], c = Matrices[m * 4 + 2], d = Matrices[m * 4 + 3] };
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
                    json.Append("{\"w\":").Append(width).Append(",\"m\":").Append(m)
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
            using (var file = File.Create(Path.Combine(dir, "nib-matrix-pen.json.gz")))
            using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress))
                zip.Write(bytes, 0, bytes.Length);
        } finally { DeleteDC(dc); }
    }

    /**
     * The nib (a zero-length polyline widened) of a geometric pen at every whole degree of a pure rotation, 0 to 359, for widths 12, 24 and 40:
     * `nib-angle-sweep.json.gz` (`a`, `b` as the single-precision matrix the call used, and the outline at native FIX precision).
     */
    public static void RunAngles(string dir)
    {
        IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
        if (dc == IntPtr.Zero || SetGraphicsMode(dc, 2) == 0) throw new Exception("CreateCompatibleDC/SetGraphicsMode failed");
        var json = new StringBuilder("[");
        try {
            foreach (int width in new[] { 12, 24, 40 })
            for (int deg = 0; deg < 360; deg++) {
                double r = deg * Math.PI / 180;
                var matrix = new Matrix { a = (float)Math.Cos(r), b = (float)Math.Sin(r), c = -(float)Math.Sin(r), d = (float)Math.Cos(r) };
                if (!SetWorldTransform(dc, ref matrix)) throw new Exception("SetWorldTransform failed");
                var brush = new Brush();
                IntPtr pen = ExtCreatePen(0x10000, (uint)width, ref brush, 0, null);
                if (pen == IntPtr.Zero) throw new Exception("ExtCreatePen failed");
                IntPtr old = SelectObject(dc, pen);
                try {
                    var source = Source(0);
                    if (!BeginPath(dc) || !Polyline(dc, source, source.Length) || !EndPath(dc) || !WidenPath(dc))
                        throw new Exception("WidenPath failed");
                    var read = new Matrix { a = 1f / 16, d = 1f / 16 };
                    if (!SetWorldTransform(dc, ref read)) throw new Exception("SetWorldTransform failed");
                    int n = GetPath(dc, null, null, 0);
                    var points = new Point[n]; var types = new byte[n];
                    if (GetPath(dc, points, types, n) != n) throw new Exception("GetPath failed");
                    if (json.Length > 1) json.Append(',');
                    json.Append("{\"w\":").Append(width).Append(",\"deg\":").Append(deg)
                        .Append(",\"a\":").Append(matrix.a.ToString("R", CultureInfo.InvariantCulture)).Append(",\"b\":").Append(matrix.b.ToString("R", CultureInfo.InvariantCulture)).Append(",\"points\":[");
                    for (int i = 0; i < n; i++) {
                        if (i > 0) json.Append(',');
                        json.Append(points[i].x).Append(',').Append(points[i].y).Append(',').Append(types[i]);
                    }
                    json.Append("]}");
                } finally { SelectObject(dc, old); DeleteObject(pen); }
            }
            var bytes = Encoding.UTF8.GetBytes(json.Append(']').ToString());
            using (var file = File.Create(Path.Combine(dir, "nib-angle-sweep.json.gz")))
            using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress))
                zip.Write(bytes, 0, bytes.Length);
        } finally { DeleteDC(dc); }
    }
}
