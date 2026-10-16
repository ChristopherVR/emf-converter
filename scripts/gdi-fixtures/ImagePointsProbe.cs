// Plain Bilinear DrawImagePoints (three float32 points, the form a metafile records for DrawImage(image, rectangle))
// against a DrawImage destination rectangle, in two views.
//
// Noise (image-points.json.gz): a sw x sh opaque bitmap of pseudo-random colour (a fixed LCG, see `seed`) is drawn with
// PointF[] { (ox, oy), (ox + dw, oy), (ox, oy + dh) } onto a transparent 32bpp surface with Bilinear and PixelOffsetMode
// None, for origins that are a base position plus small power-of-two noise (the recorder writes 20.000030517578125,
// 10.000015258789062 for a rectangle at (20, 10)) and plain fractional positions; the RGBA of the surface is stored. A
// case is "sw,sh,dw,dh,dx,dy,n": n draws spread over the 72-draw sequence (40 noise grid draws, then 32 random
// fractions).
//
// Positions (image-points-positions.json.gz): the source is a bitmap whose red is the column parity and green the row
// parity, so the filtered red (green) of a destination pixel flips where its quantised source coordinate crosses a half
// texel. For one column (row) at a time the destination origin is bisected over consecutive float32 values around its
// nominal flip origin; the first origin that flips is that pixel's native source coordinate to a fraction of a float32
// unit (a flip origin 1.9e-6 pixel apart near 20, 9.5e-7 near 10). axis 0 moves the origin's x and reads the red of the
// middle row, axis 1 moves its y and reads the green of the middle column. A query is [index, lo bits, hi bits, first
// flipping bits] with the float32 bit patterns as signed 32-bit integers.
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices;
using System.IO; using System.Text; using System.Globalization; using System.Collections.Generic;
public static class ImagePointsProbe {
    static string F(float v) { return v.ToString("R", CultureInfo.InvariantCulture); }
    static int Bits(float v) { return BitConverter.ToInt32(BitConverter.GetBytes(v), 0); }
    static float FromBits(int b) { return BitConverter.ToSingle(BitConverter.GetBytes(b), 0); }
    public const string DefaultNoise = "37,19,260,170,20,10,12;360,20,162,8,9,2,72;60,4,156,8,9,2,72;64,48,58,20,9,2,72;100,10,100,8,9,2,72";
    public const string DefaultPositions = "1,37,19,260,170,10,1;1,37,48,260,170,10,1;1,37,19,260,100,10,1;1,37,7,260,150,10,1;1,37,100,260,170,10,1;1,37,19,260,100,60,1;1,37,19,260,100,90,1;"
        + "0,37,19,260,170,10,1;0,37,19,260,170,10.0000153,1;0,37,19,260,170,10.000061,1;0,37,19,260,170,10.001,1;0,37,19,260,170,10.5,1;0,37,19,260,170,10,0";
    public static void Run(string directory) {
        Noise(directory, "image-points", DefaultNoise);
        Positions(directory, "image-points-positions", DefaultPositions);
    }
    static void WriteGz(string path, StringBuilder json) {
        byte[] data = Encoding.UTF8.GetBytes(json.ToString());
        using (var file = File.Create(path))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionLevel.Optimal)) zip.Write(data, 0, data.Length);
    }
    public static void Noise(string directory, string name, string spec) {
        var json = new StringBuilder("[");
        foreach (string caseSpec in spec.Split(';')) {
            string[] p = caseSpec.Split(',');
            int sw = int.Parse(p[0]), sh = int.Parse(p[1]);
            float dw = float.Parse(p[2], CultureInfo.InvariantCulture), dh = float.Parse(p[3], CultureInfo.InvariantCulture);
            float dx = float.Parse(p[4], CultureInfo.InvariantCulture), dy = float.Parse(p[5], CultureInfo.InvariantCulture);
            int n = int.Parse(p[6]);
            int W = (int)Math.Ceiling(dx + dw) + 3, H = (int)Math.Ceiling(dy + dh) + 3;
            uint seed = (uint)(sw * 7919 + sh * 104729 + 12345);
            using (var source = new Bitmap(sw, sh, PixelFormat.Format32bppArgb))
            using (var dest = new Bitmap(W, H, PixelFormat.Format32bppArgb)) {
                for (int y = 0; y < sh; y++) for (int x = 0; x < sw; x++) {
                    seed = seed * 1664525u + 1013904223u; int r = (int)((seed >> 16) & 255);
                    seed = seed * 1664525u + 1013904223u; int g = (int)((seed >> 16) & 255);
                    seed = seed * 1664525u + 1013904223u; int b = (int)((seed >> 16) & 255);
                    source.SetPixel(x, y, Color.FromArgb(255, r, g, b));
                }
                var draws = new StringBuilder();
                var rnd = new Random(sw * 31 + sh);
                var all = new List<float[]>();
                for (int k = 0; k < 72; k++) {
                    if (k < 40) all.Add(new float[] { dx + (k % 8) * (1f / 32768f), dy + (k / 8) * (1f / 65536f) });
                    else all.Add(new float[] { dx + rnd.Next(0, 4096) / 4096f, dy + rnd.Next(0, 4096) / 4096f });
                }
                for (int i = 0; i < n; i++) {
                    float ox = all[i * 72 / n][0], oy = all[i * 72 / n][1];
                    using (var g = Graphics.FromImage(dest)) {
                        g.CompositingMode = CompositingMode.SourceCopy;
                        g.Clear(Color.Transparent);
                        g.InterpolationMode = InterpolationMode.Bilinear;
                        g.PixelOffsetMode = PixelOffsetMode.None;
                        g.DrawImage(source, new PointF[] { new PointF(ox, oy), new PointF(ox + dw, oy), new PointF(ox, oy + dh) }, new RectangleF(0, 0, sw, sh), GraphicsUnit.Pixel);
                    }
                    var bits = dest.LockBits(new Rectangle(0, 0, W, H), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                    byte[] raw = new byte[W * H * 4];
                    try { for (int y = 0; y < H; y++) Marshal.Copy(IntPtr.Add(bits.Scan0, y * bits.Stride), raw, y * W * 4, W * 4); }
                    finally { dest.UnlockBits(bits); }
                    byte[] rgba = new byte[W * H * 4];
                    for (int q = 0; q < W * H; q++) { rgba[q * 4] = raw[q * 4 + 2]; rgba[q * 4 + 1] = raw[q * 4 + 1]; rgba[q * 4 + 2] = raw[q * 4]; rgba[q * 4 + 3] = raw[q * 4 + 3]; }
                    if (draws.Length > 0) draws.Append(',');
                    draws.Append("{\"ox\":").Append(F(ox)).Append(",\"oy\":").Append(F(oy)).Append(",\"rgba\":\"").Append(Convert.ToBase64String(rgba)).Append("\"}");
                }
                if (json.Length > 1) json.Append(',');
                json.Append("{\"sw\":").Append(sw).Append(",\"sh\":").Append(sh).Append(",\"dw\":").Append(F(dw)).Append(",\"dh\":").Append(F(dh))
                    .Append(",\"dx\":").Append(F(dx)).Append(",\"dy\":").Append(F(dy)).Append(",\"width\":").Append(W).Append(",\"height\":").Append(H)
                    .Append(",\"seed\":").Append(sw * 7919 + sh * 104729 + 12345).Append(",\"draws\":[").Append(draws).Append("]}");
            }
        }
        WriteGz(Path.Combine(directory, name + ".json.gz"), json.Append(']'));
    }
    /// <summary>Cases "axis,sw,sh,dw,dh,fixed,points": axis 1 moves the origin's y (x stays 20, fixed is the starting y), axis 0 moves its x (fixed is the y).</summary>
    public static void Positions(string directory, string name, string spec) {
        var json = new StringBuilder("[");
        foreach (string caseSpec in spec.Split(';')) {
            string[] p = caseSpec.Split(',');
            int axis = int.Parse(p[0]), sw = int.Parse(p[1]), sh = int.Parse(p[2]);
            float dw = float.Parse(p[3], CultureInfo.InvariantCulture), dh = float.Parse(p[4], CultureInfo.InvariantCulture);
            float fixedValue = float.Parse(p[5], CultureInfo.InvariantCulture);
            bool points = p[6] == "1";
            float ox0 = 20f, oy0 = axis == 1 ? fixedValue : fixedValue;
            int W = 300, H = 200;
            int row = (int)Math.Floor(oy0 + dh / 2), column = (int)Math.Floor(ox0 + dw / 2);
            int srcLen = axis == 1 ? sh : sw;
            double destLen = axis == 1 ? dh : dw;
            double G = srcLen / destLen;
            var queries = new StringBuilder();
            using (var source = new Bitmap(sw, sh, PixelFormat.Format32bppArgb))
            using (var dest = new Bitmap(W, H, PixelFormat.Format32bppPArgb)) {
                for (int y = 0; y < sh; y++) for (int x = 0; x < sw; x++) source.SetPixel(x, y, Color.FromArgb(255, x % 2, y % 2, 0));
                Func<float, int, int> read = (t, pixel) => {
                    float ox = axis == 0 ? t : ox0, oy = axis == 0 ? oy0 : t;
                    using (var g = Graphics.FromImage(dest)) {
                        g.CompositingMode = CompositingMode.SourceCopy;
                        g.Clear(Color.Transparent);
                        g.InterpolationMode = InterpolationMode.Bilinear;
                        g.PixelOffsetMode = PixelOffsetMode.None;
                        if (points) g.DrawImage(source, new PointF[] { new PointF(ox, oy), new PointF(ox + dw, oy), new PointF(ox, oy + dh) }, new RectangleF(0, 0, sw, sh), GraphicsUnit.Pixel);
                        else g.DrawImage(source, new RectangleF(ox, oy, dw, dh), new RectangleF(0, 0, sw, sh), GraphicsUnit.Pixel);
                    }
                    var bits = dest.LockBits(new Rectangle(0, 0, W, H), ImageLockMode.ReadOnly, dest.PixelFormat);
                    try { return axis == 0 ? Marshal.ReadByte(bits.Scan0, row * bits.Stride + pixel * 4 + 2) : Marshal.ReadByte(bits.Scan0, pixel * bits.Stride + column * 4 + 1); }
                    finally { dest.UnlockBits(bits); }
                };
                double start = axis == 1 ? oy0 : ox0;
                int first = (int)Math.Ceiling(start + 2), last = (int)Math.Ceiling(start + destLen - 2);
                for (int pixel = first; pixel < last; pixel++) {
                    for (int k = 0; k < srcLen; k++) {
                        double o = pixel - (k + 0.5) / G;
                        if (o < start + 0.01 || o > start + 4) continue;
                        int lo = Bits((float)(o - 0.01)), hi = Bits((float)(o + 0.01));
                        int vlo = read(FromBits(lo), pixel), vhi = read(FromBits(hi), pixel);
                        int result = 0;
                        if (vlo != vhi) {
                            while (hi - lo > 1) {
                                int mid = lo + (hi - lo) / 2;
                                if (read(FromBits(mid), pixel) == vlo) lo = mid; else hi = mid;
                            }
                            result = hi;
                        }
                        int lo0 = Bits((float)(o - 0.01));
                        if (queries.Length > 0) queries.Append(',');
                        queries.Append('[').Append(pixel).Append(',').Append(lo0).Append(',').Append(Bits((float)(o + 0.01))).Append(',').Append(vlo != vhi ? result : 0).Append(']');
                    }
                }
            }
            if (json.Length > 1) json.Append(',');
            json.Append("{\"axis\":").Append(axis).Append(",\"points\":").Append(points ? "true" : "false").Append(",\"sw\":").Append(sw).Append(",\"sh\":").Append(sh)
                .Append(",\"dw\":").Append(F(dw)).Append(",\"dh\":").Append(F(dh)).Append(",\"ox0\":").Append(F(ox0)).Append(",\"oy0\":").Append(F(oy0))
                .Append(",\"queries\":[").Append(queries).Append("]}");
        }
        WriteGz(Path.Combine(directory, name + ".json.gz"), json.Append(']'));
    }
}
