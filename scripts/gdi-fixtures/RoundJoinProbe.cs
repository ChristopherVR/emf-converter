// Public GDI+ controls only (Graphics.DrawLines); no native implementation is inspected.
// A round join through a small turn: a 3-point polyline (a 30 pixel lead-in, a turn of 0.5 to 20 degrees to either side, a straight run of 60
// pixels) drawn antialiased with a flat-capped, round-joined pen of width 3, 6 and 14 along three directions (down, right, 30 degrees below
// right). The straight run's edges sit on whole-pixel lines in the first two: the antialiased coverage shows whether they moved.
// `round-join-small-turn.json.gz`: [{ width, direction (degrees), turn (degrees), points (x, y pairs, single precision),
// rows ([y, x0, hex]: one hex byte of 255 - red per pixel from x0 to the last painted pixel of the row) }].
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Text;

public static class RoundJoinProbe
{
    const int Size = 200;
    static string F(float v) { return v.ToString("R", CultureInfo.InvariantCulture); }

    public static void Run(string dir)
    {
        var json = new StringBuilder("[");
        int count = 0;
        foreach (float width in new[] { 3f, 6f, 14f })
            foreach (double direction in new[] { 90.0, 0.0, 30.0 })
                for (int step = 1; step <= 40; step++)
                {
                    double turn = step * 0.5 * (step % 2 == 0 ? 1 : -1);
                    double phi = direction * Math.PI / 180, dev = turn * Math.PI / 180;
                    var pts = new[]
                    {
                        new PointF((float)(100 - 30 * Math.Cos(phi + dev)), (float)(60 - 30 * Math.Sin(phi + dev))),
                        new PointF(100, 60),
                        new PointF((float)(100 + 60 * Math.Cos(phi)), (float)(60 + 60 * Math.Sin(phi))),
                    };
                    using (var b = new Bitmap(Size, Size, PixelFormat.Format32bppArgb))
                    {
                        using (var g = Graphics.FromImage(b))
                        using (var pen = new Pen(Color.Black, width))
                        {
                            g.SmoothingMode = SmoothingMode.AntiAlias;
                            g.Clear(Color.White);
                            pen.LineJoin = LineJoin.Round;
                            g.DrawLines(pen, pts);
                        }
                        if (count++ > 0) json.Append(',');
                        json.Append("{\"width\":").Append(F(width)).Append(",\"direction\":").Append(F((float)direction)).Append(",\"turn\":").Append(F((float)turn)).Append(",\"points\":[");
                        for (int j = 0; j < pts.Length; j++) { if (j > 0) json.Append(','); json.Append(F(pts[j].X)).Append(',').Append(F(pts[j].Y)); }
                        json.Append("],\"rows\":[");
                        bool firstRow = true;
                        for (int y = 0; y < Size; y++)
                        {
                            int x0 = -1, x1 = -1;
                            for (int x = 0; x < Size; x++) if (b.GetPixel(x, y).R != 255) { if (x0 < 0) x0 = x; x1 = x; }
                            if (x0 < 0) continue;
                            if (!firstRow) json.Append(',');
                            firstRow = false;
                            json.Append('[').Append(y).Append(',').Append(x0).Append(",\"");
                            for (int x = x0; x <= x1; x++) json.Append((255 - b.GetPixel(x, y).R).ToString("x2"));
                            json.Append("\"]");
                        }
                        json.Append("]}");
                    }
                }
        json.Append(']');
        using (var file = File.Create(Path.Combine(dir, "round-join-small-turn.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress))
        {
            var bytes = Encoding.UTF8.GetBytes(json.ToString());
            zip.Write(bytes, 0, bytes.Length);
        }
        Console.WriteLine("round-join-small-turn.json.gz: " + count + " cases");
    }
}
