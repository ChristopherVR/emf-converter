// Public GDI+ controls only (Graphics.DrawPath); no native implementation is inspected.
// Inset-aligned pens on dashed and mixed paths, 130 x 130, white background, default pixel offset, aliased and antialiased.
// `inset-dash.json.gz`: [{ kind, width, join (LineJoin), dashCap (DashCap), pattern (pen widths, or null), offset (DashOffset), figures (arrays
// of { closed, pts: x, y pairs, single precision }), aliased and aa (rows [y, x0, hex]: one hex byte per pixel from x0 to the last non-zero pixel
// of the row) }]:
//  - star: the ten-point star of the `gpx-pen-inset-dash*` sheets with a width 14 pen, Round dash caps and the pattern 1.5, 6, with the dash offset
//    swept from 0 to 7.5 pen widths in steps of 0.125 (a dash then crosses each reflex vertex of the star at some offset, where the two
//    half-width semicircles of a double round cap both show);
//  - star-triangle: the same with Triangle dash caps (15 offsets);
//  - lshape: an L-shaped polygon (one reflex vertex) with a width 20 pen, Round dash caps and the pattern 2, 18, whose period is the perimeter, with
//    the offset swept in steps of 0.025 around the offset that puts a dash across the vertex;
//  - mixed: a closed rectangle and an open line or polyline in one path, solid and dashed (the open figure is stroked at the pen's own width,
//    centered, not clipped).
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Text;

public static class InsetDashProbe
{
    const int Size = 130;
    static string F(float v) { return v.ToString("R", CultureInfo.InvariantCulture); }

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

    static readonly float[] Star = { 55, 8, 68, 30, 100, 34, 74, 50, 82, 76, 55, 60, 28, 76, 36, 50, 10, 34, 42, 30 };
    static readonly float[] LShape = { 10, 10, 110, 10, 110, 60, 60, 60, 60, 110, 10, 110 };
    static readonly float[] Rect = { 20, 20, 100, 20, 100, 80, 20, 80 };

    class Figure { public bool Closed; public float[] Pts; public Figure(bool c, float[] p) { Closed = c; Pts = p; } }

    static void AddFigures(GraphicsPath path, List<Figure> figures)
    {
        foreach (var f in figures)
        {
            var p = new PointF[f.Pts.Length / 2];
            for (int i = 0; i < p.Length; i++) p[i] = new PointF(f.Pts[2 * i], f.Pts[2 * i + 1]);
            path.StartFigure();
            if (f.Closed) path.AddPolygon(p); else path.AddLines(p);
        }
    }

    static void Case(StringBuilder json, ref int n, string kind, float width, LineJoin join, DashCap cap, float[] pattern, float offset, List<Figure> figures)
    {
        string aliased = null, aa = null;
        foreach (bool smooth in new[] { false, true })
        {
            using (var b = new Bitmap(Size, Size, PixelFormat.Format32bppArgb))
            using (var g = Graphics.FromImage(b))
            using (var pen = new Pen(Color.Black, width))
            using (var path = new GraphicsPath())
            {
                g.SmoothingMode = smooth ? SmoothingMode.AntiAlias : SmoothingMode.None;
                g.Clear(Color.White);
                pen.Alignment = PenAlignment.Inset; pen.LineJoin = join;
                if (pattern != null) { pen.DashPattern = pattern; pen.DashCap = cap; pen.DashOffset = offset; }
                AddFigures(path, figures);
                g.DrawPath(pen, path);
                if (smooth) aa = Rows(b); else aliased = Rows(b);
            }
        }
        if (n++ > 0) json.Append(',');
        json.Append("{\"kind\":\"").Append(kind).Append("\",\"width\":").Append(F(width)).Append(",\"join\":").Append((int)join).Append(",\"dashCap\":").Append((int)cap);
        json.Append(",\"pattern\":");
        if (pattern == null) json.Append("null");
        else
        {
            json.Append('[');
            for (int i = 0; i < pattern.Length; i++) { if (i > 0) json.Append(','); json.Append(F(pattern[i])); }
            json.Append(']');
        }
        json.Append(",\"offset\":").Append(F(offset)).Append(",\"figures\":[");
        for (int f = 0; f < figures.Count; f++)
        {
            if (f > 0) json.Append(',');
            json.Append("{\"closed\":").Append(figures[f].Closed ? "true" : "false").Append(",\"pts\":[");
            for (int j = 0; j < figures[f].Pts.Length; j++) { if (j > 0) json.Append(','); json.Append(F(figures[f].Pts[j])); }
            json.Append("]}");
        }
        json.Append("],\"aliased\":").Append(aliased).Append(",\"aa\":").Append(aa).Append('}');
    }

    public static void Run(string dir)
    {
        var json = new StringBuilder("[");
        int n = 0;
        var star = new List<Figure> { new Figure(true, Star) };
        for (int i = 0; i <= 60; i++) Case(json, ref n, "star", 14, LineJoin.Round, DashCap.Round, new[] { 1.5f, 6f }, i * 0.125f, star);
        for (int i = 0; i <= 14; i++) Case(json, ref n, "star-triangle", 14, LineJoin.Round, DashCap.Triangle, new[] { 1.5f, 6f }, i * 0.5f, star);
        var l = new List<Figure> { new Figure(true, LShape) };
        for (int i = 0; i <= 24; i++) Case(json, ref n, "lshape", 20, LineJoin.Round, DashCap.Round, new[] { 2f, 18f }, 2.95f + i * 0.025f, l);
        var open1 = new List<Figure> { new Figure(true, Rect), new Figure(false, new float[] { 10, 100, 110, 115 }) };
        var open2 = new List<Figure> { new Figure(false, new float[] { 10, 100, 110, 115 }), new Figure(true, Rect) };
        var open3 = new List<Figure> { new Figure(true, Rect), new Figure(false, new float[] { 40, 10, 60, 60, 90, 40 }) };
        foreach (var figures in new[] { open1, open2, open3 })
        {
            Case(json, ref n, "mixed", 10, LineJoin.Miter, DashCap.Flat, null, 0, figures);
            Case(json, ref n, "mixed", 10, LineJoin.Round, DashCap.Flat, null, 0, figures);
            Case(json, ref n, "mixed", 10, LineJoin.Miter, DashCap.Flat, new[] { 3f, 1f }, 0, figures);
            Case(json, ref n, "mixed", 10, LineJoin.Miter, DashCap.Round, new[] { 3f, 1f }, 0, figures);
        }
        json.Append(']');
        using (var file = File.Create(Path.Combine(dir, "inset-dash.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress))
        {
            var bytes = Encoding.UTF8.GetBytes(json.ToString());
            zip.Write(bytes, 0, bytes.Length);
        }
        Console.WriteLine("inset-dash.json.gz: " + n + " cases");
    }
}
