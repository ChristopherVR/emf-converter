// Translucent ImageAttributes Clamp colour on straight (Format32bppArgb) and premultiplied (Format32bppPArgb)
// surfaces, over several backdrops. Native treats the colour's RGB as literal premultiplied values, so a pixel can
// hold a channel above its alpha in a PArgb surface; this records what a straight surface and an opaque or
// translucent backdrop make of it.
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices;
using System.IO; using System.Text; using System.Globalization;
public static class TranslucentClampProbe {
    static byte[] Bytes(Bitmap b) {
        var d = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, b.PixelFormat);
        var a = new byte[b.Width * b.Height * 4];
        try { for (int y = 0; y < b.Height; y++) Marshal.Copy(IntPtr.Add(d.Scan0, y * d.Stride), a, y * b.Width * 4, b.Width * 4); } finally { b.UnlockBits(d); }
        return a;
    }
    public static void Run(string directory) {
        var json = new StringBuilder("[");
        int[][] backdrops = { new[] { 0, 0, 0, 0 }, new[] { 255, 255, 255, 255 }, new[] { 255, 40, 60, 20 }, new[] { 255, 200, 10, 90 }, new[] { 109, 17, 201, 42 }, new[] { 200, 250, 250, 250 } };
        int[] clampAlphas = { 160, 40, 255 };
        var random = new Random(5551);
        using (var source = new Bitmap(4, 3, PixelFormat.Format32bppArgb)) {
            for (int y = 0; y < 3; y++) for (int x = 0; x < 4; x++) {
                int alpha = new int[] { 0, 1, 63, 128, 201, 255 }[(y * 4 + x) % 6];
                source.SetPixel(x, y, Color.FromArgb(alpha, random.Next(256), random.Next(256), random.Next(256)));
            }
            foreach (int clampAlpha in clampAlphas)
            foreach (int[] bd in backdrops)
            foreach (int format in new[] { 0, 1 })
            foreach (int over in new[] { 0, 1 })
            foreach (float scale in new[] { 1f, 2.5f })
            foreach (int imode in new[] { 3, 4, 6, 7 })
            using (var destination = new Bitmap(16, 14, format == 0 ? PixelFormat.Format32bppArgb : PixelFormat.Format32bppPArgb)) {
                byte[] background;
                using (var graphics = Graphics.FromImage(destination)) {
                    graphics.CompositingMode = CompositingMode.SourceCopy;
                    graphics.Clear(Color.FromArgb(bd[0], bd[1], bd[2], bd[3]));
                    background = Bytes(destination);
                    graphics.CompositingMode = over == 1 ? CompositingMode.SourceOver : CompositingMode.SourceCopy;
                    graphics.InterpolationMode = (InterpolationMode)imode;
                    graphics.PixelOffsetMode = PixelOffsetMode.None;
                    using (var imageAttributes = new ImageAttributes()) {
                        imageAttributes.SetWrapMode(WrapMode.Clamp, Color.FromArgb(clampAlpha, 217, 43, 129), false);
                        graphics.DrawImage(source, new PointF[] {
                            new PointF(3, 3), new PointF(3 + 4 * scale, 3), new PointF(3, 3 + 3 * scale)
                        }, new RectangleF(0, 0, 4, 3), GraphicsUnit.Pixel, imageAttributes);
                    }
                }
                if (json.Length > 1) json.Append(',');
                json.Append("{\"clampAlpha\":").Append(clampAlpha).Append(",\"backdrop\":[").Append(bd[0]).Append(',').Append(bd[1]).Append(',').Append(bd[2]).Append(',').Append(bd[3])
                    .Append("],\"format\":\"").Append(format == 0 ? "argb" : "pargb").Append("\",\"over\":").Append(over == 1 ? "true" : "false")
                    .Append(",\"imode\":").Append(imode).Append(",\"scale\":").Append(scale.ToString("R", CultureInfo.InvariantCulture))
                    .Append(",\"srcBgra\":\"").Append(Convert.ToBase64String(Bytes(source)))
                    .Append("\",\"background\":\"").Append(Convert.ToBase64String(background))
                    .Append("\",\"bgra\":\"").Append(Convert.ToBase64String(Bytes(destination))).Append("\"}");
            }
        }
        var data = Encoding.UTF8.GetBytes(json.Append(']').ToString());
        using (var file = File.Create(Path.Combine(directory, "translucent-clamp-surfaces.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(data, 0, data.Length);
    }
}
