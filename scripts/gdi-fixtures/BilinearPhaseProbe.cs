// Signed fractions exactly halfway between native 11-bit tent shares, and their neighbouring float values.
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging;
using System.IO; using System.Text; using System.Runtime.InteropServices; using System.Globalization;
public static class BilinearPhaseProbe {
    static byte[] Bytes(Bitmap bitmap) {
        var bits = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height), ImageLockMode.ReadOnly, bitmap.PixelFormat);
        var bytes = new byte[bitmap.Width * bitmap.Height * 4];
        try { for (int y = 0; y < bitmap.Height; y++) Marshal.Copy(IntPtr.Add(bits.Scan0, y * bits.Stride), bytes, y * bitmap.Width * 4, bitmap.Width * 4); }
        finally { bitmap.UnlockBits(bits); } return bytes;
    }
    public static void Run(string directory) {
        var json = new StringBuilder("[");
        using (var source = new Bitmap(4, 4, PixelFormat.Format32bppArgb)) {
            for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) source.SetPixel(x, y,
                Color.FromArgb(255, x % 2 == 0 ? 0 : 255, y % 2 == 0 ? 0 : 255, (x + y) % 2 == 0 ? 0 : 255));
            foreach (int phase in new int[] { -2049, -1025, -3, -1, 1, 3, 1025, 2049 })
            foreach (int neighbour in new int[] { -1, 0, 1 })
            foreach (int axis in new int[] { 0, 1 })
            using (var destination = new Bitmap(12, 12, PixelFormat.Format32bppPArgb)) {
                float value = phase / 4096f;
                int bits = BitConverter.ToInt32(BitConverter.GetBytes(value), 0);
                value = BitConverter.ToSingle(BitConverter.GetBytes(bits + neighbour), 0);
                float sx = axis == 0 ? value : 0, sy = axis == 1 ? value : 0;
                using (var graphics = Graphics.FromImage(destination)) {
                    graphics.CompositingMode = CompositingMode.SourceCopy;
                    graphics.InterpolationMode = InterpolationMode.Bilinear;
                    graphics.PixelOffsetMode = PixelOffsetMode.None;
                    graphics.DrawImage(source, new RectangleF(4, 4, 6, 6), new RectangleF(sx, sy, 3, 3), GraphicsUnit.Pixel);
                }
                if (json.Length > 1) json.Append(',');
                json.Append("{\"sx\":").Append(sx.ToString("R", CultureInfo.InvariantCulture))
                    .Append(",\"sy\":").Append(sy.ToString("R", CultureInfo.InvariantCulture))
                    .Append(",\"srcBgra\":\"").Append(Convert.ToBase64String(Bytes(source)))
                    .Append("\",\"bgra\":\"").Append(Convert.ToBase64String(Bytes(destination))).Append("\"}");
            }
        }
        var data = Encoding.UTF8.GetBytes(json.Append(']').ToString());
        using (var file = File.Create(Path.Combine(directory, "bilinear-phase-ties.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(data, 0, data.Length);
    }
}
