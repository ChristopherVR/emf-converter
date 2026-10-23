// Reads the native source coordinate of single pixels of a plain Bilinear DrawImage(Image, PointF[3], srcRect) to one
// float32 unit of the destination origin.
//
// ImageCoordinateProbe sweeps a DrawImage(destRect) origin in steps of 2^-16 pixel; this probe bisects the origin over
// consecutive float32 values instead (the TextureBisectProbe method), for the three-point form a metafile records, so the
// first origin at which a pixel's filtered red flips is its native coordinate at the resolution of the float32 origin.
// The source is a bitmap whose red is the column parity (0 or 1); the flip is the half-texel crossing of the 11-bit
// fraction. A case is "sw,sh,srcW,srcH,x0,y0,x1,y1,x2,y2,row,columns": the bitmap is sw x sh, the source rectangle is
// (0, 0, srcW, srcH), the three destination points are (tx, y0) (x1, y1) (tx, y2) with tx the searched origin (x0 is the
// search centre), and the pixels read are on destination row `row`, columns listed by `columns` ("a-b" ranges joined
// by "+"). A query is [column, lo bits, hi bits, first flipping bits] as signed 32-bit float patterns.
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices;
using System.IO; using System.Text; using System.Globalization; using System.Collections.Generic;
public static class ImagePointsBisectProbe {
    static string F(float v) { return v.ToString("R", CultureInfo.InvariantCulture); }
    static int Bits(float v) { return BitConverter.ToInt32(BitConverter.GetBytes(v), 0); }
    static float FromBits(int b) { return BitConverter.ToSingle(BitConverter.GetBytes(b), 0); }
    // The JPEG playbacks' geometry: a 37 x 19 source rectangle of a 227 x 149 bitmap to (20.000030517578125, 10.000015258789062) .. (280, 180).
    public const string DefaultSpec = "227,149,37,19,20.000030517578125,10.000015258789062,280,10.000015258789062,180,100,22-278";
    static byte[] Record(Bitmap source, int srcW, int srcH) {
        string path = Path.Combine(Path.GetTempPath(), "ipb-" + Guid.NewGuid().ToString("N") + ".emf");
        try {
            using (var surface = new Bitmap(300, 200))
            using (var host = Graphics.FromImage(surface)) {
                IntPtr hdc = host.GetHdc();
                try {
                    using (var recording = new Metafile(path, hdc, EmfType.EmfPlusOnly))
                    using (var g = Graphics.FromImage(recording)) {
                        g.Clear(Color.White);
                        g.DrawImage(source, new Rectangle(20, 10, 260, 170), 0, 0, srcW, srcH, GraphicsUnit.Pixel);
                    }
                } finally { host.ReleaseHdc(hdc); }
            }
            return File.ReadAllBytes(path);
        } finally { try { File.Delete(path); } catch { } }
    }
    static int ReadPlayback(byte[] template, Bitmap dest, float x0, float tx, int pixel, int row) {
        byte[] data = (byte[])template.Clone();
        byte[] key = BitConverter.GetBytes(x0), repl = BitConverter.GetBytes(tx);
        int hits = 0;
        for (int i = 0; i + 4 <= data.Length; i++) {
            if (data[i] == key[0] && data[i + 1] == key[1] && data[i + 2] == key[2] && data[i + 3] == key[3]) { Array.Copy(repl, 0, data, i, 4); hits++; }
        }
        if (hits != 2) throw new Exception("expected 2 recorded origins, found " + hits + " for " + F(x0));
        using (var mf = new Metafile(new MemoryStream(data)))
        using (var g = Graphics.FromImage(dest)) {
            g.Clear(Color.Magenta);
            g.DrawImage(mf, new Rectangle(0, 0, mf.Width, mf.Height), 0, 0, mf.Width, mf.Height, GraphicsUnit.Pixel);
        }
        var bits = dest.LockBits(new Rectangle(0, 0, dest.Width, 200), ImageLockMode.ReadOnly, dest.PixelFormat);
        try { return Marshal.ReadByte(bits.Scan0, row * bits.Stride + pixel * 4 + 2); }
        finally { dest.UnlockBits(bits); }
    }
    public static void Run(string directory, string name, string spec) { Run(directory, name, spec, false); }
    // playback = true records the three-point DrawImage (fixture geometry: Rectangle(20,10,260,170), source rectangle srcW x srcH) into an
    // EMF+ metafile on a 300 x 200 host, patches the recorded x of the first and third point to each searched origin and reads the
    // native playback (DrawImage(metafile, 0, 0, Width, Height)), the way codec-jpeg-*-playback.png was made.
    public static void Run(string directory, string name, string spec, bool playback) {
        var json = new StringBuilder("[");
        foreach (string caseSpec in spec.Split(';')) {
            string[] p = caseSpec.Split(',');
            int sw = int.Parse(p[0]), sh = int.Parse(p[1]), srcW = int.Parse(p[2]), srcH = int.Parse(p[3]);
            float x0 = float.Parse(p[4], CultureInfo.InvariantCulture), y0 = float.Parse(p[5], CultureInfo.InvariantCulture);
            float x1 = float.Parse(p[6], CultureInfo.InvariantCulture), y1 = float.Parse(p[7], CultureInfo.InvariantCulture);
            float y2 = float.Parse(p[8], CultureInfo.InvariantCulture);
            int row = int.Parse(p[9]);
            var cols = new List<int>();
            foreach (string part in p[10].Split('+')) {
                string[] ab = part.Split('-');
                int a = int.Parse(ab[0]), b = ab.Length > 1 ? int.Parse(ab[1]) : a;
                for (int c = a; c <= b; c++) cols.Add(c);
            }
            var queries = new StringBuilder();
            using (var source = new Bitmap(sw, sh, PixelFormat.Format32bppArgb))
            using (var dest = playback ? new Bitmap(300, 200, PixelFormat.Format32bppArgb) : new Bitmap(320, 200, PixelFormat.Format32bppPArgb)) {
                for (int y = 0; y < sh; y++) for (int x = 0; x < sw; x++) source.SetPixel(x, y, Color.FromArgb(255, x % 2, y % 2, 0));
                byte[] template = playback ? Record(source, srcW, srcH) : null;
                Func<float, int, int> read = (tx, pixel) => {
                    if (playback) return ReadPlayback(template, dest, x0, tx, pixel, row);
                    using (var g = Graphics.FromImage(dest)) {
                        g.CompositingMode = CompositingMode.SourceCopy;
                        g.Clear(Color.Transparent);
                        g.InterpolationMode = InterpolationMode.Bilinear;
                        g.PixelOffsetMode = PixelOffsetMode.None;
                        g.DrawImage(source, new PointF[] { new PointF(tx, y0), new PointF(x1, y1), new PointF(tx, y2) }, new RectangleF(0, 0, srcW, srcH), GraphicsUnit.Pixel);
                    }
                    var bits = dest.LockBits(new Rectangle(0, 0, dest.Width, 200), ImageLockMode.ReadOnly, dest.PixelFormat);
                    try { return Marshal.ReadByte(bits.Scan0, row * bits.Stride + pixel * 4 + 2); }
                    finally { dest.UnlockBits(bits); }
                };
                foreach (int pixel in cols) {
                    // the red parity flips at u = k + 0.5 (within 1/2048)
                    for (int k = -1; k < srcW; k++) {
                        // u = (pixel - tx) * srcW / (x1 - tx) = k + 0.5 (the far corner stays at x1, so the scale moves with tx)
                        double tx = (srcW * (double)pixel - (k + 0.5) * x1) / (srcW - (k + 0.5));
                        if (tx < x0 - 4 || tx > x0 + 4) continue;
                        int lo = Bits((float)(tx - 0.004)), hi = Bits((float)(tx + 0.004));
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
                        queries.Append('[').Append(pixel).Append(',').Append(Bits((float)(tx - 0.004))).Append(',').Append(Bits((float)(tx + 0.004))).Append(',').Append(vlo != vhi ? result : 0).Append(']');
                    }
                }
                // the first and last covered columns of the row at the centre origin
                read(x0, 0);
                if (playback) { /* read() already drew the playback into dest */ }
                int first = -1, last = -1;
                var bd = dest.LockBits(new Rectangle(0, 0, dest.Width, 200), ImageLockMode.ReadOnly, dest.PixelFormat);
                try { for (int c = 0; c < dest.Width; c++) if (Marshal.ReadByte(bd.Scan0, row * bd.Stride + c * 4 + 3) != 0) { if (first < 0) first = c; last = c; } }
                finally { dest.UnlockBits(bd); }
                if (json.Length > 1) json.Append(',');
                json.Append("{\"sw\":").Append(sw).Append(",\"sh\":").Append(sh).Append(",\"srcW\":").Append(srcW).Append(",\"srcH\":").Append(srcH)
                    .Append(",\"x0\":").Append(F(x0)).Append(",\"y0\":").Append(F(y0)).Append(",\"x1\":").Append(F(x1)).Append(",\"y1\":").Append(F(y1)).Append(",\"y2\":").Append(F(y2))
                    .Append(",\"row\":").Append(row).Append(",\"first\":").Append(first).Append(",\"last\":").Append(last)
                    .Append(",\"queries\":[").Append(queries).Append("]}");
            }
        }
        byte[] data = Encoding.UTF8.GetBytes(json.Append(']').ToString());
        using (var file = File.Create(Path.Combine(directory, name + ".json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionLevel.Optimal)) zip.Write(data, 0, data.Length);
    }
}
