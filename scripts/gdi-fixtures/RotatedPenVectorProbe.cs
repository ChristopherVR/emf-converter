// Public WidenPath/GetPath controls; no native implementation is inspected.
// The flat-cap perpendicular GDI picks for a single segment under rotated and sheared world transforms: for every matrix,
// pen width and logical direction, the two corners of the start cap relative to the start point (native FIX).
using System;
using System.IO;
using System.Text;
using System.Globalization;
using System.Runtime.InteropServices;

public static class RotatedPenVectorProbe
{
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct Brush { public uint style, color; public IntPtr hatch; }
    [StructLayout(LayoutKind.Sequential)] struct Matrix { public float a, b, c, d, x, y; }
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern int SetGraphicsMode(IntPtr dc, int mode);
    [DllImport("gdi32.dll")] static extern bool SetWorldTransform(IntPtr dc, ref Matrix matrix);
    [DllImport("gdi32.dll")] static extern IntPtr ExtCreatePen(uint style, uint width, ref Brush brush, uint count, IntPtr styles);
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
        1.7320508f, 1f, -.5f, .8660254f,
        1.5f, -1.5f, 1f, 1f,
        1.5f, .75f, -.75f, 1.5f,
        2f, 1f, -1f, 1f,
    };

    public static void Run(string dir)
    {
        IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
        if (dc == IntPtr.Zero || SetGraphicsMode(dc, 2) == 0) throw new Exception("CreateCompatibleDC/SetGraphicsMode failed");
        var random = new Random(9317);
        int[,] special = { { 1, 0 }, { 0, 1 }, { -1, 0 }, { 0, -1 }, { 1, 1 }, { -1, -1 }, { 1, -1 }, { -1, 1 }, { 2, 1 }, { 1, 2 }, { 5, -12 }, { -5, 12 }, { 3, -7 }, { 7, -3 } };
        var json = new StringBuilder("[");
        try {
            for (int m = 0; m < Matrices.Length / 4; m++)
            foreach (int width in new[] { 4, 5, 6, 8, 10, 12, 16, 24 }) {
                var matrix = new Matrix { a = Matrices[m * 4], b = Matrices[m * 4 + 1], c = Matrices[m * 4 + 2], d = Matrices[m * 4 + 3] };
                if (!SetWorldTransform(dc, ref matrix)) throw new Exception("SetWorldTransform failed");
                var brush = new Brush();
                IntPtr pen = ExtCreatePen((uint)(0x10000 | 0x200), (uint)width, ref brush, 0, IntPtr.Zero);
                if (pen == IntPtr.Zero) throw new Exception("ExtCreatePen failed");
                IntPtr old = SelectObject(dc, pen);
                try {
                    for (int sample = 0; sample < 120 + special.GetLength(0); sample++) {
                        int dx, dy;
                        if (sample < 120) {
                            double a = random.NextDouble() * Math.PI * 2, len = 6 + random.NextDouble() * 50;
                            dx = (int)Math.Round(Math.Cos(a) * len); dy = (int)Math.Round(Math.Sin(a) * len);
                            if (dx == 0 && dy == 0) dx = 1;
                        } else {
                            int k = sample - 120;
                            dx = special[k, 0] * (k < 4 ? 30 : k < 8 ? 20 : 6); dy = special[k, 1] * (k < 4 ? 30 : k < 8 ? 20 : 6);
                        }
                        var p = new[] { new Point { x = 60, y = 60 }, new Point { x = 60 + dx, y = 60 + dy } };
                        if (!BeginPath(dc) || !Polyline(dc, p, 2) || !EndPath(dc) || !WidenPath(dc)) throw new Exception("WidenPath failed");
                        // GetPath returns logical integers; a 1/16 transform reads the widened device path at FIX precision.
                        var read = new Matrix { a = 1f / 16, d = 1f / 16 };
                        SetWorldTransform(dc, ref read);
                        int n = GetPath(dc, null, null, 0);
                        var points = new Point[n]; var types = new byte[n];
                        GetPath(dc, points, types, n);
                        SetWorldTransform(dc, ref matrix);
                        if (json.Length > 1) json.Append(',');
                        json.Append("{\"m\":").Append(m).Append(",\"w\":").Append(width).Append(",\"dx\":").Append(dx).Append(",\"dy\":").Append(dy).Append(",\"points\":[");
                        for (int i = 0; i < n; i++) {
                            if (i > 0) json.Append(',');
                            json.Append(points[i].x).Append(',').Append(points[i].y).Append(',').Append(types[i]);
                        }
                        json.Append("]}");
                    }
                } finally { SelectObject(dc, old); DeleteObject(pen); }
            }
            Directory.CreateDirectory(dir);
            var bytes = Encoding.UTF8.GetBytes(json.Append(']').ToString());
            using (var file = File.Create(Path.Combine(dir, "rotated-pen-vectors.json.gz")))
            using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress))
                zip.Write(bytes, 0, bytes.Length);
        } finally { DeleteDC(dc); }
    }
}
