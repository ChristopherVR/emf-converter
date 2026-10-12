// Native unsupported-shaping controls for preserving the previous alignment fallback.
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;

public static class DrawStringShapingGuardProbe
{
    static string Number(float value) { return value.ToString("R", CultureInfo.InvariantCulture); }

    public static void Run(string fontSource, int style, string output)
    {
        using (var collection = new PrivateFontCollection())
        {
            bool custom = File.Exists(fontSource);
            if (custom) collection.AddFontFile(fontSource);
            using (var family = custom ? collection.Families[0] : new FontFamily(fontSource))
            using (var file = File.Create(output))
            using (var gzip = new GZipStream(file, CompressionMode.Compress))
            using (var writer = new StreamWriter(gzip))
            {
                bool first = true;
                writer.Write('[');
                foreach (bool heldout in new[] { false })
                foreach (int size in heldout ? new[] { 13, 19, 27 } : new[] { 16 })
                using (var font = new Font(family, size, (FontStyle)style, GraphicsUnit.Pixel))
                foreach (bool typo in new[] { false })
                foreach (int align in new[] { 0, 1, 2 })
                foreach (int line in new[] { 0, 1, 2 })
                foreach (string text in custom
                    ? new[] { "A", "AA", "A\ue000\ue001", "A  " }
                    : new[] { "e\u0301", "\u0644\u0627", "A\u200fB", "A\u2067B\u2069" })
                using (var bitmap = new Bitmap(256, 160, PixelFormat.Format32bppArgb))
                {
                    var rect = heldout ? new RectangleF(19.25f, 17.5f, 173.25f, 91.5f) : new RectangleF(20, 16, 180, 96);
                    SizeF measured;
                    int flags;
                    using (var graphics = Graphics.FromImage(bitmap))
                    using (var format = (StringFormat)(typo ? StringFormat.GenericTypographic : StringFormat.GenericDefault).Clone())
                    {
                        graphics.Clear(Color.White);
                        graphics.TextRenderingHint = TextRenderingHint.AntiAlias;
                        graphics.TextContrast = 0;
                        format.FormatFlags |= StringFormatFlags.NoWrap | StringFormatFlags.NoFontFallback;
                        if (heldout) format.FormatFlags |= StringFormatFlags.MeasureTrailingSpaces;
                        format.Alignment = (StringAlignment)align;
                        format.LineAlignment = (StringAlignment)line;
                        flags = (int)format.FormatFlags;
                        measured = graphics.MeasureString(text, font, rect.Size, format);
                        graphics.DrawString(text, font, Brushes.Black, rect, format);
                    }
                    var data = bitmap.LockBits(new Rectangle(0, 0, 256, 160), ImageLockMode.ReadOnly, bitmap.PixelFormat);
                    var bytes = new byte[256 * 160 * 4];
                    try
                    {
                        for (int y = 0; y < 160; y++)
                            Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), bytes, y * 1024, 1024);
                    }
                    finally { bitmap.UnlockBits(data); }
                    if (!first) writer.Write(',');
                    first = false;
                    writer.Write("{\"family\":\"" + family.Name + "\",\"style\":" + style + ",\"size\":" + size +
                        ",\"heldout\":" + (heldout ? "true" : "false") + ",\"typo\":" + (typo ? "true" : "false") +
                        ",\"flags\":" + flags + ",\"align\":" + align + ",\"line\":" + line + ",\"text\":\"" + text +
                        "\",\"x\":" + Number(rect.X) + ",\"y\":" + Number(rect.Y) + ",\"width\":" + Number(rect.Width) +
                        ",\"height\":" + Number(rect.Height) + ",\"measuredWidth\":" + Number(measured.Width) +
                        ",\"measuredHeight\":" + Number(measured.Height) + ",\"bgra\":\"" + Convert.ToBase64String(bytes) + "\"}");
                }
                writer.Write(']');
            }
        }
    }
}
