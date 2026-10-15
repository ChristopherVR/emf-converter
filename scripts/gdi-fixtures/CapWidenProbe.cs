// Public GDI+ controls only (GraphicsPath.Widen, Graphics.DrawPath): pen end caps and joins of lines, polylines and Beziers, with the
// outline GraphicsPath.Widen returns and the pixels GDI+ paints (255 - red, 140 x 140, white background), aliased and antialiased.
//  - `cap-widen-round.json.gz`: 400 random lines (widths 1 to 12 including the 4.5 and 5 of the playback fixtures, any direction, fractional end
//    points) with a Round, Flat, Square or Triangle cap at both ends, and 100 random cubic Beziers with Round caps.
//    [{ cap, width, pts (x, y pairs, single precision), widen (x, y pairs), types, aliased, aa }] (rows [y, x0, hex]: one hex byte per pixel
//    from x0 to the last non-zero pixel of the row; `widen` only for the lines).
//  - `cap-widen-custom.json.gz`: 300 pens with custom caps (AdjustableArrowCap filled, open, MiddleInset, WidthScale; CustomLineCap with a
//    fill path, and with a line path with stroke caps and join, BaseInset, WidthScale) on lines (end cap, or start and end), polylines of four
//    points (sharp turns near the ends; pen join Miter, Bevel or Round) and Beziers, at pen widths 1 to 6.
//    [{ cap (end), start (or null), kind, join, width, pts, widen, types, aliased, aa }]. With CAP_WIDEN_DIRECT=1 each case also holds the pixels
//    of DrawLine / DrawLines / DrawBezier (`aaDirect`, `aliasedDirect`), which equal the DrawPath ones on all 420 cases surveyed.
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Text;

public static class CapWidenProbe
{
    static uint seed = 424242;
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

    // The same pen drawn with the direct calls (DrawLine, DrawLines, DrawBezier) instead of DrawPath.
    static string Direct(string kind, PointF[] pts, Pen pen, bool aa)
    {
        using (var b = new Bitmap(Size, Size, PixelFormat.Format32bppArgb))
        using (var g = Graphics.FromImage(b))
        {
            g.SmoothingMode = aa ? SmoothingMode.AntiAlias : SmoothingMode.None;
            g.Clear(Color.White);
            if (kind == "line") g.DrawLine(pen, pts[0], pts[1]);
            else if (kind == "polyline") g.DrawLines(pen, pts);
            else g.DrawBezier(pen, pts[0], pts[1], pts[2], pts[3]);
            return Rows(b);
        }
    }

    static string Record(string cap, float width, PointF[] pts, GraphicsPath path, Pen pen, bool widen)
    {
        var s = "{\"cap\":\"" + cap + "\",\"width\":" + F(width) + ",\"pts\":" + Arr(pts);
        if (widen)
        {
            var w = (GraphicsPath)path.Clone();
            w.Widen(pen);
            s += ",\"widen\":" + Arr(w.PathPoints) + ",\"types\":" + Types(w.PathTypes);
            w.Dispose();
        }
        return s + ",\"aliased\":" + Pixels(path, pen, false) + ",\"aa\":" + Pixels(path, pen, true) + "}";
    }

    public static void Run(string dir)
    {
        var round = new StringBuilder("[");
        int n = 0;
        var caps = new[] { LineCap.Round, LineCap.Flat, LineCap.Square, LineCap.Triangle };
        var widths = new[] { 1f, 2f, 3f, 4.5f, 5f, 6f, 8f, 10f, 12f };
        for (int i = 0; i < 400; i++)
        {
            float width = i < 200 ? widths[i % widths.Length] : (float)(1 + Rnd() * 11);
            var cap = caps[i % 4];
            if (i % 3 == 0) cap = LineCap.Round;
            double ang = Rnd() * 2 * Math.PI, len = 20 + Rnd() * 30;
            float x0 = (float)(60 + Rnd() * 20), y0 = (float)(60 + Rnd() * 20);
            var pts = new[] { new PointF(x0, y0), new PointF((float)(x0 + len * Math.Cos(ang)), (float)(y0 + len * Math.Sin(ang))) };
            using (var path = new GraphicsPath())
            using (var pen = new Pen(Color.Black, width))
            {
                path.AddLine(pts[0], pts[1]);
                pen.StartCap = cap; pen.EndCap = cap;
                if (n++ > 0) round.Append(',');
                round.Append(Record(cap.ToString(), width, pts, path, pen, true));
            }
        }
        for (int i = 0; i < 100; i++)
        {
            float width = i < 50 ? (i % 2 == 0 ? 5f : 4.5f) : (float)(1 + Rnd() * 11);
            var pts = new PointF[4];
            for (int k = 0; k < 4; k++) pts[k] = new PointF((float)(20 + Rnd() * 100), (float)(20 + Rnd() * 100));
            using (var path = new GraphicsPath())
            using (var pen = new Pen(Color.Black, width))
            {
                path.AddBezier(pts[0], pts[1], pts[2], pts[3]);
                pen.StartCap = LineCap.Round; pen.EndCap = LineCap.Round;
                if (n++ > 0) round.Append(',');
                round.Append(Record("RoundBezier", width, pts, path, pen, false));
            }
        }
        round.Append(']');
        WriteGz(dir, "cap-widen-round.json.gz", round.ToString());

        var custom = new StringBuilder("[");
        n = 0;
        using (var filled = new AdjustableArrowCap(3f, 4f, true))
        using (var open = new AdjustableArrowCap(2.5f, 3f, false))
        using (var mid = new AdjustableArrowCap(3.5f, 4.5f, true))
        using (var small = new AdjustableArrowCap(4f, 3f, true))
        using (var fillPath = new GraphicsPath())
        using (var linePath = new GraphicsPath())
        {
            mid.MiddleInset = 1.5f;
            small.WidthScale = 0.6f;
            fillPath.AddPolygon(new PointF[] { new PointF(-1.5f, -1.2f), new PointF(0f, 2f), new PointF(1.5f, -1.2f), new PointF(0f, -0.4f) });
            linePath.AddLines(new PointF[] { new PointF(-1.5f, -0.6f), new PointF(0f, 1.4f), new PointF(1.5f, -0.6f) });
            using (var fillCap = new CustomLineCap(fillPath, null, LineCap.Flat, 0.5f))
            using (var lineCap = new CustomLineCap(null, linePath, LineCap.Round, 1f))
            using (var lineCap2 = new CustomLineCap(null, linePath, LineCap.Flat, 0f))
            {
                fillCap.WidthScale = 1.5f;
                lineCap.StrokeJoin = LineJoin.Round;
                lineCap.SetStrokeCaps(LineCap.Round, LineCap.Triangle);
                lineCap2.SetStrokeCaps(LineCap.Square, LineCap.Flat);
                lineCap2.StrokeJoin = LineJoin.Bevel;
                var names = new[] { "filled", "open", "mid", "small", "fillCap", "lineCap", "lineCap2" };
                var capsList = new CustomLineCap[] { filled, open, mid, small, fillCap, lineCap, lineCap2 };
                var cw = new[] { 1f, 2f, 3f, 4.5f, 6f };
                // i % 3: 0 a line with an end cap, 1 a line with a start and an end cap, 2 a polyline of four points (sharp turns near the ends)
                // or a cubic Bezier with both caps.
                for (int i = 0; i < 300; i++)
                {
                    int ci = i % capsList.Length;
                    int si = (i / 3 + 2) % capsList.Length;
                    float width = cw[(i / capsList.Length) % cw.Length];
                    int shape = i % 3;
                    double ang = Rnd() * 2 * Math.PI, len = 30 + Rnd() * 25;
                    float x0 = (float)(60 + Rnd() * 20), y0 = (float)(60 + Rnd() * 20);
                    PointF[] pts;
                    if (shape < 2) pts = new[] { new PointF(x0, y0), new PointF((float)(x0 + len * Math.Cos(ang)), (float)(y0 + len * Math.Sin(ang))) };
                    else
                    {
                        pts = new PointF[4];
                        for (int k = 0; k < 4; k++) pts[k] = new PointF((float)(30 + Rnd() * 80), (float)(30 + Rnd() * 80));
                    }
                    using (var path = new GraphicsPath())
                    using (var pen = new Pen(Color.Black, width))
                    {
                        string kind = shape < 2 ? "line" : (i % 2 == 0 ? "polyline" : "bezier");
                        if (shape < 2) path.AddLine(pts[0], pts[1]);
                        else if (kind == "polyline") path.AddLines(pts);
                        else path.AddBezier(pts[0], pts[1], pts[2], pts[3]);
                        LineJoin join = shape == 2 ? (LineJoin)((i / 6) % 3) : LineJoin.Miter;
                        pen.LineJoin = join;
                        pen.CustomEndCap = capsList[ci];
                        if (shape > 0) pen.CustomStartCap = capsList[si];
                        if (n++ > 0) custom.Append(',');
                        string rec = Record(names[ci], width, pts, path, pen, true);
                        string direct = Environment.GetEnvironmentVariable("CAP_WIDEN_DIRECT") == "1" ? ",\"aaDirect\":" + Direct(kind, pts, pen, true) + ",\"aliasedDirect\":" + Direct(kind, pts, pen, false) : "";
                        custom.Append(rec.Substring(0, rec.Length - 1)).Append(direct).Append(",\"join\":" + (int)join + ",\"kind\":\"" + kind + "\",\"start\":" + (shape > 0 ? "\"" + names[si] + "\"" : "null") + "}");
                    }
                }
            }
        }
        custom.Append(']');
        WriteGz(dir, "cap-widen-custom.json.gz", custom.ToString());
    }

    static void WriteGz(string dir, string name, string text)
    {
        using (var file = File.Create(Path.Combine(dir, name)))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress))
        {
            var bytes = Encoding.UTF8.GetBytes(text);
            zip.Write(bytes, 0, bytes.Length);
        }
        Console.WriteLine(name);
    }
}
