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
	[DllImport("gdi32.dll")] static extern bool BeginPath(IntPtr hdc);
	[DllImport("gdi32.dll")] static extern bool EndPath(IntPtr hdc);
	[DllImport("gdi32.dll")] static extern bool CloseFigure(IntPtr hdc);
	[DllImport("gdi32.dll")] static extern bool MoveToEx(IntPtr hdc, int x, int y, IntPtr prev);
	[DllImport("gdi32.dll")] static extern bool LineTo(IntPtr hdc, int x, int y);
	[DllImport("gdi32.dll")] static extern bool FillPath(IntPtr hdc);
	[DllImport("gdi32.dll")] static extern bool StrokeAndFillPath(IntPtr hdc);
	[DllImport("gdi32.dll")] static extern bool StrokePath(IntPtr hdc);
	[DllImport("gdi32.dll")] static extern int SetPolyFillMode(IntPtr hdc, int mode);
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

	/** Unpacks a `Rgb()`-packed int (r | g&lt;&lt;8 | b&lt;&lt;16) back into an opaque `Color`. */
	static Color PalColor(int packed)
	{
		return Color.FromArgb(255, packed & 0xff, (packed >> 8) & 0xff, (packed >> 16) & 0xff);
	}

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
	// EMF+ DrawImage of a real PNG-backed Bitmap: verifies BitmapDataType
	// ([MS-EMFPLUS] 2.1.1.2) against real GDI+ output for the standalone
	// Image object (not a TextureFill brush's embedded image, see below).
	// -----------------------------------------------------------------------

	static void ImageDrawCases()
	{
		string tmpPng = Path.Combine(outDir, "_tmp_image_draw_source.png");
		using (var src = new Bitmap(24, 20, PixelFormat.Format32bppArgb))
		{
			for (int y = 0; y < 20; y++)
			{
				for (int x = 0; x < 24; x++)
				{
					src.SetPixel(x, y, PalColor(Palette[(x / 3 + y / 3) % Palette.Length]));
				}
			}
			src.Save(tmpPng, ImageFormat.Png);
		}
		using (var bmp = new Bitmap(tmpPng))
		{
			GpCase("image-draw-png", 120, 90, delegate (Graphics g)
			{
				// EMF+'s recorded rclBounds is the tight bounding box of what was
				// actually drawn, not the frame passed to the Metafile constructor;
				// a corner-to-corner background keeps that bbox equal to the full
				// canvas so it lines up with the reference PNG (painted onto a
				// full-size Bitmap) pixel-for-pixel, the same convention the
				// gradient GpCase fixtures above use with their full-canvas fill.
				g.FillRectangle(Brushes.White, 0, 0, 120, 90);
				g.DrawImage(bmp, 8, 8, 48, 40);
				g.DrawImage(bmp, 64, 20, 40, 34);
			});
		}
		File.Delete(tmpPng);
	}

	// -----------------------------------------------------------------------
	// EMF+ TextureFill brush whose embedded image is a real PNG-backed
	// Bitmap: .NET's EMF+ recorder always serialises this as a compressed
	// image (see the note this replaces below), so this fixture exercises
	// the async pre-decode pass instead of the synchronous pixel-bitmap path
	// the uncompressed unit-test fixture already covers.
	// -----------------------------------------------------------------------

	static void TextureFillCompressedCase()
	{
		// Coarse (8px) blocks rather than a fine checkerboard: GDI+'s TextureBrush
		// tile is resampled through a Canvas `CanvasPattern`, which every tested
		// canvas backend filters regardless of `imageSmoothingEnabled` (see the
		// pattern-brush-fill note in emf-gdi-shape-paint.ts); a fine, hard-edged
		// test pattern would measure that pre-existing, separately-documented
		// residual rather than this fixture's actual purpose (does the compressed
		// image decode and paint the right content at all).
		string tmpPng = Path.Combine(outDir, "_tmp_texture_source.png");
		using (var src = new Bitmap(16, 16, PixelFormat.Format32bppArgb))
		{
			for (int y = 0; y < 16; y++)
			{
				for (int x = 0; x < 16; x++)
				{
					src.SetPixel(x, y, PalColor(Palette[(x / 8 + y / 8) % Palette.Length]));
				}
			}
			src.Save(tmpPng, ImageFormat.Png);
		}
		using (var bmp = new Bitmap(tmpPng))
		{
			GpCase("texture-fill-compressed", 160, 100, delegate (Graphics g)
			{
				using (var b = new TextureBrush(bmp))
				{
					b.WrapMode = WrapMode.Tile;
					// Full-canvas fill: see the comment in ImageDrawCases about why
					// rclBounds must match the frame exactly.
					g.FillRectangle(b, 0, 0, 160, 100);
				}
			});
		}
		File.Delete(tmpPng);
	}

	// -----------------------------------------------------------------------
	// Full-affine world-transform cases for bitmap blits and raster text:
	// real GDI rotates BOTH a BitBlt destination and ExtTextOutW/TextOutW
	// placement under a rotated EMR_SETWORLDTRANSFORM (confirmed against
	// these exact fixtures: the reference PNG is painted by the same GDI
	// calls under the same transform, so it IS the ground truth here).
	// -----------------------------------------------------------------------

	static void RotationAffineBlitTextCases()
	{
		GdiCase("rotate-bitblt-25deg", 160, 120, delegate (IntPtr hdc)
		{
			IntPtr screen = GetDC(IntPtr.Zero);
			Stripes(hdc, 160, 120);
			SetGraphicsMode(hdc, 2);
			XFORM xf = RotationXform(25, 60, 50);
			SetWorldTransform(hdc, ref xf);
			using (var src = SourceBitmap(screen, 24, 24))
			{
				BitBlt(hdc, -12, -12, 24, 24, src.Dc, 0, 0, 0x00CC0020); // SRCCOPY
			}
			ReleaseDC(IntPtr.Zero, screen);
		});

		GdiCase("rotate-text-25deg", 200, 140, delegate (IntPtr hdc)
		{
			Stripes(hdc, 200, 140);
			SetGraphicsMode(hdc, 2);
			XFORM xf = RotationXform(25, 40, 60);
			SetWorldTransform(hdc, ref xf);
			var lf = new LOGFONT();
			lf.lfHeight = -20; lf.lfWeight = 400; lf.lfCharSet = 1; lf.lfFaceName = "Arial"; lf.lfQuality = 3;
			IntPtr font = CreateFontIndirectW(ref lf);
			IntPtr of = SelectObject(hdc, font);
			SetBkMode(hdc, 1);
			SetTextColor(hdc, 0);
			TextOutW(hdc, 0, 0, "Rotated", 7);
			SelectObject(hdc, of);
			DeleteObject(font);
		});
	}

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

		// Same 16 SetROP2 modes, but the shape is built as a BeginPath/EndPath
		// bracket (MoveToEx/LineTo/CloseFigure) instead of an immediate
		// Rectangle: exercises the bitwise ROP2 combine for a bracketed path
		// fill+stroke (StrokeAndFillPath), not just an immediate shape.
		GdiCase("rop2-bitwise-path-bracket", 4 * 44, 4 * 44, delegate (IntPtr hdc)
		{
			Stripes(hdc, 4 * 44, 4 * 44);
			IntPtr brush = CreateSolidBrush(Rgb(0xCC, 0x66, 0x22));
			IntPtr pen = CreatePen(0, 1, Rgb(0x10, 0x10, 0x10));
			IntPtr ob = SelectObject(hdc, brush);
			IntPtr op = SelectObject(hdc, pen);
			SetPolyFillMode(hdc, 2); // WINDING
			for (int mode = 1; mode <= 16; mode++)
			{
				int col = (mode - 1) % 4, row = (mode - 1) / 4;
				int cx = col * 44 + 22, cy = row * 44 + 22;
				BeginPath(hdc);
				MoveToEx(hdc, cx, cy - 16, IntPtr.Zero);
				LineTo(hdc, cx + 16, cy - 5);
				LineTo(hdc, cx + 10, cy + 16);
				LineTo(hdc, cx - 10, cy + 16);
				LineTo(hdc, cx - 16, cy - 5);
				CloseFigure(hdc);
				EndPath(hdc);
				SetROP2(hdc, mode);
				StrokeAndFillPath(hdc);
			}
			SetROP2(hdc, 13);
			SelectObject(hdc, op); DeleteObject(pen);
			SelectObject(hdc, ob); DeleteObject(brush);
		});
	}

	// -----------------------------------------------------------------------
	// Extra text cases (category text-extra): every LOGFONT quality, sizes
	// 8-72 px across five faces, both lfHeight signs, weights/italic/
	// underline/strike-out/lfWidth, ExtTextOut Dx/ETO_PDY/ETO_OPAQUE/
	// ETO_CLIPPED/ETO_GLYPH_INDEX, every TA_* alignment incl. TA_UPDATECP,
	// OPAQUE backgrounds, escapement, world-transform rotation, the same
	// through WMF, and EMF+ DrawString under each TextRenderingHint.
	// -----------------------------------------------------------------------

	static class TxApi
	{
		[DllImport("gdi32.dll", CharSet = CharSet.Unicode)] public static extern bool ExtTextOutW(IntPtr hdc, int x, int y, uint options, ref RECT rc, string s, int n, int[] dx);
		[DllImport("gdi32.dll", CharSet = CharSet.Unicode, EntryPoint = "ExtTextOutW")] public static extern bool ExtTextOutNoRect(IntPtr hdc, int x, int y, uint options, IntPtr rc, string s, int n, int[] dx);
		[DllImport("gdi32.dll", EntryPoint = "ExtTextOutW")] public static extern bool ExtTextOutGlyphs(IntPtr hdc, int x, int y, uint options, IntPtr rc, ushort[] glyphs, int n, int[] dx);
		[DllImport("gdi32.dll", CharSet = CharSet.Unicode)] public static extern uint GetGlyphIndicesW(IntPtr hdc, string s, int n, [Out] ushort[] gi, uint flags);
	}

	static readonly string[] TxFaces = { "Arial", "Times New Roman", "Courier New", "Segoe UI", "Tahoma" };
	static readonly int[] TxSizes = { -8, -9, -10, -11, -12, -13, -14, -15, -16, -18, -20, -22, -24, -28, -32, -36, -48, -72 };
	static readonly int[] TxCellSizes = { 9, 10, 12, 14, 16, 18, 20, 23, 26, 30, 36, 44, 56 };
	const string TxSample = "Hamburgefonstiv 0123 AVWX &@%$";

	static string TxKey(string face) { return face.Replace(" ", "").ToLowerInvariant(); }

	static LOGFONT TxLf(string face, int height, int weight, bool italic, byte quality)
	{
		var lf = new LOGFONT();
		lf.lfHeight = height; lf.lfWeight = weight; lf.lfItalic = (byte)(italic ? 1 : 0);
		lf.lfCharSet = 1; lf.lfFaceName = face; lf.lfQuality = quality;
		return lf;
	}

	/** Selects `lf`, runs `body`, then restores and deletes the font. */
	static void TxWithFont(IntPtr hdc, LOGFONT lf, Action body)
	{
		IntPtr font = CreateFontIndirectW(ref lf);
		IntPtr old = SelectObject(hdc, font);
		body();
		SelectObject(hdc, old);
		DeleteObject(font);
	}

	static void TxLine(IntPtr hdc, LOGFONT lf, int x, int y, string s)
	{
		TxWithFont(hdc, lf, delegate { TextOutW(hdc, x, y, s, s.Length); });
	}

	/** One line per size, baseline-aligned, black on white. */
	static void TxSizeSheet(string name, string face, byte quality, int[] sizes, bool wmf)
	{
		int h = 6;
		foreach (int s in sizes) { h += (int)(Math.Abs(s) * 1.35) + 3; }
		GdiDraw draw = delegate (IntPtr hdc)
		{
			Fill(hdc, 0, 0, 480, h, Rgb(255, 255, 255));
			SetBkMode(hdc, 1); SetTextColor(hdc, 0); SetTextAlign(hdc, 24);
			int y = 3;
			foreach (int s in sizes)
			{
				y += (int)(Math.Abs(s) * 1.05) + 1;
				TxLine(hdc, TxLf(face, s, 400, false, quality), 4, y, TxSample);
				y += (int)(Math.Abs(s) * 0.3) + 2;
			}
		};
		if (wmf) { WmfCase(name, 480, h, draw); } else { GdiCase(name, 480, h, draw); }
	}

	/** Weight/italic/underline/strike-out/lfWidth variants at two sizes. */
	static void TxStyleSheet(string name, string face, byte quality, bool wmf)
	{
		int[][] v = {
			new[] { 400, 0, 0, 0, 0 }, new[] { 700, 0, 0, 0, 0 }, new[] { 400, 1, 0, 0, 0 }, new[] { 700, 1, 0, 0, 0 },
			new[] { 400, 0, 1, 0, 0 }, new[] { 400, 0, 0, 1, 0 }, new[] { 700, 1, 1, 1, 0 }, new[] { 900, 0, 0, 0, 0 },
			new[] { 300, 0, 0, 0, 0 }, new[] { 600, 0, 0, 0, 0 }, new[] { 100, 0, 0, 0, 0 },
			new[] { 400, 0, 0, 0, 4 }, new[] { 400, 0, 0, 0, 12 },
		};
		int[] heights = { -11, -17 };
		int h = 4 + v.Length * heights.Length * 22;
		GdiDraw draw = delegate (IntPtr hdc)
		{
			Fill(hdc, 0, 0, 420, h, Rgb(255, 255, 255));
			SetBkMode(hdc, 1); SetTextColor(hdc, 0); SetTextAlign(hdc, 24);
			int y = 4;
			foreach (int ht in heights)
			{
				foreach (int[] s in v)
				{
					y += 18;
					var lf = TxLf(face, ht, s[0], s[1] != 0, quality);
					lf.lfUnderline = (byte)s[2]; lf.lfStrikeOut = (byte)s[3]; lf.lfWidth = s[4] == 0 ? 0 : (ht < -12 ? s[4] + 3 : s[4]);
					TxLine(hdc, lf, 4, y, "Styled text: Quick fox jumps 0123");
					y += 4;
				}
			}
		};
		if (wmf) { WmfCase(name, 420, h, draw); } else { GdiCase(name, 420, h, draw); }
	}

	/** ExtTextOut Dx spacing, ETO_PDY, ETO_OPAQUE, ETO_CLIPPED and ETO_GLYPH_INDEX. */
	static void TxEtoSheet(string name, byte quality, bool wmf)
	{
		GdiDraw draw = delegate (IntPtr hdc)
		{
			Fill(hdc, 0, 0, 360, 250, Rgb(255, 255, 255));
			SetBkMode(hdc, 1); SetTextColor(hdc, Rgb(0x10, 0x20, 0x80)); SetBkColor(hdc, Rgb(0xFF, 0xE0, 0x70));
			SetTextAlign(hdc, 24);
			TxWithFont(hdc, TxLf("Arial", -16, 400, false, quality), delegate
			{
				string s = "Spaced Dx text";
				var dx = new int[s.Length];
				for (int i = 0; i < dx.Length; i++) { dx[i] = 9 + (i % 3) * 3; }
				TxApi.ExtTextOutNoRect(hdc, 6, 24, 0, IntPtr.Zero, s, s.Length, dx);
				var rc = new RECT(); rc.Left = 4; rc.Top = 34; rc.Right = 200; rc.Bottom = 58;
				TxApi.ExtTextOutW(hdc, 8, 52, 2, ref rc, "ETO_OPAQUE box", 14, null);
				rc.Left = 10; rc.Top = 64; rc.Right = 120; rc.Bottom = 78;
				TxApi.ExtTextOutW(hdc, 6, 80, 4, ref rc, "ETO_CLIPPED cut glyphs", 22, null);
				rc.Left = 150; rc.Top = 62; rc.Right = 300; rc.Bottom = 76;
				TxApi.ExtTextOutW(hdc, 146, 80, 6, ref rc, "Opaque+clipped text", 19, null);
				if (!wmf)
				{
					string p = "Pdy wave";
					var dxy = new int[p.Length * 2];
					for (int i = 0; i < p.Length; i++) { dxy[i * 2] = 11; dxy[i * 2 + 1] = (i % 2 == 0) ? -3 : 3; }
					TxApi.ExtTextOutNoRect(hdc, 6, 110, 0x2000, IntPtr.Zero, p, p.Length, dxy);
					string g = "Glyph index run";
					var gi = new ushort[g.Length];
					TxApi.GetGlyphIndicesW(hdc, g, g.Length, gi, 0);
					TxApi.ExtTextOutGlyphs(hdc, 150, 110, 0x10, IntPtr.Zero, gi, gi.Length, null);
					var gdx = new int[g.Length];
					for (int i = 0; i < gdx.Length; i++) { gdx[i] = 12; }
					TxApi.ExtTextOutGlyphs(hdc, 150, 140, 0x10, IntPtr.Zero, gi, gi.Length, gdx);
				}
				var ndx = new int[] { 8, 8, 8, 8, 8, 8, 8, 8, 8, 8 };
				TxApi.ExtTextOutNoRect(hdc, 6, 140, 0, IntPtr.Zero, "Narrow dx!", 10, ndx);
			});
			TxWithFont(hdc, TxLf("Times New Roman", -22, 700, true, quality), delegate
			{
				var rc = new RECT(); rc.Left = 6; rc.Top = 160; rc.Right = 340; rc.Bottom = 190;
				TxApi.ExtTextOutW(hdc, 12, 183, 6, ref rc, "Bold italic opaque", 18, null);
			});
			SetBkMode(hdc, 2);
			TxWithFont(hdc, TxLf("Courier New", -15, 400, false, quality), delegate
			{
				var rc = new RECT(); rc.Left = 6; rc.Top = 200; rc.Right = 100; rc.Bottom = 230;
				TxApi.ExtTextOutW(hdc, 20, 222, 4, ref rc, "bkmode opaque + clip", 20, null);
			});
		};
		if (wmf) { WmfCase(name, 360, 250, draw); } else { GdiCase(name, 360, 250, draw); }
	}

	/** Every TA_* horizontal x vertical combination, plus TA_UPDATECP runs. */
	static void TxAlignSheet(string name, byte quality, bool wmf)
	{
		uint[] hs = { 0, 6, 2 };     // TA_LEFT, TA_CENTER, TA_RIGHT
		uint[] vs = { 0, 24, 8 };    // TA_TOP, TA_BASELINE, TA_BOTTOM
		GdiDraw draw = delegate (IntPtr hdc)
		{
			Fill(hdc, 0, 0, 400, 260, Rgb(255, 255, 255));
			SetBkMode(hdc, 1); SetTextColor(hdc, 0);
			TxWithFont(hdc, TxLf("Arial", -15, 400, false, quality), delegate
			{
				for (int i = 0; i < 3; i++)
				{
					for (int j = 0; j < 3; j++)
					{
						SetTextAlign(hdc, hs[i] | vs[j]);
						TextOutW(hdc, 70 + i * 130, 24 + j * 42, "Align gy", 8);
					}
				}
				SetTextAlign(hdc, 1 | 24); // TA_UPDATECP | TA_BASELINE
				MoveToEx(hdc, 10, 170, IntPtr.Zero);
				TextOutW(hdc, 0, 0, "One ", 4);
				TextOutW(hdc, 0, 0, "two ", 4);
				TextOutW(hdc, 0, 0, "three", 5);
				SetTextAlign(hdc, 1 | 2 | 0); // TA_UPDATECP | TA_RIGHT | TA_TOP
				MoveToEx(hdc, 390, 190, IntPtr.Zero);
				TextOutW(hdc, 0, 0, "right", 5);
				TextOutW(hdc, 0, 0, "-to-", 4);
				TextOutW(hdc, 0, 0, "left", 4);
				SetTextAlign(hdc, 1 | 6 | 8); // TA_UPDATECP | TA_CENTER | TA_BOTTOM
				MoveToEx(hdc, 200, 250, IntPtr.Zero);
				TextOutW(hdc, 0, 0, "centered cp", 11);
			});
		};
		if (wmf) { WmfCase(name, 400, 260, draw); } else { GdiCase(name, 400, 260, draw); }
	}

	/** OPAQUE background mode: the text cell (ascent + descent, advance width) filled with bkColor. */
	static void TxOpaqueSheet(string name, byte quality, bool wmf)
	{
		GdiDraw draw = delegate (IntPtr hdc)
		{
			Stripes(hdc, 380, 180);
			SetBkMode(hdc, 2); SetBkColor(hdc, Rgb(0xFF, 0xF0, 0xB0)); SetTextColor(hdc, Rgb(0x80, 0x10, 0x10));
			SetTextAlign(hdc, 24);
			TxLine(hdc, TxLf("Arial", -14, 400, false, quality), 6, 22, "Opaque Arial 14 gjpqy");
			var lf = TxLf("Times New Roman", -20, 400, true, quality); lf.lfUnderline = 1;
			TxLine(hdc, lf, 6, 56, "Italic underlined opaque");
			SetTextAlign(hdc, 0);
			TxLine(hdc, TxLf("Segoe UI", -18, 700, false, quality), 6, 70, "Top-aligned bold Segoe");
			SetBkColor(hdc, Rgb(0x20, 0x20, 0x40)); SetTextColor(hdc, Rgb(0xFF, 0xFF, 0xFF));
			SetTextAlign(hdc, 8);
			TxLine(hdc, TxLf("Tahoma", 13, 400, false, quality), 6, 130, "Inverse Tahoma cell 13");
			SetTextAlign(hdc, 24);
			lf = TxLf("Courier New", -24, 400, false, quality); lf.lfStrikeOut = 1;
			TxLine(hdc, lf, 6, 165, "Courier strike");
		};
		if (wmf) { WmfCase(name, 380, 180, draw); } else { GdiCase(name, 380, 180, draw); }
	}

	/** lfEscapement (= lfOrientation) rotating the baseline and the glyphs. */
	static void TxEscapementSheet(string name, byte quality, bool wmf)
	{
		int[] esc = { 0, 300, 450, 900, 1800, 2700, 3150, 1200 };
		GdiDraw draw = delegate (IntPtr hdc)
		{
			Fill(hdc, 0, 0, 420, 420, Rgb(255, 255, 255));
			SetBkMode(hdc, 1); SetTextColor(hdc, 0); SetTextAlign(hdc, 24);
			for (int i = 0; i < esc.Length; i++)
			{
				var lf = TxLf(i % 2 == 0 ? "Arial" : "Times New Roman", -16, 400, false, quality);
				lf.lfEscapement = esc[i]; lf.lfOrientation = esc[i];
				int x = 60 + (i % 3) * 140, y = 70 + (i / 3) * 140;
				TxLine(hdc, lf, x, y, "Escape " + (esc[i] / 10));
			}
		};
		if (wmf) { WmfCase(name, 420, 420, draw); } else { GdiCase(name, 420, 420, draw); }
	}

	/** Rotated / scaled world transforms applied to text (EMF only: WMF has none). */
	static void TxWorldSheet(string name, byte quality)
	{
		double[] angles = { 25, 90, 180, -30, 10 };
		GdiCase(name, 360, 360, delegate (IntPtr hdc)
		{
			Fill(hdc, 0, 0, 360, 360, Rgb(255, 255, 255));
			SetBkMode(hdc, 1); SetTextColor(hdc, 0); SetTextAlign(hdc, 24);
			SetGraphicsMode(hdc, 2);
			for (int i = 0; i < angles.Length; i++)
			{
				XFORM xf = RotationXform(angles[i], 80 + (i % 3) * 110, 80 + (i / 3) * 150);
				SetWorldTransform(hdc, ref xf);
				TxLine(hdc, TxLf(i % 2 == 0 ? "Arial" : "Times New Roman", -17, 400, false, quality), 0, 0, "World " + angles[i]);
			}
			XFORM id = new XFORM { eM11 = 1, eM22 = 1 };
			SetWorldTransform(hdc, ref id);
			XFORM sc = new XFORM { eM11 = 2, eM22 = 2, eDx = 10, eDy = 300 };
			SetWorldTransform(hdc, ref sc);
			TxLine(hdc, TxLf("Arial", -9, 400, false, quality), 0, 0, "Scaled x2");
			SetWorldTransform(hdc, ref id);
		});
	}

	/** Coloured text over a striped backdrop (antialiased blending is visible). */
	static void TxColorSheet(string name, byte quality)
	{
		GdiCase(name, 360, 120, delegate (IntPtr hdc)
		{
			Stripes(hdc, 360, 120);
			SetBkMode(hdc, 1); SetTextAlign(hdc, 24);
			int[] colors = { Rgb(0, 0, 0), Rgb(0xFF, 0xFF, 0xFF), Rgb(0xC0, 0x10, 0x10), Rgb(0x10, 0x60, 0xE0) };
			for (int i = 0; i < colors.Length; i++)
			{
				SetTextColor(hdc, colors[i]);
				TxLine(hdc, TxLf(i % 2 == 0 ? "Segoe UI" : "Arial", -18 - i * 2, i == 2 ? 700 : 400, false, quality), 6, 26 + i * 28, "Colour text Ag " + i);
			}
		});
	}

	/** EMF+ DrawString under one TextRenderingHint. */
	static void TxPlusCase(string name, System.Drawing.Text.TextRenderingHint hint)
	{
		GpCase(name, 360, 140, delegate (Graphics g)
		{
			g.Clear(Color.White);
			g.TextRenderingHint = hint;
			using (var f = new Font("Arial", 16, FontStyle.Regular, GraphicsUnit.Pixel))
			using (var b = new SolidBrush(Color.Black))
			{
				g.DrawString("GDI+ DrawString Ag 0123", f, b, 6, 6);
			}
			using (var f = new Font("Times New Roman", 22, FontStyle.Italic, GraphicsUnit.Pixel))
			using (var b = new SolidBrush(Color.FromArgb(255, 0x20, 0x40, 0xA0)))
			{
				g.DrawString("Italic Times 22", f, b, 6, 40);
			}
			using (var f = new Font("Segoe UI", 12, FontStyle.Bold | FontStyle.Underline, GraphicsUnit.Pixel))
			using (var b = new SolidBrush(Color.Black))
			{
				g.DrawString("Bold underline Segoe 12", f, b, 6, 84);
			}
		});
	}

	static void TextExtraCases()
	{
		foreach (string f in TxFaces)
		{
			TxSizeSheet("textx-" + TxKey(f) + "-mono", f, 3, TxSizes, false);
			TxSizeSheet("textx-" + TxKey(f) + "-aa", f, 4, TxSizes, false);
			TxSizeSheet("textx-" + TxKey(f) + "-cell-mono", f, 3, TxCellSizes, false);
			TxStyleSheet("textx-" + TxKey(f) + "-styles-mono", f, 3, false);
		}
		TxSizeSheet("textx-arial-cleartype", "Arial", 5, TxSizes, false);
		TxSizeSheet("textx-segoeui-cleartype", "Segoe UI", 5, TxSizes, false);
		TxSizeSheet("textx-arial-ctnatural", "Arial", 6, TxSizes, false);
		TxSizeSheet("textx-arial-q0-default", "Arial", 0, TxSizes, false);
		TxSizeSheet("textx-arial-q1-draft", "Arial", 1, TxSizes, false);
		TxSizeSheet("textx-arial-q2-proof", "Arial", 2, TxSizes, false);
		TxStyleSheet("textx-arial-styles-aa", "Arial", 4, false);
		TxEtoSheet("textx-eto-mono", 3, false);
		TxEtoSheet("textx-eto-aa", 4, false);
		TxAlignSheet("textx-align-mono", 3, false);
		TxOpaqueSheet("textx-opaque-mono", 3, false);
		TxOpaqueSheet("textx-opaque-aa", 4, false);
		TxEscapementSheet("textx-escapement-mono", 3, false);
		TxEscapementSheet("textx-escapement-aa", 4, false);
		TxWorldSheet("textx-world-mono", 3);
		TxWorldSheet("textx-world-aa", 4);
		TxColorSheet("textx-color-aa", 4);
		TxColorSheet("textx-color-cleartype", 5);
		TxColorSheet("textx-color-mono", 3);
		// The same through WMF (ANSI META_TEXTOUT / META_EXTTEXTOUT records).
		foreach (string f in TxFaces)
		{
			TxSizeSheet("textx-wmf-" + TxKey(f) + "-mono", f, 3, TxSizes, true);
		}
		TxSizeSheet("textx-wmf-arial-aa", "Arial", 4, TxSizes, true);
		TxSizeSheet("textx-wmf-timesnewroman-cell-mono", "Times New Roman", 3, TxCellSizes, true);
		TxStyleSheet("textx-wmf-arial-styles-mono", "Arial", 3, true);
		TxStyleSheet("textx-wmf-timesnewroman-styles-mono", "Times New Roman", 3, true);
		TxEtoSheet("textx-wmf-eto-mono", 3, true);
		TxAlignSheet("textx-wmf-align-mono", 3, true);
		TxOpaqueSheet("textx-wmf-opaque-mono", 3, true);
		TxEscapementSheet("textx-wmf-escapement-mono", 3, true);
		// EMF+ DrawString under each TextRenderingHint.
		TxPlusCase("textx-plus-singlebitgridfit", System.Drawing.Text.TextRenderingHint.SingleBitPerPixelGridFit);
		TxPlusCase("textx-plus-singlebit", System.Drawing.Text.TextRenderingHint.SingleBitPerPixel);
		TxPlusCase("textx-plus-antialiasgridfit", System.Drawing.Text.TextRenderingHint.AntiAliasGridFit);
		TxPlusCase("textx-plus-antialias", System.Drawing.Text.TextRenderingHint.AntiAlias);
		TxPlusCase("textx-plus-cleartype", System.Drawing.Text.TextRenderingHint.ClearTypeGridFit);
		TxPlusCase("textx-plus-systemdefault", System.Drawing.Text.TextRenderingHint.SystemDefault);
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
		if (which == "all" || which == "image") { ImageDrawCases(); TextureFillCompressedCase(); }
		if (which == "all" || which == "rotation-affine") { RotationAffineBlitTextCases(); }
		if (which == "all" || which == "text-extra") { TextExtraCases(); }
	}
}
