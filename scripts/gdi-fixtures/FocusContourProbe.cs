// Public PathGradientBrush drawing controls for focus edges, vertex order and centre placement.
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Text;

public static class FocusContourProbe
{
    static string Number(float value) { return value.ToString("R", CultureInfo.InvariantCulture); }
    public static void Run(string directory)
    {
        var json = new StringBuilder("[");
        PointF[][] shapes = {
            new[] { new PointF(10, 10), new PointF(90, 15), new PointF(45, 70) },
            new[] { new PointF(10, 15), new PointF(85, 10), new PointF(60, 70) },
            new[] { new PointF(10, 10), new PointF(90, 10), new PointF(50, 70) }
        };
        PointF[] focuses = { new PointF(.75f,.25f), new PointF(.25f,.75f), new PointF(.5f,.5f), new PointF(.5f,0), new PointF(0,.5f), new PointF(1,.25f), new PointF(.25f,1) };
        foreach (var shape in shapes)
        foreach (var center in new[] { new PointF(50, 40), new PointF(48, 32) })
        for (int order = 0; order < 6; order++)
        foreach (var focus in focuses) {
            var points = new PointF[3];
            for (int i = 0; i < 3; i++) points[i] = shape[((order % 3) + (order < 3 ? i : 3 - i)) % 3];
            using (var path = new GraphicsPath())
            using (var bitmap = new Bitmap(100, 80, PixelFormat.Format32bppArgb)) {
                path.AddPolygon(points);
                using (var brush = new PathGradientBrush(path))
                using (var graphics = Graphics.FromImage(bitmap)) {
                    brush.CenterPoint = center;
                    brush.CenterColor = Color.White;
                    brush.SurroundColors = new[] { Color.Black };
                    brush.FocusScales = focus;
                    brush.WrapMode = WrapMode.Clamp;
                    graphics.PageUnit = GraphicsUnit.Pixel;
                    graphics.Clear(Color.White);
                    graphics.FillRectangle(brush, 0, 0, 100, 80);
                }
                var data = bitmap.LockBits(new Rectangle(0, 0, 100, 80), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                var bytes = new byte[100 * 80 * 4];
                try { for (int y = 0; y < 80; y++) Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), bytes, y * 400, 400); }
                finally { bitmap.UnlockBits(data); }
                if (json.Length > 1) json.Append(',');
                json.Append("{\"points\":[");
                for (int i = 0; i < 3; i++) {
                    if (i > 0) json.Append(',');
                    json.Append('[').Append(Number(points[i].X)).Append(',').Append(Number(points[i].Y)).Append(']');
                }
                json.Append("],\"center\":[").Append(Number(center.X)).Append(',').Append(Number(center.Y))
                    .Append("],\"focus\":[").Append(Number(focus.X)).Append(',').Append(Number(focus.Y))
                    .Append("],\"bgra\":\"").Append(Convert.ToBase64String(bytes)).Append("\"}");
            }
        }
        using (var file = File.Create(Path.Combine(directory, "path-gradient-focus-contours.json.gz")))
        using (var gzip = new GZipStream(file, CompressionMode.Compress)) {
            var bytes = Encoding.UTF8.GetBytes(json.Append(']').ToString());
            gzip.Write(bytes, 0, bytes.Length);
        }
    }
}
