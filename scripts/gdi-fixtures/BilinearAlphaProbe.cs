// Native premultiplied DrawImage output: 1:1 translucent copies, clamp colours and SourceOver.
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class BilinearAlphaProbe {
    static byte[] Bytes(Bitmap bitmap) {
        var bits = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height), ImageLockMode.ReadOnly, bitmap.PixelFormat);
        var bytes = new byte[bitmap.Width * bitmap.Height * 4];
        try { for (int y = 0; y < bitmap.Height; y++) Marshal.Copy(IntPtr.Add(bits.Scan0, y * bits.Stride), bytes, y * bitmap.Width * 4, bitmap.Width * 4); }
        finally { bitmap.UnlockBits(bits); }
        return bytes;
    }

    public static void Run(string directory) {
        Capture(directory, 255, "bilinear-alpha");
    }

    // Diagnostic only: native GDI+ treats a translucent Clamp colour's literal RGB as premultiplied.
    // This can yield a PArgb channel greater than alpha, which straight RGBA cannot represent.
    public static void RunTranslucentClamp(string directory) {
        Capture(directory, 160, "bilinear-translucent-clamp");
    }

    static void Capture(string directory, int clampAlpha, string name) {
        var json = new StringBuilder("[");
        var random = new Random(901271);
        using (var source = new Bitmap(4, 3, PixelFormat.Format32bppArgb)) {
            for (int y = 0; y < 3; y++) for (int x = 0; x < 4; x++) {
                int alpha = new int[] { 0, 1, 63, 128, 201, 255 }[(y * 4 + x) % 6];
                source.SetPixel(x, y, Color.FromArgb(alpha, random.Next(256), random.Next(256), random.Next(256)));
            }
            foreach (float scale in new float[] { 0.75f, 1f, 2.5f })
            foreach (float origin in new float[] { 0f, 0.375f })
            foreach (bool attributes in new bool[] { false, true })
            foreach (bool over in new bool[] { false, true })
            using (var destination = new Bitmap(16, 14, PixelFormat.Format32bppPArgb)) {
                byte[] background;
                using (var graphics = Graphics.FromImage(destination)) {
                    graphics.Clear(over ? Color.FromArgb(109, 17, 201, 42) : Color.Transparent);
                    background = Bytes(destination);
                    graphics.CompositingMode = over ? CompositingMode.SourceOver : CompositingMode.SourceCopy;
                    graphics.InterpolationMode = InterpolationMode.Bilinear;
                    graphics.PixelOffsetMode = PixelOffsetMode.None;
                    using (var imageAttributes = new ImageAttributes()) {
                        imageAttributes.SetWrapMode(WrapMode.Clamp, Color.FromArgb(clampAlpha, 217, 43, 129), false);
                        graphics.DrawImage(source, new PointF[] {
                            new PointF(2 + origin, 2 + origin),
                            new PointF(2 + origin + 4 * scale, 2 + origin),
                            new PointF(2 + origin, 2 + origin + 3 * scale)
                        }, new RectangleF(0, 0, 4, 3), GraphicsUnit.Pixel, attributes ? imageAttributes : null);
                    }
                }
                if (json.Length > 1) json.Append(',');
                json.Append("{\"scale\":").Append(scale.ToString("R", CultureInfo.InvariantCulture))
                    .Append(",\"origin\":").Append(origin.ToString("R", CultureInfo.InvariantCulture))
                    .Append(",\"clamp\":").Append(attributes ? "true" : "false")
                    .Append(",\"over\":").Append(over ? "true" : "false")
                    .Append(",\"srcBgra\":\"").Append(Convert.ToBase64String(Bytes(source)))
                    .Append("\",\"background\":\"").Append(Convert.ToBase64String(background))
                    .Append("\",\"bgra\":\"").Append(Convert.ToBase64String(Bytes(destination))).Append("\"}");
            }
        }
        var data = Encoding.UTF8.GetBytes(json.Append(']').ToString());
        using (var file = File.Create(Path.Combine(directory, name + ".json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(data, 0, data.Length);
    }
}
