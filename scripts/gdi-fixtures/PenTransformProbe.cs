// Native Windows GDI+ reference for emf-plus-stroke.test.ts: pens with a
// pen-local transform (Pen.Transform).
//
// Run by generate.ps1 (the `pen-transform` group), or by hand in Windows
// PowerShell (.NET Framework) from the repository root:
// Add-Type -Path scripts/gdi-fixtures/PenTransformProbe.cs -ReferencedAssemblies System.Drawing
// [PenTransformProbe]::Run((Resolve-Path src/__fixtures__/gdi).Path)
//
// Every case writes, to the supplied existing directory:
//   pen-<case>.emf         the drawing recorded as an EmfPlusOnly metafile
//                          (Graphics.FromImage on a recording Metafile);
//   pen-<case>.png         GDI+'s own playback of that .emf onto a bitmap;
//   pen-<case>-direct.png  the same calls painted straight onto a bitmap.
// Compiled by Add-Type (Windows PowerShell 5.1, C# 5 syntax).
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

public static class PenTransformProbe
{
	public delegate void Paint(Graphics g);

	static void Case(string dir, string name, int w, int h, Paint paint)
	{
		string emf = Path.Combine(dir, name + ".emf");
		using (var refG = Graphics.FromHwnd(IntPtr.Zero))
		{
			IntPtr hdc = refG.GetHdc();
			var mf = new Metafile(emf, hdc, new RectangleF(0, 0, w, h), MetafileFrameUnit.Pixel, EmfType.EmfPlusOnly);
			refG.ReleaseHdc(hdc);
			using (var g = Graphics.FromImage(mf)) { g.PageUnit = GraphicsUnit.Pixel; paint(g); }
			mf.Dispose();
		}
		using (var played = new Metafile(emf))
		using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
		{
			// The physical frame can describe more pixels than the recorded
			// device bounds on a scaled display. An implicit source rectangle
			// fits that frame to w x h and shrinks the drawing (150 -> 100 at
			// 150% DPI). Replay the requested device-pixel rectangle explicitly.
			using (var g = Graphics.FromImage(bmp)) { g.DrawImage(played, new Rectangle(0, 0, w, h), 0, 0, w, h, GraphicsUnit.Pixel); }
			bmp.Save(Path.Combine(dir, name + ".png"), ImageFormat.Png);
		}
		using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
		{
			using (var g = Graphics.FromImage(bmp)) { g.PageUnit = GraphicsUnit.Pixel; paint(g); }
			bmp.Save(Path.Combine(dir, name + "-direct.png"), ImageFormat.Png);
		}
	}

	/**
	 * White `w` x `h` page, then one black line per (x1, y1, x2, y2) in `lines`
	 * with a `width` pen under pen transform `transform`.
	 */
	static Paint Lines(int w, int h, Matrix transform, float width, bool customCap, DashStyle dash, bool antiAlias, params float[] lines)
	{
		return delegate (Graphics g)
		{
			g.FillRectangle(Brushes.White, 0, 0, w, h);
			g.SmoothingMode = antiAlias ? SmoothingMode.AntiAlias : SmoothingMode.None;
			g.PixelOffsetMode = PixelOffsetMode.None;
			using (var pen = new Pen(Color.Black, width))
			{
				pen.Transform = transform;
				pen.DashStyle = dash;
				if (customCap) { pen.StartCap = LineCap.ArrowAnchor; }
				for (int i = 0; i + 3 < lines.Length; i += 4) { g.DrawLine(pen, lines[i], lines[i + 1], lines[i + 2], lines[i + 3]); }
			}
		};
	}

	static void Short(string dir, string name, Matrix transform, float width, bool customCap)
	{
		Case(dir, name, 80, 64, Lines(80, 64, transform, width, customCap, DashStyle.Solid, false, 12, 30, 68, 30));
	}

	public static void Run(string dir)
	{
		Remaining(dir);
		// One horizontal line on 80 x 64: uniform scales, rotation and translation.
		Short(dir, "pen-id", new Matrix(), 2, false);
		Short(dir, "pen-scale3", new Matrix(3, 0, 0, 3, 0, 0), 2, false);
		Short(dir, "pen-scale3-rotate45-translate", new Matrix(2.1213204f, 2.1213204f, -2.1213204f, 2.1213204f, 9, 12), 2, false);
		Short(dir, "pen-rotate45", new Matrix(0.7071068f, 0.7071068f, -0.7071068f, 0.7071068f, 0, 0), 2, false);
		Short(dir, "pen-translate", new Matrix(1, 0, 0, 1, 0, 12), 2, false);
		Short(dir, "pen-zero-scale3", new Matrix(3, 0, 0, 3, 0, 0), 0, false);
		Short(dir, "pen-custom-id", new Matrix(), 2, true);

		// Nonuniform scale (4, 1) on 100 x 100 (the geometry of the
		// "nonuniform and skewed pen transforms" tests): a horizontal and a
		// vertical line, a diagonal, a dashed line, and a zero-width pen.
		var scale41 = new Matrix(4, 0, 0, 1, 0, 0);
		float[] hv = { 10, 20, 60, 20, 50, 40, 50, 90 };
		Case(dir, "pen-scale4x1", 100, 100, Lines(100, 100, scale41, 2, false, DashStyle.Solid, false, hv));
		Case(dir, "pen-scale4x1-aa", 100, 100, Lines(100, 100, scale41, 2, false, DashStyle.Solid, true, hv));
		Case(dir, "pen-scale4x1-diagonal", 100, 100, Lines(100, 100, scale41, 2, false, DashStyle.Solid, true, 10, 10, 90, 90, 10, 90, 90, 60));
		Case(dir, "pen-scale4x1-dash", 100, 100, Lines(100, 100, scale41, 2, false, DashStyle.Dash, false, 0, 50, 100, 50));
		Case(dir, "pen-scale4x1-dash-aa", 100, 100, Lines(100, 100, scale41, 2, false, DashStyle.Dash, true, 0, 50, 100, 50));
		Case(dir, "pen-zero-scale4x1", 100, 100, Lines(100, 100, scale41, 0, false, DashStyle.Solid, false, hv));

		// Skew [1 0 1 1] (x' = x + y) with an 8-wide pen: a vertical line (its
		// flat caps slant), a horizontal one, and a diagonal.
		var skew = new Matrix(1, 0, 1, 1, 0, 0);
		Case(dir, "pen-skew", 100, 100, Lines(100, 100, skew, 8, false, DashStyle.Solid, false, 50, 20, 50, 80));
		Case(dir, "pen-skew-aa", 100, 100, Lines(100, 100, skew, 8, false, DashStyle.Solid, true, 50, 20, 50, 80));
		Case(dir, "pen-skew-horizontal", 100, 100, Lines(100, 100, skew, 8, false, DashStyle.Solid, false, 10, 20, 60, 20));
		Case(dir, "pen-skew-diagonal", 100, 100, Lines(100, 100, skew, 8, false, DashStyle.Solid, true, 15, 15, 85, 85, 15, 85, 85, 50));
	}

	public static void Remaining(string dir)
	{
		// Native Pen.Transform rejects singular matrices with InvalidParameter.
		foreach (var matrix in new[] { new Matrix(0, 0, 0, 0, 0, 0), new Matrix(1, 0, 0, 0, 0, 0), new Matrix(1, 1, 1, 1, 0, 0) }) {
			using (matrix) using (var pen = new Pen(Color.Black, 4)) {
				bool rejected = false;
				try { pen.Transform = matrix; } catch (ArgumentException) { rejected = true; }
				if (!rejected) throw new Exception("GDI+ unexpectedly accepted a singular pen transform");
			}
		}
		Case(dir, "pen-scale3-dash", 100, 100, Lines(100, 100, new Matrix(3, 0, 0, 3, 0, 0), 2, false, DashStyle.Dash, false, 0, 50, 100, 50));
		Case(dir, "pen-scale3-dash-aa", 100, 100, Lines(100, 100, new Matrix(3, 0, 0, 3, 0, 0), 2, false, DashStyle.Dash, true, 0, 50, 100, 50));
		foreach (LineCap cap in new[] { LineCap.SquareAnchor, LineCap.RoundAnchor, LineCap.DiamondAnchor })
			foreach (bool aa in new[] { false, true }) {
				LineCap selected = cap; bool antialias = aa;
				Case(dir, "pen-anchor-" + cap.ToString().ToLowerInvariant() + (aa ? "-aa" : ""), 100, 100, delegate(Graphics g) {
					g.FillRectangle(Brushes.White, 0, 0, 100, 100);
					g.SmoothingMode = antialias ? SmoothingMode.AntiAlias : SmoothingMode.None;
					using (var p = new Pen(Color.Black, 4)) {
						p.StartCap = selected; p.EndCap = selected;
						g.DrawLine(p, 20, 25, 80, 25);
						g.DrawLine(p, 20, 50, 80, 80);
					}
				});
			}
	}
}
