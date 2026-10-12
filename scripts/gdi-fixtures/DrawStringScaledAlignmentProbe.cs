// Native positive-uniform scale controls and independent held-out matrices.
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;

public static class DrawStringScaledAlignmentProbe
{
    static string Number(float value) { return value.ToString("R", CultureInfo.InvariantCulture); }

    public static void Run(string fontSource, int style, bool heldout, string output)
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
                foreach (int size in heldout ? new[] { 20, 24 } : new[] { 16, 20 })
                using (var font = new Font(family, size, (FontStyle)style, GraphicsUnit.Pixel))
                foreach (bool typo in new[] { false, true })
                foreach (float scale in heldout ? new[] { 0.6f, 1.1f, 1.3f, 1.75f } : new[] { 0.75f, 1.25f, 1.5f, 2.0f })
                foreach (int align in new[] { 0, 1, 2 })
                foreach (int line in new[] { 0, 1, 2 })
                foreach (string text in custom
                    ? new[] { "A", "AA", "A\ue000\ue001", "A  " }
                    : new[] { "j", "AV", "j W", "fi fl  " })
                using (var bitmap = new Bitmap(256, 160, PixelFormat.Format32bppArgb))
                {
                    var rect = heldout ? new RectangleF(11.75f, 8.25f, 105.5f, 62.25f) : new RectangleF(12.25f, 10.5f, 100, 60);
                    float tx = heldout ? -2.75f : 3.25f, ty = heldout ? 4.25f : 2.5f;
                    SizeF measured;
                    int flags;
                    using (var graphics = Graphics.FromImage(bitmap))
                    using (var format = (StringFormat)(typo ? StringFormat.GenericTypographic : StringFormat.GenericDefault).Clone())
                    {
                        graphics.Clear(Color.White);
                        graphics.TextRenderingHint = TextRenderingHint.AntiAlias;
                        using (var matrix = new System.Drawing.Drawing2D.Matrix(scale, 0, 0, scale, tx, ty)) graphics.Transform = matrix;
                        graphics.TextContrast = 0;
                        format.FormatFlags |= StringFormatFlags.NoWrap | StringFormatFlags.NoFontFallback;
                        // Both captures deliberately exclude trailing spaces from alignment.
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
                        ",\"sx\":" + Number(scale) + ",\"sy\":" + Number(scale) + ",\"tx\":" + Number(tx) + ",\"ty\":" + Number(ty) + ",\"heldout\":" + (heldout ? "true" : "false") + ",\"typo\":" + (typo ? "true" : "false") +
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
