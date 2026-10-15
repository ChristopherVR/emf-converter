// Isolates the source-coordinate stage of GDI+ bilinear texture sampling.
//
// The texture is 2 x 2 (R = x parity, G = y parity, both 0/1) with WrapMode.Tile, so the filtered red channel is
// round(fraction of u) and the green one round(fraction of v): every destination pixel flips between 0 and 1 where
// the native, quantised source coordinate crosses a half texel. The brush translation is swept in steps of a power
// of two (sx, sy) and each draw is compared with the previous one: the draw index at which a pixel flips measures the
// native coordinate of that pixel to a fraction of the sweep step, independently of any ideal model. Two flips per
// channel are kept (rising and falling edges have different thresholds).
//
// A case is "m0,m1,m2,m3,m4,m5,x0,y0,w,h,half[,wrap]" (matrix, filled rectangle, PixelOffsetMode Half when 1, WrapMode);
// cases are separated by ';'. The recorded matrix is the brush transform at draw 0.
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices;
using System.IO; using System.Text; using System.Globalization;
public static class TextureCoordinateProbe {
    static string F(float v) { return v.ToString("R", CultureInfo.InvariantCulture); }
    // Committed capture (texture-coordinate.json.gz): the recorded fixtures' three brush matrices (reduction, 30 degree
    // rotation, enlargement), further scales, a large offset (u from 220 to 560), a fill that starts at x = 40 as a
    // rectangle and as a clip, and PixelOffsetMode Half. 8 rows each, 65,536 sweep draws.
    public const string DefaultSpec =
        "0.45,0,0,0.4,1,57,0,0,160,8,0;1.4722,0.85,-0.85,1.4722,100,10,0,0,160,8,0;2.6,0,0,2.3,3,2,0,0,160,8,0;" +
        "1.37,0,0,1.55,0.3,0.7,0,0,160,8,0;1,0,0,1,0.25,0.5,0,0,160,8,0;0.75,0,0,0.5,1.25,0.75,0,0,160,8,0;" +
        "0.45,0,0,0.4,-99,57,0,0,160,8,0;0.3,0,0,0.3,1,1,0,0,160,8,0;0.9,0,0,0.9,1,1,0,0,160,8,0;" +
        "0.45,0,0,0.4,1,57,0,0,160,8,1;1.4722,0.85,-0.85,1.4722,100,10,0,0,160,8,1;" +
        "0.45,0,0,0.4,1,57,40,0,120,8,0,0,1;0.45,0,0,0.4,1,57,40,0,120,8,0,0,2;" +
        "0.3,0,0,0.3,1,1,40,0,120,8,0,0,1;0.3,0,0,0.3,1,1,40,0,120,8,0,0,2;" +
        "1.4722,0.85,-0.85,1.4722,100,10,40,0,120,8,0,0,1";
    public static void Run(string directory) { Run(directory, "texture-coordinate", DefaultSpec, 65536); }
    public static void Run(string directory, string name, string spec, int N) {
        var json = new StringBuilder("[");
        using (var source = new Bitmap(2, 2, PixelFormat.Format32bppArgb)) {
            for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) source.SetPixel(x, y, Color.FromArgb(255, x, y, 0));
            foreach (string caseSpec in spec.Split(';')) {
                string[] p = caseSpec.Split(',');
                float[] m = new float[6];
                for (int k = 0; k < 6; k++) m[k] = float.Parse(p[k], CultureInfo.InvariantCulture);
                int X0 = int.Parse(p[6]), Y0 = int.Parse(p[7]), W = int.Parse(p[8]), H = int.Parse(p[9]), half = int.Parse(p[10]);
                int wrap = p.Length > 11 ? int.Parse(p[11]) : 0;
                float[] inv;
                using (var mat = new Matrix(m[0], m[1], m[2], m[3], m[4], m[5])) { mat.Invert(); inv = mat.Elements; }
                // sweep steps: powers of two so the translation stays exact in float32
                double needU = 1.2 / N / Math.Abs(inv[0]), needV = 1.2 / N / Math.Abs(inv[3]);
                float sx = 1f / (1 << 20), sy = 1f / (1 << 20);
                while (sx < needU) sx *= 2; while (sy < needV) sy *= 2;
                int[] flips = new int[W * H * 4];
                for (int i = 0; i < flips.Length; i++) flips[i] = -1;
                byte[] prev = new byte[W * H * 2], cur = new byte[W * H * 2], row = new byte[W * 4];
                byte[] first = new byte[W * H * 2];
                int geo = p.Length > 12 ? int.Parse(p[12]) : 0; int BW = geo == 0 ? W : X0 + W, BH = geo == 0 ? H : Y0 + H;
                using (var dest = new Bitmap(BW, BH, PixelFormat.Format32bppPArgb))
                for (int j = 0; j < N; j++) {
                    float tx = m[4] + j * sx, ty = m[5] + j * sy;
                    using (var brush = new TextureBrush(source, (WrapMode)wrap))
                    using (var mat = new Matrix(m[0], m[1], m[2], m[3], tx, ty))
                    using (var g = Graphics.FromImage(dest)) {
                        brush.Transform = mat;
                        g.CompositingMode = CompositingMode.SourceCopy;
                        g.SmoothingMode = SmoothingMode.None;
                        g.PixelOffsetMode = half == 0 ? PixelOffsetMode.None : PixelOffsetMode.Half;
                        if (geo == 0) g.TranslateTransform(-X0, -Y0);
                        if (geo == 2) g.SetClip(new Rectangle(X0, Y0, W, H));
                        if (geo == 2) g.FillRectangle(brush, 0, 0, BW, BH); else g.FillRectangle(brush, X0, Y0, W, H);
                    }
                    var bits = dest.LockBits(new Rectangle(0, 0, BW, BH), ImageLockMode.ReadOnly, dest.PixelFormat);
                    int ox = geo == 0 ? 0 : X0, oy = geo == 0 ? 0 : Y0;
                    try {
                        for (int y = 0; y < H; y++) {
                            Marshal.Copy(IntPtr.Add(bits.Scan0, (y + oy) * bits.Stride + ox * 4), row, 0, W * 4);
                            for (int x = 0; x < W; x++) { cur[(y * W + x) * 2] = row[x * 4 + 2]; cur[(y * W + x) * 2 + 1] = row[x * 4 + 1]; }
                        }
                    } finally { dest.UnlockBits(bits); }
                    if (j == 0) Array.Copy(cur, first, cur.Length);
                    else for (int q = 0; q < W * H; q++) for (int c = 0; c < 2; c++) {
                        int k = q * 2 + c;
                        if (cur[k] != prev[k]) {
                            int slot = q * 4 + c * 2;
                            if (flips[slot] < 0) flips[slot] = j; else if (flips[slot + 1] < 0) flips[slot + 1] = j;
                        }
                    }
                    byte[] t = prev; prev = cur; cur = t;
                }
                byte[] fb = new byte[flips.Length * 4]; Buffer.BlockCopy(flips, 0, fb, 0, fb.Length);
                if (json.Length > 1) json.Append(',');
                json.Append("{\"matrix\":[");
                for (int k = 0; k < 6; k++) { if (k > 0) json.Append(','); json.Append(F(m[k])); }
                json.Append("],\"inv\":[");
                for (int k = 0; k < 6; k++) { if (k > 0) json.Append(','); json.Append(F(inv[k])); }
                json.Append("],\"sx\":").Append(F(sx)).Append(",\"sy\":").Append(F(sy)).Append(",\"n\":").Append(N)
                    .Append(",\"x0\":").Append(X0).Append(",\"y0\":").Append(Y0).Append(",\"width\":").Append(W).Append(",\"height\":").Append(H)
                    .Append(",\"geo\":").Append(geo).Append(",\"half\":").Append(half).Append(",\"wrap\":").Append(wrap);
                json.Append(",\"first\":\"").Append(Convert.ToBase64String(first)).Append("\",\"flips\":\"").Append(Convert.ToBase64String(fb)).Append("\"}");
            }
        }
        byte[] data = Encoding.UTF8.GetBytes(json.Append(']').ToString());
        using (var file = File.Create(Path.Combine(directory, name + ".json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(data, 0, data.Length);
    }
}
