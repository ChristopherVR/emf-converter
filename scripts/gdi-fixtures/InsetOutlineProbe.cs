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

    // Inset cases beyond the plain solid pen on one polygon: `inset-cases.json.gz`,
    // [{ kind ("dash", "thin", "half", "multi", "dashc"), join, width, dash (DashStyle), dashCap, dashOffset, offset (PixelOffsetMode), (widen, types: the
    // GraphicsPath.Widen outline, with INSET_CASES_WIDEN=1) figures (arrays of x, y
    // pairs), aliased, aa }] drawn with DrawPath of a path of closed polygons and an Inset pen:
    //  - dash: 4 widths x DashStyle Dash, Dot, DashDot, DashDotDot and a custom pattern, Flat and Round dash caps;
    //  - thin: widths 0.5 to 2 (a pen of 1.5 pixels or less is drawn as a nominal-width line);
    //  - half: PixelOffsetMode Half (and Default as control) with widths 2 to 6;
    //  - multi: two or three overlapping closed polygons in one path;
    //  - dashc: the dash cases with a Center pen (control).
    public static void RunCases(string dir)
    {
        seed = 2468;
        var json = new StringBuilder("[");
        int n = 0;
        var styles = new[] { DashStyle.Dash, DashStyle.Dot, DashStyle.DashDot, DashStyle.DashDotDot, DashStyle.Custom };
        for (int i = 0; i < 440; i++)
        {
            string kind = i < 120 ? "dash" : i < 200 ? "thin" : i < 280 ? "half" : i < 360 ? "multi" : "dashc";
            var figures = new List<PointF[]>();
            int count = kind == "multi" ? 2 + (i % 2) : 1;
            for (int f = 0; f < count; f++)
            {
                int shape = (i + f) % 4;
                figures.Add(shape == 0 ? Triangle() : shape == 1 ? Star() : Flattened(shape == 2 ? 0 : 2));
            }
            float width = kind == "thin" ? new[] { 0.5f, 1f, 1.25f, 1.5f, 1.6f, 2f }[i % 6] : new[] { 2f, 3f, 5f, 6f }[i % 4];
            var join = (LineJoin)(i % 3);
            var style = kind == "dash" || kind == "dashc" ? styles[(i / 4) % styles.Length] : DashStyle.Solid;
            var cap = (kind == "dash" || kind == "dashc") && (i / 20) % 2 == 1 ? DashCap.Round : DashCap.Flat;
            float dashOffset = (kind == "dash" || kind == "dashc") ? new[] { 0f, 0.5f, 1.25f }[(i / 8) % 3] : 0f;
            var offset = kind == "half" ? (i % 2 == 0 ? PixelOffsetMode.Half : PixelOffsetMode.Default) : PixelOffsetMode.Default;
            string rowsAliased = null, rowsAa = null, widenJson = "";
            foreach (bool aa in new[] { false, true })
            {
                using (var b = new Bitmap(Size, Size, PixelFormat.Format32bppArgb))
                using (var g = Graphics.FromImage(b))
                using (var pen = new Pen(Color.Black, width))
                using (var path = new GraphicsPath())
                {
                    g.SmoothingMode = aa ? SmoothingMode.AntiAlias : SmoothingMode.None;
                    g.PixelOffsetMode = offset;
                    g.Clear(Color.White);
                    if (kind != "dashc") pen.Alignment = PenAlignment.Inset;
                    pen.LineJoin = join;
                    if (style == DashStyle.Custom) { pen.DashPattern = new[] { 2f, 1f, 0.5f, 1.5f }; }
                    else pen.DashStyle = style;
                    pen.DashCap = cap; pen.DashOffset = dashOffset;
                    foreach (var fig in figures) path.AddPolygon(fig);
                    g.DrawPath(pen, path);
                    if (aa) rowsAa = Rows(b); else rowsAliased = Rows(b);
                    if (aa && Environment.GetEnvironmentVariable("INSET_CASES_WIDEN") == "1")
                    {
                        var wp = (GraphicsPath)path.Clone();
                        wp.Widen(pen);
                        var pts = wp.PathPoints; var ty = wp.PathTypes;
                        var wsb = new StringBuilder(",\"widen\":[");
                        for (int j = 0; j < pts.Length; j++) { if (j > 0) wsb.Append(','); wsb.Append(F(pts[j].X)).Append(',').Append(F(pts[j].Y)); }
                        wsb.Append("],\"types\":[");
                        for (int j = 0; j < ty.Length; j++) { if (j > 0) wsb.Append(','); wsb.Append((int)ty[j]); }
                        widenJson = wsb.Append(']').ToString();
                    }
                }
            }
            if (n++ > 0) json.Append(',');
            json.Append("{\"kind\":\"").Append(kind).Append("\",\"join\":").Append((int)join).Append(",\"width\":").Append(F(width)).Append(",\"dash\":").Append((int)style).Append(",\"dashCap\":").Append((int)cap).Append(",\"dashOffset\":").Append(F(dashOffset)).Append(",\"offset\":").Append((int)offset).Append(",\"figures\":[");
            for (int f = 0; f < figures.Count; f++)
            {
                if (f > 0) json.Append(',');
                json.Append('[');
                for (int j = 0; j < figures[f].Length; j++) { if (j > 0) json.Append(','); json.Append(F(figures[f][j].X)).Append(',').Append(F(figures[f][j].Y)); }
                json.Append(']');
            }
            json.Append("],\"aliased\":").Append(rowsAliased).Append(",\"aa\":").Append(rowsAa).Append(widenJson).Append('}');
        }
        json.Append(']');
        using (var file = File.Create(Path.Combine(dir, "inset-cases.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress))
        {
            var bytes = Encoding.UTF8.GetBytes(json.ToString());
            zip.Write(bytes, 0, bytes.Length);
        }
        Console.WriteLine("inset-cases.json.gz: " + n + " cases");
    }

    // Contact survey: many random polygons (triangles, random self-crossing polygons, stars) with an Inset pen of a random width 1.6 to 9 and a
    // random join, aliased and antialiased, to see how GDI+ pairs set pixels that touch only at a corner.
    // `inset-contacts.json.gz`: [{ join, width, src, aliased, aa }].
    public static void RunContacts(string dir, int count, string name)
    {
        seed = 987654321;
        var json = new StringBuilder("[");
        for (int i = 0; i < count; i++)
        {
            PointF[] pts;
            int kind = i % 3;
            if (kind == 0) pts = Triangle();
            else if (kind == 1)
            {
                int n = 4 + (int)(Rnd() * 6);
                pts = new PointF[n];
                for (int a = 0; a < n; a++) pts[a] = new PointF((float)(10 + Rnd() * 110), (float)(10 + Rnd() * 110));
            }
            else pts = Star();
            float width = (float)(1.6 + Rnd() * 7.4);
            LineJoin join = (LineJoin)(int)(Rnd() * 3);
            if (i > 0) json.Append(',');
            json.Append("{\"join\":").Append((int)join).Append(",\"width\":").Append(F(width)).Append(",\"src\":[");
            for (int j = 0; j < pts.Length; j++) { if (j > 0) json.Append(','); json.Append(F(pts[j].X)).Append(',').Append(F(pts[j].Y)); }
            json.Append("],\"aliased\":");
            using (var b = Draw(pts, width, join, false)) json.Append(Rows(b));
            json.Append(",\"aa\":");
            using (var b = Draw(pts, width, join, true)) json.Append(Rows(b));
            json.Append('}');
        }
        json.Append(']');
        using (var file = File.Create(Path.Combine(dir, name)))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress))
        {
            var bytes = Encoding.UTF8.GetBytes(json.ToString());
            zip.Write(bytes, 0, bytes.Length);
        }
        Console.WriteLine(name + ": " + count + " cases");
    }

    // Thin slivers: where overlapping figures cancel (even-odd) the surviving part of a ring is a strip a few pixels wide, and GDI+ cuts the
    // staircase corners of such a strip differently from those of a thick ring. 240 triangles 40 to 100 pixels long and 1.2 to 6 pixels thick, in
    // random directions, drawn with an Inset pen of width 14 (so that the whole triangle is stroke: the surviving pixels are those of the hard-clipped
    // interior) and a Miter join. `inset-slivers.json.gz`: [{ join, width, src, widen, types, aliased, aa }].
    public static void RunSlivers(string dir)
    {
        seed = 777001;
        var json = new StringBuilder("[");
        int count = 0;
        for (int i = 0; i < 240; i++)
        {
            double len = 40 + Rnd() * 60, thick = 1.2 + Rnd() * 4.8, ang = Rnd() * 2 * Math.PI, along = 0.15 + Rnd() * 0.7;
            double cx = 65 + (Rnd() - 0.5) * 20, cy = 65 + (Rnd() - 0.5) * 20;
            double ca = Math.Cos(ang), sa = Math.Sin(ang);
            Func<double, double, PointF> at = (u, v) => new PointF((float)(cx + u * ca - v * sa), (float)(cy + u * sa + v * ca));
            var pts = new[] { at(-len / 2, 0), at(len / 2, 0), at(-len / 2 + along * len, thick) };
            float width = 14f;
            using (var path = new GraphicsPath())
            {
                path.AddPolygon(pts);
                using (var pen = new Pen(Color.Black, width))
                {
                    pen.Alignment = PenAlignment.Inset; pen.LineJoin = LineJoin.Miter;
                    var widened = (GraphicsPath)path.Clone();
                    widened.Widen(pen);
                    var wp = widened.PathPoints; var wt = widened.PathTypes;
                    if (count++ > 0) json.Append(',');
                    json.Append("{\"join\":0,\"width\":").Append(F(width)).Append(",\"src\":[");
                    for (int j = 0; j < pts.Length; j++) { if (j > 0) json.Append(','); json.Append(F(pts[j].X)).Append(',').Append(F(pts[j].Y)); }
                    json.Append("],\"widen\":[");
                    for (int j = 0; j < wp.Length; j++) { if (j > 0) json.Append(','); json.Append(F(wp[j].X)).Append(',').Append(F(wp[j].Y)); }
                    json.Append("],\"types\":[");
                    for (int j = 0; j < wt.Length; j++) { if (j > 0) json.Append(','); json.Append((int)wt[j]); }
                    json.Append("],\"aliased\":");
                    using (var b = Draw(pts, width, LineJoin.Miter, false)) json.Append(Rows(b));
                    json.Append(",\"aa\":");
                    using (var b = Draw(pts, width, LineJoin.Miter, true)) json.Append(Rows(b));
                    json.Append('}');
                }
            }
        }
        json.Append(']');
        using (var file = File.Create(Path.Combine(dir, "inset-slivers.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress))
        {
            var bytes = Encoding.UTF8.GetBytes(json.ToString());
            zip.Write(bytes, 0, bytes.Length);
        }
        Console.WriteLine("inset-slivers.json.gz: " + count + " cases");
    }
}
