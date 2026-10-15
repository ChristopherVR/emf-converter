// The source-coordinate stage of plain Bilinear DrawImage(destRect, srcRect), isolated the way TextureCoordinateProbe
// isolates it for texture brushes: the source is a sw x sh bitmap whose red is the column parity and green the row
// parity (0 or 1), so the filtered red/green of a destination pixel flips where its quantised source coordinate
// crosses a half texel, and the destination rectangle's origin is swept in steps of a power of two. The draw at
// which a pixel flips measures its native coordinate. A case is "sw,sh,dw,dh,dx,dy"; cases are separated by ';'.
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices;
using System.IO; using System.Text; using System.Globalization;
public static class ImageCoordinateProbe {
    static string F(float v) { return v.ToString("R", CultureInfo.InvariantCulture); }
    public const string DefaultSpec =
        "360,20,162,8,9,2;180,20,160,8,9,2;60,4,156,8,9,2;64,48,58,8,9,2;100,10,100,8,9.25,2.5;200,16,100,8,9,2;90,6,150,12,9,2";
    public static void Run(string directory) { Run(directory, "image-coordinate", DefaultSpec, 65536); }
    public static void Run(string directory, string name, string spec, int N) {
        var json = new StringBuilder("[");
        foreach (string caseSpec in spec.Split(';')) {
            string[] p = caseSpec.Split(',');
            int sw = int.Parse(p[0]), sh = int.Parse(p[1]);
            float dw = float.Parse(p[2], CultureInfo.InvariantCulture), dh = float.Parse(p[3], CultureInfo.InvariantCulture);
            float dx = float.Parse(p[4], CultureInfo.InvariantCulture), dy = float.Parse(p[5], CultureInfo.InvariantCulture);
            int W = (int)Math.Ceiling(dx + dw) + 3, H = (int)Math.Ceiling(dy + dh) + 3;
            // sweep step: a power of two, the origin moves through about 1.2 texels
            float step = 1f / (1 << 22);
            while (step * N < 1.2 * dw / sw) step *= 2;
            using (var source = new Bitmap(sw, sh, PixelFormat.Format32bppArgb))
            using (var dest = new Bitmap(W, H, PixelFormat.Format32bppPArgb)) {
                for (int y = 0; y < sh; y++) for (int x = 0; x < sw; x++) source.SetPixel(x, y, Color.FromArgb(255, x % 2, y % 2, 0));
                int[] flips = new int[W * H * 4];
                for (int i = 0; i < flips.Length; i++) flips[i] = -1;
                byte[] prev = new byte[W * H * 2], cur = new byte[W * H * 2], row = new byte[W * 4], first = new byte[W * H * 2];
                for (int j = 0; j < N; j++) {
                    float ox = dx + j * step, oy = dy + j * step;
                    using (var g = Graphics.FromImage(dest)) {
                        g.CompositingMode = CompositingMode.SourceCopy;
                        g.Clear(Color.Transparent);
                        g.InterpolationMode = InterpolationMode.Bilinear;
                        g.PixelOffsetMode = PixelOffsetMode.None;
                        g.DrawImage(source, new RectangleF(ox, oy, dw, dh), new RectangleF(0, 0, sw, sh), GraphicsUnit.Pixel);
                    }
                    var bits = dest.LockBits(new Rectangle(0, 0, W, H), ImageLockMode.ReadOnly, dest.PixelFormat);
                    try {
                        for (int y = 0; y < H; y++) {
                            Marshal.Copy(IntPtr.Add(bits.Scan0, y * bits.Stride), row, 0, W * 4);
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
                json.Append("{\"sw\":").Append(sw).Append(",\"sh\":").Append(sh).Append(",\"dw\":").Append(F(dw)).Append(",\"dh\":").Append(F(dh))
                    .Append(",\"dx\":").Append(F(dx)).Append(",\"dy\":").Append(F(dy)).Append(",\"step\":").Append(F(step)).Append(",\"n\":").Append(N)
                    .Append(",\"width\":").Append(W).Append(",\"height\":").Append(H)
                    .Append(",\"first\":\"").Append(Convert.ToBase64String(first)).Append("\",\"flips\":\"").Append(Convert.ToBase64String(fb)).Append("\"}");
            }
        }
        byte[] data = Encoding.UTF8.GetBytes(json.Append(']').ToString());
        using (var file = File.Create(Path.Combine(directory, name + ".json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(data, 0, data.Length);
    }
}
