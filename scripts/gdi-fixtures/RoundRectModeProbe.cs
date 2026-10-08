// RoundRect per graphics mode: the same calls recorded into a metafile DC under GM_COMPATIBLE and GM_ADVANCED, drawn straight onto a bitmap in the same
// mode, and the recorded file played back (PlayEnhMetaFile) onto a bitmap. Writes `emf-roundrect-mode-<mode>-<pen>.emf`, `.png` (native playback) and
// `.direct.png` (the calls drawn straight in that mode) for pens null, cosmetic and wide, and `emf-roundrect-mode-boxes.json` with the recorded
// EMR_ROUNDRECT box of every call (the record stream holds no graphics mode record; only the right/bottom edge differs).
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
public static class RoundRectModeProbe
{
	[StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
	[StructLayout(LayoutKind.Sequential)] struct BITMAPINFOHEADER { public int biSize, biWidth, biHeight; public short biPlanes, biBitCount; public int biCompression, biSizeImage, biXPelsPerMeter, biYPelsPerMeter, biClrUsed, biClrImportant; }
	[DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateEnhMetaFileW(IntPtr hdcRef, string file, ref RECT frame, string desc);
	[DllImport("gdi32.dll")] static extern IntPtr CloseEnhMetaFile(IntPtr dc);
	[DllImport("gdi32.dll")] static extern bool DeleteEnhMetaFile(IntPtr h);
	[DllImport("gdi32.dll")] static extern bool PlayEnhMetaFile(IntPtr dc, IntPtr h, ref RECT r);
	[DllImport("gdi32.dll")] static extern int SetGraphicsMode(IntPtr dc, int mode);
	[DllImport("gdi32.dll")] static extern bool RoundRect(IntPtr dc, int l, int t, int r, int b, int w, int h);
	[DllImport("gdi32.dll")] static extern bool PatBlt(IntPtr dc, int x, int y, int w, int h, uint rop);
	[DllImport("gdi32.dll")] static extern IntPtr CreatePen(int style, int width, uint color);
	[DllImport("gdi32.dll")] static extern IntPtr CreateSolidBrush(uint color);
	[DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
	[DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
	[DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
	[DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
	[DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFOHEADER bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);
	[DllImport("gdi32.dll")] static extern bool GdiFlush();
	[DllImport("gdi32.dll")] static extern int GetDeviceCaps(IntPtr dc, int index);
	[DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hwnd);
	[DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
	const int W = 480, H = 300, Cols = 6, Rows = 4;
	static readonly string[] Pens = { "null", "cosmetic", "wide" };

	static void Draw(IntPtr dc, int mode, int pen)
	{
		PatBlt(dc, 0, 0, W, H, 0x00FF0062);
		SetGraphicsMode(dc, mode);
		IntPtr p = pen == 0 ? CreatePen(5, 0, 0) : CreatePen(0, pen == 1 ? 1 : 5, 0x202020);
		IntPtr br = CreateSolidBrush(0x60A0F0);
		IntPtr op = SelectObject(dc, p), ob = SelectObject(dc, br);
		var rnd = new Random(4242);
		for (int i = 0; i < Cols * Rows; i++)
		{
			int cx = (i % Cols) * (W / Cols) + 4, cy = (i / Cols) * (H / Rows) + 4;
			int l = cx + rnd.Next(0, 6), t = cy + rnd.Next(0, 6), r = l + rnd.Next(24, 64), b = t + rnd.Next(20, 56);
			RoundRect(dc, l, t, r, b, rnd.Next(4, 30), rnd.Next(4, 30));
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

	[StructLayout(LayoutKind.Sequential)] struct Pt { public int X, Y; }
	[StructLayout(LayoutKind.Sequential)] struct LogBrush { public uint Style, Colour; public IntPtr Hatch; }
	[StructLayout(LayoutKind.Sequential)] struct EMR { public int Type, Size; }
	delegate int EnumProc(IntPtr dc, IntPtr table, IntPtr record, int handles, IntPtr data);
	[DllImport("gdi32.dll")] static extern bool EnumEnhMetaFile(IntPtr dc, IntPtr emf, EnumProc proc, IntPtr data, ref RECT rect);
	[DllImport("gdi32.dll")] static extern bool PlayEnhMetaFileRecord(IntPtr dc, IntPtr table, IntPtr record, int handles);
	[DllImport("gdi32.dll")] static extern IntPtr ExtCreatePen(uint style, uint width, ref LogBrush brush, uint count, IntPtr dashes);
	[DllImport("gdi32.dll")] static extern bool BeginPath(IntPtr dc);
	[DllImport("gdi32.dll")] static extern bool EndPath(IntPtr dc);
	[DllImport("gdi32.dll")] static extern int GetPath(IntPtr dc, [Out] Pt[] points, [Out] byte[] types, int count);
	[DllImport("gdi32.dll")] static extern int SetArcDirection(IntPtr dc, int dir);
	[DllImport("gdi32.dll")] static extern IntPtr SaveDC(IntPtr dc);

	static IntPtr MakePen(int pen, int pw)
	{
		if (pen == 0) return CreatePen(5, 0, 0);
		if (pen == 1) return CreatePen(0, 1, 0);
		if (pen == 2) return CreatePen(0, pw, 0);
		var lb = new LogBrush();
		return ExtCreatePen((uint)(0x10000 | 0x200), (uint)pw, ref lb, 0, IntPtr.Zero);
	}
	[DllImport("gdi32.dll")] static extern bool SetViewportExtEx(IntPtr dc, int x, int y, IntPtr old);
	[DllImport("gdi32.dll")] static extern bool SetWindowExtEx(IntPtr dc, int x, int y, IntPtr old);
	[DllImport("gdi32.dll")] static extern int SetMapMode(IntPtr dc, int mode);
	static void Scale16(IntPtr dc) { SetMapMode(dc, 8); SetWindowExtEx(dc, 16, 16, IntPtr.Zero); SetViewportExtEx(dc, 16, 16, IntPtr.Zero); }
	static string PathJson(IntPtr dc, bool fix = true)
	{
		// One logical unit per pixel while drawing; a 16:1 window/viewport at GetPath time returns the points in 1/16 pixel (FIX).
		if (fix) SetViewportExtEx(dc, 1, 1, IntPtr.Zero);
		int n = GetPath(dc, null, null, 0);
		var q = new Pt[n > 0 ? n : 0]; var u = new byte[n > 0 ? n : 0];
		if (n > 0) GetPath(dc, q, u, n);
		if (fix) SetViewportExtEx(dc, 16, 16, IntPtr.Zero);
		var sb = new StringBuilder("[");
		for (int i = 0; i < n; i++) { if (i > 0) sb.Append(','); sb.Append(q[i].X).Append(',').Append(q[i].Y).Append(',').Append(u[i]); }
		return sb.Append(']').ToString();
	}

	/** GetPath of RoundRect: drawn straight on a DC in the mode, and the same call recorded in that mode then played back (the path is read when the recorded EndPath has played). */
	public static void Paths(string dir)
	{
		IntPtr screen = GetDC(IntPtr.Zero);
		double mmX = GetDeviceCaps(screen, 4) * 100.0 / GetDeviceCaps(screen, 8), mmY = GetDeviceCaps(screen, 6) * 100.0 / GetDeviceCaps(screen, 10);
		var frame = new RECT { Right = (int)Math.Round(1000 * mmX), Bottom = (int)Math.Round(1000 * mmY) };
		var rnd = new Random(7771);
		var js = new StringBuilder("[");
		IntPtr pdc = CreateCompatibleDC(screen);
		int k = 0;
		foreach (int mode in new[] { 1, 2 })
			for (int rep = 0; rep < 400; rep++)
			{
				int pen = rep % 4, dr = rnd.Next(0, 4) == 0 ? 2 : 1, pw = pen >= 2 ? rnd.Next(2, 14) : 1;
				int l = rnd.Next(0, 300), t = rnd.Next(0, 300), r = l + rnd.Next(10, 100), b = t + rnd.Next(10, 100), cw = rnd.Next(4, 40), ch = rnd.Next(4, 40);
				// direct
				SetGraphicsMode(pdc, mode); SetArcDirection(pdc, dr); Scale16(pdc);
				IntPtr hp = MakePen(pen, pw); IntPtr old = SelectObject(pdc, hp);
				BeginPath(pdc); RoundRect(pdc, l, t, r, b, cw, ch); EndPath(pdc);
				string direct = PathJson(pdc), directPx = PathJson(pdc, false);
				SelectObject(pdc, old); DeleteObject(hp);
				// recorded
				IntPtr mdc = CreateEnhMetaFileW(screen, null, ref frame, null);
				SetGraphicsMode(mdc, mode); SetArcDirection(mdc, dr); Scale16(mdc);
				hp = MakePen(pen, pw); old = SelectObject(mdc, hp);
				BeginPath(mdc); RoundRect(mdc, l, t, r, b, cw, ch); EndPath(mdc);
				SelectObject(mdc, old);
				IntPtr emf = CloseEnhMetaFile(mdc);
				SetGraphicsMode(pdc, 1); SetArcDirection(pdc, 1); Scale16(pdc);
				string played = "[]"; string recBox = "[]";
				var rect = new RECT { Right = 1000, Bottom = 1000 };
				EnumProc proc = delegate (IntPtr dc, IntPtr table, IntPtr record, int handles, IntPtr data)
				{
					int type = Marshal.ReadInt32(record);
					if (type == 44) recBox = "[" + Marshal.ReadInt32(record, 8) + "," + Marshal.ReadInt32(record, 12) + "," + Marshal.ReadInt32(record, 16) + "," + Marshal.ReadInt32(record, 20) + "]";
					PlayEnhMetaFileRecord(dc, table, record, handles);
					if (type == 60) played = PathJson(dc, false);
					return 1;
				};
				EnumEnhMetaFile(pdc, emf, proc, IntPtr.Zero, ref rect);
				DeleteEnhMetaFile(emf); DeleteObject(hp);
				if (k++ > 0) js.Append(',');
				js.Append("{\"mode\":" + mode + ",\"pen\":" + pen + ",\"dir\":" + dr + ",\"pw\":" + pw + ",\"box\":[" + l + "," + t + "," + r + "," + b + "],\"corner\":[" + cw + "," + ch + "],\"rec\":" + recBox + ",\"direct\":" + direct + ",\"directPx\":" + directPx + ",\"played\":" + played + "}");
			}
		var bytes = Encoding.UTF8.GetBytes(js.Append("]").ToString());
		using (var file = File.Create(Path.Combine(dir, "emf-roundrect-mode-paths.json.gz"))) using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(bytes, 0, bytes.Length);
		DeleteDC(pdc);
		ReleaseDC(IntPtr.Zero, screen);
	}

	[DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetEnhMetaFile(string file);

	/** Native PlayEnhMetaFile of an existing fixture's metafile onto a surface of its reference PNG's size, written as `<name>.playback.png`. */
	public static void PlayExisting(string dir, string name)
	{
		int w, h;
		using (var reference = new Bitmap(Path.Combine(dir, name + ".png"))) { w = reference.Width; h = reference.Height; }
		IntPtr screen = GetDC(IntPtr.Zero);
		var bmi = new BITMAPINFOHEADER { biSize = 40, biWidth = w, biHeight = -h, biPlanes = 1, biBitCount = 32 };
		IntPtr bits;
		IntPtr dc = CreateCompatibleDC(screen);
		IntPtr bmp = CreateDIBSection(screen, ref bmi, 0, out bits, IntPtr.Zero, 0);
		SelectObject(dc, bmp);
		PatBlt(dc, 0, 0, w, h, 0x00FF0062);
		IntPtr emf = GetEnhMetaFile(Path.Combine(dir, name + ".emf"));
		var rect = new RECT { Right = w, Bottom = h };
		PlayEnhMetaFile(dc, emf, ref rect);
		GdiFlush();
		var buf = new byte[w * h * 4];
		Marshal.Copy(bits, buf, 0, buf.Length);
		for (int i = 3; i < buf.Length; i += 4) buf[i] = 255;
		using (var output = new Bitmap(w, h, PixelFormat.Format32bppArgb))
		{
			var data = output.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
			Marshal.Copy(buf, 0, data.Scan0, buf.Length);
			output.UnlockBits(data);
			output.Save(Path.Combine(dir, name + ".playback.png"), ImageFormat.Png);
		}
		DeleteEnhMetaFile(emf); DeleteDC(dc); DeleteObject(bmp); ReleaseDC(IntPtr.Zero, screen);
	}

	public static void Run(string dir)
	{
		IntPtr screen = GetDC(IntPtr.Zero);
		double mmX = GetDeviceCaps(screen, 4) * 100.0 / GetDeviceCaps(screen, 8), mmY = GetDeviceCaps(screen, 6) * 100.0 / GetDeviceCaps(screen, 10);
		var frame = new RECT { Right = (int)Math.Round(W * mmX), Bottom = (int)Math.Round(H * mmY) };
		var json = new StringBuilder("[");
		foreach (int mode in new[] { 1, 2 })
			for (int pen = 0; pen < 3; pen++)
			{
				string name = "emf-roundrect-mode-" + (mode == 1 ? "compat" : "adv") + "-" + Pens[pen];
				IntPtr mdc = CreateEnhMetaFileW(screen, Path.Combine(dir, name + ".emf"), ref frame, null);
				Draw(mdc, mode, pen);
				IntPtr emf = CloseEnhMetaFile(mdc);
				IntPtr dc, bmp;
				IntPtr bits = Surface(screen, out dc, out bmp);
				PatBlt(dc, 0, 0, W, H, 0x00FF0062);
				var rect = new RECT { Right = W, Bottom = H };
				PlayEnhMetaFile(dc, emf, ref rect);
				Save(bits, Path.Combine(dir, name + ".png"));
				DeleteEnhMetaFile(emf); DeleteDC(dc); DeleteObject(bmp);
				bits = Surface(screen, out dc, out bmp);
				Draw(dc, mode, pen);
				Save(bits, Path.Combine(dir, name + ".direct.png"));
				DeleteDC(dc); DeleteObject(bmp);
				// Recorded boxes.
				byte[] d = File.ReadAllBytes(Path.Combine(dir, name + ".emf"));
				if (json.Length > 1) json.Append(',');
				json.Append("{\"mode\":" + mode + ",\"pen\":" + pen + ",\"records\":[");
				int o = 0; bool first = true; var types = new StringBuilder();
				while (o < d.Length)
				{
					int t = BitConverter.ToInt32(d, o), s = BitConverter.ToInt32(d, o + 4);
					if (t == 44)
					{
						if (!first) json.Append(',');
						first = false;
						json.Append("[" + BitConverter.ToInt32(d, o + 8) + "," + BitConverter.ToInt32(d, o + 12) + "," + BitConverter.ToInt32(d, o + 16) + "," + BitConverter.ToInt32(d, o + 20) + "," + BitConverter.ToInt32(d, o + 24) + "," + BitConverter.ToInt32(d, o + 28) + "]");
					}
					else types.Append(t).Append(' ');
					o += s;
				}
				json.Append("],\"otherRecordTypes\":\"" + types.ToString().Trim() + "\"}");
			}
		File.WriteAllText(Path.Combine(dir, "emf-roundrect-mode-boxes.json"), json.Append("]").ToString());
		ReleaseDC(IntPtr.Zero, screen);
	}
}
