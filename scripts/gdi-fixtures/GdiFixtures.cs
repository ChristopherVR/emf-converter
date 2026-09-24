// Ground-truth fixture generator for emf-converter's pixel-parity tests.
//
// Every case is drawn TWICE with the exact same GDI / GDI+ calls: once into
// a recording metafile (the fixture the converter replays) and once straight
// onto a 32bpp bitmap (the reference PNG, i.e. what real Windows GDI/GDI+
// paints). The tests replay the metafile at dpiScale 1 and compare pixels.
//
// Compiled and run by generate.ps1 (Windows PowerShell 5.1, C# 5 syntax).
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class GdiFixtures
{
	[StructLayout(LayoutKind.Sequential)]
	public struct RECT { public int Left, Top, Right, Bottom; }

	[StructLayout(LayoutKind.Sequential)]
	public struct BITMAPINFOHEADER
	{
		public int biSize; public int biWidth; public int biHeight; public short biPlanes; public short biBitCount;
		public int biCompression; public int biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter;
		public int biClrUsed; public int biClrImportant;
	}

	[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
	public struct LOGFONT
	{
		public int lfHeight; public int lfWidth; public int lfEscapement; public int lfOrientation; public int lfWeight;
		public byte lfItalic; public byte lfUnderline; public byte lfStrikeOut; public byte lfCharSet;
		public byte lfOutPrecision; public byte lfClipPrecision; public byte lfQuality; public byte lfPitchAndFamily;
		[MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string lfFaceName;
	}

	[StructLayout(LayoutKind.Sequential)]
	public struct POINT { public int X, Y; }

	/** GDI world-transform matrix: worldX = eM11*x + eM21*y + eDx, worldY = eM12*x + eM22*y + eDy. */
	[StructLayout(LayoutKind.Sequential)]
	public struct XFORM { public float eM11, eM12, eM21, eM22, eDx, eDy; }

	[DllImport("gdi32.dll")] static extern IntPtr CreateEnhMetaFileW(IntPtr hdcRef, [MarshalAs(UnmanagedType.LPWStr)] string file, ref RECT frame, [MarshalAs(UnmanagedType.LPWStr)] string desc);
	[DllImport("gdi32.dll")] static extern IntPtr CloseEnhMetaFile(IntPtr hdc);
	[DllImport("gdi32.dll")] static extern bool DeleteEnhMetaFile(IntPtr hemf);
	[DllImport("gdi32.dll")] static extern IntPtr CreateMetaFileW([MarshalAs(UnmanagedType.LPWStr)] string file);
	[DllImport("gdi32.dll")] static extern IntPtr CloseMetaFile(IntPtr hdc);
	[DllImport("gdi32.dll")] static extern bool DeleteMetaFile(IntPtr hmf);
	[DllImport("gdi32.dll")] static extern int GetDeviceCaps(IntPtr hdc, int index);
	[DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
	[DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
	[DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFOHEADER bmi, uint usage, out IntPtr bits, IntPtr hSection, uint offset);
	[DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
	[DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
	[DllImport("gdi32.dll")] static extern IntPtr CreateSolidBrush(int color);
	[DllImport("gdi32.dll")] static extern IntPtr CreatePen(int style, int width, int color);
	[DllImport("gdi32.dll")] static extern IntPtr CreateHatchBrush(int style, int color);
	[DllImport("gdi32.dll")] static extern IntPtr CreatePatternBrush(IntPtr hbm);
	[DllImport("gdi32.dll")] static extern IntPtr CreateBitmap(int w, int h, uint planes, uint bpp, byte[] bits);
	[DllImport("gdi32.dll")] static extern IntPtr GetStockObject(int i);
	[DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr hdc, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);
	[DllImport("gdi32.dll")] static extern bool StretchBlt(IntPtr hdc, int x, int y, int w, int h, IntPtr src, int sx, int sy, int sw, int sh, uint rop);
	[DllImport("gdi32.dll")] static extern int StretchDIBits(IntPtr hdc, int x, int y, int w, int h, int sx, int sy, int sw, int sh, byte[] bits, ref BITMAPINFOHEADER bmi, uint usage, uint rop);
	[DllImport("gdi32.dll")] static extern bool PatBlt(IntPtr hdc, int x, int y, int w, int h, uint rop);
	[DllImport("gdi32.dll")] static extern int SetBkColor(IntPtr hdc, int color);
	[DllImport("gdi32.dll")] static extern int SetBkMode(IntPtr hdc, int mode);
	[DllImport("gdi32.dll")] static extern int SetTextColor(IntPtr hdc, int color);
	[DllImport("gdi32.dll")] static extern uint SetTextAlign(IntPtr hdc, uint align);
	[DllImport("gdi32.dll")] static extern int SetStretchBltMode(IntPtr hdc, int mode);
	[DllImport("gdi32.dll")] static extern bool SetBrushOrgEx(IntPtr hdc, int x, int y, IntPtr prev);
	[DllImport("gdi32.dll")] static extern bool GdiFlush();
	[DllImport("gdi32.dll")] static extern int SetROP2(IntPtr hdc, int mode);
	[DllImport("gdi32.dll")] static extern int SetGraphicsMode(IntPtr hdc, int mode);
	[DllImport("gdi32.dll")] static extern bool SetWorldTransform(IntPtr hdc, ref XFORM xform);
	[DllImport("gdi32.dll")] static extern bool Rectangle(IntPtr hdc, int l, int t, int r, int b);
	[DllImport("gdi32.dll")] static extern bool Ellipse(IntPtr hdc, int l, int t, int r, int b);
	[DllImport("gdi32.dll")] static extern bool Polygon(IntPtr hdc, [In] POINT[] pts, int count);
	[DllImport("gdi32.dll")] static extern bool RoundRect(IntPtr hdc, int l, int t, int r, int b, int w, int h);
	[DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateFontIndirectW(ref LOGFONT lf);
	[DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool TextOutW(IntPtr hdc, int x, int y, string s, int n);
	[DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool GetTextExtentExPointW(IntPtr hdc, string s, int n, int max, IntPtr fit, [Out] int[] dx, out Size size);
	[DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern int GetTextFaceW(IntPtr hdc, int n, StringBuilder face);
	[DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hwnd);
	[DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
	[DllImport("user32.dll")] static extern bool FillRect(IntPtr hdc, ref RECT r, IntPtr brush);

	public delegate void GdiDraw(IntPtr hdc);
	public delegate void GpDraw(Graphics g);

	static string outDir;

	static int Rgb(int r, int g, int b) { return r | (g << 8) | (b << 16); }

	/** A top-down 32bpp DIB section selected into a fresh memory DC. */
	sealed class Dib : IDisposable
	{
		public IntPtr Dc; public IntPtr Bmp; public IntPtr Bits; public int W; public int H; IntPtr old;
		public Dib(IntPtr refDc, int w, int h)
		{
			W = w; H = h;
			var bmi = new BITMAPINFOHEADER();
			bmi.biSize = 40; bmi.biWidth = w; bmi.biHeight = -h; bmi.biPlanes = 1; bmi.biBitCount = 32;
			Dc = CreateCompatibleDC(refDc);
			Bmp = CreateDIBSection(refDc, ref bmi, 0, out Bits, IntPtr.Zero, 0);
			old = SelectObject(Dc, Bmp);
		}
		public void SavePng(string path)
		{
			GdiFlush();
			var bmp = new Bitmap(W, H, PixelFormat.Format32bppArgb);
			var data = bmp.LockBits(new Rectangle(0, 0, W, H), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
			var buf = new byte[W * H * 4];
			Marshal.Copy(Bits, buf, 0, buf.Length);
			for (int i = 3; i < buf.Length; i += 4) { buf[i] = 255; }
			Marshal.Copy(buf, 0, data.Scan0, buf.Length);
			bmp.UnlockBits(data);
			bmp.Save(path, ImageFormat.Png);
			bmp.Dispose();
		}
		public void Dispose() { SelectObject(Dc, old); DeleteObject(Bmp); DeleteDC(Dc); }
	}

	/** Records `draw` into `<name>.emf` and paints it directly into `<name>.png`. */
	public static void GdiCase(string name, int w, int h, GdiDraw draw)
	{
		IntPtr screen = GetDC(IntPtr.Zero);
		// rclFrame in .01 mm covering exactly w x h reference-device pixels.
		double mmPerPxX = GetDeviceCaps(screen, 4) * 100.0 / GetDeviceCaps(screen, 8);
		double mmPerPxY = GetDeviceCaps(screen, 6) * 100.0 / GetDeviceCaps(screen, 10);
		var frame = new RECT();
		frame.Right = (int)Math.Round(w * mmPerPxX); frame.Bottom = (int)Math.Round(h * mmPerPxY);
		IntPtr mdc = CreateEnhMetaFileW(screen, Path.Combine(outDir, name + ".emf"), ref frame, null);
		draw(mdc);
		DeleteEnhMetaFile(CloseEnhMetaFile(mdc));
		using (var dib = new Dib(screen, w, h))
		{
			draw(dib.Dc);
			dib.SavePng(Path.Combine(outDir, name + ".png"));
		}
		ReleaseDC(IntPtr.Zero, screen);
	}

	/** Records `draw` into `<name>.wmf` (placeable header added) and paints it into `<name>.png`. */
	public static void WmfCase(string name, int w, int h, GdiDraw draw)
	{
		string tmp = Path.Combine(outDir, name + ".raw.wmf");
		IntPtr mdc = CreateMetaFileW(tmp);
		draw(mdc);
		DeleteMetaFile(CloseMetaFile(mdc));
		byte[] raw = File.ReadAllBytes(tmp);
		File.Delete(tmp);
		// Aldus placeable header: bounds 0,0,w,h at 96 units per inch.
		var ms = new MemoryStream();
		var bw = new BinaryWriter(ms);
		bw.Write((uint)0x9AC6CDD7); bw.Write((ushort)0);
		bw.Write((short)0); bw.Write((short)0); bw.Write((short)w); bw.Write((short)h);
		bw.Write((ushort)96); bw.Write((uint)0);
		ushort sum = 0;
		byte[] hdr = ms.ToArray();
		for (int i = 0; i < 20; i += 2) { sum ^= BitConverter.ToUInt16(hdr, i); }
		bw.Write(sum);
		bw.Write(raw);
		File.WriteAllBytes(Path.Combine(outDir, name + ".wmf"), ms.ToArray());
		IntPtr screen = GetDC(IntPtr.Zero);
		using (var dib = new Dib(screen, w, h))
		{
			draw(dib.Dc);
			dib.SavePng(Path.Combine(outDir, name + ".png"));
		}
		ReleaseDC(IntPtr.Zero, screen);
	}

	/** Records `draw` as an EmfPlusOnly metafile and paints it directly into `<name>.png` with GDI+. */
	public static void GpCase(string name, int w, int h, GpDraw draw)
	{
		using (var refG = Graphics.FromHwnd(IntPtr.Zero))
		{
			IntPtr hdc = refG.GetHdc();
			var mf = new Metafile(Path.Combine(outDir, name + ".emf"), hdc, new RectangleF(0, 0, w, h), MetafileFrameUnit.Pixel, EmfType.EmfPlusOnly);
			refG.ReleaseHdc(hdc);
			using (var g = Graphics.FromImage(mf)) { g.PageUnit = GraphicsUnit.Pixel; draw(g); }
			mf.Dispose();
		}
		using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
		{
			using (var g = Graphics.FromImage(bmp)) { g.PageUnit = GraphicsUnit.Pixel; draw(g); }
			bmp.Save(Path.Combine(outDir, name + ".png"), ImageFormat.Png);
		}
	}

	// -----------------------------------------------------------------------
	// Shared GDI drawing helpers
	// -----------------------------------------------------------------------

	static void Fill(IntPtr hdc, int l, int t, int r, int b, int color)
	{
		var rc = new RECT(); rc.Left = l; rc.Top = t; rc.Right = r; rc.Bottom = b;
		IntPtr br = CreateSolidBrush(color);
		FillRect(hdc, ref rc, br);
		DeleteObject(br);
	}

	static readonly int[] Palette = {
		Rgb(0xE0, 0x30, 0x20), Rgb(0x20, 0xA0, 0x40), Rgb(0x30, 0x50, 0xD0), Rgb(0xF0, 0xD0, 0x10),
		Rgb(0x90, 0x20, 0xB0), Rgb(0x10, 0xC0, 0xC0), Rgb(0xFF, 0xFF, 0xFF), Rgb(0x00, 0x00, 0x00),
	};

	/** Destination backdrop: vertical colour stripes 3px wide, so D varies inside every cell. */
	static void Stripes(IntPtr hdc, int w, int h)
	{
		for (int x = 0, i = 0; x < w; x += 3, i++) { Fill(hdc, x, 0, x + 3, h, Palette[i % Palette.Length]); }
	}

	/** A 32bpp source DC: horizontal colour bands 2px tall, offset against the palette. */
	static Dib SourceBitmap(IntPtr refDc, int w, int h)
	{
		var src = new Dib(refDc, w, h);
		for (int y = 0, i = 3; y < h; y += 2, i++) { Fill(src.Dc, 0, y, w, y + 2, Palette[i % Palette.Length]); }
		return src;
	}

	static byte[] SourceDibBits(int w, int h, out BITMAPINFOHEADER bmi)
	{
		bmi = new BITMAPINFOHEADER();
		bmi.biSize = 40; bmi.biWidth = w; bmi.biHeight = h; bmi.biPlanes = 1; bmi.biBitCount = 32;
		var bits = new byte[w * h * 4];
		for (int y = 0; y < h; y++)
		{
			for (int x = 0; x < w; x++)
			{
				int c = Palette[(x / 2 + y / 3) % Palette.Length];
				int o = (y * w + x) * 4; // bottom-up rows: row 0 is the image bottom
				bits[o] = (byte)((c >> 16) & 0xff); bits[o + 1] = (byte)((c >> 8) & 0xff); bits[o + 2] = (byte)(c & 0xff);
			}
		}
		return bits;
	}

	// -----------------------------------------------------------------------
	// ROP3 cases
	// -----------------------------------------------------------------------

	const int Cell = 12, Gap = 2, Pitch = Cell + Gap;

	/** 256 cells: BitBlt with every ROP3 index over striped D, banded S and brush `makeBrush`. */
	static void RopGrid(string name, Func<IntPtr> makeBrush, bool withSource)
	{
		int w = 16 * Pitch, h = 16 * Pitch;
		GdiCase(name, w, h, delegate (IntPtr hdc)
		{
			IntPtr screen = GetDC(IntPtr.Zero);
			Stripes(hdc, w, h);
			SetBkColor(hdc, Rgb(0xFF, 0xEE, 0xDD));
			SetTextColor(hdc, Rgb(0x11, 0x22, 0x33));
			IntPtr brush = makeBrush();
			IntPtr oldBrush = SelectObject(hdc, brush);
			using (var src = SourceBitmap(screen, Cell, Cell))
			{
				for (int i = 0; i < 256; i++)
				{
					int x = (i % 16) * Pitch, y = (i / 16) * Pitch;
					uint rop = (uint)i << 16;
					if (withSource) { BitBlt(hdc, x, y, Cell, Cell, src.Dc, 0, 0, rop); }
					else { PatBlt(hdc, x, y, Cell, Cell, rop); }
				}
			}
			SelectObject(hdc, oldBrush);
			DeleteObject(brush);
			ReleaseDC(IntPtr.Zero, screen);
		});
	}

	static IntPtr MakePatternBrush()
	{
		// 8x8 monochrome pattern (1 = text colour ... rendered via bk/text colours).
		byte[] rows = { 0x81, 0x42, 0x24, 0x18, 0x18, 0x24, 0x42, 0x81 };
		var bits = new byte[16];
		for (int i = 0; i < 8; i++) { bits[i * 2] = rows[i]; }
		IntPtr bm = CreateBitmap(8, 8, 1, 1, bits);
		IntPtr br = CreatePatternBrush(bm);
		DeleteObject(bm);
		return br;
	}

	static IntPtr MakeColorPatternBrush(IntPtr refDc)
	{
		var dib = new Dib(refDc, 8, 8);
		for (int y = 0; y < 8; y++) { for (int x = 0; x < 8; x++) { Fill(dib.Dc, x, y, x + 1, y + 1, Palette[(x + 2 * y) % 6]); } }
		IntPtr br = CreatePatternBrush(dib.Bmp);
		dib.Dispose();
		return br;
	}

	static void RopCases()
	{
		// Every HS_* hatch style (PATCOPY and PATINVERT), with and without OPAQUE background mode.
		GdiCase("rop3-hatch-styles", 6 * 24, 72, delegate (IntPtr hdc)
		{
			Stripes(hdc, 6 * 24, 72);
			SetBkColor(hdc, Rgb(0xFF, 0xF0, 0xC0));
			for (int s = 0; s < 6; s++)
			{
				IntPtr brush = CreateHatchBrush(s, Rgb(0x10, 0x20, 0x80 + s * 20));
				IntPtr ob = SelectObject(hdc, brush);
				SetBkMode(hdc, 2);
				PatBlt(hdc, s * 24, 0, 16, 16, 0x00F00021);
				PatBlt(hdc, s * 24, 24, 16, 16, 0x005A0049);
				SetBkMode(hdc, 1);
				PatBlt(hdc, s * 24, 48, 16, 16, 0x00F00021);
				SelectObject(hdc, ob);
				DeleteObject(brush);
			}
		});

		RopGrid("rop3-grid-solid", delegate { return CreateSolidBrush(Rgb(0x35, 0x9A, 0xCB)); }, true);
		RopGrid("rop3-grid-hatch", delegate { return CreateHatchBrush(5, Rgb(0xC0, 0x10, 0x60)); }, true);
		RopGrid("rop3-grid-pattern-mono", MakePatternBrush, true);
		RopGrid("rop3-grid-pattern-color", delegate { IntPtr s = GetDC(IntPtr.Zero); IntPtr b = MakeColorPatternBrush(s); ReleaseDC(IntPtr.Zero, s); return b; }, true);
		RopGrid("rop3-patblt-hatch", delegate { return CreateHatchBrush(4, Rgb(0x10, 0x60, 0xC0)); }, false);

		// StretchBlt: 2x enlargement, mirrored destinations, a source sub-rect, and a brush origin.
		GdiCase("rop3-stretchblt", 200, 120, delegate (IntPtr hdc)
		{
			IntPtr screen = GetDC(IntPtr.Zero);
			Stripes(hdc, 200, 120);
			SetBrushOrgEx(hdc, 3, 5, IntPtr.Zero);
			IntPtr brush = CreateHatchBrush(2, Rgb(0x20, 0x20, 0x90));
			IntPtr ob = SelectObject(hdc, brush);
			SetBkColor(hdc, Rgb(0xF0, 0xF0, 0x80));
			using (var src = SourceBitmap(screen, 16, 16))
			{
				StretchBlt(hdc, 4, 4, 32, 32, src.Dc, 0, 0, 16, 16, 0x00C000CA); // MERGECOPY
				StretchBlt(hdc, 76, 4, -32, 32, src.Dc, 0, 0, 16, 16, 0x00660046); // SRCINVERT, mirrored X
				StretchBlt(hdc, 84, 36, 32, -32, src.Dc, 0, 0, 16, 16, 0x008800C6); // SRCAND, mirrored Y
				StretchBlt(hdc, 124, 4, 24, 24, src.Dc, 4, 2, 8, 8, 0x00FB0A09); // PATPAINT, source sub-rect
				BitBlt(hdc, 160, 4, 30, 30, src.Dc, 3, 5, 0x005A0049); // PATINVERT (no source)
				StretchBlt(hdc, 4, 60, 48, 40, src.Dc, 2, 1, 12, 10, 0x00B8074A); // PSDPxax
				StretchBlt(hdc, 60, 60, 40, 40, src.Dc, 0, 0, 16, 16, 0x00E20746); // DSPDxax
				StretchBlt(hdc, 150, 100, -40, -36, src.Dc, 0, 0, 16, 16, 0x00EE0086); // SRCPAINT, mirrored XY
			}
			SelectObject(hdc, ob);
			DeleteObject(brush);
			ReleaseDC(IntPtr.Zero, screen);
		});

		// Nearest-neighbour sampling of StretchDIBits at awkward ratios, per stretch mode.
		GdiCase("rop3-stretch-sampling", 160, 120, delegate (IntPtr hdc)
		{
			Stripes(hdc, 160, 120);
			var bmi = new BITMAPINFOHEADER();
			bmi.biSize = 40; bmi.biWidth = 13; bmi.biHeight = 11; bmi.biPlanes = 1; bmi.biBitCount = 32;
			var bits = new byte[13 * 11 * 4];
			for (int y = 0; y < 11; y++) { for (int x = 0; x < 13; x++) { int o = (y * 13 + x) * 4; bits[o] = (byte)(y * 23); bits[o + 1] = (byte)(x * 19); bits[o + 2] = (byte)(255 - x * 19); } }
			for (int m = 0; m < 2; m++)
			{
				SetStretchBltMode(hdc, m == 0 ? 1 : 3);
				int oy = m * 60;
				StretchDIBits(hdc, 2, oy + 2, 31, 27, 0, 0, 13, 11, bits, ref bmi, 0, 0x00CC0020);
				StretchDIBits(hdc, 40, oy + 2, 5, 4, 0, 0, 13, 11, bits, ref bmi, 0, 0x00CC0020);
				StretchDIBits(hdc, 50, oy + 2, 29, 17, 1, 2, 9, 7, bits, ref bmi, 0, 0x00CC0020);
				StretchDIBits(hdc, 84, oy + 2, 31, 27, 0, 0, 13, 11, bits, ref bmi, 0, 0x00660046);
				StretchDIBits(hdc, 120, oy + 2, 7, 6, 0, 0, 13, 11, bits, ref bmi, 0, 0x00660046);
			}
		});

		// StretchDIBits: source sub-rects of a bottom-up DIB, with ROPs that read P, S and D.
		GdiCase("rop3-stretchdibits", 180, 90, delegate (IntPtr hdc)
		{
			Stripes(hdc, 180, 90);
			IntPtr brush = CreateSolidBrush(Rgb(0x70, 0x30, 0xE0));
			IntPtr ob = SelectObject(hdc, brush);
			BITMAPINFOHEADER bmi;
			byte[] bits = SourceDibBits(20, 15, out bmi);
			StretchDIBits(hdc, 4, 4, 40, 30, 0, 0, 20, 15, bits, ref bmi, 0, 0x00CC0020);
			StretchDIBits(hdc, 50, 4, 30, 30, 5, 3, 10, 10, bits, ref bmi, 0, 0x00C000CA);
			StretchDIBits(hdc, 90, 4, 40, 40, 0, 0, 20, 15, bits, ref bmi, 0, 0x005A0049);
			StretchDIBits(hdc, 136, 4, 40, 30, 2, 2, 16, 12, bits, ref bmi, 0, 0x00FB0A09);
			StretchDIBits(hdc, 4, 50, 60, 36, 0, 0, 20, 15, bits, ref bmi, 0, 0x00960000 | 0x0169); // DPSxx
			StretchDIBits(hdc, 110, 86, -40, -30, 0, 0, 20, 15, bits, ref bmi, 0, 0x00660046); // SRCINVERT flipped
			SelectObject(hdc, ob);
			DeleteObject(brush);
		});
	}

	// -----------------------------------------------------------------------
	// Gradient cases (GDI+)
	// -----------------------------------------------------------------------

	static readonly WrapMode[] Wraps = { WrapMode.Tile, WrapMode.TileFlipX, WrapMode.TileFlipY, WrapMode.TileFlipXY, WrapMode.Clamp };

	static string WrapName(WrapMode m)
	{
		switch (m)
		{
			case WrapMode.Tile: return "tile";
			case WrapMode.TileFlipX: return "flipx";
			case WrapMode.TileFlipY: return "flipy";
			case WrapMode.TileFlipXY: return "flipxy";
			default: return "clamp";
		}
	}

	static void GradientCases()
	{
		const int W = 160, H = 100;
		foreach (var wrap in Wraps)
		{
			var wm = wrap;
			if (wm != WrapMode.Clamp)
			{
				GpCase("grad-linear-h-" + WrapName(wm), W, H, delegate (Graphics g)
				{
					using (var b = new LinearGradientBrush(new RectangleF(20, 10, 36, 30), Color.FromArgb(255, 220, 40, 30), Color.FromArgb(255, 30, 60, 210), LinearGradientMode.Horizontal))
					{ b.WrapMode = wm; g.FillRectangle(b, 0, 0, W, H); }
				});
				GpCase("grad-linear-a30-" + WrapName(wm), W, H, delegate (Graphics g)
				{
					using (var b = new LinearGradientBrush(new RectangleF(30, 20, 40, 28), Color.FromArgb(255, 250, 210, 20), Color.FromArgb(255, 20, 120, 60), 30f))
					{ b.WrapMode = wm; g.FillRectangle(b, 0, 0, W, H); }
				});
				GpCase("grad-linear-skew-blend-" + WrapName(wm), W, H, delegate (Graphics g)
				{
					using (var b = new LinearGradientBrush(new RectangleF(0, 0, 30, 20), Color.White, Color.FromArgb(255, 120, 20, 140), 0f))
					{
						b.WrapMode = wm;
						var blend = new Blend(3);
						blend.Factors = new float[] { 0f, 0.8f, 1f };
						blend.Positions = new float[] { 0f, 0.3f, 1f };
						b.Blend = blend;
						b.MultiplyTransform(new Matrix(1f, 0.4f, 0.3f, 1.2f, 25f, 15f));
						g.FillRectangle(b, 0, 0, W, H);
					}
				});
				GpCase("grad-linear-preset-a120-" + WrapName(wm), W, H, delegate (Graphics g)
				{
					using (var b = new LinearGradientBrush(new RectangleF(50, 30, 44, 26), Color.Black, Color.Black, 120f))
					{
						b.WrapMode = wm;
						var cb = new ColorBlend(3);
						cb.Colors = new Color[] { Color.FromArgb(255, 255, 60, 0), Color.FromArgb(255, 255, 255, 255), Color.FromArgb(255, 0, 90, 200) };
						cb.Positions = new float[] { 0f, 0.4f, 1f };
						b.InterpolationColors = cb;
						g.FillRectangle(b, 0, 0, W, H);
					}
				});
			}
			GpCase("grad-path-ellipse-" + WrapName(wm), W, H, delegate (Graphics g)
			{
				using (var p = new GraphicsPath())
				{
					p.AddEllipse(30, 20, 50, 34);
					using (var b = new PathGradientBrush(p))
					{
						b.CenterColor = Color.FromArgb(255, 255, 255, 255);
						b.SurroundColors = new Color[] { Color.FromArgb(255, 20, 60, 200) };
						b.WrapMode = wm;
						g.FillRectangle(b, 0, 0, W, H);
					}
				}
			});
			GpCase("grad-path-triangle-" + WrapName(wm), W, H, delegate (Graphics g)
			{
				var pts = new PointF[] { new PointF(40, 12), new PointF(84, 60), new PointF(10, 50) };
				using (var b = new PathGradientBrush(pts))
				{
					b.CenterColor = Color.FromArgb(255, 250, 250, 200);
					b.CenterPoint = new PointF(42, 42);
					b.SurroundColors = new Color[] { Color.FromArgb(255, 230, 30, 30), Color.FromArgb(255, 30, 180, 40), Color.FromArgb(255, 30, 40, 220) };
					b.WrapMode = wm;
					g.FillRectangle(b, 0, 0, W, H);
				}
			});
			GpCase("grad-path-rect-blend-" + WrapName(wm), W, H, delegate (Graphics g)
			{
				var pts = new PointF[] { new PointF(20, 20), new PointF(70, 20), new PointF(70, 56), new PointF(20, 56) };
				using (var b = new PathGradientBrush(pts))
				{
					b.CenterColor = Color.FromArgb(255, 255, 230, 0);
					b.SurroundColors = new Color[] { Color.FromArgb(255, 120, 0, 60) };
					var blend = new Blend(3);
					blend.Factors = new float[] { 0f, 0.2f, 1f };
					blend.Positions = new float[] { 0f, 0.7f, 1f };
					b.Blend = blend;
					b.WrapMode = wm;
					g.FillRectangle(b, 0, 0, W, H);
				}
			});
		}
	}

	// -----------------------------------------------------------------------
	// Text cases (dx-less WMF TextOut; reference advances from GDI itself)
	// -----------------------------------------------------------------------

	static readonly string[] Samples = { "AVAWAY Toffee fi fl WAVE", "Hello, World! 0123456789", "illegal minimum" };
	static readonly string[] Faces = { "Arial", "Times New Roman", "Courier New", "MS Shell Dlg", "Helv", "NoSuchFaceXyz" };

	static void TextCases()
	{
		var json = new StringBuilder();
		json.Append("[\n");
		bool first = true;
		IntPtr screen = GetDC(IntPtr.Zero);
		foreach (var face in Faces)
		{
			foreach (int height in new int[] { -13, -20, 18 })
			{
				string name = "text-" + face.Replace(" ", "").ToLowerInvariant() + "-h" + (height < 0 ? "m" + (-height) : "p" + height);
				string sample = Samples[(Math.Abs(height) + face.Length) % Samples.Length];
				var lf = new LOGFONT();
				lf.lfHeight = height; lf.lfWeight = 400; lf.lfCharSet = 1; lf.lfFaceName = face;
				lf.lfPitchAndFamily = (byte)(face == "NoSuchFaceXyz" ? 0x12 : 0); // VARIABLE_PITCH | FF_ROMAN
				lf.lfQuality = 3; // NONANTIALIASED_QUALITY: crisp reference glyphs
				WmfCase(name, 360, 40, delegate (IntPtr hdc)
				{
					Fill(hdc, 0, 0, 360, 40, Rgb(255, 255, 255));
					IntPtr font = CreateFontIndirectW(ref lf);
					IntPtr of = SelectObject(hdc, font);
					SetBkMode(hdc, 1);
					SetTextColor(hdc, 0);
					SetTextAlign(hdc, 24); // TA_BASELINE
					TextOutW(hdc, 6, 28, sample, sample.Length);
					SelectObject(hdc, of);
					DeleteObject(font);
				});
				// GDI's own per-character placement for the same font on a screen-compatible DC.
				IntPtr fontM = CreateFontIndirectW(ref lf);
				IntPtr ofM = SelectObject(screen, fontM);
				var ext = new int[sample.Length];
				Size sz;
				GetTextExtentExPointW(screen, sample, sample.Length, 0, IntPtr.Zero, ext, out sz);
				var realFace = new StringBuilder(64);
				GetTextFaceW(screen, 64, realFace);
				SelectObject(screen, ofM);
				DeleteObject(fontM);
				if (!first) { json.Append(",\n"); }
				first = false;
				json.Append("  { \"name\": \"" + name + "\", \"face\": \"" + face + "\", \"realizedFace\": \"" + realFace + "\", \"height\": " + height + ", \"text\": \"" + sample + "\", \"x\": 6, \"extents\": [" + string.Join(",", Array.ConvertAll(ext, delegate (int v) { return v.ToString(); })) + "] }");
			}
		}
		ReleaseDC(IntPtr.Zero, screen);
		json.Append("\n]\n");
		File.WriteAllText(Path.Combine(outDir, "text-gdi-extents.json"), json.ToString());
	}

	// -----------------------------------------------------------------------
	// Pattern-brush FILL cases (Rectangle/Ellipse/Polygon/RoundRect, not blits):
	// exercises applyBrush's tiled-pattern branch, not the ROP3 blit evaluator
	// the rop3-grid-pattern-* fixtures already cover.
	// -----------------------------------------------------------------------

	static void PatternFillCases()
	{
		IntPtr screen = GetDC(IntPtr.Zero);

		GdiCase("pattern-fill-rect-mono", 160, 120, delegate (IntPtr hdc)
		{
			Stripes(hdc, 160, 120);
			IntPtr brush = MakePatternBrush();
			IntPtr ob = SelectObject(hdc, brush);
			IntPtr pen = CreatePen(0, 1, Rgb(0x10, 0x20, 0x30));
			IntPtr op = SelectObject(hdc, pen);
			Rectangle(hdc, 20, 20, 140, 100);
			SelectObject(hdc, op); DeleteObject(pen);
			SelectObject(hdc, ob); DeleteObject(brush);
		});

		GdiCase("pattern-fill-rect-color", 160, 120, delegate (IntPtr hdc)
		{
			Stripes(hdc, 160, 120);
			IntPtr brush = MakeColorPatternBrush(screen);
			IntPtr ob = SelectObject(hdc, brush);
			IntPtr pen = CreatePen(0, 1, Rgb(0xF0, 0xF0, 0xF0));
			IntPtr op = SelectObject(hdc, pen);
			SetBrushOrgEx(hdc, 3, 5, IntPtr.Zero);
			Rectangle(hdc, 20, 20, 140, 100);
			SelectObject(hdc, op); DeleteObject(pen);
			SelectObject(hdc, ob); DeleteObject(brush);
		});

		GdiCase("pattern-fill-ellipse-color", 160, 120, delegate (IntPtr hdc)
		{
			Stripes(hdc, 160, 120);
			IntPtr brush = MakeColorPatternBrush(screen);
			IntPtr ob = SelectObject(hdc, brush);
			IntPtr pen = CreatePen(0, 1, Rgb(0x10, 0x10, 0x10));
			IntPtr op = SelectObject(hdc, pen);
			Ellipse(hdc, 15, 10, 145, 110);
			SelectObject(hdc, op); DeleteObject(pen);
			SelectObject(hdc, ob); DeleteObject(brush);
		});

		GdiCase("pattern-fill-polygon-color", 160, 120, delegate (IntPtr hdc)
		{
			Stripes(hdc, 160, 120);
			IntPtr brush = MakeColorPatternBrush(screen);
			IntPtr ob = SelectObject(hdc, brush);
			IntPtr pen = CreatePen(0, 1, Rgb(0x10, 0x10, 0x10));
			IntPtr op = SelectObject(hdc, pen);
			var pts = new POINT[] {
				new POINT { X = 80, Y = 8 }, new POINT { X = 150, Y = 45 }, new POINT { X = 125, Y = 112 },
				new POINT { X = 35, Y = 112 }, new POINT { X = 10, Y = 45 },
			};
			Polygon(hdc, pts, pts.Length);
			SelectObject(hdc, op); DeleteObject(pen);
			SelectObject(hdc, ob); DeleteObject(brush);
		});

		GdiCase("pattern-fill-roundrect-mono", 160, 120, delegate (IntPtr hdc)
		{
			Stripes(hdc, 160, 120);
			IntPtr brush = MakePatternBrush();
			IntPtr ob = SelectObject(hdc, brush);
			IntPtr pen = CreatePen(0, 1, Rgb(0x20, 0x20, 0x20));
			IntPtr op = SelectObject(hdc, pen);
			RoundRect(hdc, 20, 15, 140, 105, 30, 30);
			SelectObject(hdc, op); DeleteObject(pen);
			SelectObject(hdc, ob); DeleteObject(brush);
		});

		ReleaseDC(IntPtr.Zero, screen);
	}

	// NOTE: an EMF+ TextureFill ground-truth fixture (a `TextureBrush` built
	// from an in-memory `Bitmap`) was attempted here and removed: measured
	// against real GDI+ output, .NET's EMF+ recorder always serialises the
	// brush's embedded image as a compressed PNG blob (its BitmapDataType
	// value was even observed ambiguous between the two enum values this
	// format has used, with Width/Height/Stride/PixelFormat all zeroed for
	// the compressed case), never as raw pixels, even for a bitmap built
	// with no source file involved. Decoding that needs an async image
	// decode (`createImageBitmap`/`@napi-rs/canvas`), which the synchronous,
	// per-record EMF+ brush-object parse this package uses cannot perform.
	// `decodeTextureImage` (`emf-plus-brush-parser.ts`) still decodes a
	// genuinely uncompressed pixel-format embedded bitmap synchronously
	// (exercised by a hand-built fixture in
	// `emf-plus-object-parser.test.ts`, since no real GDI+ output was found
	// that takes this path), and the compressed case is now honestly
	// detected (zeroed/invalid dimensions) and falls back to a flat colour
	// instead of misreading the PNG bytes as raw pixels. See the README's
	// Limitations section.

	// -----------------------------------------------------------------------
	// GDI world-transform rotation/skew cases (plain GDI, not EMF+): a
	// rotated/skewed EMR_SETWORLDTRANSFORM applied to Rectangle/Ellipse/
	// Polygon/RoundRect fills and strokes.
	// -----------------------------------------------------------------------

	static XFORM RotationXform(double degrees, float dx, float dy)
	{
		double rad = degrees * Math.PI / 180.0;
		return new XFORM
		{
			eM11 = (float)Math.Cos(rad), eM12 = (float)Math.Sin(rad),
			eM21 = -(float)Math.Sin(rad), eM22 = (float)Math.Cos(rad),
			eDx = dx, eDy = dy,
		};
	}

	static void RotationCases()
	{
		GdiCase("rotate-rect-25deg", 160, 120, delegate (IntPtr hdc)
		{
			Stripes(hdc, 160, 120);
			SetGraphicsMode(hdc, 2);
			XFORM xf = RotationXform(25, 40, 20);
			SetWorldTransform(hdc, ref xf);
			IntPtr brush = CreateSolidBrush(Rgb(0x30, 0x80, 0xD0));
			IntPtr ob = SelectObject(hdc, brush);
			IntPtr pen = CreatePen(0, 1, Rgb(0x10, 0x10, 0x40));
			IntPtr op = SelectObject(hdc, pen);
			Rectangle(hdc, -30, -15, 30, 15);
			SelectObject(hdc, op); DeleteObject(pen);
			SelectObject(hdc, ob); DeleteObject(brush);
		});

		GdiCase("rotate-ellipse-40deg", 160, 120, delegate (IntPtr hdc)
		{
			Stripes(hdc, 160, 120);
			SetGraphicsMode(hdc, 2);
			XFORM xf = RotationXform(40, 80, 60);
			SetWorldTransform(hdc, ref xf);
			IntPtr brush = CreateSolidBrush(Rgb(0xD0, 0x50, 0x20));
			IntPtr ob = SelectObject(hdc, brush);
			IntPtr pen = CreatePen(0, 1, Rgb(0x30, 0x10, 0x10));
			IntPtr op = SelectObject(hdc, pen);
			Ellipse(hdc, -50, -25, 50, 25);
			SelectObject(hdc, op); DeleteObject(pen);
			SelectObject(hdc, ob); DeleteObject(brush);
		});

		GdiCase("rotate-polygon-15deg", 160, 120, delegate (IntPtr hdc)
		{
			Stripes(hdc, 160, 120);
			SetGraphicsMode(hdc, 2);
			XFORM xf = RotationXform(15, 80, 60);
			SetWorldTransform(hdc, ref xf);
			IntPtr brush = CreateSolidBrush(Rgb(0x20, 0xA0, 0x60));
			IntPtr ob = SelectObject(hdc, brush);
			IntPtr pen = CreatePen(0, 1, Rgb(0x10, 0x30, 0x10));
			IntPtr op = SelectObject(hdc, pen);
			var pts = new POINT[] {
				new POINT { X = 0, Y = -50 }, new POINT { X = 45, Y = 25 }, new POINT { X = -45, Y = 25 },
			};
			Polygon(hdc, pts, pts.Length);
			SelectObject(hdc, op); DeleteObject(pen);
			SelectObject(hdc, ob); DeleteObject(brush);
		});

		GdiCase("rotate-roundrect-30deg", 160, 120, delegate (IntPtr hdc)
		{
			Stripes(hdc, 160, 120);
			SetGraphicsMode(hdc, 2);
			XFORM xf = RotationXform(30, 80, 60);
			SetWorldTransform(hdc, ref xf);
			IntPtr brush = CreateSolidBrush(Rgb(0x90, 0x40, 0xB0));
			IntPtr ob = SelectObject(hdc, brush);
			IntPtr pen = CreatePen(0, 1, Rgb(0x20, 0x10, 0x30));
			IntPtr op = SelectObject(hdc, pen);
			RoundRect(hdc, -45, -30, 45, 30, 20, 20);
			SelectObject(hdc, op); DeleteObject(pen);
			SelectObject(hdc, ob); DeleteObject(brush);
		});

		GdiCase("skew-rect", 160, 120, delegate (IntPtr hdc)
		{
			Stripes(hdc, 160, 120);
			SetGraphicsMode(hdc, 2);
			// A general affine (skew, no pure rotation): b/c both non-zero and unequal.
			XFORM xf = new XFORM { eM11 = 1f, eM12 = 0.35f, eM21 = 0.25f, eM22 = 1f, eDx = 20, eDy = 15 };
			SetWorldTransform(hdc, ref xf);
			IntPtr brush = CreateSolidBrush(Rgb(0xE0, 0xC0, 0x20));
			IntPtr ob = SelectObject(hdc, brush);
			IntPtr pen = CreatePen(0, 1, Rgb(0x40, 0x30, 0x00));
			IntPtr op = SelectObject(hdc, pen);
			Rectangle(hdc, 0, 0, 60, 40);
			SelectObject(hdc, op); DeleteObject(pen);
			SelectObject(hdc, ob); DeleteObject(brush);
		});
	}

	// -----------------------------------------------------------------------
	// Exact bitwise ROP2 cases: every SetROP2 mode (1..16) applied to a
	// filled + stroked Rectangle over a striped background.
	// -----------------------------------------------------------------------

	static void Rop2Cases()
	{
		GdiCase("rop2-bitwise-grid", 4 * 44, 4 * 44, delegate (IntPtr hdc)
		{
			Stripes(hdc, 4 * 44, 4 * 44);
			IntPtr brush = CreateSolidBrush(Rgb(0x33, 0x99, 0xCC));
			IntPtr pen = CreatePen(0, 1, Rgb(0x0F, 0x0F, 0x0F));
			IntPtr ob = SelectObject(hdc, brush);
			IntPtr op = SelectObject(hdc, pen);
			for (int mode = 1; mode <= 16; mode++)
			{
				SetROP2(hdc, mode);
				int col = (mode - 1) % 4, row = (mode - 1) / 4;
				int x = col * 44, y = row * 44;
				Rectangle(hdc, x + 4, y + 4, x + 40, y + 40);
			}
			SetROP2(hdc, 13); // R2_COPYPEN: restore default before cleanup
			SelectObject(hdc, op); DeleteObject(pen);
			SelectObject(hdc, ob); DeleteObject(brush);
		});
	}

	public static void Run(string dir, string which)
	{
		outDir = dir;
		Directory.CreateDirectory(dir);
		if (which == "all" || which == "rop") { RopCases(); }
		if (which == "all" || which == "gradient") { GradientCases(); }
		if (which == "all" || which == "text") { TextCases(); }
		if (which == "all" || which == "pattern") { PatternFillCases(); }
		if (which == "all" || which == "rotation") { RotationCases(); }
		if (which == "all" || which == "rop2") { Rop2Cases(); }
	}
}
