// Public WidenPath/GetPath controls; no native implementation is inspected.
// Solid and dashed geometric pens under rotation, skew and mixed world transforms: the widened outline's points at
// native FIX precision, for straight polylines in four shapes.
using System;
using System.IO;
using System.Text;
using System.Globalization;
using System.Runtime.InteropServices;

public static class GeneralMatrixPenProbe
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
    [DllImport("gdi32.dll")] static extern bool CloseFigure(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool SetMiterLimit(IntPtr dc, float limit, IntPtr old);
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
    };
    static readonly uint[] UserStyle = { 6, 3, 2, 3 };

    static Point[] Source(int shape)
    {
        var start = new Point { x = 10, y = 10 };
        if (shape == 0) return new[] { start, new Point { x = 70, y = 10 } };
        if (shape == 1) return new[] { start, new Point { x = 10, y = 70 } };
        if (shape == 2) return new[] { start, new Point { x = 60, y = 40 } };
        return new[] { start, new Point { x = 40, y = 55 }, new Point { x = 70, y = 20 } };
    }

    public static void Run(string dir)
    {
        IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
        if (dc == IntPtr.Zero || SetGraphicsMode(dc, 2) == 0) throw new Exception("CreateCompatibleDC/SetGraphicsMode failed");
        var json = new StringBuilder("[");
        try {
            for (int m = 0; m < Matrices.Length / 4; m++)
            foreach (int width in new[] { 4, 8 })
            foreach (int style in new[] { 0, 1, 7 })
            for (int cap = 0; cap < 3; cap++) for (int shape = 0; shape < 4; shape++) {
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
            using (var file = File.Create(Path.Combine(dir, "general-matrix-pen.json.gz")))
            using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress))
                zip.Write(bytes, 0, bytes.Length);
        } finally { DeleteDC(dc); }
    }

    static Point[] JoinSource(int shape)
    {
        if (shape == 0) return new[] { new Point { x = 10, y = 10 }, new Point { x = 70, y = 10 }, new Point { x = 30, y = 40 } };
        if (shape == 1) return new[] { new Point { x = 10, y = 10 }, new Point { x = 60, y = 10 }, new Point { x = 60, y = 60 } };
        if (shape == 2) return new[] { new Point { x = 10, y = 10 }, new Point { x = 40, y = 40 }, new Point { x = 70, y = 25 } };
        return new[] { new Point { x = 10, y = 10 }, new Point { x = 60, y = 20 }, new Point { x = 20, y = 50 } };
    }

    /**
     * Bevel and miter joins (and the miter limit) under the same eight world transforms: flat-capped open corners of 30, 90 and 150 degrees and a closed
     * triangle, widths 4, 8 and 12, miter limits 10 and 1.5. `general-matrix-pen-joins.json.gz`.
     */
    public static void RunJoins(string dir)
    {
        IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
        if (dc == IntPtr.Zero || SetGraphicsMode(dc, 2) == 0) throw new Exception("CreateCompatibleDC/SetGraphicsMode failed");
        var json = new StringBuilder("[");
        try {
            for (int m = 0; m < Matrices.Length / 4; m++)
            foreach (int width in new[] { 4, 8, 12 })
            foreach (int join in new[] { 1, 2 })
            foreach (float limit in new[] { 10f, 1.5f })
            for (int shape = 0; shape < 4; shape++) {
                if (join == 1 && limit != 10f) continue;
                var matrix = new Matrix { a = Matrices[m * 4], b = Matrices[m * 4 + 1], c = Matrices[m * 4 + 2], d = Matrices[m * 4 + 3] };
                if (!SetWorldTransform(dc, ref matrix)) throw new Exception("SetWorldTransform failed");
                SetMiterLimit(dc, limit, IntPtr.Zero);
                var brush = new Brush();
                uint flags = (uint)(0x10000 | 0x200 | join * 0x1000);
                IntPtr pen = ExtCreatePen(flags, (uint)width, ref brush, 0, null);
                if (pen == IntPtr.Zero) throw new Exception("ExtCreatePen failed");
                IntPtr old = SelectObject(dc, pen);
                try {
                    var source = JoinSource(shape);
                    if (!BeginPath(dc) || !Polyline(dc, source, source.Length)) throw new Exception("Polyline failed");
                    if (shape == 3) CloseFigure(dc);
                    if (!EndPath(dc) || !WidenPath(dc)) throw new Exception("WidenPath failed");
                    matrix = new Matrix { a = 1f / 16, d = 1f / 16 };
                    if (!SetWorldTransform(dc, ref matrix)) throw new Exception("SetWorldTransform failed");
                    int n = GetPath(dc, null, null, 0);
                    var points = new Point[n]; var types = new byte[n];
                    if (GetPath(dc, points, types, n) != n) throw new Exception("GetPath failed");
                    if (json.Length > 1) json.Append(',');
                    json.Append("{\"w\":").Append(width).Append(",\"m\":").Append(m).Append(",\"join\":").Append(join)
                        .Append(",\"limit\":").Append(limit.ToString("R", CultureInfo.InvariantCulture)).Append(",\"shape\":").Append(shape).Append(",\"points\":[");
                    for (int i = 0; i < n; i++) {
                        if (i > 0) json.Append(',');
                        json.Append(points[i].x).Append(',').Append(points[i].y).Append(',').Append(types[i]);
                    }
                    json.Append("]}");
                } finally { SelectObject(dc, old); DeleteObject(pen); }
            }
            var bytes = Encoding.UTF8.GetBytes(json.Append(']').ToString());
            using (var file = File.Create(Path.Combine(dir, "general-matrix-pen-joins.json.gz")))
            using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress))
                zip.Write(bytes, 0, bytes.Length);
        } finally { DeleteDC(dc); }
    }
}
