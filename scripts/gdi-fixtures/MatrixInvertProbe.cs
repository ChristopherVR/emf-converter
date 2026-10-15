// Native Matrix.Invert of 4,000 random float32 matrices (half axis-aligned, half sheared), recorded as the exact
// float32 bits: [a, b, c, d, e, f] followed by the six inverse elements, as int32 bit patterns.
using System; using System.Drawing.Drawing2D; using System.IO; using System.Text;
public static class MatrixInvertProbe {
    static int Bits(float v) { return BitConverter.ToInt32(BitConverter.GetBytes(v), 0); }
    public static void Run(string directory) {
        var rng = new Random(4242);
        var json = new StringBuilder("[");
        for (int i = 0; i < 4000; i++) {
            float a = (float)(0.2 + 3 * rng.NextDouble()), d = (float)(0.2 + 3 * rng.NextDouble()), b = 0, c = 0;
            if (i % 2 == 1) { b = (float)((rng.NextDouble() - 0.5) * 1.5); c = (float)((rng.NextDouble() - 0.5) * 1.5); }
            float e = (float)((rng.NextDouble() - 0.5) * 300), f = (float)((rng.NextDouble() - 0.5) * 300);
            var inverse = new Matrix(a, b, c, d, e, f);
            inverse.Invert();
            float[] el = inverse.Elements;
            if (i > 0) json.Append(',');
            json.Append('[').Append(Bits(a)).Append(',').Append(Bits(b)).Append(',').Append(Bits(c)).Append(',').Append(Bits(d)).Append(',').Append(Bits(e)).Append(',').Append(Bits(f));
            for (int k = 0; k < 6; k++) json.Append(',').Append(Bits(el[k]));
            json.Append(']');
        }
        var data = Encoding.UTF8.GetBytes(json.Append(']').ToString());
        using (var file = File.Create(Path.Combine(directory, "matrix-invert.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(data, 0, data.Length);
    }
}
