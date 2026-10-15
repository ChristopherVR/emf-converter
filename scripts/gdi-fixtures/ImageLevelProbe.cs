// Level sequences of a DrawImage(destRect, srcRect) of grey noise while the destination origin is swept by a power of
// two per draw: for every destination pixel the draws at which its red changes and the value it changes to (up to 24
// changes). Unlike the 0/1 flips of ImageCoordinateProbe, the noise makes every pixel step through many levels, so the
// sequence pins the native position of the pixel to the resolution of the sweep for the high-quality kernels too.
// A case is "sw,sh,dw,dh,dx,dy,mode,axis": mode is the InterpolationMode value (6 HighQualityBilinear, 7 HighQualityBicubic;
// 3 is Bilinear and 5 is NearestNeighbor), axis 0 sweeps the destination's x origin and 1 its y origin (the other stays put,
// so each axis is measured alone).
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices;
using System.IO; using System.Text; using System.Globalization;
public static class ImageLevelProbe {
    static string F(float v) { return v.ToString("R", CultureInfo.InvariantCulture); }
    public const int Changes = 24;
    public const string DefaultSpec =
        "64,48,58,20,9,2,6,0;64,48,58,20,9,2,7,0;64,48,58,20,9,2,6,1;64,48,58,20,9,2,7,1;" +
        "64,48,25.6,21.6,9,2,6,0;64,48,25.6,21.6,9,2,7,0;64,48,25.6,21.6,9,2,6,1;64,48,25.6,21.6,9,2,7,1";
    public static void Run(string directory) { Run(directory, "image-levels", DefaultSpec, 65536); }
    public static void Run(string directory, string name, string spec, int N) {
        var json = new StringBuilder("[");
        foreach (string caseSpec in spec.Split(';')) {
            string[] p = caseSpec.Split(',');
            int sw = int.Parse(p[0]), sh = int.Parse(p[1]);
            float dw = float.Parse(p[2], CultureInfo.InvariantCulture), dh = float.Parse(p[3], CultureInfo.InvariantCulture);
            float dx = float.Parse(p[4], CultureInfo.InvariantCulture), dy = float.Parse(p[5], CultureInfo.InvariantCulture);
            int mode = int.Parse(p[6]); int axis = p.Length > 7 ? int.Parse(p[7]) : 0;
            int W = (int)Math.Ceiling(dx + dw) + 3, H = (int)Math.Ceiling(dy + dh) + 3;
            float step = 1f / N; // the origin moves by one pixel over the sweep
            var rng = new Random(sw * 31 + sh);
            using (var source = new Bitmap(sw, sh, PixelFormat.Format32bppArgb))
            using (var dest = new Bitmap(W, H, PixelFormat.Format32bppPArgb)) {
                for (int y = 0; y < sh; y++) for (int x = 0; x < sw; x++) { int v = rng.Next(256); source.SetPixel(x, y, Color.FromArgb(255, v, v, v)); }
                int[] when = new int[W * H * Changes], what = new int[W * H * Changes], count = new int[W * H];
                byte[] prev = new byte[W * H], cur = new byte[W * H], row = new byte[W * 4], first = new byte[W * H];
                for (int j = 0; j < N; j++) {
                    float ox = axis == 0 ? dx + j * step : dx, oy = axis == 1 ? dy + j * step : dy;
                    using (var g = Graphics.FromImage(dest)) {
                        g.CompositingMode = CompositingMode.SourceCopy;
                        g.Clear(Color.Transparent);
                        g.InterpolationMode = (InterpolationMode)mode;
                        g.PixelOffsetMode = PixelOffsetMode.None;
                        g.DrawImage(source, new RectangleF(ox, oy, dw, dh), new RectangleF(0, 0, sw, sh), GraphicsUnit.Pixel);
                    }
                    var bits = dest.LockBits(new Rectangle(0, 0, W, H), ImageLockMode.ReadOnly, dest.PixelFormat);
                    try {
                        for (int y = 0; y < H; y++) {
                            Marshal.Copy(IntPtr.Add(bits.Scan0, y * bits.Stride), row, 0, W * 4);
                            for (int x = 0; x < W; x++) cur[y * W + x] = row[x * 4 + 2];
                        }
                    } finally { dest.UnlockBits(bits); }
                    if (j == 0) Array.Copy(cur, first, cur.Length);
                    else for (int q = 0; q < W * H; q++) if (cur[q] != prev[q] && count[q] < Changes) { when[q * Changes + count[q]] = j; what[q * Changes + count[q]] = cur[q]; count[q]++; }
                    byte[] t = prev; prev = cur; cur = t;
                }
                byte[] wb = new byte[when.Length * 4]; Buffer.BlockCopy(when, 0, wb, 0, wb.Length);
                byte[] vb = new byte[what.Length]; for (int i = 0; i < what.Length; i++) vb[i] = (byte)what[i];
                byte[] cb = new byte[count.Length]; for (int i = 0; i < count.Length; i++) cb[i] = (byte)count[i];
                byte[] src = new byte[sw * sh];
                for (int y = 0; y < sh; y++) for (int x = 0; x < sw; x++) src[y * sw + x] = source.GetPixel(x, y).R;
                if (json.Length > 1) json.Append(',');
                json.Append("{\"sw\":").Append(sw).Append(",\"sh\":").Append(sh).Append(",\"dw\":").Append(F(dw)).Append(",\"dh\":").Append(F(dh))
                    .Append(",\"dx\":").Append(F(dx)).Append(",\"dy\":").Append(F(dy)).Append(",\"mode\":").Append(mode).Append(",\"axis\":").Append(axis).Append(",\"step\":").Append(F(step)).Append(",\"n\":").Append(N)
                    .Append(",\"width\":").Append(W).Append(",\"height\":").Append(H).Append(",\"changes\":").Append(Changes)
                    .Append(",\"source\":\"").Append(Convert.ToBase64String(src)).Append("\",\"first\":\"").Append(Convert.ToBase64String(first))
                    .Append("\",\"count\":\"").Append(Convert.ToBase64String(cb)).Append("\",\"when\":\"").Append(Convert.ToBase64String(wb))
                    .Append("\",\"what\":\"").Append(Convert.ToBase64String(vb)).Append("\"}");
            }
        }
        byte[] data = Encoding.UTF8.GetBytes(json.Append(']').ToString());
        using (var file = File.Create(Path.Combine(directory, name + ".json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(data, 0, data.Length);
    }
}
