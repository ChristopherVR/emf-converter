// Reads the native source coordinate of single texture-brush pixels to one float32 unit of the brush translation.
//
// TextureCoordinateProbe sweeps the translation in steps of 2^-17 or coarser, which resolves a pixel's coordinate to a
// few float32 units of u. This probe bisects the translation over consecutive float32 values instead, so the first
// translation at which a pixel's filtered red flips is its native coordinate at the resolution of the float32
// translation (4.8e-7 near 1 for a 0.3 scale, where the inverse translation moves 3.3 times as fast).
//
// A case is "m0,m1,m2,m3,ty,x0,columns,width[,wrap]": the matrix [m0 m1 m2 m3 tx ty] with tx searched, a fill of
// `width` pixels from x0 on a one row surface (no world transform), the pixels read are x0 to x0 + columns - 1. The
// 2 x 2 texture has red = texel column parity. For every column every half-texel crossing with tx between 1 and 1.6
// is bisected. A query is [column, lo bits, hi bits, first flipping bits] as signed 32-bit float patterns.
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices;
using System.IO; using System.Text; using System.Globalization;
public static class TextureBisectProbe {
    static string F(float v) { return v.ToString("R", CultureInfo.InvariantCulture); }
    static int Bits(float v) { return BitConverter.ToInt32(BitConverter.GetBytes(v), 0); }
    static float FromBits(int b) { return BitConverter.ToSingle(BitConverter.GetBytes(b), 0); }
    // The first committed set (texture-bisect-scale03.json.gz); generate-texture-bisect.ps1 holds all four.
    public const string DefaultSpec = "0.3,0,0,0.3,1,0,60,160;0.3,0,0,0.3,1,1,60,159;0.3,0,0,0.3,1,2,60,158;0.3,0,0,0.3,1,3,60,157;0.3,0,0,0.3,1,4,60,156;0.3,0,0,0.3,1,5,60,155;0.3,0,0,0.3,1,6,60,154;0.3,0,0,0.3,1,7,60,153;0.3,0,0,0.3,1,8,60,152;0.3,0,0,0.3,1,9,60,151;0.3,0,0,0.3,1,12,60,148;0.3,0,0,0.3,1,16,60,144";
    public static void Run(string directory, string name, string spec) {
        var json = new StringBuilder("[");
        using (var source = new Bitmap(2, 2, PixelFormat.Format32bppArgb)) {
            for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) source.SetPixel(x, y, Color.FromArgb(255, x, y, 0));
            foreach (string caseSpec in spec.Split(';')) {
                string[] p = caseSpec.Split(',');
                float[] m = new float[4];
                for (int k = 0; k < 4; k++) m[k] = float.Parse(p[k], CultureInfo.InvariantCulture);
                float ty = float.Parse(p[4], CultureInfo.InvariantCulture);
                int X0 = int.Parse(p[5]), columns = int.Parse(p[6]), W = int.Parse(p[7]);
                int wrap = p.Length > 8 ? int.Parse(p[8]) : 0;
                int BW = X0 + W;
                var queries = new StringBuilder();
                float[] inv;
                using (var mat = new Matrix(m[0], m[1], m[2], m[3], 1f, ty)) { mat.Invert(); inv = mat.Elements; }
                using (var dest = new Bitmap(BW, 2, PixelFormat.Format32bppPArgb)) {
                    Func<float, int, int> read = (tx, pixel) => {
                        using (var brush = new TextureBrush(source, (WrapMode)wrap))
                        using (var mat = new Matrix(m[0], m[1], m[2], m[3], tx, ty))
                        using (var g = Graphics.FromImage(dest)) {
                            brush.Transform = mat;
                            g.CompositingMode = CompositingMode.SourceCopy;
                            g.SmoothingMode = SmoothingMode.None;
                            g.PixelOffsetMode = PixelOffsetMode.None;
                            g.FillRectangle(brush, X0, 0, W, 1);
                        }
                        var bits = dest.LockBits(new Rectangle(0, 0, BW, 2), ImageLockMode.ReadOnly, dest.PixelFormat);
                        try { return Marshal.ReadByte(bits.Scan0, pixel * 4 + 2); }
                        finally { dest.UnlockBits(bits); }
                    };
                    for (int c = 0; c < columns; c++) {
                        int pixel = X0 + c;
                        // u = inv0 * pixel + inv4(tx), inv4 = -tx * inv0 (translation only): crossings at u = k + 0.5.
                        double a = inv[0];
                        for (int k = -4; k < 400; k++) {
                            double tx = pixel - (k + 0.5) / a;
                            if (tx < 1.0 || tx > 1.6) continue;
                            int lo = Bits((float)(tx - 0.002)), hi = Bits((float)(tx + 0.002));
                            int vlo = read(FromBits(lo), pixel), vhi = read(FromBits(hi), pixel);
                            int result = 0;
                            if (vlo != vhi) {
                                while (hi - lo > 1) {
                                    int mid = lo + (hi - lo) / 2;
                                    if (read(FromBits(mid), pixel) == vlo) lo = mid; else hi = mid;
                                }
                                result = hi;
                            }
                            if (queries.Length > 0) queries.Append(',');
                            queries.Append('[').Append(pixel).Append(',').Append(Bits((float)(tx - 0.002))).Append(',').Append(Bits((float)(tx + 0.002))).Append(',').Append(vlo != vhi ? result : 0).Append(']');
                        }
                    }
                }
                if (json.Length > 1) json.Append(',');
                json.Append("{\"matrix\":[").Append(F(m[0])).Append(',').Append(F(m[1])).Append(',').Append(F(m[2])).Append(',').Append(F(m[3])).Append("],\"ty\":").Append(F(ty))
                    .Append(",\"x0\":").Append(X0).Append(",\"columns\":").Append(columns).Append(",\"width\":").Append(W).Append(",\"wrap\":").Append(wrap)
                    .Append(",\"queries\":[").Append(queries).Append("]}");
            }
        }
        byte[] data = Encoding.UTF8.GetBytes(json.Append(']').ToString());
        using (var file = File.Create(Path.Combine(directory, name + ".json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionLevel.Optimal)) zip.Write(data, 0, data.Length);
    }
}
