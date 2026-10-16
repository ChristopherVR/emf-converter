// Public GDI+ controls only (GraphicsPath.Widen, Graphics.DrawPath): dashed pens on open lines, polylines and closed triangles, with the
// outline GraphicsPath.Widen returns and the pixels GDI+ paints (255 - red, 140 x 140, white background), aliased and antialiased.
// `dash-widen.json.gz`: [{ kind (line | polyline | closed), width, dashCap (DashCap), startCap, join, pattern (pen widths, or null for a stock
//  DashStyle), style (DashStyle), offset (pen widths), pts (x, y pairs, single precision), widen, types, aliased, aa }].
//  - patterns include dashes of 0.25 to 4 pen widths, so a Round or Triangle DashCap meets dashes shorter than the cap (the straight part would
//    be negative) as well as longer ones;
//  - the open lines also carry a Round start cap, to see how the line's own caps and the dash caps combine.
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Text;

public static class DashWidenProbe
{
    static uint seed = 31415926;
    static double Rnd() { seed = unchecked(seed * 1664525u + 1013904223u); return seed / 4294967296.0; }
    static string F(float v) { return v.ToString("R", CultureInfo.InvariantCulture); }

    static string Arr(PointF[] p)
    {
        var sb = new StringBuilder("[");
        for (int i = 0; i < p.Length; i++) { if (i > 0) sb.Append(','); sb.Append(F(p[i].X)).Append(',').Append(F(p[i].Y)); }
        return sb.Append(']').ToString();
    }

    static string Types(byte[] t)
    {
        var sb = new StringBuilder("[");
        for (int i = 0; i < t.Length; i++) { if (i > 0) sb.Append(','); sb.Append((int)t[i]); }
        return sb.Append(']').ToString();
    }

    const int Size = 140;

    static string Rows(Bitmap b)
    {
        var sb = new StringBuilder("[");
        bool firstRow = true;
        for (int y = 0; y < Size; y++)
        {
            int x0 = -1, x1 = -1;
            for (int x = 0; x < Size; x++) if (b.GetPixel(x, y).R != 255) { if (x0 < 0) x0 = x; x1 = x; }
            if (x0 < 0) continue;
            if (!firstRow) sb.Append(',');
            firstRow = false;
            sb.Append('[').Append(y).Append(',').Append(x0).Append(",\"");
            for (int x = x0; x <= x1; x++) sb.Append((255 - b.GetPixel(x, y).R).ToString("x2"));
            sb.Append("\"]");
        }
        return sb.Append(']').ToString();
    }

    static string Pixels(GraphicsPath path, Pen pen, bool aa)
    {
        using (var b = new Bitmap(Size, Size, PixelFormat.Format32bppArgb))
        using (var g = Graphics.FromImage(b))
        {
            g.SmoothingMode = aa ? SmoothingMode.AntiAlias : SmoothingMode.None;
            g.Clear(Color.White);
            g.DrawPath(pen, path);
            return Rows(b);
        }
    }

    public static void Run(string dir)
    {
        var json = new StringBuilder("[");
        int n = 0;
        var widths = new[] { 2f, 3f, 4.5f, 6f, 8f, 12f };
        var caps = new[] { DashCap.Flat, DashCap.Round, DashCap.Triangle };
        var patterns = new[]
        {
            new[] { 0.25f, 1f }, new[] { 0.5f, 1.5f }, new[] { 1f, 1f }, new[] { 0.75f, 2f }, new[] { 1.5f, 1f }, new[] { 2f, 1f, 0.5f, 1.5f },
            new[] { 3f, 1f, 1f, 1f }, new[] { 4f, 2f }, new[] { 0.5f, 0.5f }, new[] { 2f, 3f, 0.25f, 0.75f },
        };
        for (int i = 0; i < 480; i++)
        {
            string kind = i % 3 == 0 ? "line" : i % 3 == 1 ? "polyline" : "closed";
            float width = widths[(i / 3) % widths.Length];
            var cap = caps[(i / 18) % caps.Length];
            bool stock = (i / 54) % 5 == 4;
            var style = stock ? (DashStyle)(1 + (i / 3) % 4) : DashStyle.Custom;
            float[] pattern = stock ? null : patterns[(i / 3) % patterns.Length];
            float offset = new[] { 0f, 0.5f, 1.25f }[(i / 7) % 3];
            PointF[] pts;
            if (kind == "line")
            {
                double ang = Rnd() * 2 * Math.PI, len = 30 + Rnd() * 40;
                float x0 = (float)(50 + Rnd() * 40), y0 = (float)(50 + Rnd() * 40);
                pts = new[] { new PointF(x0, y0), new PointF((float)(x0 + len * Math.Cos(ang)), (float)(y0 + len * Math.Sin(ang))) };
            }
            else
            {
                int count = kind == "closed" ? 3 : 3 + (i % 2);
                pts = new PointF[count];
                for (int k = 0; k < count; k++) pts[k] = new PointF((float)(25 + Rnd() * 90), (float)(25 + Rnd() * 90));
            }
            var join = (LineJoin)(i % 3);
            using (var path = new GraphicsPath())
            using (var pen = new Pen(Color.Black, width))
            {
                if (kind == "closed") path.AddPolygon(pts); else path.AddLines(pts);
                if (style == DashStyle.Custom) pen.DashPattern = pattern; else pen.DashStyle = style;
                pen.DashCap = cap; pen.DashOffset = offset; pen.LineJoin = join;
                var startCap = kind != "closed" && i % 2 == 0 ? LineCap.Round : LineCap.Flat;
                pen.StartCap = startCap;
                var w = (GraphicsPath)path.Clone();
                w.Widen(pen);
                if (n++ > 0) json.Append(',');
                json.Append("{\"kind\":\"").Append(kind).Append("\",\"width\":").Append(F(width)).Append(",\"dashCap\":").Append((int)cap)
                    .Append(",\"startCap\":").Append((int)startCap).Append(",\"join\":").Append((int)join).Append(",\"style\":").Append((int)style)
                    .Append(",\"pattern\":").Append(pattern == null ? "null" : Arr2(pattern)).Append(",\"offset\":").Append(F(offset))
                    .Append(",\"pts\":").Append(Arr(pts)).Append(",\"widen\":").Append(Arr(w.PathPoints)).Append(",\"types\":").Append(Types(w.PathTypes))
                    .Append(",\"aliased\":").Append(Pixels(path, pen, false)).Append(",\"aa\":").Append(Pixels(path, pen, true)).Append('}');
                w.Dispose();
            }
        }
        // The figures of the `gpx-pen-inset-dashround` sheet (a rectangle, a triangle and the ten-point concave star) as Center pens: widths of 3 to
        // 14 pixels with the stock Dash and DashDot styles, Round and Triangle dash caps, dash offsets 0 and 0.5.
        var sheet = new[]
        {
            new[] { new PointF(10, 12), new PointF(100, 12), new PointF(100, 70), new PointF(10, 70) },
            new[] { new PointF(55, 10), new PointF(102, 72), new PointF(12, 60) },
            new[] { new PointF(55, 8), new PointF(68, 30), new PointF(100, 34), new PointF(74, 50), new PointF(82, 76), new PointF(55, 60), new PointF(28, 76), new PointF(36, 50), new PointF(10, 34), new PointF(42, 30) },
        };
        for (int shape = 0; shape < sheet.Length; shape++)
            foreach (float width in new[] { 3f, 6f, 9f, 14f })
                foreach (var style in new[] { DashStyle.Dash, DashStyle.DashDot })
                    foreach (var cap in new[] { DashCap.Round, DashCap.Triangle })
                        foreach (float offset in new[] { 0f, 0.5f })
                        foreach (bool inset in new[] { false, true })
                        {
                            var pts = sheet[shape];
                            var join = width > 6 ? LineJoin.Round : LineJoin.Miter;
                            using (var path = new GraphicsPath())
                            using (var pen = new Pen(Color.Black, width))
                            {
                                path.AddPolygon(pts);
                                pen.DashStyle = style; pen.DashCap = cap; pen.DashOffset = offset; pen.LineJoin = join; if (inset) pen.Alignment = PenAlignment.Inset;
                                var w = (GraphicsPath)path.Clone();
                                w.Widen(pen);
                                if (n++ > 0) json.Append(',');
                                json.Append("{\"kind\":\"closed\",\"inset\":").Append(inset ? "true" : "false").Append(",\"width\":").Append(F(width)).Append(",\"dashCap\":").Append((int)cap)
                                    .Append(",\"startCap\":0,\"join\":").Append((int)join).Append(",\"style\":").Append((int)style)
                                    .Append(",\"pattern\":null,\"offset\":").Append(F(offset))
                                    .Append(",\"pts\":").Append(Arr(pts)).Append(",\"widen\":").Append(Arr(w.PathPoints)).Append(",\"types\":").Append(Types(w.PathTypes))
                                    .Append(",\"aliased\":").Append(Pixels(path, pen, false)).Append(",\"aa\":").Append(Pixels(path, pen, true)).Append('}');
                                w.Dispose();
                            }
                        }
        json.Append(']');
        using (var file = File.Create(Path.Combine(dir, "dash-widen.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress))
        {
            var bytes = Encoding.UTF8.GetBytes(json.ToString());
            zip.Write(bytes, 0, bytes.Length);
        }
        Console.WriteLine("dash-widen.json.gz: " + n + " cases");
    }

    static string Arr2(float[] p)
    {
        var sb = new StringBuilder("[");
        for (int i = 0; i < p.Length; i++) { if (i > 0) sb.Append(','); sb.Append(F(p[i])); }
        return sb.Append(']').ToString();
    }
}
