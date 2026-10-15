// Public GDI+ DrawString advances of every printable ASCII glyph: each glyph is drawn once and in a run of 30 copies on
// white, with the default StringFormat and with GenericTypographic, under AntiAliasGridFit (3) and ClearTypeGridFit (5).
// The capture keeps the first and last ink columns of both draws, so (last of 30 - last of 1) / 29 is the mean advance in
// device pixels: a whole number when every gap is the same, a fraction when GDI+ redistributes the run.
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.Text;

public static class TextAdvanceProbe
{
    static int[] Ink(string face, int style, float size, int hint, bool typo, string text, int width)
    {
        using (var font = new Font(face, size, (FontStyle)style, GraphicsUnit.Pixel))
        using (var bmp = new Bitmap(width, (int)(size * 1.6f) + 4, PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(bmp))
            {
                g.Clear(Color.White);
                g.TextRenderingHint = (TextRenderingHint)hint;
                g.TextContrast = 0;
                if (typo) g.DrawString(text, font, Brushes.Black, 4, 2, StringFormat.GenericTypographic);
                else g.DrawString(text, font, Brushes.Black, 4, 2);
            }
            var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            var bytes = new byte[data.Stride * bmp.Height];
            System.Runtime.InteropServices.Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
            bmp.UnlockBits(data);
            int lo = int.MaxValue, hi = -1;
            for (int y = 0; y < bmp.Height; y++)
                for (int x = 0; x < bmp.Width; x++)
                    if (bytes[y * data.Stride + x * 4] < 255 || bytes[y * data.Stride + x * 4 + 1] < 255 || bytes[y * data.Stride + x * 4 + 2] < 255) { if (x < lo) lo = x; if (x > hi) hi = x; }
            return new[] { lo == int.MaxValue ? -1 : lo, hi };
        }
    }

    public static void Run(string dir)
    {
        Directory.CreateDirectory(dir);
        var json = new StringBuilder("[");
        bool first = true;
        var faces = new[] { new object[] { "Arial", 0 }, new object[] { "Arial", 1 }, new object[] { "Times New Roman", 0 }, new object[] { "Tahoma", 0 } };
        foreach (var f in faces)
        foreach (int size in new[] { 12, 16, 20, 40 })
        foreach (int hint in new[] { 3, 5 })
        foreach (bool typo in new[] { false, true })
        {
            for (int code = 33; code < 127; code++)
            {
                string ch = ((char)code).ToString();
                var one = Ink((string)f[0], (int)f[1], size, hint, typo, ch, (int)(size * 2.4f));
                var many = Ink((string)f[0], (int)f[1], size, hint, typo, new string((char)code, 30), (int)(size * 1.4f * 32));
                if (!first) json.Append(',');
                first = false;
                json.Append("{\"face\":\"").Append(f[0]).Append("\",\"style\":").Append(f[1]).Append(",\"size\":").Append(size).Append(",\"hint\":").Append(hint)
                    .Append(",\"typo\":").Append(typo ? "true" : "false").Append(",\"code\":").Append(code)
                    .Append(",\"one\":[").Append(one[0]).Append(',').Append(one[1]).Append("],\"run\":[").Append(many[0]).Append(',').Append(many[1]).Append("]}");
            }
        }
        json.Append(']');
        var bytesOut = Encoding.UTF8.GetBytes(json.ToString());
        using (var file = File.Create(Path.Combine(dir, "text-advances.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionLevel.Optimal)) zip.Write(bytesOut, 0, bytesOut.Length);
    }
}
