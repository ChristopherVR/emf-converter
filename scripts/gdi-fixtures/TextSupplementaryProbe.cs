// Native DrawString controls from the CC0 supplementary font. BMP and non-BMP
// aliases have identical glyphs; capture all five explicit text rendering hints.
using System;
using System.Drawing;
using System.Drawing.Text;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Runtime.InteropServices;

public static class TextSupplementaryProbe
{
    public static void Run(string dir)
    {
        using (var fonts = new PrivateFontCollection())
        {
            fonts.AddFontFile(Path.Combine(dir, "supplementary.ttf"));
            var json = new StringBuilder("[");
            var texts = new[] { "A\ue000A", "A\U000f0000A", "A\U0001f642A", "\ue000\ue001", "\U000f0000\U000f0001" };
            foreach (int size in new[] { 16, 32, 48 })
            using (var font = new Font(fonts.Families[0], size, FontStyle.Regular, GraphicsUnit.Pixel))
            {
                for (int hint = 1; hint < 6; hint++)
                for (int i = 0; i < texts.Length; i++)
                using (var bitmap = new Bitmap(200, 64, PixelFormat.Format32bppArgb))
                {
                    using (var g = Graphics.FromImage(bitmap))
                    using (var format = (StringFormat)StringFormat.GenericTypographic.Clone())
                    {
                        g.Clear(Color.White);
                        g.TextRenderingHint = (TextRenderingHint)hint;
                        g.TextContrast = 0;
                        format.FormatFlags |= StringFormatFlags.NoFontFallback;
                        g.DrawString(texts[i], font, Brushes.Black, new PointF(8, 8), format);
                    }
                    var data = bitmap.LockBits(new Rectangle(0, 0, 200, 64), ImageLockMode.ReadOnly, bitmap.PixelFormat);
                    var bytes = new byte[200 * 64 * 4];
                    try
                    {
                        for (int y = 0; y < 64; y++)
                            Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), bytes, y * 800, 800);
                    }
                    finally { bitmap.UnlockBits(data); }
                    if (json.Length > 1) json.Append(',');
                    json.Append("{\"hint\":").Append(hint).Append(",\"size\":").Append(size)
                        .Append(",\"text\":").Append(i).Append(",\"bgra\":\"")
                        .Append(Convert.ToBase64String(bytes)).Append("\"}");
                }
            }
            var encoded = Encoding.UTF8.GetBytes(json.Append(']').ToString());
            using (var file = File.Create(Path.Combine(dir, "text-supplementary.json.gz")))
            using (var gzip = new GZipStream(file, CompressionMode.Compress))
                gzip.Write(encoded, 0, encoded.Length);
        }
    }
}
