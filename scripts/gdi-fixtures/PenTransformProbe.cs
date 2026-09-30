// Native Windows GDI+ reference for emf-plus-stroke.test.ts.
// Run in Windows PowerShell (.NET Framework), from the repository root:
// Add-Type -Path scripts/gdi-fixtures/PenTransformProbe.cs -ReferencedAssemblies System.Drawing
// [PenTransformProbe]::Run((Get-Location).Path)
// Writes fifteen PNGs to the supplied, existing output directory.
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

public static class PenTransformProbe
{
	static void Draw(string path, Matrix transform, float width, bool customCap, bool antialias = false)
	{
		using (var bmp = new Bitmap(80, 64, PixelFormat.Format32bppArgb))
		using (var g = Graphics.FromImage(bmp))
		using (var pen = new Pen(Color.Black, width))
		{
			g.Clear(Color.White);
			g.SmoothingMode = antialias ? SmoothingMode.AntiAlias : SmoothingMode.None;
			g.PixelOffsetMode = PixelOffsetMode.None;
			pen.Transform = transform;
			if (customCap) pen.StartCap = LineCap.ArrowAnchor;
			g.DrawLine(pen, 12, 30, 68, 30);
			bmp.Save(path, ImageFormat.Png);
		}
	}
	public static void Run(string dir)
	{
		Draw(System.IO.Path.Combine(dir, "pen-id.png"), new Matrix(), 2, false);
		Draw(System.IO.Path.Combine(dir, "pen-scale3.png"), new Matrix(3, 0, 0, 3, 0, 0), 2, false);
		Draw(System.IO.Path.Combine(dir, "pen-scale3-rotate45-translate.png"), new Matrix(2.1213204f, 2.1213204f, -2.1213204f, 2.1213204f, 9, 12), 2, false);
		Draw(System.IO.Path.Combine(dir, "pen-rotate45.png"), new Matrix(0.7071068f, 0.7071068f, -0.7071068f, 0.7071068f, 0, 0), 2, false);
		Draw(System.IO.Path.Combine(dir, "pen-translate.png"), new Matrix(1, 0, 0, 1, 0, 12), 2, false);
		Draw(System.IO.Path.Combine(dir, "pen-zero-scale3.png"), new Matrix(3, 0, 0, 3, 0, 0), 0, false);
		Draw(System.IO.Path.Combine(dir, "pen-custom-id.png"), new Matrix(), 2, true);
		Draw(System.IO.Path.Combine(dir, "pen-scale-x.png"), new Matrix(3, 0, 0, 1, 0, 0), 4, false);
		Draw(System.IO.Path.Combine(dir, "pen-scale-y.png"), new Matrix(1, 0, 0, 3, 0, 0), 4, false);
		Draw(System.IO.Path.Combine(dir, "pen-skew-x.png"), new Matrix(1, 0, 2, 1, 0, 0), 4, false);
		Draw(System.IO.Path.Combine(dir, "pen-skew-y.png"), new Matrix(1, 2, 0, 1, 0, 0), 4, false);
		Draw(System.IO.Path.Combine(dir, "pen-scale-x-aa.png"), new Matrix(3, 0, 0, 1, 0, 0), 4, false, true);
		Draw(System.IO.Path.Combine(dir, "pen-scale-y-aa.png"), new Matrix(1, 0, 0, 3, 0, 0), 4, false, true);
		Draw(System.IO.Path.Combine(dir, "pen-skew-x-aa.png"), new Matrix(1, 0, 2, 1, 0, 0), 4, false, true);
		Draw(System.IO.Path.Combine(dir, "pen-skew-y-aa.png"), new Matrix(1, 2, 0, 1, 0, 0), 4, false, true);
	}
}
