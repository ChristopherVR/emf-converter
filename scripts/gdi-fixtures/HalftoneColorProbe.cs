using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

/// <summary>
/// Captures Windows' halftone colour-adjustment cubes. For each of the 32^3
/// palette colours (inputs <c>vin[n]</c> chosen so the dither does not move the
/// level) it stretches an 8x8 patch in HALFTONE mode under
/// <c>SetColorAdjustment</c> and keeps the most frequent output channel values.
/// Writes R, G, B bytes per colour, index <c>(r * 32 + g) * 32 + b</c>. The
/// illuminant cubes back <c>src/emf-gdi-illuminant-data.ts</c> (see
/// <c>generate-illuminant-data.ts</c>); cubes for other adjustments measured
/// the stage order and constants in <c>src/emf-gdi-color-adjust.ts</c>.
/// </summary>
public static class HalftoneColorProbe
{
	[StructLayout(LayoutKind.Sequential)]
	struct BIH { public int biSize, biWidth, biHeight; public short biPlanes, biBitCount; public int biCompression, biSizeImage, x, y, c, i; }
	[DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
	[DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
	[DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
	[DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr hdc, ref BIH bmi, uint u, out IntPtr bits, IntPtr s, uint o);
	[DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
	[DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
	[DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
	[DllImport("gdi32.dll")] static extern bool StretchBlt(IntPtr hdc, int x, int y, int w, int h, IntPtr src, int sx, int sy, int sw, int sh, uint rop);
	[DllImport("gdi32.dll")] static extern int SetStretchBltMode(IntPtr hdc, int mode);
	[DllImport("gdi32.dll")] static extern bool SetBrushOrgEx(IntPtr hdc, int x, int y, IntPtr p);
	[DllImport("gdi32.dll")] static extern bool GdiFlush();
	[DllImport("gdi32.dll")] static extern bool SetColorAdjustment(IntPtr hdc, byte[] ca);

	static IntPtr Make(IntPtr screen, int w, int h, out IntPtr bmp, out IntPtr bits, out IntPtr old)
	{
		var b = new BIH { biSize = 40, biWidth = w, biHeight = -h, biPlanes = 1, biBitCount = 32 };
		IntPtr dc = CreateCompatibleDC(screen);
		bmp = CreateDIBSection(screen, ref b, 0, out bits, IntPtr.Zero, 0);
		old = SelectObject(dc, bmp);
		return dc;
	}

	/// <summary>COLORADJUSTMENT bytes for flags, illuminant, gammas, reference black/white, contrast, brightness, colorfulness, tint.</summary>
	public static byte[] Adjustment(int flags, int illuminant, int rg, int gg, int bg, int black, int white, int contrast, int brightness, int colorfulness, int tint)
	{
		var ca = new byte[24];
		BitConverter.GetBytes((ushort)24).CopyTo(ca, 0);
		BitConverter.GetBytes((ushort)flags).CopyTo(ca, 2);
		BitConverter.GetBytes((ushort)illuminant).CopyTo(ca, 4);
		BitConverter.GetBytes((ushort)rg).CopyTo(ca, 6);
		BitConverter.GetBytes((ushort)gg).CopyTo(ca, 8);
		BitConverter.GetBytes((ushort)bg).CopyTo(ca, 10);
		BitConverter.GetBytes((ushort)black).CopyTo(ca, 12);
		BitConverter.GetBytes((ushort)white).CopyTo(ca, 14);
		BitConverter.GetBytes((short)contrast).CopyTo(ca, 16);
		BitConverter.GetBytes((short)brightness).CopyTo(ca, 18);
		BitConverter.GetBytes((short)colorfulness).CopyTo(ca, 20);
		BitConverter.GetBytes((short)tint).CopyTo(ca, 22);
		return ca;
	}

	/// <summary>Captures one cube for <paramref name="ca"/> into <paramref name="path"/>.</summary>
	public static void Cube(string path, byte[] ca)
	{
		var vin = new int[32];
		for (int n = 0; n < 32; n++)
		{
			int fl = (int)Math.Floor(255.0 * n / 31), ce = (int)Math.Ceiling(255.0 * n / 31);
			vin[n] = 255 * n - 31 * fl <= 31 * ce - 255 * n ? fl : ce;
		}
		const int S = 8;
		var cube = new byte[32768 * 3];
		IntPtr screen = GetDC(IntPtr.Zero);
		try
		{
			for (int i = 0; i < 32768; i++)
			{
				var input = new byte[S * S * 4];
				for (int k = 0; k < S * S; k++)
				{
					input[k * 4] = (byte)vin[i & 31];
					input[k * 4 + 1] = (byte)vin[(i >> 5) & 31];
					input[k * 4 + 2] = (byte)vin[i >> 10];
					input[k * 4 + 3] = 255;
				}
				IntPtr sb, sbits, sold, db, dbits, dold;
				IntPtr sdc = Make(screen, S, S, out sb, out sbits, out sold);
				Marshal.Copy(input, 0, sbits, input.Length);
				IntPtr ddc = Make(screen, S + 4, S + 4, out db, out dbits, out dold);
				SetStretchBltMode(ddc, 4);
				SetBrushOrgEx(ddc, 0, 0, IntPtr.Zero);
				if (!SetColorAdjustment(ddc, ca)) throw new Exception("SetColorAdjustment failed");
				if (!StretchBlt(ddc, 2, 2, S, S, sdc, 0, 0, S, S, 0x00CC0020)) throw new Exception("StretchBlt failed");
				GdiFlush();
				var px = new byte[(S + 4) * (S + 4) * 4];
				Marshal.Copy(dbits, px, 0, px.Length);
				for (int ch = 0; ch < 3; ch++)
				{
					var counts = new Dictionary<byte, int>();
					for (int y = 0; y < S; y++)
						for (int x = 0; x < S; x++)
						{
							byte v = px[((y + 2) * (S + 4) + x + 2) * 4 + 2 - ch];
							int c; counts.TryGetValue(v, out c); counts[v] = c + 1;
						}
					byte best = 0; int bc = -1;
					foreach (var kv in counts) if (kv.Value > bc) { bc = kv.Value; best = kv.Key; }
					cube[i * 3 + ch] = best;
				}
				SelectObject(sdc, sold); DeleteObject(sb); DeleteDC(sdc);
				SelectObject(ddc, dold); DeleteObject(db); DeleteDC(ddc);
			}
		}
		finally { ReleaseDC(IntPtr.Zero, screen); }
		File.WriteAllBytes(path, cube);
	}

	/// <summary>Captures the cubes of illuminants 1..8 (except D65) into <paramref name="dir"/> as <c>illuminant-cube-N.bin</c>.</summary>
	public static void IlluminantCubes(string dir)
	{
		Directory.CreateDirectory(dir);
		foreach (int illuminant in new[] { 1, 2, 3, 4, 5, 7, 8 })
			Cube(Path.Combine(dir, "illuminant-cube-" + illuminant + ".bin"), Adjustment(0, illuminant, 10000, 10000, 10000, 0, 10000, 0, 0, 0, 0));
	}
}
