// Public GraphicsPath.Flatten controls; no native implementation is inspected.
using System;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;

public static class BezierFlattenProbe
{
    static string Points(GraphicsPath path)
    {
        var json = new StringBuilder("[");
        var points = path.PathPoints;
        var types = path.PathTypes;
        for (int i = 0; i < points.Length; i++) {
            if (i > 0) json.Append(',');
            json.Append("[" + points[i].X.ToString("R", CultureInfo.InvariantCulture) + "," +
                points[i].Y.ToString("R", CultureInfo.InvariantCulture) + "," + types[i] + "]");
        }
        return json.Append(']').ToString();
    }

    public static void Run(string directory)
    {
        var json = new StringBuilder("[");
        var random = new Random(8182);
        for (int i = 0; i < 65; i++) {
            using (var path = new GraphicsPath()) {
                if (i == 64) path.AddEllipse(10, 10, 80, 60);
                else {
                    var points = new PointF[4];
                    for (int j = 0; j < 4; j++) points[j] = new PointF(
                        (float)(random.NextDouble() * 120 - 40), (float)(random.NextDouble() * 120 - 40));
                    path.AddBezier(points[0], points[1], points[2], points[3]);
                }
                string source = Points(path);
                path.Flatten(null, 0.25f);
                if (i > 0) json.Append(',');
                json.Append("{\"source\":" + source + ",\"flat\":" + Points(path) + "}");
            }
        }
        byte[] bytes = Encoding.UTF8.GetBytes(json.Append(']').ToString());
        using (var file = File.Create(Path.Combine(directory, "gdiplus-bezier-flatten.json.gz")))
        using (var gzip = new GZipStream(file, CompressionMode.Compress)) gzip.Write(bytes, 0, bytes.Length);
    }
}
