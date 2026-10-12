// Independent TextureBrush sampling controls. Sources are written as straight
// RGBA bytes; destination bytes are captured independently from straight ARGB
// and premultiplied PARGB surfaces so extraction cannot hide sampling errors.
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Text;

public static class TextureSamplingProbe {
    static string Number(float value) { return value.ToString("R", CultureInfo.InvariantCulture); }
    static byte[] Pixels(Bitmap bitmap) {
        var bits = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height), ImageLockMode.ReadOnly, bitmap.PixelFormat);
        try {
            byte[] row = new byte[bitmap.Width * 4], rgba = new byte[bitmap.Width * bitmap.Height * 4];
            for (int y = 0; y < bitmap.Height; y++) {
                Marshal.Copy(IntPtr.Add(bits.Scan0, y * bits.Stride), row, 0, row.Length);
                for (int x = 0; x < bitmap.Width; x++) {
                    int p = (y * bitmap.Width + x) * 4, q = x * 4;
                    rgba[p] = row[q + 2]; rgba[p + 1] = row[q + 1]; rgba[p + 2] = row[q]; rgba[p + 3] = row[q + 3];
                }
            }
            return rgba;
        } finally { bitmap.UnlockBits(bits); }
    }
    static void Source(Bitmap bitmap, int kind) {
        uint state = 0x91e10da5;
        int[] alphas = { 0, 1, 17, 63, 127, 128, 191, 254, 255 };
        for (int y = 0; y < bitmap.Height; y++) for (int x = 0; x < bitmap.Width; x++) {
            int[] c = new int[3];
            for (int k = 0; k < 3; k++) { state = unchecked(state * 1664525 + 1013904223); c[k] = (int)(state >> 24); }
            if (kind == 2) { c[0] = (x * 41 + y * 13) % 256; c[1] = (x * 29 + y * 47) % 256; c[2] = (x * 17 + y * 31) % 256; }
            int alpha = kind == 1 ? alphas[(y * bitmap.Width + x) % alphas.Length] : 255;
            bitmap.SetPixel(x, y, Color.FromArgb(alpha, c[0], c[1], c[2]));
        }
    }
    public static void Run(string directory) {
        float[][] matrices = {
            new float[] { 1, 0, 0, 1, 0, 0 },
            new float[] { 2, 0, 0, 2, 0, 0 },
            new float[] { 4, 0, 0, 4, 0, 0 },
            new float[] { 1, 0, 0, 1, 0.25f, 0.5f },
            new float[] { 1.37f, 0, 0, 1.55f, 0.3f, 0.7f },
            new float[] { 0.75f, 0, 0, 0.5f, 1.25f, 0.75f },
            new float[] { -2, 0, 0, 1.5f, 12.5f, 0.25f },
            new float[] { 1.5f, 0.25f, -0.5f, 2, 5.25f, 1.5f }
        };
        var json = new StringBuilder("[");
        const int W = 24, H = 18;
        for (int kind = 0; kind < 3; kind++) using (var source = new Bitmap(5, 4, PixelFormat.Format32bppArgb)) {
            Source(source, kind);
            for (int m = 0; m < matrices.Length; m++) for (int wrap = 0; wrap < 5; wrap++) for (int half = 0; half < 2; half++) {
                float[] matrix = matrices[m];
                using (var bitmap = new Bitmap(W, H, PixelFormat.Format32bppArgb))
                using (var premultiplied = new Bitmap(W, H, PixelFormat.Format32bppPArgb))
                using (var brush = new TextureBrush(source, (WrapMode)wrap))
                using (var transform = new Matrix(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5])) {
                    brush.Transform = transform;
                    foreach (var surface in new Bitmap[] { bitmap, premultiplied }) using (var g = Graphics.FromImage(surface)) {
                        g.CompositingMode = CompositingMode.SourceCopy;
                        g.SmoothingMode = SmoothingMode.None;
                        g.PixelOffsetMode = half == 0 ? PixelOffsetMode.None : PixelOffsetMode.Half;
                        g.InterpolationMode = InterpolationMode.NearestNeighbor;
                        g.Clear(Color.Transparent);
                        g.FillRectangle(brush, 0, 0, W, H);
                    }
                    if (json.Length > 1) json.Append(',');
                    json.Append("{\"name\":\"k").Append(kind).Append("-m").Append(m).Append("-w").Append(wrap).Append("-h").Append(half);
                    json.Append("\",\"width\":").Append(W).Append(",\"height\":").Append(H).Append(",\"sourceWidth\":5,\"sourceHeight\":4,\"wrap\":").Append(wrap).Append(",\"half\":").Append(half == 1 ? "true" : "false");
                    json.Append(",\"matrix\":[");
                    for (int k = 0; k < matrix.Length; k++) { if (k > 0) json.Append(','); json.Append(Number(matrix[k])); }
                    json.Append("],\"source\":\"").Append(Convert.ToBase64String(Pixels(source))).Append("\",\"rgba\":\"").Append(Convert.ToBase64String(Pixels(bitmap))).Append("\",\"premultiplied\":\"").Append(Convert.ToBase64String(Pixels(premultiplied))).Append("\"}");
                }
            }
        }
        byte[] data = Encoding.UTF8.GetBytes(json.Append(']').ToString());
        using (var file = File.Create(Path.Combine(directory, "texture-sampling.json.gz")))
        using (var gzip = new GZipStream(file, CompressionMode.Compress)) gzip.Write(data, 0, data.Length);
    }
}
