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
    [DllImport("gdi32.dll")] static extern bool SetMiterLimit(IntPtr dc, float limit, IntPtr old);

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
    // One-degree sweep: long segments (flat, round and square capped) at every whole logical degree under the identity and two
    // rotations, so the rounding of the perpendicular can be read as a function of the direction (round 6); "deg" -1 is the
    // zero-length path of the same pen. Writes rotated-pen-sweep.json.gz.
    static readonly float[] SweepMatrices = {
        1f, 0f, 0f, 1f,
        .8660254f, .5f, -.5f, .8660254f,
        .7071068f, .7071068f, -.7071068f, .7071068f,
        // Mirrors (a negative determinant): a flip in y, a flip in x, a rotation composed with a flip.
        1f, 0f, 0f, -1f,
        -1f, 0f, 0f, 1f,
        .8660254f, .5f, .5f, -.8660254f,
    };

    public static void RunSweep(string dir)
    {
        IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
        if (dc == IntPtr.Zero || SetGraphicsMode(dc, 2) == 0) throw new Exception("CreateCompatibleDC/SetGraphicsMode failed");
        var json = new StringBuilder("[");
        try {
            for (int m = 0; m < SweepMatrices.Length / 4; m++)
            foreach (int width in new[] { 8, 16 })
            foreach (int cap in new[] { 0x200, 0x0, 0x100 }) {
                var matrix = new Matrix { a = SweepMatrices[m * 4], b = SweepMatrices[m * 4 + 1], c = SweepMatrices[m * 4 + 2], d = SweepMatrices[m * 4 + 3] };
                if (!SetWorldTransform(dc, ref matrix)) throw new Exception("SetWorldTransform failed");
                var brush = new Brush();
                IntPtr pen = ExtCreatePen((uint)(0x10000 | cap), (uint)width, ref brush, 0, IntPtr.Zero);
                if (pen == IntPtr.Zero) throw new Exception("ExtCreatePen failed");
                IntPtr old = SelectObject(dc, pen);
                try {
                    for (int deg = -1; deg < 360; deg++) {
                        // deg -1 is the zero-length nib of this pen.
                        double a = deg * Math.PI / 180, len = 100;
                        int dx = deg < 0 ? 0 : (int)Math.Round(Math.Cos(a) * len), dy = deg < 0 ? 0 : (int)Math.Round(Math.Sin(a) * len);
                        var p = new[] { new Point { x = 150, y = 150 }, new Point { x = 150 + dx, y = 150 + dy } };
                        if (!BeginPath(dc) || !Polyline(dc, p, 2) || !EndPath(dc) || !WidenPath(dc)) throw new Exception("WidenPath failed");
                        var read = new Matrix { a = 1f / 16, d = 1f / 16 };
                        SetWorldTransform(dc, ref read);
                        int n = GetPath(dc, null, null, 0);
                        var points = new Point[n]; var types = new byte[n];
                        GetPath(dc, points, types, n);
                        SetWorldTransform(dc, ref matrix);
                        if (json.Length > 1) json.Append(',');
                        json.Append("{\"m\":").Append(m).Append(",\"w\":").Append(width).Append(",\"cap\":").Append(cap).Append(",\"deg\":").Append(deg).Append(",\"dx\":").Append(dx).Append(",\"dy\":").Append(dy).Append(",\"points\":[");
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
            using (var file = File.Create(Path.Combine(dir, "rotated-pen-sweep.json.gz")))
            using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress))
                zip.Write(bytes, 0, bytes.Length);
        } finally { DeleteDC(dc); }
    }
    // The pen polygon (nib) a round-capped, round-joined long segment shows, read from the cap vertices: four logical directions
    // under rotations of the given angles (and scale) for widths 5 to 40 (round 6). Writes rotated-pen-nibs.json.gz.
    public static void RunNibs(string dir)
    {
        IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
        if (dc == IntPtr.Zero || SetGraphicsMode(dc, 2) == 0) throw new Exception("CreateCompatibleDC/SetGraphicsMode failed");
        var json = new StringBuilder("[");
        double[,] mats = { { 10, 1 }, { 15, 1 }, { 20, 1 }, { 30, 1 }, { 45, 1 }, { 60, 1 }, { 75, 1 }, { 100, 1 }, { 135, 1 }, { 200, 1 }, { 300, 1 }, { 30, 1.5 }, { 45, 2 }, { 20, 0.75 } };
        try {
            // Then general matrices (shears, unequal scales, a rotation with unequal scales, mirrors): a, b, c, d.
            float[] gen = {
                1f, 0f, .5f, 1f, 1f, .5f, 0f, 1f, 2f, 0f, 1f, 1f, 1.5f, -1.5f, 1f, 1f, 1.7320508f, 1f, -.5f, .8660254f,
                2f, 0f, 0f, 1f, 1f, 0f, 0f, 3f, 1f, 0f, 0f, -1f, -1f, 0f, 0f, 1f, .8660254f, .5f, .5f, -.8660254f,
            };
            for (int m = 0; m < mats.GetLength(0) + gen.Length / 4; m++)
            for (int width = 5; width <= 40; width++) {
                int gi = m - mats.GetLength(0);
                double rad = gi < 0 ? mats[m, 0] * Math.PI / 180 : 0, sc = gi < 0 ? mats[m, 1] : 0;
                var matrix = gi < 0
                    ? new Matrix { a = (float)(Math.Cos(rad) * sc), b = (float)(Math.Sin(rad) * sc), c = (float)(-Math.Sin(rad) * sc), d = (float)(Math.Cos(rad) * sc) }
                    : new Matrix { a = gen[gi * 4], b = gen[gi * 4 + 1], c = gen[gi * 4 + 2], d = gen[gi * 4 + 3] };
                if (!SetWorldTransform(dc, ref matrix)) throw new Exception("SetWorldTransform failed");
                var brush = new Brush();
                IntPtr pen = ExtCreatePen(0x10000, (uint)width, ref brush, 0, IntPtr.Zero);
                if (pen == IntPtr.Zero) throw new Exception("ExtCreatePen failed");
                IntPtr old = SelectObject(dc, pen);
                try {
                    for (int dir4 = 0; dir4 < 4; dir4++) {
                        int dx = new[] { 40, 0, -40, 0 }[dir4], dy = new[] { 0, 40, 0, -40 }[dir4];
                        var pts = new[] { new Point { x = 150, y = 150 }, new Point { x = 150 + dx, y = 150 + dy } };
                        if (!BeginPath(dc) || !Polyline(dc, pts, 2) || !EndPath(dc) || !WidenPath(dc)) throw new Exception("WidenPath failed");
                        var read = new Matrix { a = 1f / 16, d = 1f / 16 };
                        SetWorldTransform(dc, ref read);
                        int n = GetPath(dc, null, null, 0);
                        var points = new Point[n]; var types = new byte[n];
                        GetPath(dc, points, types, n);
                        SetWorldTransform(dc, ref matrix);
                        if (json.Length > 1) json.Append(',');
                        json.Append("{\"deg\":").Append((gi < 0 ? mats[m, 0] : 1000 + gi).ToString(CultureInfo.InvariantCulture)).Append(",\"scale\":").Append(sc.ToString(CultureInfo.InvariantCulture))
                            .Append(",\"a\":").Append(matrix.a.ToString("R", CultureInfo.InvariantCulture)).Append(",\"b\":").Append(matrix.b.ToString("R", CultureInfo.InvariantCulture))
                            .Append(",\"c\":").Append(matrix.c.ToString("R", CultureInfo.InvariantCulture)).Append(",\"d\":").Append(matrix.d.ToString("R", CultureInfo.InvariantCulture))
                            .Append(",\"w\":").Append(width).Append(",\"dx\":").Append(dx).Append(",\"dy\":").Append(dy).Append(",\"points\":[");
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
            using (var file = File.Create(Path.Combine(dir, "rotated-pen-nibs.json.gz")))
            using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress))
                zip.Write(bytes, 0, bytes.Length);
        } finally { DeleteDC(dc); }
    }

    // Miter joins under matrices (round 6): an open corner of every 5 degrees from 20 to 175 (arms of 40 logical units), flat caps,
    // miter limits 1.2 to 5, widths 6, 10 and 16, under three rotations and a rotation with unequal scales. Which corners GDI
    // mitres and which it bevels tells how the miter limit is tested. Writes rotated-pen-miters.json.gz.
    public static void RunMiters(string dir)
    {
        IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
        if (dc == IntPtr.Zero || SetGraphicsMode(dc, 2) == 0) throw new Exception("CreateCompatibleDC/SetGraphicsMode failed");
        var json = new StringBuilder("[");
        float[] mats = { .8660254f, .5f, -.5f, .8660254f, .7071068f, .7071068f, -.7071068f, .7071068f, .9659258f, -.258819f, .258819f, .9659258f, 1.7320508f, 1f, -.5f, .8660254f,
            1f, 0f, 0f, -1f, -1f, 0f, 0f, 1f, .8660254f, .5f, .5f, -.8660254f };
        try {
            for (int m = 0; m < mats.Length / 4; m++)
            foreach (int width in new[] { 6, 10, 16 })
            foreach (float limit in new[] { 1.2f, 1.5f, 2f, 3f, 5f }) {
                var matrix = new Matrix { a = mats[m * 4], b = mats[m * 4 + 1], c = mats[m * 4 + 2], d = mats[m * 4 + 3] };
                if (!SetWorldTransform(dc, ref matrix)) throw new Exception("SetWorldTransform failed");
                SetMiterLimit(dc, limit, IntPtr.Zero);
                var brush = new Brush();
                IntPtr pen = ExtCreatePen((uint)(0x10000 | 0x200 | 0x2000), (uint)width, ref brush, 0, IntPtr.Zero);
                if (pen == IntPtr.Zero) throw new Exception("ExtCreatePen failed");
                IntPtr old = SelectObject(dc, pen);
                try {
                    for (int angle = 20; angle <= 175; angle += 5) {
                        double turn = (180 - angle) * Math.PI / 180;
                        int x1 = 100 + 40, y1 = 100;
                        int x2 = x1 + (int)Math.Round(40 * Math.Cos(turn)), y2 = y1 + (int)Math.Round(40 * Math.Sin(turn));
                        var p = new[] { new Point { x = 100, y = 100 }, new Point { x = x1, y = y1 }, new Point { x = x2, y = y2 } };
                        if (!BeginPath(dc) || !Polyline(dc, p, 3) || !EndPath(dc) || !WidenPath(dc)) throw new Exception("WidenPath failed");
                        var read = new Matrix { a = 1f / 16, d = 1f / 16 };
                        SetWorldTransform(dc, ref read);
                        int n = GetPath(dc, null, null, 0);
                        var points = new Point[n]; var types = new byte[n];
                        GetPath(dc, points, types, n);
                        SetWorldTransform(dc, ref matrix);
                        if (json.Length > 1) json.Append(',');
                        json.Append("{\"m\":").Append(m).Append(",\"w\":").Append(width).Append(",\"limit\":").Append(limit.ToString(CultureInfo.InvariantCulture)).Append(",\"angle\":").Append(angle)
                            .Append(",\"p\":[").Append(100).Append(',').Append(100).Append(',').Append(x1).Append(',').Append(y1).Append(',').Append(x2).Append(',').Append(y2).Append("],\"points\":[");
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
            using (var file = File.Create(Path.Combine(dir, "rotated-pen-miters.json.gz")))
            using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress))
                zip.Write(bytes, 0, bytes.Length);
        } finally { DeleteDC(dc); }
    }
}
