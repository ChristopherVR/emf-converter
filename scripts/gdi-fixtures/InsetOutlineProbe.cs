// Public GDI+ controls only (GraphicsPath.Widen, Graphics.DrawPolygon); no native implementation is inspected.
// Inset-aligned pens on closed polygons: for 120 deterministic polygons (triangles, star-shaped polygons and polygons made of a flattened
// ellipse, rounded rectangle or closed curve) drawn aliased and antialiased with an Inset pen of width 2 to 6 and a Miter, Bevel or Round join,
// the pixels GDI+ paints (255 - red, 130 x 130, white background, default pixel offset) and the polygon `GraphicsPath.Widen` returns for the
// same pen. `inset-outline.json.gz`: [{ kind, join (LineJoin), width, src (x, y pairs, single precision), widen (x, y pairs), types
// (path point types), aliased and aa (rows [y, x0, hex]: one hex byte per pixel from x0 to the last non-zero pixel of the row) }].
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Text;

public static class InsetOutlineProbe
{
    const int Size = 130;
    static uint seed = 12345;
    static double Rnd() { seed = unchecked(seed * 1664525u + 1013904223u); return seed / 4294967296.0; }
    static string F(float v) { return v.ToString("R", CultureInfo.InvariantCulture); }

    static PointF[] Triangle()
    {
        var p = new PointF[3];
        for (int i = 0; i < 3; i++) p[i] = new PointF((float)(10 + Rnd() * 100), (float)(10 + Rnd() * 100));
        return p;
    }

    static PointF[] Star()
    {
        int n = 6 + (int)(Rnd() * 7);
        var p = new PointF[n];
        for (int a = 0; a < n; a++)
        {
            double ang = (a + Rnd() * 0.7) * 2 * Math.PI / n, r = 20 + Rnd() * 35;
            p[a] = new PointF((float)(65 + r * Math.Cos(ang)), (float)(65 + r * Math.Sin(ang)));
        }
        return p;
    }

    static PointF[] Flattened(int k)
    {
        var path = new GraphicsPath();
        if (k == 0) path.AddEllipse((float)(15 + Rnd() * 15), (float)(15 + Rnd() * 15), (float)(40 + Rnd() * 50), (float)(30 + Rnd() * 50));
        else if (k == 1)
        {
            float x = (float)(10 + Rnd() * 10), y = (float)(10 + Rnd() * 10), w = (float)(50 + Rnd() * 50), h = (float)(40 + Rnd() * 50), r = (float)(10 + Rnd() * 10);
            path.AddArc(x, y, r, r, 180, 90); path.AddArc(x + w - r, y, r, r, 270, 90);
            path.AddArc(x + w - r, y + h - r, r, r, 0, 90); path.AddArc(x, y + h - r, r, r, 90, 90);
            path.CloseFigure();
        }
        else
        {
            int m = 4 + (int)(Rnd() * 3);
            var q = new PointF[m];
            for (int a = 0; a < m; a++)
            {
                double ang = (a + Rnd() * 0.5) * 2 * Math.PI / m, r = 25 + Rnd() * 30;
                q[a] = new PointF((float)(62 + r * Math.Cos(ang)), (float)(62 + r * Math.Sin(ang)));
            }
            path.AddClosedCurve(q);
        }
        path.Flatten(new Matrix(), 0.1f);
        var pts = new List<PointF>(path.PathPoints);
        if (pts.Count > 1 && pts[0] == pts[pts.Count - 1]) pts.RemoveAt(pts.Count - 1);
        for (int i = pts.Count - 1; i > 0; i--) if (pts[i] == pts[i - 1]) pts.RemoveAt(i);
        return pts.ToArray();
    }

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

    static Bitmap Draw(PointF[] pts, float width, LineJoin join, bool aa)
    {
        var b = new Bitmap(Size, Size, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(b))
        using (var pen = new Pen(Color.Black, width))
        {
            g.SmoothingMode = aa ? SmoothingMode.AntiAlias : SmoothingMode.None;
            g.Clear(Color.White);
            pen.Alignment = PenAlignment.Inset; pen.LineJoin = join;
            g.DrawPolygon(pen, pts);
        }
        return b;
    }

    public static void Run(string dir)
    {
        var joins = new[] { LineJoin.Miter, LineJoin.Round, LineJoin.Bevel, LineJoin.Miter, LineJoin.Round };
        var widths = new[] { 2f, 3f, 5f, 3f, 6f };
        var json = new StringBuilder("[");
        int count = 0;
        for (int kind = 0; kind < 3; kind++)
            for (int i = 0; i < 40; i++)
            {
                PointF[] pts = kind == 0 ? Triangle() : kind == 1 ? Star() : Flattened(i % 3);
                float width = widths[i % 5];
                LineJoin join = joins[i % 5];
                using (var path = new GraphicsPath())
                {
                    path.AddPolygon(pts);
                    using (var pen = new Pen(Color.Black, width))
                    {
                        pen.Alignment = PenAlignment.Inset; pen.LineJoin = join;
                        var widened = (GraphicsPath)path.Clone();
                        widened.Widen(pen);
                        var wp = widened.PathPoints; var wt = widened.PathTypes;
                        if (count++ > 0) json.Append(',');
                        json.Append("{\"kind\":\"").Append(kind == 0 ? "triangle" : kind == 1 ? "polygon" : "curve").Append("\",\"join\":").Append((int)join).Append(",\"width\":").Append(F(width)).Append(",\"src\":[");
                        for (int j = 0; j < pts.Length; j++) { if (j > 0) json.Append(','); json.Append(F(pts[j].X)).Append(',').Append(F(pts[j].Y)); }
                        json.Append("],\"widen\":[");
                        for (int j = 0; j < wp.Length; j++) { if (j > 0) json.Append(','); json.Append(F(wp[j].X)).Append(',').Append(F(wp[j].Y)); }
                        json.Append("],\"types\":[");
                        for (int j = 0; j < wt.Length; j++) { if (j > 0) json.Append(','); json.Append((int)wt[j]); }
                        json.Append("],\"aliased\":");
                        using (var b = Draw(pts, width, join, false)) json.Append(Rows(b));
                        json.Append(",\"aa\":");
                        using (var b = Draw(pts, width, join, true)) json.Append(Rows(b));
                        json.Append('}');
                    }
                }
            }
        json.Append(']');
        using (var file = File.Create(Path.Combine(dir, "inset-outline.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress))
        {
            var bytes = Encoding.UTF8.GetBytes(json.ToString());
            zip.Write(bytes, 0, bytes.Length);
        }
        Console.WriteLine("inset-outline.json.gz: " + count + " cases");
    }
}
