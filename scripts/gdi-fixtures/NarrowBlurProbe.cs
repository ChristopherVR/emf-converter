// Records both the effect input and GDI+'s baked output for small expanded blurs in one Dual metafile.
// Narrow source rectangles (a single reduced sample, a few samples) at large radii, and
// rectangles reaching an image edge, pin how the enlarged samples are continued and how the
// buffer's ends behave. Read back with src/__fixtures__/emf-plus-effect-baked.ts.
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;

public static class NarrowBlurProbe
{
	[StructLayout(LayoutKind.Sequential)] struct RectF { public float X, Y, Width, Height; }
	[DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
	[DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
	[DllImport("gdiplus.dll", CharSet=CharSet.Unicode)] static extern int GdipRecordMetafileFileName(string file, IntPtr dc, int type, ref RectF frame, int unit, string description, out IntPtr image);
	[DllImport("gdiplus.dll")] static extern int GdipCreateBitmapFromScan0(int width, int height, int stride, int format, IntPtr scan, out IntPtr image);
	[DllImport("gdiplus.dll")] static extern int GdipBitmapSetPixel(IntPtr image, int x, int y, int argb);
	[DllImport("gdiplus.dll")] static extern int GdipGetImageGraphicsContext(IntPtr image, out IntPtr graphics);
	[DllImport("gdiplus.dll")] static extern int GdipSetPageUnit(IntPtr graphics, int unit);
	[DllImport("gdiplus.dll")] static extern int GdipDeleteGraphics(IntPtr graphics);
	[DllImport("gdiplus.dll")] static extern int GdipDisposeImage(IntPtr image);
	[DllImport("gdiplus.dll")] static extern int GdipCreateMatrix2(float a, float b, float c, float d, float x, float y, out IntPtr matrix);
	[DllImport("gdiplus.dll")] static extern int GdipDeleteMatrix(IntPtr matrix);
	[DllImport("gdiplus.dll")] static extern int GdipCreateEffect(Guid guid, out IntPtr effect);
	[DllImport("gdiplus.dll")] static extern int GdipDeleteEffect(IntPtr effect);
	[DllImport("gdiplus.dll")] static extern int GdipSetEffectParameters(IntPtr effect, byte[] parameters, uint size);
	[DllImport("gdiplus.dll")] static extern int GdipDrawImageFX(IntPtr graphics, IntPtr image, ref RectF rect, IntPtr matrix, IntPtr effect, IntPtr attributes, int unit);
	static void Check(int status) { if (status != 0) throw new Exception("GDI+ status " + status); }

	const int Size = 48;

	public static void Run(string dir)
	{
		using (var init = new Bitmap(1, 1)) {
			IntPtr dc = GetDC(IntPtr.Zero), metafile = IntPtr.Zero, graphics = IntPtr.Zero, matrix = IntPtr.Zero;
			try {
				var frame = new RectF { Width = Size, Height = Size };
				Check(GdipRecordMetafileFileName(Path.Combine(dir, "effect-blur-narrow.emf"), dc, 5, ref frame, 2, null, out metafile));
				Check(GdipGetImageGraphicsContext(metafile, out graphics)); Check(GdipSetPageUnit(graphics, 2));
				Check(GdipCreateMatrix2(1, 0, 0, 1, 0, 0, out matrix));
				var narrow = new[] { new[]{1,1}, new[]{2,2}, new[]{3,3}, new[]{3,12}, new[]{12,3}, new[]{4,4}, new[]{7,7}, new[]{8,8}, new[]{9,9}, new[]{15,15}, new[]{16,16}, new[]{17,17} };
				for (int pattern = 0; pattern < 2; pattern++) {
					IntPtr image = IntPtr.Zero;
					try {
						Check(GdipCreateBitmapFromScan0(Size, Size, 0, 0x26200a, IntPtr.Zero, out image));
						uint state = (uint)(1234 + pattern);
						for (int y = 0; y < Size; y++) for (int x = 0; x < Size; x++) {
							int rgb = 0;
							for (int c = 0; c < 3; c++) { state = (state * 1103515245u + 12345u) & 0x7fffffffu; rgb = (rgb << 8) | (int)((state >> 16) & 255); }
							int alpha = 255;
							if (pattern == 1) { state = (state * 1103515245u + 12345u) & 0x7fffffffu; alpha = 64 + (int)((state >> 16) % 192); }
							Check(GdipBitmapSetPixel(image, x, y, (alpha << 24) | rgb));
						}
						foreach (float radius in new float[] { 40, 64, 81, 160, 255 })
							foreach (var wh in narrow) Draw(graphics, image, matrix, radius, new RectF { X = 10, Y = 10, Width = wh[0], Height = wh[1] });
						foreach (float radius in new float[] { 20, 32, 40, 64, 160 })
							foreach (var source in new RectF[] {
								new RectF { X = 33, Y = 12, Width = 15, Height = 20 },
								new RectF { X = 12, Y = 33, Width = 20, Height = 15 },
								new RectF { X = 32, Y = 32, Width = 16, Height = 16 } })
								Draw(graphics, image, matrix, radius, source);
					} finally { if (image != IntPtr.Zero) GdipDisposeImage(image); }
				}
			} finally {
				if (matrix != IntPtr.Zero) GdipDeleteMatrix(matrix); if (graphics != IntPtr.Zero) GdipDeleteGraphics(graphics);
				if (metafile != IntPtr.Zero) GdipDisposeImage(metafile); ReleaseDC(IntPtr.Zero, dc);
			}
		}
	}

	static void Draw(IntPtr graphics, IntPtr image, IntPtr matrix, float radius, RectF rect)
	{
		IntPtr effect = IntPtr.Zero;
		try {
			Check(GdipCreateEffect(new Guid("633c80a4-1843-482b-9ef2-be2834c5fdd4"), out effect));
			byte[] parameters = new byte[8]; Buffer.BlockCopy(new float[] { radius }, 0, parameters, 0, 4); parameters[4] = 1;
			Check(GdipSetEffectParameters(effect, parameters, 8)); Check(GdipDrawImageFX(graphics, image, ref rect, matrix, effect, IntPtr.Zero, 2));
		} finally { if (effect != IntPtr.Zero) GdipDeleteEffect(effect); }
	}
}
