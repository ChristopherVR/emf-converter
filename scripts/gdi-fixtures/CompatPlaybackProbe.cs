// GM_COMPATIBLE drawing recorded into a metafile and played back natively. The compat-only rules of the converter (whole-device-pixel points
// of a compatible map mode, arcs, null-pen ellipses) were fitted to calls drawn straight onto a device; this records the same calls under
// map modes with a non-unit logical-to-device ratio, plays the metafile back (PlayEnhMetaFile) and writes `compat-playback-<map>-<pen>.emf`
// with `.png` (native playback) and `.direct.png` (the same calls drawn straight in that mode).
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
public static class CompatPlaybackProbe
{
	[StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
	[StructLayout(LayoutKind.Sequential)] struct BITMAPINFOHEADER { public int biSize, biWidth, biHeight; public short biPlanes, biBitCount; public int biCompression, biSizeImage, biXPelsPerMeter, biYPelsPerMeter, biClrUsed, biClrImportant; }
	[StructLayout(LayoutKind.Sequential)] struct LogBrush { public uint Style, Colour; public IntPtr Hatch; }
	[DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateEnhMetaFileW(IntPtr hdcRef, string file, ref RECT frame, string desc);
	[DllImport("gdi32.dll")] static extern IntPtr CloseEnhMetaFile(IntPtr dc);
	[DllImport("gdi32.dll")] static extern bool DeleteEnhMetaFile(IntPtr h);
	[DllImport("gdi32.dll")] static extern bool PlayEnhMetaFile(IntPtr dc, IntPtr h, ref RECT r);
	[DllImport("gdi32.dll")] static extern bool Rectangle(IntPtr dc, int l, int t, int r, int b);
	[DllImport("gdi32.dll")] static extern bool RoundRect(IntPtr dc, int l, int t, int r, int b, int w, int h);
	[DllImport("gdi32.dll")] static extern bool Ellipse(IntPtr dc, int l, int t, int r, int b);
	[DllImport("gdi32.dll")] static extern bool Arc(IntPtr dc, int l, int t, int r, int b, int x1, int y1, int x2, int y2);
	[DllImport("gdi32.dll")] static extern bool Chord(IntPtr dc, int l, int t, int r, int b, int x1, int y1, int x2, int y2);
	[DllImport("gdi32.dll")] static extern bool Pie(IntPtr dc, int l, int t, int r, int b, int x1, int y1, int x2, int y2);
	[DllImport("gdi32.dll")] static extern bool MoveToEx(IntPtr dc, int x, int y, IntPtr old);
	[DllImport("gdi32.dll")] static extern bool LineTo(IntPtr dc, int x, int y);
	[DllImport("gdi32.dll")] static extern bool Polygon(IntPtr dc, int[] pts, int n);
	[DllImport("gdi32.dll")] static extern bool PatBlt(IntPtr dc, int x, int y, int w, int h, uint rop);
	[DllImport("gdi32.dll")] static extern IntPtr CreatePen(int style, int width, uint color);
	[DllImport("gdi32.dll")] static extern IntPtr ExtCreatePen(uint style, uint width, ref LogBrush brush, uint count, uint[] dashes);
	[DllImport("gdi32.dll")] static extern IntPtr CreateSolidBrush(uint color);
	[DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
	[DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
	[DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
	[DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
	[DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFOHEADER bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);
	[DllImport("gdi32.dll")] static extern bool GdiFlush();
	[DllImport("gdi32.dll")] static extern int GetDeviceCaps(IntPtr dc, int index);
	[DllImport("gdi32.dll")] static extern int SetMapMode(IntPtr dc, int mode);
	[DllImport("gdi32.dll")] static extern bool SetWindowExtEx(IntPtr dc, int x, int y, IntPtr old);
	[DllImport("gdi32.dll")] static extern bool SetViewportExtEx(IntPtr dc, int x, int y, IntPtr old);
	[DllImport("gdi32.dll")] static extern int SetArcDirection(IntPtr dc, int dir);
	[DllImport("gdi32.dll")] static extern int SetBkMode(IntPtr dc, int mode);
	[DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hwnd);
	[DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
	const int W = 420, H = 300;
	// {window x, window y, viewport x, viewport y}: logical units per device pixel is window / viewport.
	static readonly string[] MapNames = { "id", "r43", "r107", "r34", "r21", "r32x11" };
	static readonly int[][] Maps = { new[] { 1, 1, 1, 1 }, new[] { 4, 4, 3, 3 }, new[] { 10, 10, 7, 7 }, new[] { 3, 3, 4, 4 }, new[] { 2, 2, 1, 1 }, new[] { 3, 1, 2, 1 } };
	static readonly string[] PenNames = { "null", "cosmetic", "wide3", "wide7", "geo5", "geosq9", "dash" };

	static IntPtr MakePen(int pen)
	{
		var lb = new LogBrush { Style = 0, Colour = 0x202020 };
		switch (pen)
		{
			case 0: return CreatePen(5, 0, 0);
			case 1: return CreatePen(0, 0, 0x202020);
			case 2: return CreatePen(0, 3, 0x202020);
			case 3: return CreatePen(0, 7, 0x202020);
			case 4: return ExtCreatePen(0x10000, 5, ref lb, 0, null);
			case 5: return ExtCreatePen(0x10000 | 0x100, 9, ref lb, 0, null);
			default: return CreatePen(2, 1, 0x202020);
		}
	}

	static void Draw(IntPtr dc, int map, int pen)
	{
		PatBlt(dc, 0, 0, W, H, 0x00FF0062);
		var m = Maps[map];
		SetMapMode(dc, 8);
		SetWindowExtEx(dc, m[0], m[1], IntPtr.Zero);
		SetViewportExtEx(dc, m[2], m[3], IntPtr.Zero);
		SetBkMode(dc, 1);
		IntPtr p = MakePen(pen), br = CreateSolidBrush(0x60A0F0);
		IntPtr op = SelectObject(dc, p), ob = SelectObject(dc, br);
		var rnd = new Random(900 + map * 10 + pen);
		const int cols = 6, rows = 6;
		for (int i = 0; i < cols * rows; i++)
		{
			double kx = (double)m[0] / m[2], ky = (double)m[1] / m[3];
			int cx = (i % cols) * (W / cols) + 2, cy = (i / cols) * (H / rows) + 2;
			int l = (int)Math.Round((cx + rnd.Next(0, 5)) * kx), t = (int)Math.Round((cy + rnd.Next(0, 5)) * ky);
			int r = l + (int)Math.Round(rnd.Next(18, 56) * kx), b = t + (int)Math.Round(rnd.Next(14, 40) * ky);
			int w = r - l, h = b - t;
			int x1 = l + rnd.Next(0, w + 1), y1 = t, x2 = l, y2 = t + rnd.Next(0, h + 1);
			if (rnd.Next(2) == 0) { x1 = r; y1 = t + rnd.Next(0, h + 1); x2 = l + rnd.Next(0, w + 1); y2 = b; }
			switch (i % 9)
			{
				case 0: Ellipse(dc, l, t, r, b); break;
				case 1: Arc(dc, l, t, r, b, x1, y1, x2, y2); break;
				case 2: Chord(dc, l, t, r, b, x1, y1, x2, y2); break;
				case 3: Pie(dc, l, t, r, b, x1, y1, x2, y2); break;
				case 4: Rectangle(dc, l, t, r, b); break;
				case 5: RoundRect(dc, l, t, r, b, w / 3, h / 3); break;
				case 6: Polygon(dc, new[] { l, b, l + w / 2, t, r, b - h / 3, l + w / 3, t + h / 2 }, 4); break;
				case 7: MoveToEx(dc, l, t, IntPtr.Zero); LineTo(dc, r, b); LineTo(dc, r, t); LineTo(dc, l + w / 2, b); break;
				default: SetArcDirection(dc, 2); Chord(dc, l, t, r, b, x1, y1, x2, y2); SetArcDirection(dc, 1); break;
			}
		}
		SelectObject(dc, op); SelectObject(dc, ob); DeleteObject(p); DeleteObject(br);
	}

	static void Save(IntPtr bits, string path)
	{
		GdiFlush();
		var bmp = new Bitmap(W, H, PixelFormat.Format32bppArgb);
		var data = bmp.LockBits(new Rectangle(0, 0, W, H), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
		var buf = new byte[W * H * 4];
		Marshal.Copy(bits, buf, 0, buf.Length);
		for (int i = 3; i < buf.Length; i += 4) buf[i] = 255;
		Marshal.Copy(buf, 0, data.Scan0, buf.Length);
		bmp.UnlockBits(data);
		bmp.Save(path, ImageFormat.Png);
		bmp.Dispose();
	}

	static IntPtr Surface(IntPtr screen, out IntPtr dc, out IntPtr bmp)
	{
		var bmi = new BITMAPINFOHEADER { biSize = 40, biWidth = W, biHeight = -H, biPlanes = 1, biBitCount = 32 };
		IntPtr bits;
		dc = CreateCompatibleDC(screen);
		bmp = CreateDIBSection(screen, ref bmi, 0, out bits, IntPtr.Zero, 0);
		SelectObject(dc, bmp);
		return bits;
	}

	[DllImport("gdi32.dll")] static extern IntPtr GetStockObject(int i);
	[DllImport("gdi32.dll")] static extern bool SetWindowOrgEx(IntPtr dc, int x, int y, IntPtr old);
	[DllImport("gdi32.dll")] static extern bool SetViewportOrgEx(IntPtr dc, int x, int y, IntPtr old);

	// Rectangle sweep: {window x, window y, viewport x, viewport y, window org x, y, viewport org x, y}.
	static readonly string[] SweepNames = { "r43", "r107", "r34", "r73", "r54", "r12", "r43o", "r12o", "w43", "w34" };
	static readonly int[][] Sweeps = {
		new[] { 4, 4, 3, 3, 0, 0, 0, 0 }, new[] { 10, 10, 7, 7, 0, 0, 0, 0 }, new[] { 3, 3, 4, 4, 0, 0, 0, 0 }, new[] { 7, 7, 3, 3, 0, 0, 0, 0 },
		new[] { 5, 5, 4, 4, 0, 0, 0, 0 }, new[] { 1, 1, 2, 2, 0, 0, 0, 0 }, new[] { 4, 4, 3, 3, 13, -7, 5, 3 }, new[] { 1, 1, 2, 2, 3, 5, 1, 1 }, new[] { 4, 4, 3, 3, 0, 0, 0, 0, 1 }, new[] { 3, 3, 4, 4, 0, 0, 0, 0, 1 } };
	[StructLayout(LayoutKind.Sequential)] struct Xform { public float M11, M12, M21, M22, Dx, Dy; }
	[DllImport("gdi32.dll")] static extern bool SetWorldTransform(IntPtr dc, ref Xform x);
	[DllImport("gdi32.dll")] static extern int SetGraphicsMode(IntPtr dc, int mode);
	static readonly string[] SweepPens = { "cosmetic", "null", "dot" };

	static void DrawSweep(IntPtr dc, int[] m, int pen, int shape = 0)
	{
		PatBlt(dc, 0, 0, W, H, 0x00FF0062);
		if (m.Length > 8)
		{
			SetGraphicsMode(dc, 2);
			var xf = new Xform { M11 = (float)m[2] / m[0], M22 = (float)m[3] / m[1] };
			SetWorldTransform(dc, ref xf);
		}
		else
		{
			SetMapMode(dc, 8);
			SetWindowExtEx(dc, m[0], m[1], IntPtr.Zero); SetViewportExtEx(dc, m[2], m[3], IntPtr.Zero);
			SetWindowOrgEx(dc, m[4], m[5], IntPtr.Zero); SetViewportOrgEx(dc, m[6], m[7], IntPtr.Zero);
		}
		IntPtr p = pen == 0 ? CreatePen(0, 0, 0x202020) : pen == 1 ? CreatePen(5, 0, 0) : CreatePen(2, 1, 0x202020);
		IntPtr br = pen == 1 ? CreateSolidBrush(0x60A0F0) : GetStockObject(5);
		IntPtr op = SelectObject(dc, p), ob = SelectObject(dc, br);
		int pw = m[0], ph = m[1];
		double kx = (double)m[0] / m[2], ky = (double)m[1] / m[3];
		for (int i = 0; i < 21 * 15; i++)
		{
			int cx = (i % 21) * 20 + 2, cy = (i / 21) * 20 + 2;
			int l = (int)Math.Round((cx - m[6]) * kx) + m[4] + (i % pw), t = (int)Math.Round((cy - m[7]) * ky) + m[5] + ((i / pw) % ph);
			int r = l + (int)Math.Round(9 * kx) + (i % 3), b = t + (int)Math.Round(8 * ky) + (i / 3 % 3);
			if (shape == 0) Rectangle(dc, l, t, r, b); else Ellipse(dc, l, t, r, b);
		}
		SelectObject(dc, op); SelectObject(dc, ob); DeleteObject(p); if (pen == 1) DeleteObject(br);
	}

	public static void RectSweep(string dir)
	{
		IntPtr screen = GetDC(IntPtr.Zero);
		double mmX = GetDeviceCaps(screen, 4) * 100.0 / GetDeviceCaps(screen, 8), mmY = GetDeviceCaps(screen, 6) * 100.0 / GetDeviceCaps(screen, 10);
		var frame = new RECT { Right = (int)Math.Round(W * mmX), Bottom = (int)Math.Round(H * mmY) };
		for (int shape = 0; shape < 2; shape++)
		for (int s = 0; s < Sweeps.Length; s++)
			for (int pen = 0; pen < SweepPens.Length; pen++)
			{
				string name = (shape == 0 ? "compat-rects-" : "compat-ellipses-") + SweepNames[s] + "-" + SweepPens[pen];
				IntPtr mdc = CreateEnhMetaFileW(screen, Path.Combine(dir, name + ".emf"), ref frame, null);
				DrawSweep(mdc, Sweeps[s], pen, shape);
				IntPtr emf = CloseEnhMetaFile(mdc);
				IntPtr dc, bmp;
				IntPtr bits = Surface(screen, out dc, out bmp);
				PatBlt(dc, 0, 0, W, H, 0x00FF0062);
				var rect = new RECT { Right = W, Bottom = H };
				PlayEnhMetaFile(dc, emf, ref rect);
				Save(bits, Path.Combine(dir, name + ".png"));
				DeleteEnhMetaFile(emf); DeleteDC(dc); DeleteObject(bmp);
			}
		ReleaseDC(IntPtr.Zero, screen);
	}

	public static void Run(string dir)
	{
		IntPtr screen = GetDC(IntPtr.Zero);
		double mmX = GetDeviceCaps(screen, 4) * 100.0 / GetDeviceCaps(screen, 8), mmY = GetDeviceCaps(screen, 6) * 100.0 / GetDeviceCaps(screen, 10);
		var frame = new RECT { Right = (int)Math.Round(W * mmX), Bottom = (int)Math.Round(H * mmY) };
		for (int map = 0; map < Maps.Length; map++)
			for (int pen = 0; pen < PenNames.Length; pen++)
			{
				string name = "compat-playback-" + MapNames[map] + "-" + PenNames[pen];
				IntPtr mdc = CreateEnhMetaFileW(screen, Path.Combine(dir, name + ".emf"), ref frame, null);
				Draw(mdc, map, pen);
				IntPtr emf = CloseEnhMetaFile(mdc);
				IntPtr dc, bmp;
				IntPtr bits = Surface(screen, out dc, out bmp);
				PatBlt(dc, 0, 0, W, H, 0x00FF0062);
				var rect = new RECT { Right = W, Bottom = H };
				PlayEnhMetaFile(dc, emf, ref rect);
				Save(bits, Path.Combine(dir, name + ".png"));
				DeleteEnhMetaFile(emf); DeleteDC(dc); DeleteObject(bmp);
				bits = Surface(screen, out dc, out bmp);
				Draw(dc, map, pen);
				Save(bits, Path.Combine(dir, name + ".direct.png"));
				DeleteDC(dc); DeleteObject(bmp);
			}
		ReleaseDC(IntPtr.Zero, screen);
	}
}
