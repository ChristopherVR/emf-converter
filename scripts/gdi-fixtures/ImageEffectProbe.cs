// Native GDI+ 1.1 effect reference. Run in Windows PowerShell:
// Add-Type -Path scripts/gdi-fixtures/ImageEffectProbe.cs -ReferencedAssemblies System.Drawing
// [ImageEffectProbe]::Run((Resolve-Path src/__fixtures__/gdi).Path)
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.IO;

public static class ImageEffectProbe
{
	[DllImport("gdiplus.dll")] static extern int GdipCreateEffect(Guid guid, out IntPtr effect);
	[DllImport("gdiplus.dll")] static extern int GdipDeleteEffect(IntPtr effect);
	[DllImport("gdiplus.dll")] static extern int GdipSetEffectParameters(IntPtr effect, byte[] parameters, uint size);
	[DllImport("gdiplus.dll")] static extern int GdipCreateBitmapFromScan0(int width, int height, int stride, int format, IntPtr scan, out IntPtr bitmap);
	[DllImport("gdiplus.dll")] static extern int GdipBitmapSetPixel(IntPtr bitmap, int x, int y, int argb);
	[DllImport("gdiplus.dll")] static extern int GdipBitmapGetPixel(IntPtr bitmap, int x, int y, out int argb);
	[DllImport("gdiplus.dll")] static extern int GdipDisposeImage(IntPtr bitmap);
	[DllImport("gdiplus.dll")] static extern int GdipBitmapApplyEffect(IntPtr bitmap, IntPtr effect, IntPtr roi, bool useAux, IntPtr aux, IntPtr auxSize);
	static void Check(int status) { if (status != 0) throw new Exception("GDI+ status " + status); }
	static byte[] Pixels(IntPtr bitmap)
	{
		byte[] data = new byte[16 * 16 * 4];
		for (int y = 0; y < 16; y++) for (int x = 0; x < 16; x++) {
			int argb; Check(GdipBitmapGetPixel(bitmap, x, y, out argb));
			int o = (y * 16 + x) * 4;
			data[o] = (byte)(argb >> 16); data[o + 1] = (byte)(argb >> 8); data[o + 2] = (byte)argb; data[o + 3] = (byte)(argb >> 24);
		}
		return data;
	}
	static byte[] Case(string dir, string name, string guid, byte[] parameters, bool ramp = false)
	{
		IntPtr bitmap = IntPtr.Zero, effect = IntPtr.Zero;
		try {
			Check(GdipCreateBitmapFromScan0(16, 16, 0, 0x26200a, IntPtr.Zero, out bitmap));
			for (int y = 0; y < 16; y++) for (int x = 0; x < 16; x++) {
				int a = ramp || y < 8 ? 255 : new int[] { 0, 64, 128, 200 }[x % 4];
				int rgb = ramp ? (y * 16 + x) * 0x010101 : ((x * 17) << 16) | ((y * 17) << 8) | ((x * 31 + y * 13) & 255);
				Check(GdipBitmapSetPixel(bitmap, x, y, (a << 24) | rgb));
			}
			byte[] source = Pixels(bitmap);
			Check(GdipCreateEffect(new Guid(guid), out effect));
			Check(GdipSetEffectParameters(effect, parameters, (uint)parameters.Length));
			Check(GdipBitmapApplyEffect(bitmap, effect, IntPtr.Zero, false, IntPtr.Zero, IntPtr.Zero));
			byte[] expected = Pixels(bitmap);
			if (!ramp) File.WriteAllText(Path.Combine(dir, "effect-" + name + ".json"), "{\"guid\":\"" + guid + "\",\"parameters\":\"" + Convert.ToBase64String(parameters) + "\",\"source\":\"" + Convert.ToBase64String(source) + "\",\"expected\":\"" + Convert.ToBase64String(expected) + "\"}");
			return expected;
		} finally {
			if (effect != IntPtr.Zero) GdipDeleteEffect(effect);
			if (bitmap != IntPtr.Zero) GdipDisposeImage(bitmap);
		}
	}
	public static void Run(string dir)
	{
		using (var init = new Bitmap(1, 1)) {
			float[] matrix = { 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1 };
			byte[] m = new byte[100]; Buffer.BlockCopy(matrix, 0, m, 0, 100);
			Case(dir, "matrix-swap", "718f2615-7933-40e3-a511-5f68fe14dd74", m);
			matrix = new float[] { .8f, .2f, 0, 0, 0, .1f, .7f, .2f, 0, 0, .2f, 0, .9f, 0, 0, 0, 0, 0, .5f, 0, .1f, -.1f, .05f, .2f, 1 };
			Buffer.BlockCopy(matrix, 0, m, 0, 100);
			Case(dir, "matrix-mix", "718f2615-7933-40e3-a511-5f68fe14dd74", m);
			byte[] lut = new byte[1024];
			for (int i = 0; i < 256; i++) { lut[i] = (byte)(255 - i); lut[256 + i] = (byte)(i / 2); lut[512 + i] = (byte)Math.Min(255, i + 30); lut[768 + i] = (byte)i; }
			Case(dir, "lookup", "a7ce72a9-0f7f-40d7-b3cc-d0c02d5c3212", lut);
			int[][] balances = { new int[] { 50, -25, 75 }, new int[] { -100, 100, 0 }, new int[] { 1, -1, 33 }, new int[] { -47, 58, 19 }, new int[] { 99, 41, -3 } };
			for (int i = 0; i < balances.Length; i++) {
				byte[] balance = new byte[12]; Buffer.BlockCopy(balances[i], 0, balance, 0, 12);
				Case(dir, "balance-" + i, "537e597d-251e-48da-9664-29ca496b70f8", balance);
			}
		}
	}
	public static void BalanceSweep(string dir)
	{
		byte[] lookup = new byte[201 * 256];
		using (var init = new Bitmap(1, 1)) for (int value = -100; value <= 100; value++) {
			byte[] parameters = new byte[12];
			Buffer.BlockCopy(new int[] { value, value, value }, 0, parameters, 0, 12);
			byte[] pixels = Case(dir, "balance-sweep-" + value, "537e597d-251e-48da-9664-29ca496b70f8", parameters, true);
			for (int level = 0; level < 256; level++) lookup[(value + 100) * 256 + level] = pixels[level * 4];
		}
		File.WriteAllText(Path.Combine(dir, "effect-balance-sweep.json"), "{\"expected\":\"" + Convert.ToBase64String(lookup) + "\"}");
	}
	public static void ContrastSweep(string dir)
	{
		int[] brightness = { -255, -73, -1, 0, 1, 30, 255 };
		int[] contrast = { -100, -99, -50, -1, 0, 1, 50, 99, 100 };
		byte[] lookup = new byte[brightness.Length * contrast.Length * 256];
		int offset = 0;
		using (var init = new Bitmap(1, 1)) foreach (int b in brightness) foreach (int c in contrast) {
			byte[] parameters = new byte[8]; Buffer.BlockCopy(new int[] { b, c }, 0, parameters, 0, 8);
			byte[] pixels = Case(dir, "contrast-sweep", "d3a1dbe1-8ec4-4c17-9f4c-ea97ad1c343d", parameters, true);
			for (int level = 0; level < 256; level++) lookup[offset++] = pixels[level * 4];
		}
		File.WriteAllText(Path.Combine(dir, "effect-contrast-sweep.json"), "{\"brightness\":[-255,-73,-1,0,1,30,255],\"contrast\":[-100,-99,-50,-1,0,1,50,99,100],\"expected\":\"" + Convert.ToBase64String(lookup) + "\"}");
	}
}
