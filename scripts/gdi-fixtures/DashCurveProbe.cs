// Public GDI+ controls only (GraphicsPath.Flatten, GraphicsPath.Widen, Graphics.DrawPath): where GDI+ cuts the dashes of a dashed pen on a Bezier curve.
//
// `dash-curve.json.gz`: 120 random cubic Beziers (control points in 20..100, single precision), each followed by a 250 pixel horizontal line
// from the curve's end, drawn as one open path with a Center pen of width 2 and a Flat dash cap, pattern 7 and 5 pixels or 10 and 2 pixels:
// [{ b (the four control points, x y pairs), pat (dash, gap in pixels), flat (GraphicsPath.Flatten(matrix, 0.25) points), widen
//    (GraphicsPath.Widen(pen) points), types, linesWiden and linesTypes (the same for the control path made of the flattened vertices as
//    straight lines, then the 250 pixel line) }]. The line carries many cuts at exactly known distances from the curve's end, so the length of the
// curve as the dasher measured it is the distance of the first cut from a multiple of the period.
//
// `RunEquivalence` (console only): the Inset dashed sheet figures (`gpx-pen-inset-dash`, widths 3 to 14) drawn natively with an Inset pen, against
// SetClip(figure) + a Center pen of twice the width whose dash lengths are the same pixels (the pattern in pen widths halved) and whose dash offset
// is the same number of (doubled) pen widths; aliased, the two bitmaps are identical for all 24 figures.
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Text;

public static class DashCurveProbe
{
    static uint seed = 4242;
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
        for (int i = 0; i < t.Length; i++) { if (i > 0) sb.Append(','); sb.Append(t[i]); }
        return sb.Append(']').ToString();
    }

    public static void Run(string dir)
    {
        var json = new StringBuilder("[");
        const int count = 120;
        for (int k = 0; k < count; k++)
        {
            var b = new PointF[4];
            for (int i = 0; i < 4; i++) b[i] = new PointF((float)(20 + Rnd() * 80), (float)(20 + Rnd() * 80));
            if (k % 3 == 0)
            {
                // A quarter circle of random radius, as the arcs of a rounded rectangle are.
                float r = (float)(5 + Rnd() * 50);
                using (var gp = new GraphicsPath())
                {
                    gp.AddArc(30, 30, 2 * r, 2 * r, 180, 90);
                    b = gp.PathPoints;
                }
            }
            using (var path = new GraphicsPath())
            {
                path.AddBezier(b[0], b[1], b[2], b[3]);
                path.AddLine(b[3], new PointF(b[3].X + 250, b[3].Y));
                float[] pat = k % 2 == 0 ? new float[] { 3.5f, 2.5f } : new float[] { 5f, 1f };
                using (var pen = new Pen(Color.Black, 2f))
                {
                    pen.DashPattern = pat; pen.DashCap = DashCap.Flat;
                    var widened = (GraphicsPath)path.Clone();
                    widened.Widen(pen, new Matrix(), 0.25f);
                    var flat = (GraphicsPath)path.Clone();
                    flat.Flatten(new Matrix(), 0.25f);
                    // The control: the same flattened vertices handed to GDI+ as straight lines.
                    var lines = new GraphicsPath();
                    var curvePts = new PointF[flat.PathPoints.Length - 1];
                    Array.Copy(flat.PathPoints, curvePts, curvePts.Length);
                    lines.AddLines(curvePts);
                    lines.AddLine(curvePts[curvePts.Length - 1], new PointF(curvePts[curvePts.Length - 1].X + 250, curvePts[curvePts.Length - 1].Y));
                    var linesWidened = (GraphicsPath)lines.Clone();
                    linesWidened.Widen(pen, new Matrix(), 0.25f);
                    if (k > 0) json.Append(',');
                    json.Append("{\"b\":").Append(Arr(b)).Append(",\"pat\":[").Append(F(pat[0] * 2f)).Append(',').Append(F(pat[1] * 2f)).Append("],\"flat\":").Append(Arr(flat.PathPoints))
                        .Append(",\"widen\":").Append(Arr(widened.PathPoints)).Append(",\"types\":").Append(Types(widened.PathTypes))
                        .Append(",\"linesWiden\":").Append(Arr(linesWidened.PathPoints)).Append(",\"linesTypes\":").Append(Types(linesWidened.PathTypes)).Append('}');
                    widened.Dispose(); flat.Dispose(); lines.Dispose(); linesWidened.Dispose();
                }
            }
        }
        json.Append(']');
        using (var file = File.Create(Path.Combine(dir, "dash-curve.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress))
        {
            var bytes = Encoding.UTF8.GetBytes(json.ToString());
            zip.Write(bytes, 0, bytes.Length);
        }
        Console.WriteLine("dash-curve.json.gz: " + count + " cases");
        RunEquivalence();
        RunInsetDashPolygons(dir);
    }

    static GraphicsPath SheetFigure(int col, int row)
    {
        float x = 10 + col * 120, y = 8 + row * 78;
        var path = new GraphicsPath();
        switch (row)
        {
            case 0: path.AddRectangle(new RectangleF(x, y + 4, 90, 58)); break;
            case 1: path.AddEllipse(x, y + 4, 90, 58); break;
            case 2: path.AddPolygon(new PointF[] { new PointF(x + 45, y + 2), new PointF(x + 92, y + 64), new PointF(x + 2, y + 52) }); break;
            case 3: path.AddPolygon(new PointF[] { new PointF(x + 45, y), new PointF(x + 58, y + 22), new PointF(x + 90, y + 26), new PointF(x + 64, y + 42), new PointF(x + 72, y + 68), new PointF(x + 45, y + 52), new PointF(x + 18, y + 68), new PointF(x + 26, y + 42), new PointF(x, y + 26), new PointF(x + 32, y + 22) }); break;
            case 4: path.AddClosedCurve(new PointF[] { new PointF(x + 6, y + 20), new PointF(x + 50, y + 2), new PointF(x + 88, y + 28), new PointF(x + 60, y + 64), new PointF(x + 20, y + 54) }); break;
            default:
                path.AddArc(x, y + 4, 28, 28, 180, 90); path.AddArc(x + 62, y + 4, 28, 28, 270, 90);
                path.AddArc(x + 62, y + 34, 28, 28, 0, 90); path.AddArc(x, y + 34, 28, 28, 90, 90);
                path.CloseFigure(); break;
        }
        return path;
    }

    static Bitmap Draw(Action<Graphics> f)
    {
        var bmp = new Bitmap(500, 480, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp)) { g.SmoothingMode = SmoothingMode.None; g.Clear(Color.White); f(g); }
        return bmp;
    }

    static int Diff(Bitmap a, Bitmap b)
    {
        int n = 0;
        for (int y = 0; y < 480; y++) for (int x = 0; x < 500; x++) if (a.GetPixel(x, y).ToArgb() != b.GetPixel(x, y).ToArgb()) n++;
        return n;
    }

    public static void RunEquivalence()
    {
        float[] widths = { 3f, 6f, 9f, 14f };
        int figures = 0, differing = 0;
        for (int col = 0; col < 4; col++)
            for (int row = 0; row < 6; row++)
            {
                float w = widths[col];
                float[] pat = col < 2 ? new float[] { 3, 1 } : new float[] { 3, 1, 1, 1 };
                float off = col % 2 == 1 ? 0.5f : 0f;
                LineJoin join = col % 2 == 0 ? LineJoin.Miter : LineJoin.Round;
                var inset = Draw(g =>
                {
                    using (var path = SheetFigure(col, row))
                    using (var pen = new Pen(Color.Black, w))
                    {
                        pen.Alignment = PenAlignment.Inset; pen.LineJoin = join; pen.DashStyle = col < 2 ? DashStyle.Dash : DashStyle.DashDot; pen.DashOffset = off;
                        g.DrawPath(pen, path);
                    }
                });
                var clipped = Draw(g =>
                {
                    using (var path = SheetFigure(col, row))
                    using (var pen = new Pen(Color.Black, 2 * w))
                    {
                        var half = new float[pat.Length];
                        for (int i = 0; i < pat.Length; i++) half[i] = pat[i] / 2;
                        pen.LineJoin = join; pen.DashPattern = half; pen.DashOffset = off;
                        g.SetClip(path);
                        g.DrawPath(pen, path);
                    }
                });
                figures++;
                if (Diff(inset, clipped) != 0) differing++;
            }
        Console.WriteLine("Inset flat dash vs SetClip + Center pen of twice the width: " + differing + " of " + figures + " figures differ");
    }

    static string Rows(Bitmap b)
    {
        var sb = new StringBuilder("[");
        bool first = true;
        for (int y = 0; y < 480; y++)
        {
            int x0 = -1, x1 = -1;
            for (int x = 0; x < 500; x++) if (b.GetPixel(x, y).R != 255) { if (x0 < 0) x0 = x; x1 = x; }
            if (x0 < 0) continue;
            if (!first) sb.Append(',');
            first = false;
            sb.Append('[').Append(y).Append(',').Append(x0).Append(",\"");
            for (int x = x0; x <= x1; x++) sb.Append((255 - b.GetPixel(x, y).R).ToString("x2"));
            sb.Append("\"]");
        }
        return sb.Append(']').ToString();
    }

    /**
     * `inset-dash-polygons.json.gz`: the 24 figures of the `gpx-pen-inset-dash` sheets (Dash and DashDot, widths 3 to 14, flat dash caps) drawn one at a
     * time with their Inset pen, aliased and antialiased (pixels as rows [y, x0, hex of 255 - red]), and the polygons `GraphicsPath.Widen(pen,
     * new Matrix(), 0.25)` returns for the same pen (whole-pixel coordinates): [{ col, row, width, join, widen, types, aliased, aa }].
     */
    public static void RunInsetDashPolygons(string dir)
    {
        float[] widths = { 3f, 6f, 9f, 14f };
        var json = new StringBuilder("[");
        int n = 0;
        for (int col = 0; col < 4; col++)
            for (int row = 0; row < 6; row++)
            {
                float w = widths[col];
                LineJoin join = col % 2 == 0 ? LineJoin.Miter : LineJoin.Round;
                Func<Pen> makePen = () =>
                {
                    var pen = new Pen(Color.FromArgb(255, 0, 110, 200), w);
                    pen.Alignment = PenAlignment.Inset; pen.LineJoin = join; pen.DashStyle = col < 2 ? DashStyle.Dash : DashStyle.DashDot; pen.DashOffset = col % 2 == 1 ? 0.5f : 0f;
                    return pen;
                };
                string[] pix = new string[2];
                for (int m = 0; m < 2; m++)
                {
                    var bmp = Draw(g =>
                    {
                        g.SmoothingMode = m == 0 ? SmoothingMode.None : SmoothingMode.AntiAlias;
                        using (var path = SheetFigure(col, row))
                        using (var pen = makePen()) g.DrawPath(pen, path);
                    });
                    pix[m] = Rows(bmp);
                }
                using (var path = SheetFigure(col, row))
                using (var pen = makePen())
                {
                    var widened = (GraphicsPath)path.Clone();
                    widened.Widen(pen, new Matrix(), 0.25f);
                    if (n++ > 0) json.Append(',');
                    json.Append("{\"col\":").Append(col).Append(",\"row\":").Append(row).Append(",\"width\":").Append(F(w)).Append(",\"join\":").Append((int)join)
                        .Append(",\"widen\":").Append(Arr(widened.PathPoints)).Append(",\"types\":").Append(Types(widened.PathTypes))
                        .Append(",\"aliased\":").Append(pix[0]).Append(",\"aa\":").Append(pix[1]).Append('}');
                    widened.Dispose();
                }
            }
        json.Append(']');
        using (var file = File.Create(Path.Combine(dir, "inset-dash-polygons.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress))
        {
            var bytes = Encoding.UTF8.GetBytes(json.ToString());
            zip.Write(bytes, 0, bytes.Length);
        }
        Console.WriteLine("inset-dash-polygons.json.gz: " + n + " figures");
    }
}
