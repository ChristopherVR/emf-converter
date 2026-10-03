// Asymmetric FocusScales measured only through public GDI+ drawing calls.
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

public static class PathGradientFocusProbe
{
    static void Paint(Graphics g, float fx, float fy, string shape)
    {
        g.PageUnit = GraphicsUnit.Pixel;
        g.Clear(Color.White);
        using (var path = new GraphicsPath()) {
        if (shape == "ellipse") path.AddEllipse(10, 10, 80, 60);
        else if (shape == "triangle") path.AddPolygon(new[] { new PointF(10, 10), new PointF(90, 15), new PointF(45, 70) });
        else path.AddRectangle(new Rectangle(10, 10, 80, 60));
        using (var brush = new PathGradientBrush(path)) {
            brush.CenterPoint = new PointF(50, 40);
            brush.CenterColor = Color.White;
            brush.SurroundColors = new[] { Color.Black };
            brush.FocusScales = new PointF(fx, fy);
            brush.WrapMode = WrapMode.Clamp;
            g.FillRectangle(brush, 0, 0, 100, 80);
        }
        }
    }
    public static void Run(string dir)
    {
        Directory.CreateDirectory(dir);
        foreach (string shape in new[] { "rect", "triangle", "ellipse" })
        foreach (var focus in new[] { new PointF(0.75f, 0.25f), new PointF(0.25f, 0.75f), new PointF(0.5f, 0.5f), new PointF(0.5f, 0), new PointF(0, 0.5f), new PointF(1, 0.25f), new PointF(0.25f, 1) }) {
            string name = "grad-path-focus-" + (shape == "rect" ? "" : shape + "-") + ((int)(focus.X * 100)).ToString() + "-" + ((int)(focus.Y * 100)).ToString();
            using (var reference = Graphics.FromHwnd(IntPtr.Zero)) {
                var dc = reference.GetHdc();
                try {
                    using (var mf = new Metafile(Path.Combine(dir, name + ".emf"), dc, new RectangleF(0, 0, 100, 80), MetafileFrameUnit.Pixel, EmfType.EmfPlusOnly))
                    using (var g = Graphics.FromImage(mf)) Paint(g, focus.X, focus.Y, shape);
                } finally { reference.ReleaseHdc(dc); }
            }
            using (var bitmap = new Bitmap(100, 80, PixelFormat.Format32bppArgb)) {
                using (var g = Graphics.FromImage(bitmap)) Paint(g, focus.X, focus.Y, shape);
                bitmap.Save(Path.Combine(dir, name + ".png"), ImageFormat.Png);
            }
        }
    }
}
