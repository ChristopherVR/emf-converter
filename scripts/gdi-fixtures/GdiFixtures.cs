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
using System.Drawing.Text;
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
		TxRasterCases();
		TxRotatedAlignCases();
	}

	// -----------------------------------------------------------------------
	// GDI rasteriser cases (category "gdi-raster"): what GDI itself paints,
	// pixel for pixel, for cosmetic lines at every angle (integer and 28.4
	// fractional end points), ellipses of many sizes (odd/even, tiny, null
	// pen, rotated), rounded rectangles, arcs/chords/pies in both
	// directions, Beziers, bracketed paths, ALTERNATE vs WINDING polygon
	// fills, cosmetic and geometric pen styles, wide pens with every cap and
	// join, ROP2 double-combination, and rotated/mirrored/stretched/skewed
	// bitmap blits. Every case draws in GM_ADVANCED where a null pen meets a
	// curved shape: GM_COMPATIBLE shrinks such a shape by a pixel when it
	// paints directly, which an EMF (always played back in GM_ADVANCED)
	// cannot record.
	// -----------------------------------------------------------------------

	[StructLayout(LayoutKind.Sequential)]
	public struct LOGBRUSH { public uint lbStyle; public int lbColor; public IntPtr lbHatch; }

	[DllImport("gdi32.dll")] static extern bool Arc(IntPtr hdc, int l, int t, int r, int b, int xs, int ys, int xe, int ye);
	[DllImport("gdi32.dll")] static extern bool ArcTo(IntPtr hdc, int l, int t, int r, int b, int xs, int ys, int xe, int ye);
	[DllImport("gdi32.dll")] static extern bool Chord(IntPtr hdc, int l, int t, int r, int b, int xs, int ys, int xe, int ye);
	[DllImport("gdi32.dll")] static extern bool Pie(IntPtr hdc, int l, int t, int r, int b, int xs, int ys, int xe, int ye);
	[DllImport("gdi32.dll")] static extern bool Polyline(IntPtr hdc, [In] POINT[] pts, int count);
	[DllImport("gdi32.dll")] static extern bool PolyBezier(IntPtr hdc, [In] POINT[] pts, int count);
	[DllImport("gdi32.dll")] static extern bool PolyBezierTo(IntPtr hdc, [In] POINT[] pts, int count);
	[DllImport("gdi32.dll")] static extern bool PolyPolygon(IntPtr hdc, [In] POINT[] pts, [In] int[] counts, int n);
	[DllImport("gdi32.dll")] static extern IntPtr ExtCreatePen(uint style, uint width, ref LOGBRUSH lb, uint count, uint[] styles);
	[DllImport("gdi32.dll")] static extern int SetArcDirection(IntPtr hdc, int dir);
	[DllImport("gdi32.dll")] static extern bool SetMiterLimit(IntPtr hdc, float limit, IntPtr old);

	const uint PS_GEOMETRIC = 0x10000, PS_ENDCAP_SQUARE = 0x100, PS_ENDCAP_FLAT = 0x200, PS_JOIN_BEVEL = 0x1000, PS_JOIN_MITER = 0x2000;

	/** A solid `ExtCreatePen` pen. */
	static IntPtr ExtPen(uint style, int width, int color, uint[] user)
	{
		var lb = new LOGBRUSH { lbStyle = 0, lbColor = color, lbHatch = IntPtr.Zero };
		return ExtCreatePen(style, (uint)width, ref lb, user == null ? 0u : (uint)user.Length, user);
	}

	static POINT P(int x, int y) { return new POINT { X = x, Y = y }; }

	/** Deterministic pseudo-random sequence (same numbers on every run). */
	sealed class Lcg
	{
		uint s;
		public Lcg(uint seed) { s = seed; }
		public int Next(int n) { s = s * 1103515245u + 12345u; return (int)((s >> 8) % (uint)n); }
	}

	/** Selects `pen` and `brush` (either may be IntPtr.Zero to keep the current one), runs `draw`, then restores and deletes them. */
	static void WithObjects(IntPtr hdc, IntPtr pen, IntPtr brush, Action draw)
	{
		IntPtr op = pen != IntPtr.Zero ? SelectObject(hdc, pen) : IntPtr.Zero;
		IntPtr ob = brush != IntPtr.Zero ? SelectObject(hdc, brush) : IntPtr.Zero;
		draw();
		if (pen != IntPtr.Zero) { SelectObject(hdc, op); DeleteObject(pen); }
		if (brush != IntPtr.Zero) { SelectObject(hdc, ob); DeleteObject(brush); }
	}

	static void RasterLineCases()
	{
		// Stars of one-pixel lines from two centres to ring points at every
		// angle (1-degree-ish steps), plus short lines of length 1..3.
		GdiCase("raster-lines-star", 200, 200, delegate (IntPtr hdc)
		{
			Stripes(hdc, 200, 200);
			for (int k = 0; k < 96; k++)
			{
				double a = k * Math.PI * 2 / 96;
				int cx = k % 2 == 0 ? 60 : 141, cy = k % 3 == 0 ? 60 : 141;
				int r = 20 + (k * 7) % 38;
				IntPtr pen = CreatePen(0, 0, Palette[k % 8] ^ 0x404040);
				WithObjects(hdc, pen, IntPtr.Zero, delegate
				{
					MoveToEx(hdc, cx, cy, IntPtr.Zero);
					LineTo(hdc, cx + (int)Math.Round(Math.Cos(a) * r), cy + (int)Math.Round(Math.Sin(a) * r));
				});
			}
			IntPtr p2 = CreatePen(0, 1, Rgb(0, 0, 0));
			WithObjects(hdc, p2, IntPtr.Zero, delegate
			{
				for (int i = 0; i < 12; i++)
				{
					int x = 8 + i * 15, y = 190;
					MoveToEx(hdc, x, y, IntPtr.Zero); LineTo(hdc, x + (i % 4), y - (i / 4));
				}
			});
		});

		// Fractional (28.4) end points: a rotated, scaled world transform.
		GdiCase("raster-lines-fractional", 200, 200, delegate (IntPtr hdc)
		{
			Stripes(hdc, 200, 200);
			SetGraphicsMode(hdc, 2);
			XFORM xf = RotationXform(17, 100, 100);
			xf.eM11 *= 0.73f; xf.eM12 *= 0.73f; xf.eM21 *= 0.73f; xf.eM22 *= 0.73f;
			SetWorldTransform(hdc, ref xf);
			var rng = new Lcg(7);
			for (int k = 0; k < 120; k++)
			{
				IntPtr pen = CreatePen(0, 0, Palette[k % 8] ^ 0x202020);
				int x0 = rng.Next(240) - 120, y0 = rng.Next(240) - 120;
				int x1 = x0 + rng.Next(80) - 40, y1 = y0 + rng.Next(80) - 40;
				if (k % 5 == 0) { x1 = x0 + (y1 - y0); } // 45 degrees before the transform
				WithObjects(hdc, pen, IntPtr.Zero, delegate
				{
					MoveToEx(hdc, x0, y0, IntPtr.Zero); LineTo(hdc, x1, y1);
				});
			}
		});

		// Polylines with sharp turns, zigzags, closed outlines, PolylineTo and
		// PolyBezier/PolyBezierTo, all with one-pixel pens.
		GdiCase("raster-polylines-beziers", 200, 160, delegate (IntPtr hdc)
		{
			Stripes(hdc, 200, 160);
			IntPtr pen = CreatePen(0, 0, Rgb(0x10, 0x10, 0x10));
			IntPtr brush = GetStockObject(5); // NULL_BRUSH
			IntPtr ob = SelectObject(hdc, brush);
			WithObjects(hdc, pen, IntPtr.Zero, delegate
			{
				Polyline(hdc, new[] { P(5, 5), P(60, 12), P(8, 30), P(70, 40), P(12, 55), P(40, 70) }, 6);
				Polyline(hdc, new[] { P(80, 5), P(90, 70), P(100, 5), P(110, 70), P(120, 5), P(130, 70) }, 6);
				Polygon(hdc, new[] { P(140, 10), P(195, 25), P(150, 70), P(185, 40) }, 4);
				PolyBezier(hdc, new[] { P(5, 90), P(20, 60), P(60, 150), P(80, 100), P(90, 80), P(120, 155), P(150, 95) }, 7);
				MoveToEx(hdc, 150, 150, IntPtr.Zero);
				PolyBezierTo(hdc, new[] { P(160, 100), P(200, 160), P(195, 90) }, 3);
				MoveToEx(hdc, 10, 150, IntPtr.Zero);
				PolyBezier(hdc, new[] { P(10, 150), P(12, 149), P(15, 152), P(18, 150) }, 4);
			});
			SelectObject(hdc, ob);
		});
	}

	static void RasterEllipseCases()
	{
		// A grid of pen-and-brush ellipses of every size from 1x1 to 16x16.
		GdiCase("raster-ellipses-sizes", 240, 240, delegate (IntPtr hdc)
		{
			Stripes(hdc, 240, 240);
			for (int j = 0; j < 12; j++)
			{
				for (int i = 0; i < 12; i++)
				{
					int w = 1 + ((i + j * 12) * 5) % 18, h = 1 + ((i * 7 + j * 3) % 18);
					IntPtr pen = CreatePen(0, 0, Rgb(0x10, 0x10, 0x30));
					IntPtr brush = CreateSolidBrush(Palette[(i + j) % 8]);
					int x = 2 + i * 20, y = 2 + j * 20;
					WithObjects(hdc, pen, brush, delegate { Ellipse(hdc, x, y, x + w, y + h); });
				}
			}
		});

		// Null-pen fills (GM_ADVANCED), at identity and under a scale.
		GdiCase("raster-ellipses-nullpen", 240, 160, delegate (IntPtr hdc)
		{
			Stripes(hdc, 240, 160);
			SetGraphicsMode(hdc, 2);
			IntPtr np = GetStockObject(8); // NULL_PEN
			IntPtr op = SelectObject(hdc, np);
			for (int i = 0; i < 30; i++)
			{
				IntPtr brush = CreateSolidBrush(Palette[i % 8] ^ 0x303030);
				int w = 1 + (i * 3) % 23, h = 1 + (i * 5) % 19;
				int x = 3 + (i % 10) * 23, y = 3 + (i / 10) * 25;
				WithObjects(hdc, IntPtr.Zero, brush, delegate { Ellipse(hdc, x, y, x + w, y + h); });
			}
			XFORM xf = new XFORM { eM11 = 1.37f, eM12 = 0, eM21 = 0, eM22 = 0.81f, eDx = 3.3f, eDy = 80.6f };
			SetWorldTransform(hdc, ref xf);
			for (int i = 0; i < 16; i++)
			{
				IntPtr brush = CreateSolidBrush(Palette[(i + 3) % 8]);
				int w = 2 + (i * 7) % 15, h = 2 + (i * 3) % 17;
				int x = (i % 8) * 20, y = (i / 8) * 40;
				WithObjects(hdc, IntPtr.Zero, brush, delegate { Ellipse(hdc, x, y, x + w, y + h); });
			}
			SelectObject(hdc, op);
		});

		// Rotated, skewed and mirrored ellipses (pen + brush).
		GdiCase("raster-ellipses-rotated", 240, 200, delegate (IntPtr hdc)
		{
			Stripes(hdc, 240, 200);
			SetGraphicsMode(hdc, 2);
			var rng = new Lcg(11);
			for (int k = 0; k < 20; k++)
			{
				XFORM xf = RotationXform(k * 19 + 3, 25 + (k % 5) * 48, 25 + (k / 5) * 48);
				if (k % 4 == 1) { xf.eM21 += 0.3f; }
				if (k % 4 == 2) { xf.eM11 = -xf.eM11; xf.eM12 = -xf.eM12; }
				SetWorldTransform(hdc, ref xf);
				int w = 6 + rng.Next(30), h = 4 + rng.Next(24);
				IntPtr pen = CreatePen(0, 1, Rgb(0x20, 0x10, 0x10));
				IntPtr brush = CreateSolidBrush(Palette[k % 8]);
				WithObjects(hdc, pen, brush, delegate { Ellipse(hdc, -w / 2, -h / 2, w - w / 2, h - h / 2); });
			}
		});
	}

	// RoundRect, Arc, ArcTo, Chord and Pie draw in GM_ADVANCED: in
	// GM_COMPATIBLE Windows paints them differently when drawing directly
	// than when it plays the recorded EMF back (PlayEnhMetaFile renders the
	// recorded, already inclusive, GM_ADVANCED geometry; measured on 20 random
	// shapes each), so only GM_ADVANCED gives a reference that is the EMF's
	// own meaning.
	static void RasterRoundArcCases()
	{
		// Rounded rectangles: many boxes and corner sizes (corners larger than
		// the box included), GM_COMPATIBLE with a pen.
		GdiCase("raster-roundrects", 240, 200, delegate (IntPtr hdc)
		{
			Stripes(hdc, 240, 200);
			SetGraphicsMode(hdc, 2); // see RasterRoundArcCases
			var rng = new Lcg(5);
			for (int k = 0; k < 30; k++)
			{
				int x = 4 + (k % 6) * 39, y = 4 + (k / 6) * 39;
				int w = 6 + rng.Next(30), h = 6 + rng.Next(30);
				int cw = rng.Next(k % 7 == 0 ? 60 : 24), ch = rng.Next(k % 7 == 0 ? 60 : 24);
				IntPtr pen = CreatePen(0, 0, Rgb(0x10, 0x20, 0x10));
				IntPtr brush = CreateSolidBrush(Palette[k % 8]);
				WithObjects(hdc, pen, brush, delegate { RoundRect(hdc, x, y, x + w, y + h, cw, ch); });
			}
		});

		// Arcs from radials all round the clock, both directions, plus ArcTo.
		GdiCase("raster-arcs", 240, 200, delegate (IntPtr hdc)
		{
			Stripes(hdc, 240, 200);
			SetGraphicsMode(hdc, 2);
			var rng = new Lcg(21);
			for (int k = 0; k < 30; k++)
			{
				int x = 4 + (k % 6) * 39, y = 4 + (k / 6) * 39;
				int w = 8 + rng.Next(28), h = 8 + rng.Next(28);
				double a0 = rng.Next(360) * Math.PI / 180, a1 = rng.Next(360) * Math.PI / 180;
				int cx = x + w / 2, cy = y + h / 2;
				SetArcDirection(hdc, k % 3 == 2 ? 2 : 1);
				IntPtr pen = CreatePen(0, 0, Palette[k % 8] ^ 0x404040);
				WithObjects(hdc, pen, IntPtr.Zero, delegate
				{
					int xs = cx + (int)(Math.Cos(a0) * 50), ys = cy - (int)(Math.Sin(a0) * 50);
					int xe = cx + (int)(Math.Cos(a1) * 50), ye = cy - (int)(Math.Sin(a1) * 50);
					if (k % 5 == 4)
					{
						MoveToEx(hdc, x, y + h, IntPtr.Zero);
						ArcTo(hdc, x, y, x + w, y + h, xs, ys, xe, ye);
						LineTo(hdc, x + w, y + h);
					}
					else
					{
						Arc(hdc, x, y, x + w, y + h, xs, ys, xe, ye);
					}
				});
			}
			SetArcDirection(hdc, 1);
		});

		// Filled pies and chords, both directions.
		GdiCase("raster-pies-chords", 240, 200, delegate (IntPtr hdc)
		{
			Stripes(hdc, 240, 200);
			SetGraphicsMode(hdc, 2);
			var rng = new Lcg(33);
			for (int k = 0; k < 30; k++)
			{
				int x = 4 + (k % 6) * 39, y = 4 + (k / 6) * 39;
				int w = 8 + rng.Next(28), h = 8 + rng.Next(28);
				double a0 = rng.Next(360) * Math.PI / 180, a1 = rng.Next(360) * Math.PI / 180;
				int cx = x + w / 2, cy = y + h / 2;
				SetArcDirection(hdc, k % 4 == 3 ? 2 : 1);
				IntPtr pen = CreatePen(0, 0, Rgb(0x10, 0x10, 0x10));
				IntPtr brush = CreateSolidBrush(Palette[k % 8]);
				WithObjects(hdc, pen, brush, delegate
				{
					int xs = cx + (int)(Math.Cos(a0) * 50), ys = cy - (int)(Math.Sin(a0) * 50);
					int xe = cx + (int)(Math.Cos(a1) * 50), ye = cy - (int)(Math.Sin(a1) * 50);
					if (k % 2 == 0) { Pie(hdc, x, y, x + w, y + h, xs, ys, xe, ye); }
					else { Chord(hdc, x, y, x + w, y + h, xs, ys, xe, ye); }
				});
			}
			SetArcDirection(hdc, 1);
		});
	}

	static void RasterFillCases()
	{
		// Self-intersecting and nested polygons, ALTERNATE vs WINDING, with a
		// null pen and with a pen; PolyPolygon with nested figures.
		GdiCase("raster-polygon-fillmodes", 240, 160, delegate (IntPtr hdc)
		{
			Stripes(hdc, 240, 160);
			POINT[] star = { P(40, 5), P(62, 70), P(5, 28), P(75, 28), P(18, 70) };
			for (int m = 0; m < 4; m++)
			{
				SetPolyFillMode(hdc, m % 2 == 0 ? 1 : 2);
				int ox = m * 60;
				var pts = new POINT[star.Length];
				for (int i = 0; i < star.Length; i++) { pts[i] = P(star[i].X + ox - (m > 1 ? 2 : 0), star[i].Y); }
				IntPtr pen = m < 2 ? GetStockObject(8) : CreatePen(0, 0, Rgb(0, 0, 0x40));
				IntPtr brush = CreateSolidBrush(Palette[m + 1]);
				IntPtr op = SelectObject(hdc, pen);
				WithObjects(hdc, IntPtr.Zero, brush, delegate { Polygon(hdc, pts, pts.Length); });
				SelectObject(hdc, op);
				if (m >= 2) { DeleteObject(pen); }
			}
			for (int m = 0; m < 2; m++)
			{
				SetPolyFillMode(hdc, m + 1);
				int ox = 10 + m * 120;
				POINT[] pp = {
					P(ox, 80), P(ox + 100, 80), P(ox + 100, 155), P(ox, 155),
					P(ox + 20, 95), P(ox + 80, 95), P(ox + 80, 140), P(ox + 20, 140),
					P(ox + 35, 105), P(ox + 65, 130), P(ox + 35, 130), P(ox + 65, 105),
				};
				IntPtr pen = CreatePen(0, 0, Rgb(0x30, 0, 0));
				IntPtr brush = CreateSolidBrush(Palette[5 + m]);
				WithObjects(hdc, pen, brush, delegate { PolyPolygon(hdc, pp, new[] { 4, 4, 4 }, 3); });
			}
			SetPolyFillMode(hdc, 1);
		});

		// Bracketed paths: lines, Beziers, an ellipse, a rectangle and an arc as
		// figures of one path, filled (WINDING), stroked, and both.
		GdiCase("raster-paths", 240, 120, delegate (IntPtr hdc)
		{
			Stripes(hdc, 240, 120);
			SetGraphicsMode(hdc, 2); // ArcTo: see RasterRoundArcCases
			SetPolyFillMode(hdc, 2);
			for (int m = 0; m < 3; m++)
			{
				int ox = m * 80;
				IntPtr pen = CreatePen(0, 0, Rgb(0x10, 0x10, 0x10));
				IntPtr brush = CreateSolidBrush(Palette[m + 2]);
				WithObjects(hdc, pen, brush, delegate
				{
					BeginPath(hdc);
					MoveToEx(hdc, ox + 5, 5, IntPtr.Zero);
					LineTo(hdc, ox + 70, 12);
					PolyBezierTo(hdc, new[] { P(ox + 80, 60), P(ox + 20, 20), P(ox + 30, 70) }, 3);
					CloseFigure(hdc);
					Ellipse(hdc, ox + 10, 60, ox + 50, 100);
					Rectangle(hdc, ox + 40, 70, ox + 75, 115);
					MoveToEx(hdc, ox + 60, 40, IntPtr.Zero);
					ArcTo(hdc, ox + 45, 30, ox + 78, 62, ox + 78, 30, ox + 45, 62);
					EndPath(hdc);
					if (m == 0) { FillPath(hdc); }
					else if (m == 1) { StrokePath(hdc); }
					else { StrokeAndFillPath(hdc); }
				});
			}
			SetPolyFillMode(hdc, 1);
		});

		// XOR pen and brush on overlapping shapes: which pixels GDI combines
		// twice (fill under outline) and which only once (Rectangle).
		GdiCase("raster-rop2-shapes", 240, 120, delegate (IntPtr hdc)
		{
			Stripes(hdc, 240, 120);
			SetGraphicsMode(hdc, 2); // RoundRect/Pie/Chord: see RasterRoundArcCases
			SetROP2(hdc, 7); // R2_XORPEN
			IntPtr pen = CreatePen(0, 0, Rgb(0x55, 0xaa, 0x33));
			IntPtr brush = CreateSolidBrush(Rgb(0x0f, 0xf0, 0x99));
			WithObjects(hdc, pen, brush, delegate
			{
				Ellipse(hdc, 5, 5, 60, 50);
				Rectangle(hdc, 30, 20, 90, 70);
				RoundRect(hdc, 70, 5, 140, 60, 20, 16);
				Polygon(hdc, new[] { P(120, 10), P(200, 40), P(130, 80) }, 3);
				Pie(hdc, 150, 30, 235, 115, 235, 30, 150, 115);
				Chord(hdc, 5, 60, 80, 115, 80, 60, 5, 115);
				Polyline(hdc, new[] { P(90, 70), P(140, 115), P(140, 70), P(90, 115), P(90, 70) }, 5);
			});
			SetROP2(hdc, 13);
		});
	}

	static void RasterPenStyleCases()
	{
		// Cosmetic styles (DASH, DOT, DASHDOT, DASHDOTDOT, ALTERNATE,
		// USERSTYLE) on horizontal/vertical/diagonal lines, a polyline, a LineTo
		// chain broken by a MoveTo, and ellipse/rectangle outlines; OPAQUE and
		// TRANSPARENT background.
		GdiCase("raster-dash-cosmetic", 240, 240, delegate (IntPtr hdc)
		{
			Stripes(hdc, 240, 240);
			SetBkColor(hdc, Rgb(0xff, 0xff, 0x80));
			IntPtr nb = GetStockObject(5);
			IntPtr obr = SelectObject(hdc, nb);
			for (int s = 0; s < 6; s++)
			{
				for (int bk = 0; bk < 2; bk++)
				{
					SetBkMode(hdc, bk == 0 ? 2 : 1);
					int y = 4 + (s * 2 + bk) * 19;
					IntPtr pen;
					if (s < 4) { pen = CreatePen(s + 1, 0, Rgb(0x10, 0x10, 0x80)); }
					else if (s == 4) { pen = ExtPen(8, 1, Rgb(0x80, 0x10, 0x10), null); } // PS_COSMETIC | PS_ALTERNATE
					else { pen = ExtPen(7, 1, Rgb(0x10, 0x60, 0x10), new uint[] { 3, 2, 5, 1 }); } // PS_USERSTYLE
					WithObjects(hdc, pen, IntPtr.Zero, delegate
					{
						MoveToEx(hdc, 3, y, IntPtr.Zero); LineTo(hdc, 90, y);
						MoveToEx(hdc, 3, y + 3, IntPtr.Zero); LineTo(hdc, 40, y + 16); LineTo(hdc, 70, y + 4);
						MoveToEx(hdc, 70, y + 9, IntPtr.Zero); LineTo(hdc, 90, y + 15);
						Polyline(hdc, new[] { P(95, y), P(130, y + 15), P(160, y), P(165, y + 16) }, 4);
						Ellipse(hdc, 170, y, 200, y + 17);
						Rectangle(hdc, 205, y, 236, y + 17);
					});
				}
			}
			SelectObject(hdc, obr);
			SetBkMode(hdc, 2);
		});

		// Geometric styles on wide pens: DASH/DOT/DASHDOT/DASHDOTDOT/USERSTYLE,
		// widths 3 and 4, flat, square and round caps, three directions.
		GdiCase("raster-dash-geometric", 240, 200, delegate (IntPtr hdc)
		{
			Stripes(hdc, 240, 200);
			uint[] caps = { PS_ENDCAP_FLAT, PS_ENDCAP_SQUARE, 0 };
			for (int s = 0; s < 5; s++)
			{
				for (int c = 0; c < 3; c++)
				{
					int w = c == 1 ? 4 : 3;
					uint style = s < 4 ? (uint)(s + 1) : 7u;
					IntPtr pen = ExtPen(PS_GEOMETRIC | caps[c] | style, w, Palette[(s + c) % 8] ^ 0x404040, s == 4 ? new uint[] { 6, 3, 2, 4 } : null);
					int y = 8 + (s * 3 + c) * 12;
					WithObjects(hdc, pen, IntPtr.Zero, delegate
					{
						MoveToEx(hdc, 6, y, IntPtr.Zero); LineTo(hdc, 150, y);
						MoveToEx(hdc, 160, y, IntPtr.Zero); LineTo(hdc, 190, y + 10);
					});
				}
			}
			IntPtr vp = ExtPen(PS_GEOMETRIC | PS_ENDCAP_FLAT | 1, 3, Rgb(0, 0, 0), null);
			WithObjects(hdc, vp, IntPtr.Zero, delegate { MoveToEx(hdc, 215, 5, IntPtr.Zero); LineTo(hdc, 215, 195); });
		});
	}

	static void RasterWidePenCases()
	{
		// CreatePen wide pens (round caps and joins), widths 2..8: lines at
		// several angles, a polyline, a rectangle and an ellipse outline.
		GdiCase("raster-wide-pens", 240, 240, delegate (IntPtr hdc)
		{
			Stripes(hdc, 240, 240);
			IntPtr nb = GetStockObject(5);
			IntPtr obr = SelectObject(hdc, nb);
			for (int w = 2; w <= 8; w++)
			{
				IntPtr pen = CreatePen(0, w, Palette[w % 8] ^ 0x505050);
				int y = 6 + (w - 2) * 33;
				WithObjects(hdc, pen, IntPtr.Zero, delegate
				{
					MoveToEx(hdc, 8, y, IntPtr.Zero); LineTo(hdc, 60, y);
					MoveToEx(hdc, 8, y + 8, IntPtr.Zero); LineTo(hdc, 60, y + 22);
					MoveToEx(hdc, 70, y, IntPtr.Zero); LineTo(hdc, 80, y + 24);
					Polyline(hdc, new[] { P(90, y), P(120, y + 20), P(140, y + 2), P(150, y + 24) }, 4);
					Rectangle(hdc, 160, y, 190, y + 24);
					Ellipse(hdc, 200, y, 234, y + 26);
				});
			}
			SelectObject(hdc, obr);
		});

		// ExtCreatePen geometric solid pens: every cap on open polylines, every
		// join on a zigzag, and the miter limit cutting sharp joins.
		GdiCase("raster-wide-joins", 240, 200, delegate (IntPtr hdc)
		{
			Stripes(hdc, 240, 200);
			uint[] caps = { 0, PS_ENDCAP_SQUARE, PS_ENDCAP_FLAT };
			uint[] joins = { 0, PS_JOIN_BEVEL, PS_JOIN_MITER };
			for (int c = 0; c < 3; c++)
			{
				for (int j = 0; j < 3; j++)
				{
					int w = 5 + (c + j) % 3 * 2;
					IntPtr pen = ExtPen(PS_GEOMETRIC | caps[c] | joins[j], w, Palette[(c * 3 + j) % 8] ^ 0x303030, null);
					int ox = 8 + j * 78, oy = 10 + c * 62;
					// EMR_SETMITERLIMIT records a whole number, so the limit is one too.
					SetMiterLimit(hdc, c == 2 ? 2f : 10f, IntPtr.Zero);
					WithObjects(hdc, pen, IntPtr.Zero, delegate
					{
						Polyline(hdc, new[] { P(ox, oy + 40), P(ox + 15, oy), P(ox + 30, oy + 40), P(ox + 45, oy + 5), P(ox + 64, oy + 20) }, 5);
					});
				}
			}
			SetMiterLimit(hdc, 10f, IntPtr.Zero);
		});
	}

	static void RasterBlitCases()
	{
		IntPtr screen = GetDC(IntPtr.Zero);
		// Rotated BitBlt/StretchBlt at several angles, mirrored, stretched and
		// skewed, including a pattern-brush ROP3 (P, S and D all involved).
		GdiCase("raster-blit-rotated", 240, 240, delegate (IntPtr hdc)
		{
			Stripes(hdc, 240, 240);
			SetGraphicsMode(hdc, 2);
			using (var src = SourceBitmap(screen, 20, 16))
			{
				float[] angles = { 10, 45, 90, 135, 200, 300, 33, 77, 160 };
				for (int k = 0; k < angles.Length; k++)
				{
					XFORM xf = RotationXform(angles[k], 40 + (k % 3) * 80, 40 + (k / 3) * 80);
					if (k == 6) { xf.eM11 = -xf.eM11; xf.eM12 = -xf.eM12; }
					if (k == 7) { xf.eM21 += 0.35f; }
					SetWorldTransform(hdc, ref xf);
					if (k == 8)
					{
						IntPtr hb = CreateHatchBrush(3, Rgb(0x20, 0x20, 0xc0));
						IntPtr ob = SelectObject(hdc, hb);
						SetBkColor(hdc, Rgb(0xf0, 0xf0, 0x20));
						StretchBlt(hdc, -15, -12, 30, 24, src.Dc, 0, 0, 20, 16, 0x00E20746); // DSPDxax
						SelectObject(hdc, ob);
						DeleteObject(hb);
					}
					else if (k % 3 == 1)
					{
						StretchBlt(hdc, -16, -9, 33, 19, src.Dc, 2, 1, 14, 12, 0x00CC0020); // SRCCOPY, stretched
					}
					else
					{
						BitBlt(hdc, -10, -8, 20, 16, src.Dc, 0, 0, k % 2 == 0 ? 0x00CC0020u : 0x00660046u); // SRCCOPY / SRCINVERT
					}
				}
			}
		});
		ReleaseDC(IntPtr.Zero, screen);
	}

	static void RasterBenchCase()
	{
		// A shape-heavy drawing for the aliased-vs-antialiased benchmark (and a
		// parity case of its own): rectangles, ellipses, triangles, lines and
		// rounded rectangles with one-pixel pens and solid brushes.
		GdiCase("raster-bench-shapes", 400, 300, delegate (IntPtr hdc)
		{
			var rng = new Lcg(99);
			SetGraphicsMode(hdc, 2); // see RasterRoundArcCases
			var bg = new RECT { Left = 0, Top = 0, Right = 400, Bottom = 300 };
			IntPtr white = CreateSolidBrush(Rgb(255, 255, 255));
			FillRect(hdc, ref bg, white);
			DeleteObject(white);
			for (int i = 0; i < 800; i++)
			{
				int x = rng.Next(400), y = rng.Next(300), w = 3 + rng.Next(40), h = 3 + rng.Next(40);
				IntPtr pen = CreatePen(0, 1, Rgb(rng.Next(256), rng.Next(256), 0));
				IntPtr brush = CreateSolidBrush(Rgb(rng.Next(256), 128, rng.Next(256)));
				int kind = i % 5;
				WithObjects(hdc, pen, brush, delegate
				{
					if (kind == 0) { Rectangle(hdc, x, y, x + w, y + h); }
					else if (kind == 1) { Ellipse(hdc, x, y, x + w, y + h); }
					else if (kind == 2) { Polygon(hdc, new[] { P(x, y), P(x + w, y + 4), P(x + 8, y + h) }, 3); }
					else if (kind == 3) { MoveToEx(hdc, x, y, IntPtr.Zero); LineTo(hdc, x + w, y + h); }
					else { RoundRect(hdc, x, y, x + w, y + h, 9, 9); }
				});
			}
		});
	}

	// -----------------------------------------------------------------------
	// gdiplus-extra: GDI+ linear-gradient interpolation table (preset
	// colours, blend factors, sigma/triangular shapes, gamma correction,
	// translucency, PixelOffsetMode), see emf-plus-linear-ramp.ts.
	// -----------------------------------------------------------------------

	static ColorBlend Presets(float[] pos, params Color[] cols)
	{
		var cb = new ColorBlend(cols.Length);
		cb.Colors = cols; cb.Positions = pos;
		return cb;
	}

	static void GpxLinearGradientCases()
	{
		const int W = 160, H = 100;
		var five = Presets(new float[] { 0f, 0.13f, 0.5f, 0.77f, 1f }, Color.Black, Color.FromArgb(255, 255, 40, 0), Color.FromArgb(255, 0, 220, 60), Color.FromArgb(255, 20, 40, 255), Color.White);
		// Five presets on a large rect (w + h > 128: a 64-interval table) and a
		// small one (16 intervals), both at an angle.
		GpCase("gpx-lin-preset5-large", W, H, delegate (Graphics g)
		{
			using (var b = new LinearGradientBrush(new RectangleF(10, 10, 120, 40), Color.Black, Color.Black, 20f))
			{ b.InterpolationColors = five; g.FillRectangle(b, 0, 0, W, H); }
		});
		GpCase("gpx-lin-preset5-small", W, H, delegate (Graphics g)
		{
			using (var b = new LinearGradientBrush(new RectangleF(10, 10, 70, 40), Color.Black, Color.Black, -35f))
			{ b.InterpolationColors = five; b.WrapMode = WrapMode.TileFlipX; g.FillRectangle(b, 0, 0, W, H); }
		});
		// A rect with w + h > 512: the 256-interval table.
		GpCase("gpx-lin-preset5-huge", W, H, delegate (Graphics g)
		{
			using (var b = new LinearGradientBrush(new RectangleF(-200, 0, 560, 20), Color.Black, Color.Black, 0f))
			{ b.InterpolationColors = five; g.FillRectangle(b, 0, 0, W, H); }
		});
		GpCase("gpx-lin-sigma", W, H, delegate (Graphics g)
		{
			using (var b = new LinearGradientBrush(new RectangleF(5, 0, 150, 30), Color.FromArgb(255, 250, 240, 10), Color.FromArgb(255, 30, 0, 120), 60f))
			{ b.SetSigmaBellShape(0.35f, 0.9f); g.FillRectangle(b, 0, 0, W, H); }
		});
		GpCase("gpx-lin-triangular", W, H, delegate (Graphics g)
		{
			using (var b = new LinearGradientBrush(new RectangleF(20, 0, 90, 30), Color.FromArgb(255, 10, 90, 200), Color.FromArgb(255, 240, 230, 220), 0f))
			{ b.SetBlendTriangularShape(0.3f, 0.8f); b.WrapMode = WrapMode.TileFlipX; g.FillRectangle(b, 0, 0, W, H); }
		});
		GpCase("gpx-lin-gamma", W, H, delegate (Graphics g)
		{
			using (var b = new LinearGradientBrush(new RectangleF(10, 0, 110, 30), Color.FromArgb(255, 200, 0, 30), Color.FromArgb(255, 0, 60, 255), 15f))
			{ b.GammaCorrection = true; g.FillRectangle(b, 0, 0, W, H); }
		});
		GpCase("gpx-lin-gamma-preset", W, H, delegate (Graphics g)
		{
			using (var b = new LinearGradientBrush(new RectangleF(0, 0, 100, 60), Color.Black, Color.Black, 45f))
			{
				b.GammaCorrection = true;
				b.InterpolationColors = Presets(new float[] { 0f, 0.4f, 1f }, Color.FromArgb(255, 255, 60, 0), Color.White, Color.FromArgb(255, 0, 90, 200));
				g.FillRectangle(b, 0, 0, W, H);
			}
		});
		GpCase("gpx-lin-alpha", W, H, delegate (Graphics g)
		{
			g.FillRectangle(Brushes.White, 0, 0, W, H);
			using (var stripes = new SolidBrush(Color.FromArgb(255, 30, 30, 30)))
			{ for (int x = 0; x < W; x += 20) { g.FillRectangle(stripes, x, 0, 10, H); } }
			using (var b = new LinearGradientBrush(new RectangleF(0, 0, 120, 50), Color.FromArgb(0, 255, 0, 0), Color.FromArgb(200, 0, 0, 255), 30f))
			{ g.FillRectangle(b, 0, 0, W, H); }
		});
		GpCase("gpx-lin-pixeloffset-half", W, H, delegate (Graphics g)
		{
			g.PixelOffsetMode = PixelOffsetMode.Half;
			using (var b = new LinearGradientBrush(new RectangleF(3, 0, 23, 10), Color.FromArgb(255, 250, 250, 0), Color.FromArgb(255, 0, 0, 160), 0f))
			{ g.FillRectangle(b, 0, 0, W, H); }
		});
		// Blend factors and presets under a world transform, on an ellipse
		// (span starts vary per row).
		GpCase("gpx-lin-blend-ellipse", W, H, delegate (Graphics g)
		{
			g.FillRectangle(Brushes.White, 0, 0, W, H);
			g.TranslateTransform(80, 50);
			g.RotateTransform(-25);
			using (var b = new LinearGradientBrush(new RectangleF(-60, -30, 50, 60), Color.FromArgb(255, 220, 30, 60), Color.FromArgb(255, 20, 200, 140), 0f))
			{
				var blend = new Blend(4);
				blend.Factors = new float[] { 0f, 0.7f, 0.2f, 1f };
				blend.Positions = new float[] { 0f, 0.25f, 0.6f, 1f };
				b.Blend = blend;
				g.FillEllipse(b, -70, -40, 140, 80);
			}
		});
	}

	// -----------------------------------------------------------------------
	// gdiplus-extra: GraphicsPath FillMode (Alternate / Winding) for FillPath
	// and SetClip(path), on a self-overlapping star and two overlapping
	// same-direction rectangles (where the two rules differ).
	// -----------------------------------------------------------------------

	static GraphicsPath StarPath(FillMode mode, float cx, float cy, float r)
	{
		var p = new GraphicsPath(mode);
		var pts = new PointF[5];
		for (int i = 0; i < 5; i++)
		{
			double a = -Math.PI / 2 + i * 4 * Math.PI / 5;
			pts[i] = new PointF(cx + (float)(r * Math.Cos(a)), cy + (float)(r * Math.Sin(a)));
		}
		p.AddPolygon(pts);
		// Two overlapping rectangles wound the same way.
		p.AddRectangle(new RectangleF(cx + r + 6, cy - 30, 30, 40));
		p.AddRectangle(new RectangleF(cx + r + 16, cy - 20, 30, 40));
		return p;
	}

	// Shapes under each SmoothingMode: None (GDI+'s default), HighSpeed,
	// AntiAlias and HighQuality (GDI+'s 8x4-sample antialiasing).
	static void GpxSmoothingCases()
	{
		const int W = 160, H = 100;
		foreach (var sm in new[] { SmoothingMode.None, SmoothingMode.HighSpeed, SmoothingMode.AntiAlias, SmoothingMode.HighQuality })
		{
			var mode = sm;
			GpCase("gpx-smooth-" + mode.ToString().ToLowerInvariant(), W, H, delegate (Graphics g)
			{
				g.FillRectangle(Brushes.White, 0, 0, W, H);
				g.SmoothingMode = mode;
				using (var b = new SolidBrush(Color.FromArgb(255, 30, 90, 200)))
				{
					g.FillEllipse(b, 6.3f, 5.7f, 50.2f, 37.9f);
					g.FillPolygon(b, new PointF[] { new PointF(70.2f, 4.9f), new PointF(118.7f, 30.3f), new PointF(80.1f, 46.6f) });
				}
				using (var p = new GraphicsPath())
				{
					p.AddBezier(125, 8, 170, 20, 110, 60, 150, 48);
					p.AddLine(150, 48, 128, 40);
					using (var b = new SolidBrush(Color.FromArgb(255, 200, 40, 40)))
					{ g.FillPath(b, p); }
				}
				using (var pen = new Pen(Color.FromArgb(255, 20, 120, 40), 3.5f))
				{ g.DrawEllipse(pen, 12.4f, 55.2f, 60.1f, 38.3f); }
				using (var pen = new Pen(Color.FromArgb(255, 90, 20, 120), 1f))
				{ g.DrawLine(pen, 85.3f, 60.2f, 155.7f, 93.1f); g.DrawLine(pen, 90.1f, 95.4f, 130.6f, 55.8f); }
			});
		}
	}

	static void GpxPathFillModeCases()
	{
		const int W = 160, H = 100;
		// SetClip(Region): a Region object (ObjectType 4) built from a union
		// and an exclusion, as GDI+ records it.
		GpCase("gpx-clipregion", W, H, delegate (Graphics g)
		{
			g.FillRectangle(Brushes.White, 0, 0, W, H);
			using (var r = new Region(new Rectangle(10, 10, 60, 40)))
			{
				r.Union(new Rectangle(50, 30, 80, 50));
				r.Exclude(new Rectangle(30, 20, 60, 20));
				g.SetClip(r, CombineMode.Replace);
				using (var b = new SolidBrush(Color.FromArgb(255, 90, 40, 160)))
				{ g.FillRectangle(b, 0, 0, W, H); }
				g.ResetClip();
			}
		});
		foreach (var mode in new[] { FillMode.Alternate, FillMode.Winding })
		{
			var fm = mode;
			string tag = fm == FillMode.Alternate ? "alternate" : "winding";
			GpCase("gpx-fillpath-" + tag, W, H, delegate (Graphics g)
			{
				g.FillRectangle(Brushes.White, 0, 0, W, H);
				using (var p = StarPath(fm, 45, 52, 40))
				using (var b = new SolidBrush(Color.FromArgb(255, 30, 90, 200)))
				{ g.FillPath(b, p); }
			});
			GpCase("gpx-clippath-" + tag, W, H, delegate (Graphics g)
			{
				g.FillRectangle(Brushes.White, 0, 0, W, H);
				using (var p = StarPath(fm, 45, 52, 40))
				{
					g.SetClip(p);
					using (var b = new SolidBrush(Color.FromArgb(255, 200, 40, 40)))
					{ g.FillRectangle(b, 0, 0, W, H); }
					g.ResetClip();
				}
			});
		}
	}

	// -----------------------------------------------------------------------
	// gdiplus-extra: DrawImage resampling (every InterpolationMode, up and
	// down, and each PixelOffsetMode), in-order DrawImage under a clip and
	// beneath later shapes, and DrawImage of an embedded metafile.
	// -----------------------------------------------------------------------

	/** A PNG-backed bitmap with smooth ramps, hard edges and single-pixel detail. */
	static Bitmap GpxSourceBitmap(int w, int h)
	{
		string tmp = Path.Combine(outDir, "_tmp_gpx_source_" + w + "x" + h + ".png");
		using (var src = new Bitmap(w, h, PixelFormat.Format32bppArgb))
		{
			for (int y = 0; y < h; y++)
			{
				for (int x = 0; x < w; x++)
				{
					int r = (x * 255) / Math.Max(1, w - 1);
					int g = (y * 255) / Math.Max(1, h - 1);
					int b = ((x / 4 + y / 4) % 2 == 0) ? 40 : 220;
					if ((x * 7 + y * 3) % 11 == 0) { r = 255 - r; g = 255 - g; }
					src.SetPixel(x, y, Color.FromArgb(255, r, g, b));
				}
			}
			src.Save(tmp, ImageFormat.Png);
		}
		var bytes = File.ReadAllBytes(tmp);
		File.Delete(tmp);
		return new Bitmap(new MemoryStream(bytes));
	}

	static readonly InterpolationMode[] GpxModes = {
		InterpolationMode.NearestNeighbor, InterpolationMode.Bilinear, InterpolationMode.Bicubic,
		InterpolationMode.HighQualityBilinear, InterpolationMode.HighQualityBicubic,
		InterpolationMode.Default, InterpolationMode.Low, InterpolationMode.High,
	};

	static void GpxImageCases()
	{
		const int W = 160, H = 100;
		using (var small = GpxSourceBitmap(20, 16))
		using (var big = GpxSourceBitmap(64, 48))
		{
			foreach (var mode in GpxModes)
			{
				var m = mode;
				GpCase("gpx-image-" + m.ToString().ToLowerInvariant(), W, H, delegate (Graphics g)
				{
					g.FillRectangle(Brushes.White, 0, 0, W, H);
					g.InterpolationMode = m;
					// Up (x2.6 / x2.35), down (x0.4 / x0.45), and a non-uniform up/down.
					g.DrawImage(small, new RectangleF(4, 4, 52, 37.6f));
					g.DrawImage(big, new RectangleF(64, 6, 25.6f, 21.6f));
					g.DrawImage(big, new RectangleF(98, 4, 58, 20));
					g.DrawImage(small, new RectangleF(64, 50, 90, 44));
				});
			}
			foreach (var pom in new[] { PixelOffsetMode.Half, PixelOffsetMode.HighQuality, PixelOffsetMode.HighSpeed })
			{
				foreach (var mode in new[] { InterpolationMode.Bilinear, InterpolationMode.HighQualityBicubic, InterpolationMode.NearestNeighbor })
				{
					var p = pom; var m = mode;
					GpCase("gpx-image-pom-" + p.ToString().ToLowerInvariant() + "-" + m.ToString().ToLowerInvariant(), W, H, delegate (Graphics g)
					{
						g.FillRectangle(Brushes.White, 0, 0, W, H);
						g.InterpolationMode = m;
						g.PixelOffsetMode = p;
						g.DrawImage(small, new RectangleF(4, 4, 52, 37.6f));
						g.DrawImage(big, new RectangleF(64, 6, 25.6f, 21.6f));
					});
				}
			}
			// Rotated DrawImage (parallelogram) in two modes.
			foreach (var mode in new[] { InterpolationMode.Bilinear, InterpolationMode.HighQualityBicubic })
			{
				var m = mode;
				GpCase("gpx-image-rotated-" + m.ToString().ToLowerInvariant(), W, H, delegate (Graphics g)
				{
					g.FillRectangle(Brushes.White, 0, 0, W, H);
					g.InterpolationMode = m;
					g.DrawImage(small, new PointF[] { new PointF(30, 10), new PointF(90, 30), new PointF(15, 55) });
				});
			}
			// In-order DrawImage: under a clip, then partly covered by later shapes.
			GpCase("gpx-image-clip-zorder", W, H, delegate (Graphics g)
			{
				g.FillRectangle(Brushes.White, 0, 0, W, H);
				g.SetClip(new Rectangle(10, 10, 60, 40));
				g.DrawImage(small, new RectangleF(0, 0, 90, 70));
				g.ResetClip();
				using (var b = new SolidBrush(Color.FromArgb(255, 30, 120, 60)))
				{ g.FillRectangle(b, 40, 30, 50, 40); }
				g.SetClip(new Rectangle(100, 20, 40, 60), CombineMode.Replace);
				g.SetClip(new Rectangle(90, 50, 60, 20), CombineMode.Exclude);
				g.DrawImage(big, new RectangleF(85, 10, 70, 80));
				g.ResetClip();
				using (var b = new SolidBrush(Color.FromArgb(160, 200, 30, 30)))
				{ g.FillRectangle(b, 110, 5, 20, 90); }
			});
		}
	}

	// DrawImage with an ImageAttributes WrapMode (the usual TileFlipXY idiom
	// against faded edges, Tile, and Clamp with a clamp colour).
	static void GpxImageAttributeCases()
	{
		const int W = 160, H = 100;
		using (var small = GpxSourceBitmap(20, 16))
		using (var big = GpxSourceBitmap(64, 48))
		{
			foreach (var wrap in new[] { WrapMode.TileFlipXY, WrapMode.Tile, WrapMode.Clamp })
			{
				foreach (var mode in new[] { InterpolationMode.Bilinear, InterpolationMode.HighQualityBicubic })
				{
					var wm = wrap; var m = mode;
					GpCase("gpx-image-attr-" + WrapName(wm) + "-" + m.ToString().ToLowerInvariant(), W, H, delegate (Graphics g)
					{
						g.FillRectangle(Brushes.White, 0, 0, W, H);
						g.InterpolationMode = m;
						using (var ia = new ImageAttributes())
						{
							if (wm == WrapMode.Clamp) { ia.SetWrapMode(wm, Color.FromArgb(255, 40, 200, 80)); }
							else { ia.SetWrapMode(wm); }
							g.DrawImage(small, new Rectangle(4, 4, 52, 38), 0, 0, 20, 16, GraphicsUnit.Pixel, ia);
							g.DrawImage(big, new Rectangle(64, 6, 26, 22), 0, 0, 64, 48, GraphicsUnit.Pixel, ia);
							g.DrawImage(small, new Rectangle(64, 50, 90, 44), 2, 3, 14, 10, GraphicsUnit.Pixel, ia);
						}
					});
				}
			}
		}
	}

	/** Records `draw` into an in-memory EMF+ metafile of `w` x `h` pixels and reloads it. */
	static Metafile GpxMemoryMetafile(int w, int h, EmfType type, GpDraw draw)
	{
		var ms = new MemoryStream();
		using (var refG = Graphics.FromHwnd(IntPtr.Zero))
		{
			IntPtr hdc = refG.GetHdc();
			var mf = new Metafile(ms, hdc, new RectangleF(0, 0, w, h), MetafileFrameUnit.Pixel, type);
			refG.ReleaseHdc(hdc);
			using (var g = Graphics.FromImage(mf)) { g.PageUnit = GraphicsUnit.Pixel; draw(g); }
			mf.Dispose();
		}
		return new Metafile(new MemoryStream(ms.ToArray()));
	}

	static void GpxNestedMetafileDraw(Graphics g)
	{
		g.FillRectangle(Brushes.White, 0, 0, 80, 60);
		using (var b = new SolidBrush(Color.FromArgb(255, 220, 40, 30)))
		{ g.FillRectangle(b, 5, 5, 30, 20); }
		using (var b = new LinearGradientBrush(new RectangleF(40, 0, 36, 60), Color.FromArgb(255, 20, 60, 220), Color.FromArgb(255, 250, 220, 40), 90f))
		{ g.FillRectangle(b, 40, 4, 36, 52); }
		using (var b = new SolidBrush(Color.FromArgb(255, 30, 150, 60)))
		{ g.FillEllipse(b, 8, 30, 26, 24); }
		g.SetClip(new Rectangle(10, 12, 60, 10));
		using (var b = new SolidBrush(Color.FromArgb(180, 250, 250, 0)))
		{ g.FillRectangle(b, 0, 0, 80, 60); }
		g.ResetClip();
	}

	static void GpxNestedMetafileCases()
	{
		const int W = 160, H = 100;
		using (var mf = GpxMemoryMetafile(80, 60, EmfType.EmfPlusOnly, GpxNestedMetafileDraw))
		{
			GpCase("gpx-metafile-scaled", W, H, delegate (Graphics g)
			{
				g.FillRectangle(Brushes.White, 0, 0, W, H);
				g.DrawImage(mf, new RectangleF(10, 10, 120, 80));
			});
			GpCase("gpx-metafile-clip-zorder", W, H, delegate (Graphics g)
			{
				g.FillRectangle(Brushes.White, 0, 0, W, H);
				g.SetClip(new Rectangle(20, 15, 100, 50));
				g.DrawImage(mf, new RectangleF(10, 10, 80, 60));
				g.ResetClip();
				using (var b = new SolidBrush(Color.FromArgb(255, 60, 60, 60)))
				{ g.FillRectangle(b, 60, 40, 60, 30); }
				g.DrawImage(mf, new RectangleF(100, 50, 40, 30));
			});
		}
	}

	// -----------------------------------------------------------------------
	// gdiplus-extra: TextureBrush fills scaled up, rotated and scaled down by
	// the brush transform, for each WrapMode. GDI+ samples a texture brush
	// bilinearly whatever the InterpolationMode (every mode produced the
	// identical bitmap when this was measured), so the default mode covers
	// them all; two cases under other modes, and one under PixelOffsetMode
	// Half, pin that down.
	// -----------------------------------------------------------------------

	static void GpxTextureFill(Graphics g, Bitmap tex, WrapMode wm)
	{
		const int W = 160, H = 100;
		g.FillRectangle(Brushes.White, 0, 0, W, H);
		using (var b = new TextureBrush(tex, wm))
		{
			b.ScaleTransform(2.6f, 2.3f);
			b.TranslateTransform(3, 2, MatrixOrder.Append);
			g.FillRectangle(b, 0, 0, 70, 50);
		}
		using (var b = new TextureBrush(tex, wm))
		{
			b.RotateTransform(30);
			b.ScaleTransform(1.7f, 1.7f, MatrixOrder.Append);
			b.TranslateTransform(100, 10, MatrixOrder.Append);
			g.FillRectangle(b, 75, 0, 85, 55);
		}
		using (var b = new TextureBrush(tex, wm))
		{
			b.ScaleTransform(0.45f, 0.4f);
			b.TranslateTransform(1, 57, MatrixOrder.Append);
			g.FillRectangle(b, 0, 55, 160, 45);
		}
	}

	static void GpxTextureCases()
	{
		const int W = 160, H = 100;
		using (var tex = GpxSourceBitmap(12, 10))
		{
			foreach (var wrap in Wraps)
			{
				var wm = wrap;
				GpCase("gpx-texture-" + WrapName(wm), W, H, delegate (Graphics g) { GpxTextureFill(g, tex, wm); });
			}
			GpCase("gpx-texture-nearest-tile", W, H, delegate (Graphics g)
			{
				g.InterpolationMode = InterpolationMode.NearestNeighbor;
				GpxTextureFill(g, tex, WrapMode.Tile);
			});
			GpCase("gpx-texture-hqbicubic-flipxy", W, H, delegate (Graphics g)
			{
				g.InterpolationMode = InterpolationMode.HighQualityBicubic;
				GpxTextureFill(g, tex, WrapMode.TileFlipXY);
			});
			GpCase("gpx-texture-pom-half-tile", W, H, delegate (Graphics g)
			{
				g.PixelOffsetMode = PixelOffsetMode.Half;
				GpxTextureFill(g, tex, WrapMode.Tile);
			});
		}
	}

	// -----------------------------------------------------------------------
	// gdiplus-extra: pens and text painted with a texture, linear-gradient
	// or path-gradient brush. Strokes are axis-aligned and whole-pixel wide
	// (so edge antialiasing, which Canvas and GDI+ do differently, does not
	// enter), plus one curved stroke for the edges; text interiors show the
	// brush colour, glyph edges belong to the font engine.
	// -----------------------------------------------------------------------

	static void GpxBrushStrokes(Graphics g, Brush brush)
	{
		g.FillRectangle(Brushes.White, 0, 0, 160, 100);
		using (var pen = new Pen(brush, 10))
		{
			g.DrawRectangle(pen, 15, 15, 60, 40);
			g.DrawLine(pen, 100, 5, 100, 95);
			g.DrawLine(pen, 90, 80, 155, 80);
		}
		using (var pen = new Pen(brush, 6))
		{
			g.DrawEllipse(pen, 112, 12, 36, 50);
		}
	}

	// An explicit TextRenderingHint: SystemDefault follows the machine's
	// ClearType setting, which made these references change between runs.
	static void GpxBrushText(Graphics g, Brush brush)
	{
		GpxBrushText(g, brush, TextRenderingHint.AntiAliasGridFit);
	}

	static void GpxBrushText(Graphics g, Brush brush, TextRenderingHint hint)
	{
		g.TextRenderingHint = hint;
		g.FillRectangle(Brushes.White, 0, 0, 160, 100);
		using (var f = new Font("Arial", 40, FontStyle.Bold, GraphicsUnit.Pixel))
		{
			g.DrawString("HIM", f, brush, 4, 8);
		}
		using (var pen = new Pen(brush, 12))
		{
			g.DrawLine(pen, 0, 80, 160, 80);
		}
	}

	static void GpxPenTextCases()
	{
		const int W = 160, H = 100;
		using (var tex = GpxSourceBitmap(12, 10))
		{
			GpCase("gpx-pen-texture", W, H, delegate (Graphics g)
			{
				using (var b = new TextureBrush(tex, WrapMode.Tile)) { b.ScaleTransform(2.5f, 2.5f); GpxBrushStrokes(g, b); }
			});
			GpCase("gpx-text-texture", W, H, delegate (Graphics g)
			{
				using (var b = new TextureBrush(tex, WrapMode.TileFlipXY)) { b.ScaleTransform(3f, 3f); GpxBrushText(g, b); }
			});
			GpCase("gpx-text-texture-mono", W, H, delegate (Graphics g)
			{
				using (var b = new TextureBrush(tex, WrapMode.TileFlipXY)) { b.ScaleTransform(3f, 3f); GpxBrushText(g, b, TextRenderingHint.SingleBitPerPixelGridFit); }
			});
			GpCase("gpx-text-texture-cleartype", W, H, delegate (Graphics g)
			{
				using (var b = new TextureBrush(tex, WrapMode.TileFlipXY)) { b.ScaleTransform(3f, 3f); GpxBrushText(g, b, TextRenderingHint.ClearTypeGridFit); }
			});
		}
		GpCase("gpx-pen-lingrad", W, H, delegate (Graphics g)
		{
			using (var b = new LinearGradientBrush(new RectangleF(10, 0, 70, 40), Color.FromArgb(255, 230, 30, 30), Color.FromArgb(255, 20, 40, 220), 35f))
			{ GpxBrushStrokes(g, b); }
		});
		GpCase("gpx-text-lingrad", W, H, delegate (Graphics g)
		{
			using (var b = new LinearGradientBrush(new RectangleF(0, 0, 60, 30), Color.FromArgb(255, 250, 200, 0), Color.FromArgb(255, 120, 0, 160), 70f))
			{ b.WrapMode = WrapMode.TileFlipX; GpxBrushText(g, b); }
		});
		GpCase("gpx-pen-pathgrad", W, H, delegate (Graphics g)
		{
			using (var p = new GraphicsPath())
			{
				p.AddEllipse(0, 0, 50, 40);
				using (var b = new PathGradientBrush(p))
				{
					b.CenterColor = Color.White;
					b.SurroundColors = new Color[] { Color.FromArgb(255, 200, 20, 90) };
					b.WrapMode = WrapMode.TileFlipXY;
					GpxBrushStrokes(g, b);
				}
			}
		});
		GpCase("gpx-text-pathgrad", W, H, delegate (Graphics g)
		{
			var pts = new PointF[] { new PointF(10, 0), new PointF(70, 20), new PointF(30, 60) };
			using (var b = new PathGradientBrush(pts))
			{
				b.CenterColor = Color.FromArgb(255, 255, 250, 180);
				b.SurroundColors = new Color[] { Color.FromArgb(255, 220, 30, 30), Color.FromArgb(255, 30, 160, 40), Color.FromArgb(255, 30, 40, 220) };
				b.WrapMode = WrapMode.Tile;
				GpxBrushText(g, b);
			}
		});
		// Pen options that move the embedded brush's offset in the record
		// (dash pattern, alignment, compound line, caps, join, miter limit).
		GpCase("gpx-pen-styles", W, H, delegate (Graphics g)
		{
			g.FillRectangle(Brushes.White, 0, 0, W, H);
			using (var pen = new Pen(Color.FromArgb(255, 20, 110, 200), 8))
			{
				pen.DashPattern = new float[] { 3f, 1f, 1f, 1f };
				pen.DashOffset = 0.5f;
				pen.Alignment = PenAlignment.Inset;
				pen.LineJoin = LineJoin.Round;
				pen.StartCap = LineCap.Round;
				pen.EndCap = LineCap.Square;
				pen.MiterLimit = 4f;
				g.DrawRectangle(pen, 20, 20, 50, 40);
				g.DrawLine(pen, 90, 20, 150, 20);
			}
			using (var pen = new Pen(Color.FromArgb(255, 200, 60, 20), 12))
			{
				pen.CompoundArray = new float[] { 0f, 0.3f, 0.6f, 1f };
				g.DrawLine(pen, 90, 60, 150, 60);
			}
		});
	}

	static void RasterCases()
	{
		RasterLineCases();
		RasterEllipseCases();
		RasterRoundArcCases();
		RasterFillCases();
		RasterPenStyleCases();
		RasterWidePenCases();
		RasterBlitCases();
		RasterBenchCase();
	}

	// Raster (.fon) faces: GDI draws these from their bitmaps, picking a size
	// (and a whole-number stretch) by its mapper's height penalties.
	static readonly string[] TxRasterFaces = { "MS Sans Serif", "MS Serif", "Courier", "Small Fonts", "System", "Terminal", "Fixedsys", "Helv", "Tms Rmn", "MS Shell Dlg" };
	static readonly int[] TxRasterSizes = { -6, -8, -10, -11, -13, -15, -16, -18, -20, -22, -24, -27, -30, -33, -36, -40, -44, -52 };
	static readonly int[] TxRasterCellSizes = { 8, 12, 13, 15, 16, 18, 20, 22, 24, 25, 29, 33, 39, 45, 50 };

	static void TxRasterCases()
	{
		foreach (string f in TxRasterFaces)
		{
			TxSizeSheet("textx-fon-" + TxKey(f), f, 3, TxRasterSizes, false);
			TxSizeSheet("textx-fon-" + TxKey(f) + "-cell", f, 3, TxRasterCellSizes, true);
		}
		TxStyleSheet("textx-fon-mssansserif-styles", "MS Sans Serif", 0, false);
		TxStyleSheet("textx-fon-courier-styles", "Courier", 0, true);
		TxSizeSheet("textx-fon-mssansserif-aa", "MS Sans Serif", 4, TxRasterSizes, false);
	}

	// Rotated text with TA_TOP / TA_BOTTOM / TA_BASELINE and TA_CENTER /
	// TA_RIGHT, by escapement and by world transform, with a cross at each
	// reference point.
	static void TxRotatedAlignSheet(string name, bool world, int height)
	{
		int[] angles = { 0, 25, 45, 90, 160, 300 };
		int[] aligns = { 0, 8, 24, 6 | 24, 2 };
		GdiCase(name, 600, 520, delegate (IntPtr hdc)
		{
			Fill(hdc, 0, 0, 600, 520, Rgb(255, 255, 255));
			SetBkMode(hdc, 1); SetTextColor(hdc, 0);
			SetGraphicsMode(hdc, 2);
			for (int i = 0; i < angles.Length; i++)
			{
				for (int j = 0; j < aligns.Length; j++)
				{
					int x = 50 + j * 115, y = 45 + i * 80;
					SetTextAlign(hdc, (uint)aligns[j]);
					var lf = TxLf(j % 2 == 0 ? "Arial" : "Times New Roman", height, 400, false, 3);
					if (world)
					{
						XFORM xf = RotationXform(-angles[i], x, y);
						SetWorldTransform(hdc, ref xf);
						TxLine(hdc, lf, 0, 0, "Tg" + angles[i]);
						XFORM id = new XFORM { eM11 = 1, eM22 = 1 };
						SetWorldTransform(hdc, ref id);
					}
					else
					{
						lf.lfEscapement = angles[i] * 10; lf.lfOrientation = angles[i] * 10;
						TxLine(hdc, lf, x, y, "Tg" + angles[i]);
					}
					Fill(hdc, x, y, x + 1, y + 1, Rgb(255, 0, 0));
				}
			}
		});
	}

	static void TxRotatedAlignCases()
	{
		TxRotatedAlignSheet("textx-rotalign-esc", false, -20);
		TxRotatedAlignSheet("textx-rotalign-esc-small", false, -13);
		TxRotatedAlignSheet("textx-rotalign-world", true, -20);
	}

	// Wide pens beyond the small (Hobby) nibs: flattened-ellipse pens of 7 to
	// 14 px on closed polygons, ellipses, Bezier curves, rectangles and
	// dashed polylines, in both graphics modes (category "gdi-raster").
	static void RasterWideExtraCases()
	{
		GdiCase("raster-wide-extra", 240, 240, delegate (IntPtr hdc)
		{
			Stripes(hdc, 240, 240);
			IntPtr nb = GetStockObject(5);
			IntPtr obr = SelectObject(hdc, nb);
			uint[] caps = { 0, PS_ENDCAP_SQUARE, PS_ENDCAP_FLAT };
			uint[] joins = { 0, PS_JOIN_BEVEL, PS_JOIN_MITER };
			int[] widths = { 7, 9, 10, 12, 14 };
			for (int k = 0; k < 15; k++)
			{
				SetGraphicsMode(hdc, k % 2 == 0 ? 1 : 2);
				int w = widths[k % 5];
				uint style = PS_GEOMETRIC | caps[k % 3] | joins[(k / 3) % 3] | (k >= 12 ? (uint)(k - 11) : 0u);
				IntPtr pen = k % 4 == 3 ? CreatePen(0, w, Palette[k % 8] ^ 0x505050) : ExtPen(style, w, Palette[k % 8] ^ 0x505050, null);
				int ox = 12 + (k % 5) * 46, oy = 14 + (k / 5) * 76;
				WithObjects(hdc, pen, IntPtr.Zero, delegate
				{
					if (k % 5 == 0) { Polygon(hdc, new[] { P(ox, oy), P(ox + 30, oy + 8), P(ox + 14, oy + 40) }, 3); }
					else if (k % 5 == 1) { Ellipse(hdc, ox - 4, oy, ox + 31, oy + 27); }
					else if (k % 5 == 2) { PolyBezier(hdc, new[] { P(ox - 2, oy + 40), P(ox + 4, oy - 12), P(ox + 30, oy + 60), P(ox + 34, oy + 6) }, 4); }
					else if (k % 5 == 3) { Rectangle(hdc, ox, oy + 4, ox + 30, oy + 36); }
					else { Polyline(hdc, new[] { P(ox - 4, oy + 50), P(ox + 10, oy), P(ox + 22, oy + 44), P(ox + 34, oy + 8) }, 4); }
				});
			}
			SetGraphicsMode(hdc, 1);
			SelectObject(hdc, obr);
		});
	}

	// -----------------------------------------------------------------------
	// WMF record cases (category "wmf-records"). Each case is a WMF (recorded
	// by CreateMetaFile, or assembled record by record for the records Win32
	// never writes itself) and the PNG Windows paints when it PLAYS those
	// exact bytes: PlayMetaFile onto a white 32bpp DIB section. A placeable
	// file is played the way a placeable-aware player maps it (MM_ANISOTROPIC,
	// the window on the header bounds, the viewport on the image's pixel
	// size at 96 dpi); a non-placeable one on the DIB's default MM_TEXT DC.
	// -----------------------------------------------------------------------

	static class WmfApi
	{
		[DllImport("gdi32.dll")] public static extern bool PlayMetaFile(IntPtr hdc, IntPtr hmf);
		[DllImport("gdi32.dll")] public static extern IntPtr SetMetaFileBitsEx(uint size, byte[] data);
		[DllImport("gdi32.dll")] public static extern int SetMapMode(IntPtr hdc, int mode);
		[DllImport("gdi32.dll")] public static extern bool SetWindowOrgEx(IntPtr hdc, int x, int y, IntPtr prev);
		[DllImport("gdi32.dll")] public static extern bool SetWindowExtEx(IntPtr hdc, int x, int y, IntPtr prev);
		[DllImport("gdi32.dll")] public static extern bool SetViewportOrgEx(IntPtr hdc, int x, int y, IntPtr prev);
		[DllImport("gdi32.dll")] public static extern bool SetViewportExtEx(IntPtr hdc, int x, int y, IntPtr prev);
		[DllImport("gdi32.dll")] public static extern bool OffsetWindowOrgEx(IntPtr hdc, int x, int y, IntPtr prev);
		[DllImport("gdi32.dll")] public static extern bool OffsetViewportOrgEx(IntPtr hdc, int x, int y, IntPtr prev);
		[DllImport("gdi32.dll")] public static extern bool ScaleWindowExtEx(IntPtr hdc, int xn, int xd, int yn, int yd, IntPtr prev);
		[DllImport("gdi32.dll")] public static extern bool ScaleViewportExtEx(IntPtr hdc, int xn, int xd, int yn, int yd, IntPtr prev);
		[DllImport("gdi32.dll")] public static extern int SaveDC(IntPtr hdc);
		[DllImport("gdi32.dll")] public static extern bool RestoreDC(IntPtr hdc, int saved);
		[DllImport("gdi32.dll")] public static extern int IntersectClipRect(IntPtr hdc, int l, int t, int r, int b);
		[DllImport("gdi32.dll")] public static extern int ExcludeClipRect(IntPtr hdc, int l, int t, int r, int b);
		[DllImport("gdi32.dll")] public static extern int OffsetClipRgn(IntPtr hdc, int x, int y);
		[DllImport("gdi32.dll")] public static extern int SelectClipRgn(IntPtr hdc, IntPtr rgn);
		[DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
		[DllImport("gdi32.dll")] public static extern IntPtr CreateEllipticRgn(int l, int t, int r, int b);
		[DllImport("gdi32.dll")] public static extern IntPtr CreateRoundRectRgn(int l, int t, int r, int b, int w, int h);
		[DllImport("gdi32.dll")] public static extern IntPtr CreatePolygonRgn([In] POINT[] pts, int n, int mode);
		[DllImport("gdi32.dll")] public static extern int CombineRgn(IntPtr dst, IntPtr a, IntPtr b, int mode);
		[DllImport("gdi32.dll")] public static extern bool FillRgn(IntPtr hdc, IntPtr rgn, IntPtr brush);
		[DllImport("gdi32.dll")] public static extern bool FrameRgn(IntPtr hdc, IntPtr rgn, IntPtr brush, int w, int h);
		[DllImport("gdi32.dll")] public static extern bool InvertRgn(IntPtr hdc, IntPtr rgn);
		[DllImport("gdi32.dll")] public static extern bool PaintRgn(IntPtr hdc, IntPtr rgn);
		[DllImport("gdi32.dll")] public static extern uint SetPixel(IntPtr hdc, int x, int y, int color);
		[DllImport("gdi32.dll")] public static extern bool FloodFill(IntPtr hdc, int x, int y, int color);
		[DllImport("gdi32.dll")] public static extern bool ExtFloodFill(IntPtr hdc, int x, int y, int color, uint type);
		[DllImport("gdi32.dll")] public static extern IntPtr CreatePalette(byte[] logPalette);
		[DllImport("gdi32.dll")] public static extern IntPtr SelectPalette(IntPtr hdc, IntPtr pal, bool background);
		[DllImport("gdi32.dll")] public static extern uint RealizePalette(IntPtr hdc);
		[DllImport("gdi32.dll")] public static extern uint SetPaletteEntries(IntPtr pal, uint start, uint n, byte[] entries);
		[DllImport("gdi32.dll")] public static extern bool AnimatePalette(IntPtr pal, uint start, uint n, byte[] entries);
		[DllImport("gdi32.dll")] public static extern bool ResizePalette(IntPtr pal, uint n);
		[DllImport("gdi32.dll")] public static extern int SetTextCharacterExtra(IntPtr hdc, int extra);
		[DllImport("gdi32.dll")] public static extern bool SetTextJustification(IntPtr hdc, int extra, int count);
		[DllImport("gdi32.dll")] public static extern uint SetMapperFlags(IntPtr hdc, uint flags);
		[DllImport("gdi32.dll")] public static extern uint SetLayout(IntPtr hdc, uint layout);
		[DllImport("gdi32.dll")] public static extern int Escape(IntPtr hdc, int esc, int cb, byte[] input, IntPtr output);
		[DllImport("gdi32.dll")] public static extern int SetDIBitsToDevice(IntPtr hdc, int x, int y, int w, int h, int sx, int sy, uint start, uint lines, byte[] bits, byte[] bmi, uint usage);
		[DllImport("gdi32.dll")] public static extern int StretchDIBits(IntPtr hdc, int x, int y, int w, int h, int sx, int sy, int sw, int sh, byte[] bits, byte[] bmi, uint usage, uint rop);
		[DllImport("gdi32.dll")] public static extern IntPtr CreateDIBPatternBrushPt(byte[] packed, uint usage);
		[DllImport("gdi32.dll")] public static extern uint GetWinMetaFileBits(IntPtr hemf, uint size, byte[] buf, int mapMode, IntPtr hdcRef);
		[DllImport("gdi32.dll")] public static extern IntPtr SetWinMetaFileBits(uint size, byte[] buf, IntPtr hdcRef, ref METAFILEPICT mfp);
		[DllImport("gdi32.dll")] public static extern bool PlayEnhMetaFile(IntPtr hdc, IntPtr hemf, ref RECT rc);
		[DllImport("gdi32.dll")] public static extern uint GetEnhMetaFileBits(IntPtr hemf, uint size, byte[] buf);
		[DllImport("gdi32.dll", CharSet = CharSet.Ansi)] public static extern bool TextOutA(IntPtr hdc, int x, int y, string s, int n);
		[DllImport("gdi32.dll")] public static extern int SetArcDirection(IntPtr hdc, int dir);
		[DllImport("gdi32.dll")] public static extern bool EnumMetaFile(IntPtr hdc, IntPtr hmf, MfEnumProc proc, IntPtr param);
		[DllImport("gdi32.dll")] public static extern bool PlayMetaFileRecord(IntPtr hdc, IntPtr table, IntPtr record, uint objects);
		[DllImport("gdi32.dll")] public static extern bool SetBrushOrgEx(IntPtr hdc, int x, int y, IntPtr prev);
	}

	[StructLayout(LayoutKind.Sequential)]
	public struct METAFILEPICT { public int mm; public int xExt; public int yExt; public IntPtr hMF; }

	public delegate int MfEnumProc(IntPtr hdc, IntPtr table, IntPtr record, int objects, IntPtr param);

	/**
	 * When set, {@link WmfPlayCase} plays the file record by record and turns
	 * each metric META_SETMAPMODE into the mode's definition on a 96 dpi
	 * device (MM_ANISOTROPIC, window = units per inch, viewport = 96 x -96
	 * pixels): GDI derives the metric modes from the display's physical size,
	 * which differs per machine; the converter's device is the 96 dpi
	 * reference device. Every other record is played by PlayMetaFileRecord.
	 */
	static bool wmfMetricAs96Dpi;
	static readonly MfEnumProc WmfMetricRecord = delegate (IntPtr hdc, IntPtr table, IntPtr record, int objects, IntPtr param)
	{
		int fn = Marshal.ReadInt16(record, 4) & 0xffff;
		if (fn == 0x0103)
		{
			int mode = Marshal.ReadInt16(record, 6);
			int units = mode == 2 ? 254 : mode == 3 ? 2540 : mode == 4 ? 100 : mode == 5 ? 1000 : mode == 6 ? 1440 : 0;
			if (units > 0)
			{
				WmfApi.SetMapMode(hdc, 8);
				WmfApi.SetWindowExtEx(hdc, units, units, IntPtr.Zero);
				WmfApi.SetViewportExtEx(hdc, 96, -96, IntPtr.Zero);
				return 1;
			}
		}
		WmfApi.PlayMetaFileRecord(hdc, table, record, (uint)objects);
		return 1;
	};

	/** Assembles a WMF record by record (for records Win32 never writes itself). */
	sealed class WmfWriter
	{
		readonly MemoryStream body = new MemoryStream();
		int maxRecord = 3;
		public int Objects;
		/** A record of 16-bit parameters, given in file order. */
		public void Rec(int fn, params int[] words)
		{
			var bytes = new byte[words.Length * 2];
			for (int i = 0; i < words.Length; i++) { bytes[i * 2] = (byte)(words[i] & 0xff); bytes[i * 2 + 1] = (byte)((words[i] >> 8) & 0xff); }
			RecBytes(fn, bytes);
		}
		/** A record with raw parameter bytes (padded to a word). */
		public void RecBytes(int fn, byte[] data)
		{
			int len = data.Length + (data.Length & 1);
			int words = 3 + len / 2;
			var bw = new BinaryWriter(body);
			bw.Write((uint)words); bw.Write((ushort)fn); bw.Write(data);
			if ((data.Length & 1) != 0) { bw.Write((byte)0); }
			maxRecord = Math.Max(maxRecord, words);
		}
		public byte[] Build()
		{
			Rec(0);
			byte[] recs = body.ToArray();
			var ms = new MemoryStream();
			var bw = new BinaryWriter(ms);
			bw.Write((ushort)1); bw.Write((ushort)9); bw.Write((ushort)0x0300);
			bw.Write((uint)(9 + recs.Length / 2)); bw.Write((ushort)Objects); bw.Write((uint)maxRecord); bw.Write((ushort)0);
			bw.Write(recs);
			return ms.ToArray();
		}
	}

	/** Records `draw` through CreateMetaFile and returns the raw (non-placeable) WMF bytes. */
	static byte[] WmfRecord(GdiDraw draw)
	{
		string tmp = Path.Combine(outDir, "wmf-records.tmp.wmf");
		IntPtr mdc = CreateMetaFileW(tmp);
		draw(mdc);
		DeleteMetaFile(CloseMetaFile(mdc));
		byte[] raw = File.ReadAllBytes(tmp);
		File.Delete(tmp);
		// GDI copies the face name's whole buffer, bytes after its terminator
		// included (uninitialised memory): clear them so the file is deterministic.
		for (int off = 18; off + 6 <= raw.Length; )
		{
			int size = BitConverter.ToInt32(raw, off) * 2;
			int fn = BitConverter.ToUInt16(raw, off + 4);
			if (size < 6) { break; }
			if (fn == 0x02FB && size >= 6 + 18 + 32)
			{
				bool end = false;
				for (int i = 0; i < 32; i++) { int at = off + 6 + 18 + i; if (end) { raw[at] = 0; } else if (raw[at] == 0) { end = true; } }
			}
			if (fn == 0x0521 && size >= 8)
			{
				int n = BitConverter.ToInt16(raw, off + 6);
				if ((n & 1) != 0 && off + 8 + n < off + size) { raw[off + 8 + n] = 0; }
			}
			if (fn == 0x0A32 && size >= 14)
			{
				int n = BitConverter.ToInt16(raw, off + 10);
				int opts = BitConverter.ToUInt16(raw, off + 12);
				int str = off + 14 + ((opts & 6) != 0 ? 8 : 0);
				if ((n & 1) != 0 && str + n < off + size) { raw[str + n] = 0; }
			}
			off += size;
		}
		return raw;
	}

	/** Prefixes `raw` with an Aldus placeable header (bounds `l,t,r,b` at `inch` units per inch). */
	static byte[] WmfPlaceable(byte[] raw, int l, int t, int r, int b, int inch)
	{
		var ms = new MemoryStream();
		var bw = new BinaryWriter(ms);
		bw.Write((uint)0x9AC6CDD7); bw.Write((ushort)0);
		bw.Write((short)l); bw.Write((short)t); bw.Write((short)r); bw.Write((short)b);
		bw.Write((ushort)inch); bw.Write((uint)0);
		ushort sum = 0;
		byte[] hdr = ms.ToArray();
		for (int i = 0; i < 20; i += 2) { sum ^= BitConverter.ToUInt16(hdr, i); }
		bw.Write(sum);
		bw.Write(raw);
		return ms.ToArray();
	}

	/**
	 * Writes `<name>.wmf` (placeable when `bounds` is given) and `<name>.png`:
	 * `raw` played by PlayMetaFile onto a white `w` x `h` DIB, under the
	 * placeable mapping (window = bounds, viewport = w x h) or on the plain
	 * MM_TEXT DC.
	 */
	static void WmfPlayCase(string name, int w, int h, byte[] raw, int[] bounds, int inch)
	{
		File.WriteAllBytes(Path.Combine(outDir, name + ".wmf"), bounds != null ? WmfPlaceable(raw, bounds[0], bounds[1], bounds[2], bounds[3], inch) : raw);
		IntPtr screen = GetDC(IntPtr.Zero);
		using (var dib = new Dib(screen, w, h))
		{
			Fill(dib.Dc, 0, 0, w, h, Rgb(255, 255, 255));
			IntPtr hmf = WmfApi.SetMetaFileBitsEx((uint)raw.Length, raw);
			int saved = WmfApi.SaveDC(dib.Dc);
			// MM_ANISOTROPIC, the viewport on the picture: the window on the
			// placeable bounds, or (a CF_METAFILEPICT player) the picture's
			// pixel size, which the file's own window records then override.
			WmfApi.SetMapMode(dib.Dc, 8);
			if (bounds != null)
			{
				WmfApi.SetWindowOrgEx(dib.Dc, bounds[0], bounds[1], IntPtr.Zero);
				WmfApi.SetWindowExtEx(dib.Dc, bounds[2] - bounds[0], bounds[3] - bounds[1], IntPtr.Zero);
			}
			else
			{
				WmfApi.SetWindowOrgEx(dib.Dc, 0, 0, IntPtr.Zero);
				WmfApi.SetWindowExtEx(dib.Dc, w, h, IntPtr.Zero);
			}
			WmfApi.SetViewportOrgEx(dib.Dc, 0, 0, IntPtr.Zero);
			WmfApi.SetViewportExtEx(dib.Dc, w, h, IntPtr.Zero);
			if (wmfMetricAs96Dpi) { WmfApi.EnumMetaFile(dib.Dc, hmf, WmfMetricRecord, IntPtr.Zero); }
			else { WmfApi.PlayMetaFile(dib.Dc, hmf); }
			WmfApi.RestoreDC(dib.Dc, saved);
			DeleteMetaFile(hmf);
			dib.SavePng(Path.Combine(outDir, name + ".png"));
		}
		ReleaseDC(IntPtr.Zero, screen);
	}

	/** A placeable case at 96 dpi: bounds 0,0,w,h, drawn in pixels. */
	static void WmfPixelCase(string name, int w, int h, GdiDraw draw)
	{
		WmfPlayCase(name, w, h, WmfRecord(draw), new int[] { 0, 0, w, h }, 96);
	}

	/** Every shape record with the selected pen and brush, coordinates scaled by `k` (one 38-unit box per shape). */
	static void WmfShapeRow(IntPtr hdc, int oy, int k)
	{
		Func<int, int> S = delegate (int v) { return v * k; };
		int x = 0;
		Rectangle(hdc, S(x + 4), S(oy + 4), S(x + 33), S(oy + 30)); x += 38;
		Rectangle(hdc, S(x + 33), S(oy + 30), S(x + 4), S(oy + 4)); x += 38;
		RoundRect(hdc, S(x + 3), S(oy + 3), S(x + 34), S(oy + 31), S(12), S(9)); x += 38;
		Ellipse(hdc, S(x + 3), S(oy + 3), S(x + 34), S(oy + 30)); x += 38;
		Arc(hdc, S(x + 3), S(oy + 3), S(x + 34), S(oy + 31), S(x + 34), S(oy + 3), S(x + 3), S(oy + 25)); x += 38;
		Chord(hdc, S(x + 3), S(oy + 3), S(x + 34), S(oy + 31), S(x + 34), S(oy + 8), S(x + 3), S(oy + 25)); x += 38;
		Pie(hdc, S(x + 3), S(oy + 3), S(x + 35), S(oy + 31), S(x + 34), S(oy + 30), S(x + 30), S(oy + 3)); x += 38;
		Polygon(hdc, new[] { P(S(x + 18), S(oy + 2)), P(S(x + 34), S(oy + 30)), P(S(x + 2), S(oy + 14)), P(S(x + 33), S(oy + 12)), P(S(x + 5), S(oy + 31)) }, 5); x += 38;
		Polyline(hdc, new[] { P(S(x + 3), S(oy + 30)), P(S(x + 12), S(oy + 3)), P(S(x + 22), S(oy + 28)), P(S(x + 34), S(oy + 5)) }, 4); x += 38;
		MoveToEx(hdc, S(x + 3), S(oy + 3), IntPtr.Zero); LineTo(hdc, S(x + 34), S(oy + 30)); LineTo(hdc, S(x + 3), S(oy + 30)); LineTo(hdc, S(x + 20), S(oy + 8));
	}

	/** Seven rows of {@link WmfShapeRow} under different pens, brushes and modes. */
	static void WmfShapeSheet(IntPtr hdc, int k)
	{
		SetBkMode(hdc, 2);
		SetBkColor(hdc, Rgb(0xFF, 0xF0, 0xC0));
		WithObjects(hdc, CreatePen(0, 0, Rgb(0x10, 0x20, 0x90)), CreateSolidBrush(Rgb(0xE0, 0x90, 0x30)), delegate { WmfShapeRow(hdc, 0, k); });
		WithObjects(hdc, CreatePen(5, 0, 0), CreateSolidBrush(Rgb(0x30, 0xA0, 0x60)), delegate { WmfShapeRow(hdc, 36, k); });
		WithObjects(hdc, CreatePen(0, 5 * k, Rgb(0x90, 0x20, 0x40)), CreateHatchBrush(5, Rgb(0x20, 0x40, 0xC0)), delegate { WmfShapeRow(hdc, 72, k); });
		WithObjects(hdc, CreatePen(1, 1, Rgb(0x10, 0x10, 0x10)), CreateHatchBrush(2, Rgb(0xC0, 0x20, 0x20)), delegate { WmfShapeRow(hdc, 108, k); });
		WithObjects(hdc, CreatePen(6, 4 * k, Rgb(0x20, 0x70, 0x70)), CreateSolidBrush(Rgb(0xF0, 0xE0, 0x60)), delegate { WmfShapeRow(hdc, 144, k); });
		SetBkMode(hdc, 1);
		WithObjects(hdc, CreatePen(2, 0, Rgb(0x60, 0x10, 0x80)), CreateHatchBrush(3, Rgb(0x10, 0x80, 0x10)), delegate { WmfShapeRow(hdc, 180, k); });
		WithObjects(hdc, CreatePen(0, 3 * k, Rgb(0x70, 0x40, 0x10)), GetStockObject(5), delegate { WmfShapeRow(hdc, 216, k); });
	}

	static void WmfShapeCases()
	{
		int w = 380, h = 252;
		WmfPixelCase("wmf-shapes", w, h, delegate (IntPtr hdc) { WmfShapeSheet(hdc, 1); });
		// Twips (1440 per inch): every coordinate and pen width 15x, bounds 15x.
		WmfPlayCase("wmf-shapes-twips", w, h, WmfRecord(delegate (IntPtr hdc) { WmfShapeSheet(hdc, 15); }), new int[] { 0, 0, w * 15, h * 15 }, 1440);
		// 1000 per inch at 10 units per drawn unit: a non-integer device scale (0.96).
		WmfPlayCase("wmf-shapes-scaled", 365, 242, WmfRecord(delegate (IntPtr hdc) { WmfShapeSheet(hdc, 10); }), new int[] { 0, 0, 3800, 2520 }, 1000);
	}

	/** A few shapes in a 60 x 40 logical cell at (`x`, `y`), scaled by `k`. */
	static void WmfProbe(IntPtr hdc, int x, int y, int k, int color)
	{
		WithObjects(hdc, CreatePen(0, 0, Rgb(0x10, 0x10, 0x60)), CreateSolidBrush(color), delegate
		{
			Rectangle(hdc, x, y, x + 30 * k, y + 20 * k);
			Ellipse(hdc, x + 32 * k, y, x + 60 * k, y + 20 * k);
			Polygon(hdc, new[] { P(x, y + 22 * k), P(x + 60 * k, y + 26 * k), P(x + 20 * k, y + 40 * k) }, 3);
			MoveToEx(hdc, x + 30 * k, y + 40 * k, IntPtr.Zero); LineTo(hdc, x + 60 * k, y + 22 * k);
		});
	}

	static void WmfMappingCases()
	{
		// Origins, offsets and extent scaling under the placeable player's MM_ANISOTROPIC.
		WmfPixelCase("wmf-map-anisotropic", 260, 180, delegate (IntPtr hdc)
		{
			WmfProbe(hdc, 4, 4, 1, Palette[0]);
			WmfApi.SetViewportOrgEx(hdc, 70, 6, IntPtr.Zero);
			WmfProbe(hdc, 0, 0, 1, Palette[1]);
			WmfApi.OffsetViewportOrgEx(hdc, 60, 3, IntPtr.Zero);
			WmfApi.SetWindowOrgEx(hdc, -10, -5, IntPtr.Zero);
			WmfProbe(hdc, 0, 0, 1, Palette[2]);
			WmfApi.OffsetWindowOrgEx(hdc, 3, -40, IntPtr.Zero);
			WmfApi.ScaleWindowExtEx(hdc, 3, 2, 5, 4, IntPtr.Zero);
			WmfProbe(hdc, -120, 20, 1, Palette[3]);
			WmfApi.ScaleViewportExtEx(hdc, 2, 3, 7, 5, IntPtr.Zero);
			WmfApi.SetViewportOrgEx(hdc, 10, 60, IntPtr.Zero);
			WmfApi.SetWindowOrgEx(hdc, 0, 0, IntPtr.Zero);
			WmfProbe(hdc, 0, 0, 2, Palette[4]);
			WmfApi.SetWindowExtEx(hdc, 400, -300, IntPtr.Zero);
			WmfApi.SetViewportExtEx(hdc, 260, 180, IntPtr.Zero);
			WmfApi.SetViewportOrgEx(hdc, 0, 180, IntPtr.Zero);
			WmfProbe(hdc, 200, 90, 2, Palette[5]);
		});
		// MM_ISOTROPIC: the viewport shrinks on the axis with the larger scale, after every extent change.
		WmfPixelCase("wmf-map-isotropic", 260, 180, delegate (IntPtr hdc)
		{
			WmfApi.SetMapMode(hdc, 7);
			WmfApi.SetWindowExtEx(hdc, 300, 100, IntPtr.Zero);
			WmfApi.SetViewportExtEx(hdc, 260, 180, IntPtr.Zero);
			WmfProbe(hdc, 4, 4, 1, Palette[0]);
			WmfApi.SetWindowExtEx(hdc, 100, 170, IntPtr.Zero);
			WmfProbe(hdc, 150, 4, 1, Palette[1]);
			WmfApi.ScaleViewportExtEx(hdc, 1, 2, 3, 1, IntPtr.Zero);
			WmfApi.SetViewportOrgEx(hdc, 0, 90, IntPtr.Zero);
			WmfProbe(hdc, 4, 4, 2, Palette[2]);
			WmfApi.SetViewportExtEx(hdc, -200, 120, IntPtr.Zero);
			WmfApi.SetViewportOrgEx(hdc, 250, 90, IntPtr.Zero);
			WmfProbe(hdc, 4, 4, 1, Palette[3]);
		});
		// MM_TEXT inside a placeable file: one logical unit per device pixel, extents ignored.
		WmfPlayCase("wmf-map-text", 240, 150, WmfRecord(delegate (IntPtr hdc)
		{
			WmfProbe(hdc, 40, 40, 10, Palette[0]);
			WmfApi.SetMapMode(hdc, 1);
			WmfApi.SetWindowExtEx(hdc, 5, 5, IntPtr.Zero);
			WmfApi.SetViewportOrgEx(hdc, 100, 20, IntPtr.Zero);
			WmfProbe(hdc, 10, 10, 1, Palette[1]);
		}), new int[] { 0, 0, 2400, 1500 }, 960);
		// The metric modes (on the 96 dpi reference device) and MM_TEXT back again.
		wmfMetricAs96Dpi = true;
		WmfPixelCase("wmf-map-metric", 300, 200, delegate (IntPtr hdc)
		{
			int[] modes = { 2, 3, 4, 5, 6 };
			int[] units = { 254, 2540, 100, 1000, 1440 };
			for (int i = 0; i < modes.Length; i++)
			{
				WmfApi.SetMapMode(hdc, modes[i]);
				WmfApi.SetViewportOrgEx(hdc, 4 + (i % 3) * 98, 90 + (i / 3) * 100, IntPtr.Zero);
				int u = units[i];
				// 0.7 inch wide, 0.8 inch tall above the origin (y grows up).
				int c = Palette[i];
				WithObjects(hdc, CreatePen(0, 0, Rgb(0x10, 0x10, 0x60)), CreateSolidBrush(c), delegate
				{
					Rectangle(hdc, 0, 0, u * 7 / 10, u * 8 / 10);
					Ellipse(hdc, u / 10, u / 10, u * 6 / 10, u * 7 / 10);
				});
			}
			WmfApi.SetMapMode(hdc, 1);
			WmfApi.SetViewportOrgEx(hdc, 0, 0, IntPtr.Zero);
			WmfProbe(hdc, 200, 150, 1, Palette[6]);
		});
		wmfMetricAs96Dpi = false;
		// Non-placeable: the window extent names the picture (window origin off zero).
		WmfPlayCase("wmf-nonplaceable", 300, 200, WmfRecord(delegate (IntPtr hdc)
		{
			WmfApi.SetWindowOrgEx(hdc, -20, -10, IntPtr.Zero);
			WmfApi.SetWindowExtEx(hdc, 300, 200, IntPtr.Zero);
			WmfShapeRow(hdc, 0, 1);
			WmfProbe(hdc, 10, 60, 2, Palette[2]);
		}), null, 0);
		// Non-placeable, MM_ANISOTROPIC with its own viewport: the viewport extent is the picture.
		WmfPlayCase("wmf-nonplaceable-viewport", 200, 150, WmfRecord(delegate (IntPtr hdc)
		{
			WmfApi.SetMapMode(hdc, 8);
			WmfApi.SetWindowOrgEx(hdc, 0, 0, IntPtr.Zero);
			WmfApi.SetWindowExtEx(hdc, 400, 300, IntPtr.Zero);
			WmfApi.SetViewportExtEx(hdc, 200, 150, IntPtr.Zero);
			WmfShapeRow(hdc, 0, 1);
			WmfProbe(hdc, 10, 60, 3, Palette[4]);
		}), null, 0);
		// Placeable with the bounds' origin off zero (window origin = bounds' top left).
		WmfPlayCase("wmf-placeable-origin", 200, 140, WmfRecord(delegate (IntPtr hdc)
		{
			WmfProbe(hdc, -80, -50, 2, Palette[0]);
			WmfProbe(hdc, 20, 10, 1, Palette[3]);
		}), new int[] { -100, -60, 100, 80 }, 96);
	}

	/** A striped backdrop through which clips are visible. */
	static void WmfBackdrop(IntPtr hdc, int w, int h, int k)
	{
		for (int x = 0, i = 0; x < w; x += 6 * k, i++) { Fill(hdc, x, 0, x + 6 * k, h, Palette[i % 6]); }
	}

	static void WmfClipSheet(IntPtr hdc, int k)
	{
		Func<int, int> S = delegate (int v) { return v * k; };
		WmfApi.SaveDC(hdc);
		WmfApi.IntersectClipRect(hdc, S(10), S(10), S(110), S(70));
		WmfApi.ExcludeClipRect(hdc, S(30), S(25), S(60), S(50));
		WmfBackdrop(hdc, S(240), S(200), k);
		WmfApi.OffsetClipRgn(hdc, S(120), S(3));
		WithObjects(hdc, CreatePen(5, 0, 0), CreateHatchBrush(4, Rgb(0x20, 0x20, 0x80)), delegate { Rectangle(hdc, 0, 0, S(240), S(90)); });
		WmfApi.RestoreDC(hdc, -1);
		// A selected clip region is in device pixels: an ellipse and a polygon combined.
		IntPtr e = WmfApi.CreateEllipticRgn(10, 90, 110, 150);
		IntPtr q = WmfApi.CreatePolygonRgn(new[] { P(60, 80), P(140, 120), P(70, 160) }, 3, 1);
		WmfApi.CombineRgn(e, e, q, 3); // RGN_XOR
		WmfApi.SelectClipRgn(hdc, e);
		WithObjects(hdc, CreatePen(5, 0, 0), CreateSolidBrush(Rgb(0xE0, 0x40, 0x40)), delegate { Rectangle(hdc, 0, S(80), S(240), S(170)); });
		WmfApi.SaveDC(hdc);
		IntPtr r = WmfApi.CreateRoundRectRgn(150, 90, 230, 190, 30, 20);
		WmfApi.SelectClipRgn(hdc, r);
		WmfApi.IntersectClipRect(hdc, S(160), S(80), S(240), S(170));
		WithObjects(hdc, CreatePen(5, 0, 0), CreateSolidBrush(Rgb(0x40, 0xA0, 0x40)), delegate { Rectangle(hdc, 0, S(80), S(240), S(200)); });
		WmfApi.RestoreDC(hdc, -1);
		WithObjects(hdc, CreatePen(0, 0, 0), IntPtr.Zero, delegate { MoveToEx(hdc, 0, S(85), IntPtr.Zero); LineTo(hdc, S(240), S(195)); });
		WmfApi.SelectClipRgn(hdc, IntPtr.Zero);
		WithObjects(hdc, CreatePen(0, 0, Rgb(0x80, 0, 0x80)), IntPtr.Zero, delegate { MoveToEx(hdc, 0, S(199), IntPtr.Zero); LineTo(hdc, S(240), S(170)); });
		DeleteObject(e); DeleteObject(q); DeleteObject(r);
	}

	static void WmfClipCases()
	{
		WmfPixelCase("wmf-clip", 240, 200, delegate (IntPtr hdc) { WmfClipSheet(hdc, 1); });
		WmfPlayCase("wmf-clip-twips", 240, 200, WmfRecord(delegate (IntPtr hdc) { WmfClipSheet(hdc, 15); }), new int[] { 0, 0, 3600, 3000 }, 1440);
		WmfPlayCase("wmf-clip-scaled", 230, 192, WmfRecord(delegate (IntPtr hdc) { WmfClipSheet(hdc, 10); }), new int[] { 0, 0, 2400, 2000 }, 1000);
	}

	static void WmfRegionSheet(IntPtr hdc, int k)
	{
		Func<int, int> S = delegate (int v) { return v * k; };
		WmfBackdrop(hdc, S(260), S(200), k);
		IntPtr e = WmfApi.CreateEllipticRgn(S(10), S(10), S(90), S(70));
		IntPtr q = WmfApi.CreatePolygonRgn(new[] { P(S(100), S(10)), P(S(170), S(40)), P(S(110), S(80)) }, 3, 1);
		IntPtr rr = WmfApi.CreateRoundRectRgn(S(180), S(10), S(250), S(80), S(30), S(20));
		IntPtr u = WmfApi.CreateRectRgn(S(10), S(100), S(80), S(140));
		IntPtr u2 = WmfApi.CreateRectRgn(S(40), S(120), S(120), S(190));
		WmfApi.CombineRgn(u, u, u2, 2); // RGN_OR
		IntPtr solid = CreateSolidBrush(Rgb(0x20, 0x30, 0x90));
		IntPtr hatch = CreateHatchBrush(5, Rgb(0x90, 0x10, 0x10));
		WmfApi.FillRgn(hdc, e, solid);
		SetBkMode(hdc, 1);
		WmfApi.FillRgn(hdc, q, hatch);
		SetBkMode(hdc, 2);
		SetBkColor(hdc, Rgb(0xF0, 0xF0, 0xA0));
		WmfApi.FrameRgn(hdc, rr, hatch, S(3), S(5));
		WmfApi.FrameRgn(hdc, u, solid, S(2), S(1));
		IntPtr br = CreateSolidBrush(Rgb(0xC0, 0x90, 0x20));
		IntPtr ob = SelectObject(hdc, br);
		IntPtr p1 = WmfApi.CreateEllipticRgn(S(130), S(100), S(250), S(190));
		SetROP2(hdc, 7); // R2_XORPEN
		WmfApi.PaintRgn(hdc, p1);
		SetROP2(hdc, 13);
		IntPtr p2 = WmfApi.CreateRectRgn(S(140), S(150), S(240), S(170));
		WmfApi.PaintRgn(hdc, p2);
		IntPtr inv = WmfApi.CreateRectRgn(S(60), S(60), S(200), S(110));
		WmfApi.InvertRgn(hdc, inv);
		SelectObject(hdc, ob);
		foreach (IntPtr o in new[] { e, q, rr, u, u2, solid, hatch, br, p1, p2, inv }) { DeleteObject(o); }
	}

	static void WmfRegionCases()
	{
		WmfPixelCase("wmf-regions", 260, 200, delegate (IntPtr hdc) { WmfRegionSheet(hdc, 1); });
		WmfPlayCase("wmf-regions-twips", 260, 200, WmfRecord(delegate (IntPtr hdc) { WmfRegionSheet(hdc, 15); }), new int[] { 0, 0, 3900, 3000 }, 1440);
	}

	/** A packed DIB (BITMAPINFOHEADER, colour table, bits) of `bpp` bits. */
	static byte[] WmfPackedDib(int w, int h, int bpp, bool topDown, int[] table, Func<int, int, int> px)
	{
		int stride = ((w * bpp + 31) / 32) * 4;
		var ms = new MemoryStream();
		var bw = new BinaryWriter(ms);
		bw.Write(40); bw.Write(w); bw.Write(topDown ? -h : h); bw.Write((short)1); bw.Write((short)bpp);
		bw.Write(0); bw.Write(stride * h); bw.Write(0); bw.Write(0); bw.Write(table == null ? 0 : table.Length); bw.Write(0);
		if (table != null) { foreach (int c in table) { bw.Write((byte)((c >> 16) & 0xff)); bw.Write((byte)((c >> 8) & 0xff)); bw.Write((byte)(c & 0xff)); bw.Write((byte)0); } }
		for (int row = 0; row < h; row++)
		{
			int y = topDown ? row : h - 1 - row;
			var line = new byte[stride];
			for (int x = 0; x < w; x++)
			{
				int v = px(x, y);
				if (bpp == 32) { line[x * 4] = (byte)((v >> 16) & 0xff); line[x * 4 + 1] = (byte)((v >> 8) & 0xff); line[x * 4 + 2] = (byte)(v & 0xff); }
				else if (bpp == 24) { line[x * 3] = (byte)((v >> 16) & 0xff); line[x * 3 + 1] = (byte)((v >> 8) & 0xff); line[x * 3 + 2] = (byte)(v & 0xff); }
				else if (bpp == 8) { line[x] = (byte)v; }
				else if (bpp == 4) { line[x / 2] |= (byte)((v & 15) << (x % 2 == 0 ? 4 : 0)); }
				else if (bpp == 1) { if (v != 0) { line[x / 8] |= (byte)(0x80 >> (x % 8)); } }
			}
			bw.Write(line);
		}
		return ms.ToArray();
	}

	/** Splits a packed DIB into its header+table and its bits. */
	static void WmfSplitDib(byte[] packed, out byte[] bmi, out byte[] bits)
	{
		int bpp = BitConverter.ToInt16(packed, 14);
		int used = BitConverter.ToInt32(packed, 32);
		int n = bpp <= 8 ? (used != 0 ? used : 1 << bpp) : 0;
		int head = 40 + n * 4;
		bmi = new byte[head]; Array.Copy(packed, bmi, head);
		bits = new byte[packed.Length - head]; Array.Copy(packed, head, bits, 0, bits.Length);
	}

	static void WmfBitmapSheet(IntPtr hdc, int k)
	{
		Func<int, int> S = delegate (int v) { return v * k; };
		IntPtr screen = GetDC(IntPtr.Zero);
		WmfBackdrop(hdc, S(300), S(220), k);
		IntPtr hatch = CreateHatchBrush(5, Rgb(0x10, 0x60, 0x10));
		IntPtr ob = SelectObject(hdc, hatch);
		SetBkColor(hdc, Rgb(0xFF, 0xEE, 0xDD));
		SetTextColor(hdc, Rgb(0x11, 0x22, 0x33));
		using (var src = SourceBitmap(screen, 16, 12))
		{
			uint[] rops = { 0x00CC0020, 0x008800C6, 0x00660046, 0x00C000CA, 0x00330008, 0x00B8074A };
			// BitBlt's source extent is its destination extent in logical units, which
			// under a scaled mapping reaches past the bitmap: scaled sheets use StretchBlt.
			for (int i = 0; i < rops.Length; i++)
			{
				if (k == 1) { BitBlt(hdc, S(4 + i * 20), S(4), S(16), S(12), src.Dc, 0, 0, rops[i]); }
				else { StretchBlt(hdc, S(4 + i * 20), S(4), S(16), S(12), src.Dc, 0, 0, 16, 12, rops[i]); }
			}
			SetStretchBltMode(hdc, 3); // COLORONCOLOR
			StretchBlt(hdc, S(4), S(22), S(40), S(30), src.Dc, 2, 1, 12, 10, 0x00CC0020);
			StretchBlt(hdc, S(90), S(22), S(-40), S(30), src.Dc, 0, 0, 16, 12, 0x00CC0020);
			SetStretchBltMode(hdc, 1); // BLACKONWHITE
			StretchBlt(hdc, S(96), S(22), S(10), S(8), src.Dc, 0, 0, 16, 12, 0x00CC0020);
			SetStretchBltMode(hdc, 2); // WHITEONBLACK
			StretchBlt(hdc, S(110), S(22), S(10), S(8), src.Dc, 0, 0, 16, 12, 0x00CC0020);
		}
		PatBlt(hdc, S(130), S(4), S(40), S(20), 0x005A0049); // PATINVERT
		PatBlt(hdc, S(175), S(4), S(40), S(20), 0x00550009); // DSTINVERT
		PatBlt(hdc, S(220), S(4), S(40), S(20), 0x00F00021); // PATCOPY
		PatBlt(hdc, S(265), S(4), S(30), S(20), 0x00000042); // BLACKNESS
		// A monochrome DDB: 0 bits in the text colour, 1 bits in the background colour.
		byte[] rows = { 0xF0, 0, 0x0F, 0, 0xAA, 0, 0x55, 0, 0xFF, 0, 0x81, 0, 0x3C, 0, 0x00, 0 };
		IntPtr mono = CreateBitmap(8, 8, 1, 1, rows);
		IntPtr mdc = CreateCompatibleDC(screen);
		IntPtr om = SelectObject(mdc, mono);
		if (k == 1) { BitBlt(hdc, S(130), S(30), S(8), S(8), mdc, 0, 0, 0x00CC0020); }
		else { StretchBlt(hdc, S(130), S(30), S(8), S(8), mdc, 0, 0, 8, 8, 0x00CC0020); }
		StretchBlt(hdc, S(145), S(30), S(24), S(24), mdc, 0, 0, 8, 8, 0x00CC0020);
		if (k == 1) { BitBlt(hdc, S(175), S(30), S(8), S(8), mdc, 0, 0, 0x008800C6); }
		else { StretchBlt(hdc, S(175), S(30), S(8), S(8), mdc, 0, 0, 8, 8, 0x008800C6); }
		SelectObject(mdc, om); DeleteDC(mdc); DeleteObject(mono);
		// StretchDIBits: bottom-up 32 bpp, a sub-rectangle, and an 8 bpp DIB with its own table.
		byte[] bmi32, bits32;
		WmfSplitDib(WmfPackedDib(20, 14, 32, false, null, delegate (int x, int y) { return Palette[(x / 3 + y / 2) % 6]; }), out bmi32, out bits32);
		WmfApi.StretchDIBits(hdc, S(4), S(60), S(40), S(28), 0, 0, 20, 14, bits32, bmi32, 0, 0x00CC0020);
		WmfApi.StretchDIBits(hdc, S(50), S(60), S(30), S(30), 4, 2, 10, 8, bits32, bmi32, 0, 0x00CC0020);
		WmfApi.StretchDIBits(hdc, S(86), S(60), S(20), S(14), 0, 0, 20, 14, bits32, bmi32, 0, 0x00EE0086); // SRCPAINT
		byte[] bmi8, bits8;
		WmfSplitDib(WmfPackedDib(12, 10, 8, true, new[] { Palette[0], Palette[1], Palette[2], Palette[3], Palette[4], Palette[5] }, delegate (int x, int y) { return (x + y) % 6; }), out bmi8, out bits8);
		WmfApi.StretchDIBits(hdc, S(112), S(60), S(24), S(20), 0, 0, 12, 10, bits8, bmi8, 0, 0x00CC0020);
		byte[] bmi4, bits4;
		WmfSplitDib(WmfPackedDib(10, 10, 4, false, new[] { Palette[3], Palette[4], Palette[5], Palette[6] }, delegate (int x, int y) { return (x * y) % 4; }), out bmi4, out bits4);
		WmfApi.StretchDIBits(hdc, S(140), S(60), S(10), S(10), 0, 0, 10, 10, bits4, bmi4, 0, 0x00CC0020);
		// SetDIBitsToDevice: whole and a partial band of scan lines.
		WmfApi.SetDIBitsToDevice(hdc, S(160), S(60), 20, 14, 0, 0, 0, 14, bits32, bmi32, 0);
		byte[] band = new byte[20 * 4 * 6];
		Array.Copy(bits32, 20 * 4 * 4, band, 0, band.Length);
		WmfApi.SetDIBitsToDevice(hdc, S(190), S(60), 16, 10, 2, 2, 4, 6, band, bmi32, 0);
		byte[] bmiBand = (byte[])bmi32.Clone();
		Array.Clear(bmiBand, 20, 4); // biSizeImage 0
		WmfApi.SetDIBitsToDevice(hdc, S(210), S(60), 16, 6, 2, 4, 4, 6, band, bmiBand, 0);
		WmfApi.SetDIBitsToDevice(hdc, S(230), S(60), 16, 10, 2, 2, 4, 6, band, bmiBand, 0);
		Array.Copy(BitConverter.GetBytes(6), 0, bmiBand, 8, 4); // a 6-row DIB: every scan line present
		WmfApi.SetDIBitsToDevice(hdc, S(250), S(60), 16, 6, 2, 4, 4, 6, band, bmiBand, 0);
		WmfApi.SetDIBitsToDevice(hdc, S(270), S(60), 16, 6, 2, 0, 0, 6, band, bmiBand, 0);
		WmfApi.SetDIBitsToDevice(hdc, S(160), S(80), 16, 12, 2, 0, 0, 6, band, bmi32, 0); // first 6 of 14 rows
		SelectObject(hdc, ob);
		DeleteObject(hatch);
		ReleaseDC(IntPtr.Zero, screen);
	}

	/** Pattern brushes: monochrome and colour CreatePatternBrush, CreateDIBPatternBrushPt, hatches opaque and transparent. */
	static void WmfPatternSheet(IntPtr hdc, int k)
	{
		Func<int, int> S = delegate (int v) { return v * k; };
		IntPtr screen = GetDC(IntPtr.Zero);
		WmfBackdrop(hdc, S(240), S(120), k);
		SetBkColor(hdc, Rgb(0xFF, 0xF0, 0xC0));
		SetTextColor(hdc, Rgb(0x30, 0x10, 0x60));
		IntPtr[] brushes =
		{
			MakePatternBrush(),
			MakeColorPatternBrush(screen),
			WmfApi.CreateDIBPatternBrushPt(WmfPackedDib(6, 5, 24, false, null, delegate (int x, int y) { return Palette[(x + 2 * y) % 6]; }), 0),
			WmfApi.CreateDIBPatternBrushPt(WmfPackedDib(8, 8, 1, false, new[] { Rgb(0xC0, 0x20, 0x20), Rgb(0x20, 0xC0, 0x20) }, delegate (int x, int y) { return (x ^ y) & 2; }), 0),
			CreateHatchBrush(1, Rgb(0x80, 0x00, 0x40)),
		};
		for (int i = 0; i < brushes.Length; i++)
		{
			IntPtr b = brushes[i];
			WithObjects(hdc, CreatePen(0, 0, 0), b, delegate
			{
				int x = 4 + i * 46;
				SetBkMode(hdc, 2);
				Rectangle(hdc, S(x), S(4), S(x + 42), S(40));
				Ellipse(hdc, S(x), S(44), S(x + 42), S(80));
				SetBkMode(hdc, 1);
				Polygon(hdc, new[] { P(S(x), S(84)), P(S(x + 42), S(90)), P(S(x + 10), S(116)) }, 3);
				PatBlt(hdc, S(x + 24), S(100), S(18), S(16), 0x00F00021);
			});
		}
		ReleaseDC(IntPtr.Zero, screen);
	}

	/** A hand-assembled Bitmap16 blit record: rop, [src extents,] src y, src x, dest extents, dest origin, Bitmap16. */
	static byte[] WmfBitmap16Params(uint rop, int[] words, int w, int h, int bpp, Func<int, int, int> px)
	{
		int widthBytes = ((w * bpp + 15) / 16) * 2;
		var ms = new MemoryStream();
		var bw = new BinaryWriter(ms);
		bw.Write(rop);
		foreach (int v in words) { bw.Write((short)v); }
		bw.Write((short)0); bw.Write((short)w); bw.Write((short)h); bw.Write((short)widthBytes); bw.Write((byte)1); bw.Write((byte)bpp);
		for (int y = 0; y < h; y++)
		{
			var line = new byte[widthBytes];
			for (int x = 0; x < w; x++)
			{
				int v = px(x, y);
				if (bpp == 1) { if (v != 0) { line[x / 8] |= (byte)(0x80 >> (x % 8)); } }
				else if (bpp == 24) { line[x * 3] = (byte)((v >> 16) & 0xff); line[x * 3 + 1] = (byte)((v >> 8) & 0xff); line[x * 3 + 2] = (byte)(v & 0xff); }
			}
			bw.Write(line);
		}
		return ms.ToArray();
	}

	/** Records Win32 never writes: Bitmap16 blits and pattern brush, SetRelAbs, and escapes a player skips. */
	static byte[] WmfLegacyRecords()
	{
		var wr = new WmfWriter();
		wr.Objects = 4;
		// Backdrop: a PATCOPY band per colour.
		for (int i = 0; i < 6; i++)
		{
			wr.Rec(0x02FC, 0, Palette[i] & 0xffff, (Palette[i] >> 16) & 0xffff, 0); // CREATEBRUSHINDIRECT -> slot 0
			wr.Rec(0x012D, 0);
			wr.Rec(0x061D, 0x0021, 0x00F0, 160, 20, 0, i * 20); // PATBLT rop(lo, hi), h, w, y, x
			wr.Rec(0x01F0, 0);
		}
		wr.Rec(0x0105, 1); // SETRELABS
		wr.Rec(0x0231, 0, 0); // SETMAPPERFLAGS
		wr.RecBytes(0x0626, new byte[] { 0x10, 0x00, 0x04, 0x00, 1, 2, 3, 4 }); // ESCAPE (SETCOLORTABLE-ish, ignored)
		wr.RecBytes(0x0626, new byte[] { 0x0F, 0x00, 0x06, 0x00, (byte)'h', (byte)'i', (byte)'!', 0, 0, 0 }); // MFCOMMENT text
		wr.Rec(0x0209, 0x2211, 0x0033); // SETTEXTCOLOR
		wr.Rec(0x0201, 0xEEFF, 0x00DD); // SETBKCOLOR
		// META_BITBLT, monochrome Bitmap16 16x10.
		wr.RecBytes(0x0922, WmfBitmap16Params(0x00CC0020, new[] { 0, 0, 10, 16, 8, 6 }, 16, 10, 1, delegate (int x, int y) { return (x / 2 + y) & 1; }));
		// META_BITBLT with SRCINVERT, 24 bpp.
		wr.RecBytes(0x0922, WmfBitmap16Params(0x00660046, new[] { 0, 0, 10, 16, 8, 30 }, 16, 10, 24, delegate (int x, int y) { return Palette[(x + y) % 6]; }));
		// META_BITBLT, SRCCOPY: 24 bpp and 8 bpp Bitmap16 on the white margin.
		wr.RecBytes(0x0922, WmfBitmap16Params(0x00CC0020, new[] { 0, 0, 10, 16, 8, 124 }, 16, 10, 24, delegate (int x, int y) { return Palette[(x + y) % 6]; }));
		wr.RecBytes(0x0922, WmfBitmap16Params(0x00CC0020, new[] { 0, 0, 10, 16, 24, 124 }, 16, 10, 1, delegate (int x, int y) { return (x / 2 + y) & 1; }));
		wr.RecBytes(0x0922, WmfBitmap16Params(0x00CC0020, new[] { 0, 0, 10, 16, 40, 124 }, 16, 10, 32, delegate (int x, int y) { return Palette[(x + y) % 6]; }));
		// META_STRETCHBLT, monochrome, stretched 3x and mirrored.
		wr.RecBytes(0x0B23, WmfBitmap16Params(0x00CC0020, new[] { 10, 16, 0, 0, 30, -48, 30, 110 }, 16, 10, 1, delegate (int x, int y) { return (x + y / 3) & 1; }));
		// META_BITBLT without a bitmap: a pattern blit (rop, src y, src x, reserved, h, w, y, x).
		wr.Rec(0x02FC, 2, 0x4020, 0x00C0, 3); // hatched brush -> slot 0
		wr.Rec(0x012D, 0);
		wr.Rec(0x0922, 0x0049, 0x005A, 0, 0, 0, 20, 30, 60, 8);
		// META_CREATEPATTERNBRUSH: Bitmap16 header (14), reserved (18), 8x8 mono rows (word aligned).
		var pat = new MemoryStream();
		var pw = new BinaryWriter(pat);
		pw.Write((short)0); pw.Write((short)8); pw.Write((short)8); pw.Write((short)2); pw.Write((byte)1); pw.Write((byte)1); pw.Write(0);
		pw.Write(new byte[18]);
		foreach (byte b in new byte[] { 0x81, 0x42, 0x24, 0x18, 0x18, 0x24, 0x42, 0x81 }) { pw.Write(b); pw.Write((byte)0); }
		wr.RecBytes(0x01F9, pat.ToArray()); // -> slot 1
		wr.Rec(0x012D, 1);
		wr.Rec(0x02FA, 5, 0, 0, 0, 0); // null pen -> slot 2
		wr.Rec(0x012D, 2);
		wr.Rec(0x041B, 150, 110, 70, 60); // RECTANGLE b, r, t, l
		wr.Rec(0x0418, 150, 160, 80, 116); // ELLIPSE
		return wr.Build();
	}

	static void WmfBitmapCases()
	{
		WmfPixelCase("wmf-bitmaps", 300, 220, delegate (IntPtr hdc) { WmfBitmapSheet(hdc, 1); });
		WmfPlayCase("wmf-bitmaps-twips", 300, 220, WmfRecord(delegate (IntPtr hdc) { WmfBitmapSheet(hdc, 15); }), new int[] { 0, 0, 4500, 3300 }, 1440);
		WmfPixelCase("wmf-patterns", 240, 120, delegate (IntPtr hdc) { WmfPatternSheet(hdc, 1); });
		WmfPlayCase("wmf-legacy", 180, 160, WmfLegacyRecords(), new int[] { 0, 0, 180, 160 }, 96);
	}

	static int PalIndex(int i) { return 0x01000000 | i; }

	/** LOGPALETTE (version 0x300) or PALETTEENTRY run bytes for `colors` with `flags`. */
	static byte[] WmfPalEntries(int[] colors, byte flags, bool header)
	{
		var ms = new MemoryStream();
		var bw = new BinaryWriter(ms);
		if (header) { bw.Write((short)0x300); bw.Write((short)colors.Length); }
		foreach (int c in colors) { bw.Write((byte)(c & 0xff)); bw.Write((byte)((c >> 8) & 0xff)); bw.Write((byte)((c >> 16) & 0xff)); bw.Write(flags); }
		return ms.ToArray();
	}

	/** One swatch row: a Rectangle per brush colour reference in `refs`. */
	static void WmfSwatches(IntPtr hdc, int y, int[] refs)
	{
		for (int i = 0; i < refs.Length; i++)
		{
			WithObjects(hdc, CreatePen(0, 0, 0), CreateSolidBrush(refs[i]), delegate { Rectangle(hdc, 4 + i * 14, y, 16 + i * 14, y + 12); });
		}
	}

	static void WmfPaletteSheet(IntPtr hdc)
	{
		int[] idx = new int[22];
		for (int i = 0; i < 22; i++) { idx[i] = PalIndex(i == 21 ? 40 : i); }
		// Before any palette: the default palette's 20 entries, then out of range.
		WmfSwatches(hdc, 4, idx);
		int[] cols = { Rgb(200, 30, 30), Rgb(30, 160, 60), Rgb(40, 60, 200), Rgb(230, 200, 20), Rgb(150, 30, 170), Rgb(20, 180, 190), Rgb(250, 130, 20), Rgb(90, 90, 90) };
		IntPtr pal = WmfApi.CreatePalette(WmfPalEntries(cols, 1, true)); // PC_RESERVED entries
		WmfApi.SelectPalette(hdc, pal, false);
		WmfApi.RealizePalette(hdc);
		WmfSwatches(hdc, 20, new[] { PalIndex(0), PalIndex(1), PalIndex(2), PalIndex(3), PalIndex(4), PalIndex(5), PalIndex(6), PalIndex(7), PalIndex(8), PalIndex(12), 0x02102030, 0x02C08040 });
		// A pen and a background colour through the palette.
		IntPtr keep = CreateSolidBrush(PalIndex(2));
		IntPtr okeep = SelectObject(hdc, keep);
		SetBkMode(hdc, 2);
		SetBkColor(hdc, PalIndex(3));
		WithObjects(hdc, CreatePen(0, 3, PalIndex(4)), CreateHatchBrush(5, PalIndex(1)), delegate { Rectangle(hdc, 180, 20, 250, 60); });
		// Changing entries re-colours what is selected.
		WmfApi.SetPaletteEntries(pal, 2, 2, WmfPalEntries(new[] { Rgb(255, 0, 255), Rgb(0, 0, 0) }, 1, false));
		WithObjects(hdc, CreatePen(5, 0, 0), IntPtr.Zero, delegate { Rectangle(hdc, 4, 40, 40, 60); });
		WmfSwatches(hdc, 64, new[] { PalIndex(0), PalIndex(1), PalIndex(2), PalIndex(3) });
		WmfApi.AnimatePalette(pal, 0, 2, WmfPalEntries(new[] { Rgb(0, 255, 0), Rgb(255, 255, 0) }, 1, false));
		WmfSwatches(hdc, 80, new[] { PalIndex(0), PalIndex(1), PalIndex(2), PalIndex(3) });
		WmfApi.ResizePalette(pal, 4);
		WmfSwatches(hdc, 96, new[] { PalIndex(0), PalIndex(3), PalIndex(5), PalIndex(9) });
		WmfApi.ResizePalette(pal, 10);
		WmfSwatches(hdc, 112, new[] { PalIndex(0), PalIndex(3), PalIndex(5), PalIndex(9) });
		WmfApi.SetPixel(hdc, 120, 100, PalIndex(0));
		WmfApi.SetPixel(hdc, 122, 100, PalIndex(1));
		// An 8 bpp DIB_PAL_COLORS bitmap: its colour table is palette indices.
		var bmi = new byte[40 + 8 * 2];
		Array.Copy(WmfPackedDib(1, 1, 8, false, null, delegate (int x, int y) { return 0; }), bmi, 40);
		Array.Copy(BitConverter.GetBytes(8), 0, bmi, 32, 4);
		for (int i = 0; i < 8; i++) { Array.Copy(BitConverter.GetBytes((short)(7 - i)), 0, bmi, 40 + i * 2, 2); }
		Array.Copy(BitConverter.GetBytes(8), 0, bmi, 4, 4);
		Array.Copy(BitConverter.GetBytes(8), 0, bmi, 8, 4);
		var bits = new byte[8 * 8];
		for (int i = 0; i < bits.Length; i++) { bits[i] = (byte)((i % 8 + i / 8) % 8); }
		WmfApi.StretchDIBits(hdc, 140, 70, 32, 32, 0, 0, 8, 8, bits, bmi, 1, 0x00CC0020);
		SelectObject(hdc, okeep);
		DeleteObject(keep);
	}

	/** SetPixel, and FloodFill / ExtFloodFill against drawn borders and surfaces. */
	static void WmfPixelSheet(IntPtr hdc, int k)
	{
		Func<int, int> S = delegate (int v) { return v * k; };
		Fill(hdc, 0, 0, S(240), S(64), Rgb(255, 255, 255));
		for (int i = 0; i < 40; i++) { WmfApi.SetPixel(hdc, S(4 + (i * 7) % 60), S(4 + (i * 11) % 30), Palette[i % 6]); }
		WithObjects(hdc, CreatePen(0, S(2), Rgb(0x20, 0x20, 0x90)), CreateSolidBrush(Rgb(0xF0, 0xF0, 0xF0)), delegate
		{
			Ellipse(hdc, S(70), S(4), S(150), S(60));
			Rectangle(hdc, S(160), S(4), S(230), S(60));
		});
		WithObjects(hdc, CreatePen(0, 0, Rgb(0x90, 0x10, 0x10)), IntPtr.Zero, delegate
		{
			MoveToEx(hdc, S(160), S(30), IntPtr.Zero); LineTo(hdc, S(230), S(31));
			MoveToEx(hdc, S(190), S(4), IntPtr.Zero); LineTo(hdc, S(191), S(60));
		});
		WithObjects(hdc, IntPtr.Zero, CreateSolidBrush(Rgb(0x30, 0xC0, 0x60)), delegate { WmfApi.FloodFill(hdc, S(110), S(30), Rgb(0x20, 0x20, 0x90)); });
		WithObjects(hdc, IntPtr.Zero, CreateHatchBrush(4, Rgb(0xC0, 0x40, 0x20)), delegate { WmfApi.ExtFloodFill(hdc, S(170), S(10), Rgb(0xF0, 0xF0, 0xF0), 1); });
		WithObjects(hdc, IntPtr.Zero, CreateSolidBrush(Rgb(0x20, 0x80, 0xE0)), delegate
		{
			SetROP2(hdc, 7);
			WmfApi.ExtFloodFill(hdc, S(210), S(50), Rgb(0x90, 0x10, 0x10), 0);
			SetROP2(hdc, 13);
			WmfApi.ExtFloodFill(hdc, S(20), S(50), Rgb(0x10, 0x10, 0x10), 1); // not the surface colour: nothing
		});
	}

	/** SetTextCharacterExtra and SetTextJustification with ANSI TextOut / ExtTextOut. */
	static void WmfTextSpacingSheet(IntPtr hdc)
	{
		Fill(hdc, 0, 0, 360, 140, Rgb(255, 255, 255));
		var lf = TxLf("Arial", -16, 400, false, 3);
		TxWithFont(hdc, lf, delegate
		{
			SetBkMode(hdc, 1);
			SetTextColor(hdc, 0);
			WmfApi.TextOutA(hdc, 6, 6, "Spacing, plain.", 15);
			WmfApi.SetTextCharacterExtra(hdc, 3);
			WmfApi.TextOutA(hdc, 6, 26, "Spacing, extra 3.", 17);
			WmfApi.SetTextCharacterExtra(hdc, -1);
			WmfApi.TextOutA(hdc, 6, 46, "Spacing, extra -1.", 18);
			WmfApi.SetTextCharacterExtra(hdc, 0);
			WmfApi.SetTextJustification(hdc, 23, 3);
			WmfApi.TextOutA(hdc, 6, 66, "Justified by three breaks", 25);
			WmfApi.SetTextJustification(hdc, 0, 0);
			WmfApi.SetTextCharacterExtra(hdc, 2);
			WmfApi.SetTextJustification(hdc, 10, 2);
			WmfApi.TextOutA(hdc, 6, 86, "Both at once here", 17);
			WmfApi.SetTextJustification(hdc, 0, 0);
			SetTextAlign(hdc, 2); // TA_RIGHT
			WmfApi.TextOutA(hdc, 350, 106, "Right aligned extra", 19);
		});
	}

	/** An EMF whose WMF rendering (GetWinMetaFileBits) carries it in MFCOMMENT escapes; SetWinMetaFileBits recovers it. */
	static void WmfEmbeddedEmfCase(string name, int w, int h, GdiDraw draw)
	{
		IntPtr screen = GetDC(IntPtr.Zero);
		double mmPerPxX = GetDeviceCaps(screen, 4) * 100.0 / GetDeviceCaps(screen, 8);
		double mmPerPxY = GetDeviceCaps(screen, 6) * 100.0 / GetDeviceCaps(screen, 10);
		var frame = new RECT();
		frame.Right = (int)Math.Round(w * mmPerPxX); frame.Bottom = (int)Math.Round(h * mmPerPxY);
		IntPtr mdc = CreateEnhMetaFileW(screen, null, ref frame, null);
		draw(mdc);
		IntPtr emf = CloseEnhMetaFile(mdc);
		uint size = WmfApi.GetWinMetaFileBits(emf, 0, null, 8, screen);
		var raw = new byte[size];
		WmfApi.GetWinMetaFileBits(emf, size, raw, 8, screen);
		DeleteEnhMetaFile(emf);
		// The picture at 96 dpi: frame .01 mm -> pixels.
		File.WriteAllBytes(Path.Combine(outDir, name + ".wmf"), WmfPlaceable(raw, 0, 0, frame.Right * 96 / 2540, frame.Bottom * 96 / 2540, 96));
		var mfp = new METAFILEPICT { mm = 8, xExt = frame.Right, yExt = frame.Bottom, hMF = IntPtr.Zero };
		IntPtr back = WmfApi.SetWinMetaFileBits((uint)raw.Length, raw, screen, ref mfp);
		using (var dib = new Dib(screen, w, h))
		{
			// The recovered EMF (written below: byte for byte the embedded one)
			// played one to one on its reference device, as the EMF fixtures are:
			// the same calls painted straight onto the bitmap.
			Fill(dib.Dc, 0, 0, w, h, Rgb(255, 255, 255));
			draw(dib.Dc);
			dib.SavePng(Path.Combine(outDir, name + ".png"));
		}
		uint n = WmfApi.GetEnhMetaFileBits(back, 0, null);
		var bytes = new byte[n];
		WmfApi.GetEnhMetaFileBits(back, n, bytes);
		File.WriteAllBytes(Path.Combine(outDir, name + ".recovered.emf"), bytes);
		DeleteEnhMetaFile(back);
		ReleaseDC(IntPtr.Zero, screen);
	}

	/** Object slots: deletes in odd orders, a palette and a region holding slots, a deleted brush still selected. */
	static void WmfObjectSheet(IntPtr hdc)
	{
		IntPtr a = CreateSolidBrush(Palette[0]);
		IntPtr b = CreateSolidBrush(Palette[1]);
		IntPtr c = CreateSolidBrush(Palette[2]);
		IntPtr pal = WmfApi.CreatePalette(WmfPalEntries(new[] { Palette[3], Palette[4] }, 0, true));
		WmfApi.SelectPalette(hdc, pal, false);
		SelectObject(hdc, a); Rectangle(hdc, 4, 4, 30, 30);
		SelectObject(hdc, b); Rectangle(hdc, 34, 4, 60, 30);
		SelectObject(hdc, c);
		DeleteObject(a);
		IntPtr rgn = WmfApi.CreateRectRgn(0, 0, 200, 200);
		WmfApi.SelectClipRgn(hdc, rgn);
		DeleteObject(rgn);
		IntPtr d = CreateSolidBrush(Palette[5]);
		SelectObject(hdc, b); Rectangle(hdc, 64, 4, 90, 30);
		SelectObject(hdc, d); Rectangle(hdc, 94, 4, 120, 30);
		DeleteObject(c);
		IntPtr e = CreateSolidBrush(PalIndex(1));
		SelectObject(hdc, e); Rectangle(hdc, 124, 4, 150, 30);
		DeleteObject(e); // still selected: keeps painting
		Rectangle(hdc, 4, 34, 30, 60);
		SelectObject(hdc, GetStockObject(0));
		DeleteObject(b); DeleteObject(d);
	}

	static void WmfMiscCases()
	{
		WmfPixelCase("wmf-palette", 320, 130, delegate (IntPtr hdc) { WmfPaletteSheet(hdc); });
		WmfPixelCase("wmf-pixels", 240, 64, delegate (IntPtr hdc) { WmfPixelSheet(hdc, 1); });
		WmfPlayCase("wmf-pixels-twips", 240, 64, WmfRecord(delegate (IntPtr hdc) { WmfPixelSheet(hdc, 15); }), new int[] { 0, 0, 3600, 960 }, 1440);
		WmfPixelCase("wmf-text-spacing", 360, 130, delegate (IntPtr hdc) { WmfTextSpacingSheet(hdc); });
		WmfPixelCase("wmf-objects", 160, 64, delegate (IntPtr hdc) { WmfObjectSheet(hdc); });
		WmfEmbeddedEmfCase("wmf-embedded-emf", 240, 120, delegate (IntPtr hdc)
		{
			WithObjects(hdc, CreatePen(0, 3, Rgb(0x20, 0x20, 0x80)), CreateSolidBrush(Rgb(0xE0, 0x90, 0x30)), delegate
			{
				Ellipse(hdc, 10, 10, 110, 90);
				Rectangle(hdc, 120, 20, 230, 100);
			});
			WithObjects(hdc, CreatePen(0, 1, 0), CreateHatchBrush(5, Rgb(0x20, 0x80, 0x20)), delegate { RoundRect(hdc, 60, 40, 180, 110, 20, 20); });
		});
		// Escapes a player ignores, SetMapperFlags, SetLayout.
		WmfPixelCase("wmf-escapes", 160, 60, delegate (IntPtr hdc)
		{
			WmfApi.Escape(hdc, 15, 5, new byte[] { (byte)'n', (byte)'o', (byte)'t', (byte)'e', 0 }, IntPtr.Zero);
			WmfApi.SetMapperFlags(hdc, 1);
			WmfProbe(hdc, 4, 4, 1, Palette[1]);
			WmfApi.Escape(hdc, 4101, 0, null, IntPtr.Zero);
			WmfProbe(hdc, 80, 4, 1, Palette[2]);
		});
		WmfPixelCase("wmf-layout-rtl", 160, 60, delegate (IntPtr hdc)
		{
			WmfProbe(hdc, 4, 4, 1, Palette[1]);
			WmfApi.SetLayout(hdc, 1);
			WmfProbe(hdc, 4, 10, 1, Palette[2]);
			WithObjects(hdc, CreatePen(0, 0, 0), CreateSolidBrush(Palette[3]), delegate { Rectangle(hdc, 70, 44, 100, 56); });
			WmfApi.SetLayout(hdc, 0);
			WmfProbe(hdc, 100, 20, 1, Palette[4]);
		});
	}

	static void WmfRecordCases()
	{
		WmfMiscCases();
		WmfBitmapCases();
		WmfShapeCases();
		WmfMappingCases();
		WmfClipCases();
		WmfRegionCases();
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
		if (which == "all" || which == "gdi-raster") { RasterCases(); }
		if (which == "all" || which == "gdi-raster") { RasterWideExtraCases(); }
		if (which == "all" || which == "gdiplus-extra") { GpxLinearGradientCases(); GpxPathFillModeCases(); GpxSmoothingCases(); GpxImageCases(); GpxImageAttributeCases(); GpxNestedMetafileCases(); GpxTextureCases(); GpxPenTextCases(); }
		if (which == "all" || which == "wmf-records") { WmfRecordCases(); }
	}
}
