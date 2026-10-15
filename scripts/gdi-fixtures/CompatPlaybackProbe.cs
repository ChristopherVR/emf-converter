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

	/** `mirror`: bit 0 flips x, bit 1 flips y (a negative viewport extent with the viewport origin at the far edge). */
	static void Draw(IntPtr dc, int map, int pen, int mirror = 0)
	{
		PatBlt(dc, 0, 0, W, H, 0x00FF0062);
		var m = Maps[map];
		int sx = (mirror & 1) != 0 ? -1 : 1, sy = (mirror & 2) != 0 ? -1 : 1;
		SetMapMode(dc, 8);
		SetWindowExtEx(dc, m[0], m[1], IntPtr.Zero);
		SetViewportExtEx(dc, sx * m[2], sy * m[3], IntPtr.Zero);
		if (mirror != 0) SetViewportOrgEx(dc, sx < 0 ? W : 0, sy < 0 ? H : 0, IntPtr.Zero);
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

	static void DrawSweep(IntPtr dc, int[] m, int pen, int shape = 0, int mirror = 0)
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
			int sx = (mirror & 1) != 0 ? -1 : 1, sy = (mirror & 2) != 0 ? -1 : 1;
			SetWindowExtEx(dc, m[0], m[1], IntPtr.Zero); SetViewportExtEx(dc, sx * m[2], sy * m[3], IntPtr.Zero);
			SetWindowOrgEx(dc, m[4], m[5], IntPtr.Zero); SetViewportOrgEx(dc, (sx < 0 ? W : 0) + m[6], (sy < 0 ? H : 0) + m[7], IntPtr.Zero);
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

	[DllImport("gdi32.dll")] static extern bool BeginPath(IntPtr dc);
	[DllImport("gdi32.dll")] static extern bool EndPath(IntPtr dc);
	[DllImport("gdi32.dll")] static extern int GetPath(IntPtr dc, [Out] Point[] pts, [Out] byte[] types, int n);
	[DllImport("gdi32.dll")] static extern bool AbortPath(IntPtr dc);
	[DllImport("gdi32.dll")] static extern int SaveDC(IntPtr dc);
	[DllImport("gdi32.dll")] static extern bool RestoreDC(IntPtr dc, int n);
	delegate int EnhMetaFileProc(IntPtr hdc, IntPtr handleTable, IntPtr record, int nObjects, IntPtr data);
	[DllImport("gdi32.dll")] static extern bool EnumEnhMetaFile(IntPtr dc, IntPtr emf, EnhMetaFileProc proc, IntPtr data, ref RECT rect);
	[DllImport("gdi32.dll")] static extern bool PlayEnhMetaFileRecord(IntPtr dc, IntPtr table, IntPtr record, int n);

	[DllImport("gdi32.dll")] static extern bool ModifyWorldTransform(IntPtr dc, IntPtr xform, int mode);
	static string PathJson(IntPtr dc, bool resetWorld = false)
	{
		if (resetWorld) { SetGraphicsMode(dc, 2); ModifyWorldTransform(dc, IntPtr.Zero, 1); }
		SetMapMode(dc, 8); SetWindowExtEx(dc, 16, 16, IntPtr.Zero); SetViewportExtEx(dc, 1, 1, IntPtr.Zero);
		SetWindowOrgEx(dc, 0, 0, IntPtr.Zero); SetViewportOrgEx(dc, 0, 0, IntPtr.Zero);
		int n = GetPath(dc, null, null, 0);
		if (n < 0) return "null";
		var q = new Point[n]; var u = new byte[n];
		if (n > 0) GetPath(dc, q, u, n);
		var js = new System.Text.StringBuilder("[");
		for (int i = 0; i < n; i++) { if (i > 0) js.Append(','); js.Append(q[i].X).Append(',').Append(q[i].Y).Append(',').Append(u[i]); }
		return js.Append(']').ToString();
	}

	/** Native GetPath of the Arc, Chord and Pie records of `compat-playback` played back (`PlayEnhMetaFile` between BeginPath and EndPath of the target DC) and, for comparison, the same call drawn straight in the same map (`compat-playback-paths.json.gz`). Each entry: map, kind, dir, the call's eight arguments, `played` and `direct` as `[x, y, type]` FIX triples. */
	public static void PathPlayback(string dir)
	{
		IntPtr screen = GetDC(IntPtr.Zero);
		double mmX = GetDeviceCaps(screen, 4) * 100.0 / GetDeviceCaps(screen, 8), mmY = GetDeviceCaps(screen, 6) * 100.0 / GetDeviceCaps(screen, 10);
		var frame = new RECT { Right = (int)Math.Round(W * mmX), Bottom = (int)Math.Round(H * mmY) };
		var js = new System.Text.StringBuilder("[");
		int count = 0;
		for (int map = 0; map < Maps.Length; map++)
		{
			var m = Maps[map];
			var rnd = new Random(31000 + map);
			for (int k = 0; k < 600; k++)
			{
				double kx = (double)m[0] / m[2], ky = (double)m[1] / m[3];
				int cx = rnd.Next(0, 6) * (W / 6) + 2, cy = rnd.Next(0, 6) * (H / 6) + 2;
				int l = (int)Math.Round((cx + rnd.Next(0, 5)) * kx), t = (int)Math.Round((cy + rnd.Next(0, 5)) * ky);
				int r = l + (int)Math.Round(rnd.Next(18, 56) * kx), b = t + (int)Math.Round(rnd.Next(14, 40) * ky);
				int w = r - l, h = b - t;
				int x1 = l + rnd.Next(0, w + 1), y1 = t, x2 = l, y2 = t + rnd.Next(0, h + 1);
				if (rnd.Next(2) == 0) { x1 = r; y1 = t + rnd.Next(0, h + 1); x2 = l + rnd.Next(0, w + 1); y2 = b; }
				int kind = k % 3, dirn = (k / 3) % 4 == 3 ? 2 : 1;
				IntPtr mdc = CreateEnhMetaFileW(screen, null, ref frame, null);
				SetMapMode(mdc, 8); SetWindowExtEx(mdc, m[0], m[1], IntPtr.Zero); SetViewportExtEx(mdc, m[2], m[3], IntPtr.Zero);
				SetArcDirection(mdc, dirn);
				if (kind == 0) Arc(mdc, l, t, r, b, x1, y1, x2, y2); else if (kind == 1) Chord(mdc, l, t, r, b, x1, y1, x2, y2); else Pie(mdc, l, t, r, b, x1, y1, x2, y2);
				IntPtr emf = CloseEnhMetaFile(mdc);
				IntPtr dc, bmp;
				Surface(screen, out dc, out bmp);
				var rect = new RECT { Right = W, Bottom = H };
				string played = "[]", recJson = "[]";
				// PlayEnhMetaFile adds nothing to a path bracket of the target DC; the arc record is played alone inside one instead.
				EnumEnhMetaFile(dc, emf, delegate(IntPtr hdc, IntPtr table, IntPtr rec, int n, IntPtr data)
				{
					int type = Marshal.ReadInt32(rec);
					if (type >= 45 && type <= 47)
					{
						SaveDC(hdc);
						BeginPath(hdc);
						PlayEnhMetaFileRecord(hdc, table, rec, n);
						EndPath(hdc);
						played = PathJson(hdc, true);
						recJson = "[" + Marshal.ReadInt32(rec, 8) + "," + Marshal.ReadInt32(rec, 12) + "," + Marshal.ReadInt32(rec, 16) + "," + Marshal.ReadInt32(rec, 20) + "," + Marshal.ReadInt32(rec, 24) + "," + Marshal.ReadInt32(rec, 28) + "," + Marshal.ReadInt32(rec, 32) + "," + Marshal.ReadInt32(rec, 36) + "]";
						RestoreDC(hdc, -1);
					}
					else PlayEnhMetaFileRecord(hdc, table, rec, n);
					return 1;
				}, IntPtr.Zero, ref rect);
				DeleteEnhMetaFile(emf); DeleteDC(dc); DeleteObject(bmp);
				Surface(screen, out dc, out bmp);
				SetMapMode(dc, 8); SetWindowExtEx(dc, m[0], m[1], IntPtr.Zero); SetViewportExtEx(dc, m[2], m[3], IntPtr.Zero);
				SetArcDirection(dc, dirn);
				BeginPath(dc);
				if (kind == 0) Arc(dc, l, t, r, b, x1, y1, x2, y2); else if (kind == 1) Chord(dc, l, t, r, b, x1, y1, x2, y2); else Pie(dc, l, t, r, b, x1, y1, x2, y2);
				EndPath(dc);
				string direct = PathJson(dc);
				DeleteDC(dc); DeleteObject(bmp);
				if (count++ > 0) js.Append(',');
				js.Append("{\"map\":").Append(map).Append(",\"kind\":").Append(kind).Append(",\"dir\":").Append(dirn).Append(",\"args\":[").Append(l).Append(',').Append(t).Append(',').Append(r).Append(',').Append(b).Append(',').Append(x1).Append(',').Append(y1).Append(',').Append(x2).Append(',').Append(y2).Append("],\"rec\":").Append(recJson).Append(",\"played\":").Append(played).Append(",\"direct\":").Append(direct).Append('}');
			}
		}
		ReleaseDC(IntPtr.Zero, screen);
		var bytes = System.Text.Encoding.UTF8.GetBytes(js.Append(']').ToString());
		using (var file = File.Create(Path.Combine(dir, "compat-playback-paths.json.gz")))
		using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(bytes, 0, bytes.Length);
	}

	/** Native GetPath of every shape kind played back under the six `compat-playback` maps and their x, y and x-and-y mirrored forms (a negative viewport extent with the viewport origin at the far edge), under a null, a cosmetic, a plain 3 and an inside-frame 3 unit pen (`compat-playback-shapes.json.gz`). Each entry: map (0 to 23: base map + 6 * mirror), kind (Arc, Chord, Pie, Ellipse, RoundRect, Rectangle), pen, dir, the call, the record Windows wrote and the played path as `[x, y, type]` FIX triples. */
	public static void PathPlaybackShapes(string dir)
	{
		IntPtr screen = GetDC(IntPtr.Zero);
		double mmX = GetDeviceCaps(screen, 4) * 100.0 / GetDeviceCaps(screen, 8), mmY = GetDeviceCaps(screen, 6) * 100.0 / GetDeviceCaps(screen, 10);
		var frame = new RECT { Right = (int)Math.Round(W * mmX), Bottom = (int)Math.Round(H * mmY) };
		var js = new System.Text.StringBuilder("[");
		int count = 0;
		for (int map = 0; map < 24; map++)
		{
			var m = Maps[map % 6];
			int mirror = map / 6;
			int sx = (mirror & 1) != 0 ? -1 : 1, sy = (mirror & 2) != 0 ? -1 : 1;
			var rnd = new Random(52000 + map);
			for (int kind = 0; kind < 6; kind++)
				for (int k = 0; k < 48; k++)
				{
					double kx = (double)m[0] / m[2], ky = (double)m[1] / m[3];
					int cx = rnd.Next(0, 6) * (W / 6) + 2, cy = rnd.Next(0, 6) * (H / 6) + 2;
					int l = (int)Math.Round((cx + rnd.Next(0, 5)) * kx), t = (int)Math.Round((cy + rnd.Next(0, 5)) * ky);
					int r = l + (int)Math.Round(rnd.Next(18, 56) * kx), b = t + (int)Math.Round(rnd.Next(14, 40) * ky);
					int w = r - l, h = b - t;
					int x1 = l + rnd.Next(0, w + 1), y1 = t, x2 = l, y2 = t + rnd.Next(0, h + 1);
					if (rnd.Next(2) == 0) { x1 = r; y1 = t + rnd.Next(0, h + 1); x2 = l + rnd.Next(0, w + 1); y2 = b; }
					int cw = rnd.Next(3, Math.Max(4, w)), ch = rnd.Next(3, Math.Max(4, h));
					int pen = k % 4, dirn = (k / 4) % 2 == 1 ? 2 : 1;
					IntPtr mdc = CreateEnhMetaFileW(screen, null, ref frame, null);
					SetMapMode(mdc, 8); SetWindowExtEx(mdc, m[0], m[1], IntPtr.Zero); SetViewportExtEx(mdc, sx * m[2], sy * m[3], IntPtr.Zero);
					SetViewportOrgEx(mdc, sx < 0 ? W : 0, sy < 0 ? H : 0, IntPtr.Zero);
					SetArcDirection(mdc, dirn);
					IntPtr hp = pen == 0 ? CreatePen(5, 0, 0) : pen == 1 ? CreatePen(0, 0, 0x202020) : pen == 2 ? CreatePen(0, 3, 0x202020) : CreatePen(6, 3, 0x202020);
					IntPtr op = SelectObject(mdc, hp);
					switch (kind)
					{
						case 0: Arc(mdc, l, t, r, b, x1, y1, x2, y2); break;
						case 1: Chord(mdc, l, t, r, b, x1, y1, x2, y2); break;
						case 2: Pie(mdc, l, t, r, b, x1, y1, x2, y2); break;
						case 3: Ellipse(mdc, l, t, r, b); break;
						case 4: RoundRect(mdc, l, t, r, b, cw, ch); break;
						default: Rectangle(mdc, l, t, r, b); break;
					}
					SelectObject(mdc, op); DeleteObject(hp);
					IntPtr emf = CloseEnhMetaFile(mdc);
					IntPtr dc, bmp;
					Surface(screen, out dc, out bmp);
					var rect = new RECT { Right = W, Bottom = H };
					string played = "[]", recJson = "[]";
					EnumEnhMetaFile(dc, emf, delegate(IntPtr hdc, IntPtr table, IntPtr rec, int n, IntPtr data)
					{
						int type = Marshal.ReadInt32(rec);
						if (type >= 42 && type <= 47)
						{
							SaveDC(hdc);
							BeginPath(hdc);
							PlayEnhMetaFileRecord(hdc, table, rec, n);
							EndPath(hdc);
							played = PathJson(hdc, true);
							int ints = (Marshal.ReadInt32(rec, 4) - 8) / 4;
							recJson = "[";
							for (int q = 0; q < ints; q++) recJson += (q > 0 ? "," : "") + Marshal.ReadInt32(rec, 8 + 4 * q);
							recJson += "]";
							RestoreDC(hdc, -1);
						}
						else PlayEnhMetaFileRecord(hdc, table, rec, n);
						return 1;
					}, IntPtr.Zero, ref rect);
					DeleteEnhMetaFile(emf); DeleteDC(dc); DeleteObject(bmp);
					if (count++ > 0) js.Append(',');
					js.Append("{\"map\":").Append(map).Append(",\"kind\":").Append(kind).Append(",\"pen\":").Append(pen).Append(",\"dir\":").Append(dirn).Append(",\"rec\":").Append(recJson).Append(",\"played\":").Append(played).Append('}');
				}
		}
		ReleaseDC(IntPtr.Zero, screen);
		var bytes = System.Text.Encoding.UTF8.GetBytes(js.Append(']').ToString());
		using (var file = File.Create(Path.Combine(dir, "compat-playback-shapes.json.gz")))
		using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(bytes, 0, bytes.Length);
	}

	[DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetEnhMetaFileW(string file);
	[DllImport("gdi32.dll")] static extern bool WidenPath(IntPtr dc);

	/** The native path of every Arc, Chord, Pie, Ellipse, RoundRect and Rectangle record of a recorded sheet, played one by one as in `PathPlayback`: a JSON array of `{type, rec, played}`. */
	public static string SheetPaths(string emfFile, bool widen = false, bool lines = false)
	{
		IntPtr screen = GetDC(IntPtr.Zero);
		IntPtr emf = GetEnhMetaFileW(emfFile);
		IntPtr dc, bmp;
		Surface(screen, out dc, out bmp);
		var rect = new RECT { Right = W, Bottom = H };
		var js = new System.Text.StringBuilder("[");
		int count = 0;
		EnumEnhMetaFile(dc, emf, delegate(IntPtr hdc, IntPtr table, IntPtr rec, int n, IntPtr data)
		{
			int type = Marshal.ReadInt32(rec);
			if ((type >= 42 && type <= 47) || (lines && type == 54))
			{
				SaveDC(hdc);
				BeginPath(hdc);
				PlayEnhMetaFileRecord(hdc, table, rec, n);
				EndPath(hdc);
				if (widen) WidenPath(hdc);
				string played = PathJson(hdc, true);
				int ints = (Marshal.ReadInt32(rec, 4) - 8) / 4;
				var recJson = new System.Text.StringBuilder("[");
				for (int q = 0; q < ints; q++) recJson.Append(q > 0 ? "," : "").Append(Marshal.ReadInt32(rec, 8 + 4 * q));
				recJson.Append(']');
				RestoreDC(hdc, -1);
				if (count++ > 0) js.Append(',');
				js.Append("{\"type\":").Append(type).Append(",\"rec\":").Append(recJson).Append(",\"played\":").Append(played).Append('}');
				// the record is then played for real so the DC state carries on as in a normal playback
			}
			PlayEnhMetaFileRecord(hdc, table, rec, n);
			return 1;
		}, IntPtr.Zero, ref rect);
		DeleteEnhMetaFile(emf); DeleteDC(dc); DeleteObject(bmp); ReleaseDC(IntPtr.Zero, screen);
		return js.Append(']').ToString();
	}

	/** The Rectangle and Ellipse sweeps under mirrored maps: `compat-rects-m<x|y|xy>-<sweep>-<pen>` and `compat-ellipses-m...` for the 10:7, 3:4, 4:3 and 1:2 sweeps. */
	public static void RectSweepMirrored(string dir)
	{
		IntPtr screen = GetDC(IntPtr.Zero);
		double mmX = GetDeviceCaps(screen, 4) * 100.0 / GetDeviceCaps(screen, 8), mmY = GetDeviceCaps(screen, 6) * 100.0 / GetDeviceCaps(screen, 10);
		var frame = new RECT { Right = (int)Math.Round(W * mmX), Bottom = (int)Math.Round(H * mmY) };
		string[] mirrorNames = { "", "x", "y", "xy" };
		int[] sweepIdx = { 0, 1, 2, 5 };
		for (int shape = 0; shape < 2; shape++)
			for (int mirror = 1; mirror < 4; mirror++)
				foreach (int s in sweepIdx)
					for (int pen = 0; pen < SweepPens.Length; pen++)
					{
						string name = (shape == 0 ? "compat-rects-m" : "compat-ellipses-m") + mirrorNames[mirror] + "-" + SweepNames[s] + "-" + SweepPens[pen];
						IntPtr mdc = CreateEnhMetaFileW(screen, Path.Combine(dir, name + ".emf"), ref frame, null);
						DrawSweep(mdc, Sweeps[s], pen, shape, mirror);
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

	/** The `compat-playback` sheets drawn under mirrored maps: `compat-playback-m<x|y|xy>-<map>-<pen>` (maps 1:1, 10:7, 3:4 and 3:2 by 1:1; null, cosmetic, plain 3, geometric round 5 and dotted pens). */
	public static void RunMirrored(string dir)
	{
		IntPtr screen = GetDC(IntPtr.Zero);
		double mmX = GetDeviceCaps(screen, 4) * 100.0 / GetDeviceCaps(screen, 8), mmY = GetDeviceCaps(screen, 6) * 100.0 / GetDeviceCaps(screen, 10);
		var frame = new RECT { Right = (int)Math.Round(W * mmX), Bottom = (int)Math.Round(H * mmY) };
		string[] mirrorNames = { "", "x", "y", "xy" };
		int[] maps = { 0, 2, 3, 5 };
		int[] pens = { 0, 1, 2, 4, 6 };
		for (int mirror = 1; mirror < 4; mirror++)
			foreach (int map in maps)
				foreach (int pen in pens)
				{
					string name = "compat-playback-m" + mirrorNames[mirror] + "-" + MapNames[map] + "-" + PenNames[pen];
					IntPtr mdc = CreateEnhMetaFileW(screen, Path.Combine(dir, name + ".emf"), ref frame, null);
					Draw(mdc, map, pen, mirror);
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

	/** Wide-pen sweep under the 3:2 by 1:1 map and its x mirror: 300 cells of one random polyline, polygon or ellipse each. `compat-widemirror-<kind>-p<width>-<m|u>`: the same logical shapes with the viewport x extent negated. */
	public static void WideMirror(string dir)
	{
		IntPtr screen = GetDC(IntPtr.Zero);
		double mmX = GetDeviceCaps(screen, 4) * 100.0 / GetDeviceCaps(screen, 8), mmY = GetDeviceCaps(screen, 6) * 100.0 / GetDeviceCaps(screen, 10);
		var frame = new RECT { Right = (int)Math.Round(W * mmX), Bottom = (int)Math.Round(H * mmY) };
		string[] kinds = { "line", "poly3", "poly4", "ellipse", "hline", "vline", "dot" };
		int[] penWidths = { 3, 4 };
		for (int kind = 0; kind < kinds.Length; kind++)
			foreach (int pw in penWidths)
				for (int mirror = 0; mirror < 2; mirror++)
				{
					string name = "compat-widemirror-" + kinds[kind] + "-p" + pw + "-" + (mirror == 1 ? "m" : "u");
					IntPtr mdc = CreateEnhMetaFileW(screen, Path.Combine(dir, name + ".emf"), ref frame, null);
					PatBlt(mdc, 0, 0, W, H, 0x00FF0062);
					SetMapMode(mdc, 8);
					SetWindowExtEx(mdc, 3, 1, IntPtr.Zero);
					SetViewportExtEx(mdc, mirror == 1 ? -2 : 2, 1, IntPtr.Zero);
					if (mirror == 1) SetViewportOrgEx(mdc, W, 0, IntPtr.Zero);
					SetBkMode(mdc, 1);
					IntPtr p = CreatePen(0, pw, 0x202020), br = CreateSolidBrush(0x60A0F0);
					IntPtr op = SelectObject(mdc, p), ob = SelectObject(mdc, br);
					var rnd = new Random(77 + kind);
					for (int i = 0; i < 20 * 15; i++)
					{
						int col = i % 20, row = i / 20;
						int lx0 = col * 31 + 3, ly0 = row * 20 + 3;
						int[] pts = new int[8];
						for (int k = 0; k < 4; k++) { pts[2 * k] = lx0 + rnd.Next(0, 25); pts[2 * k + 1] = ly0 + rnd.Next(0, 14); }						if (kind == 0) { MoveToEx(mdc, pts[0], pts[1], IntPtr.Zero); LineTo(mdc, pts[2], pts[3]); }
						else if (kind == 6) { MoveToEx(mdc, pts[0], pts[1], IntPtr.Zero); LineTo(mdc, pts[0], pts[1]); }
						else if (kind == 4) { MoveToEx(mdc, pts[0], pts[1], IntPtr.Zero); LineTo(mdc, pts[2], pts[1]); }
						else if (kind == 5) { MoveToEx(mdc, pts[0], pts[1], IntPtr.Zero); LineTo(mdc, pts[0], pts[3]); }
						else if (kind == 1) Polygon(mdc, pts, 3);
						else if (kind == 2) Polygon(mdc, pts, 4);
						else { int l = Math.Min(pts[0], pts[2]), r = Math.Max(pts[0], pts[2]) + 8, t = Math.Min(pts[1], pts[3]), b = Math.Max(pts[1], pts[3]) + 4; Ellipse(mdc, l, t, r, b); }
					}
					SelectObject(mdc, op); SelectObject(mdc, ob); DeleteObject(p); DeleteObject(br);
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

	/**
	 * Native `WidenPath` of a zero-length `LineTo` (a dot) of a wide plain pen at every sub-pixel device position, under the nib of the
	 * `compat-widemirror` sheets (a 2 by 3 pixel nib: pen width 64 logical units, x scale 1/32 pixel and y scale 3/64 pixel per unit, or the
	 * 4-unit nib 1/24 and 1/16; the x extent negated for `m`). A logical step is half a FIX in x and 0.75 (p3) or 1 (p4) FIX in y, so the
	 * grid covers every fractional device position: `compat-dot-grid.json.gz`, one object per variant `{v, dots: [{rec, played}]}` (recorded and
	 * played back, `SheetPaths` with `lines`).
	 */
	public static void DotGrid(string dir)
	{
		IntPtr screen = GetDC(IntPtr.Zero);
		double mmX = GetDeviceCaps(screen, 4) * 100.0 / GetDeviceCaps(screen, 8), mmY = GetDeviceCaps(screen, 6) * 100.0 / GetDeviceCaps(screen, 10);
		var frame = new RECT { Right = (int)Math.Round(W * mmX), Bottom = (int)Math.Round(H * mmY) };
		var js = new System.Text.StringBuilder("[");
		string tmp = Path.Combine(Path.GetTempPath(), "dotgrid.emf");
		// name, map mode, window x, window y, viewport x, viewport y, pen width, grid x, grid y, base x, base y
		object[][] variants = {
			new object[] { "p3u", 8, 32, 64, 1, 3, 64, 32, 64, 2400, 3000 },
			new object[] { "p3m", 8, 32, 64, -1, 3, 64, 32, 64, 2400, 3000 },
			new object[] { "p4u", 8, 24, 16, 1, 1, 64, 48, 16, 2400, 3000 },
			new object[] { "p4m", 8, 24, 16, -1, 1, 64, 48, 16, 2400, 3000 },
			new object[] { "id2", 1, 1, 1, 1, 1, 2, 1, 1, 50, 50 },
			new object[] { "id3", 1, 1, 1, 1, 1, 3, 1, 1, 50, 50 },
			new object[] { "id4", 1, 1, 1, 1, 1, 4, 1, 1, 50, 50 },
			new object[] { "id5", 1, 1, 1, 1, 1, 5, 1, 1, 50, 50 },
			new object[] { "id8", 1, 1, 1, 1, 1, 8, 1, 1, 50, 50 },
			new object[] { "id12", 1, 1, 1, 1, 1, 12, 1, 1, 50, 50 },
			new object[] { "x2y1w3", 8, 1, 1, 2, 1, 3, 1, 1, 50, 50 },
			new object[] { "x2y1w4", 8, 1, 1, 2, 1, 4, 1, 1, 50, 50 },
			new object[] { "x1y2w3", 8, 1, 1, 1, 2, 3, 1, 1, 50, 50 },
			new object[] { "x2y3w3", 8, 1, 1, 2, 3, 3, 1, 1, 50, 50 },
			new object[] { "x3y2w3", 8, 3, 1, 2, 1, 3, 3, 1, 50, 50 },
			new object[] { "L-id3-h", 1, 1, 1, 1, 1, 3, 1, 1, 50, 50, 20, 0 },
			new object[] { "L-id3-d", 1, 1, 1, 1, 1, 3, 1, 1, 50, 50, 20, 7 },
			new object[] { "L-id4-h", 1, 1, 1, 1, 1, 4, 1, 1, 50, 50, 20, 0 },
			new object[] { "L-id4-d", 1, 1, 1, 1, 1, 4, 1, 1, 50, 50, 20, 7 },
			new object[] { "L-id2-d", 1, 1, 1, 1, 1, 2, 1, 1, 50, 50, 20, 7 },
			new object[] { "L-x2y1w3-d", 8, 1, 1, 2, 1, 3, 1, 1, 50, 50, 20, 7 },
			new object[] { "L-x2y1w3-h", 8, 1, 1, 2, 1, 3, 1, 1, 50, 50, 20, 0 },
			new object[] { "L-x2y1w3-v", 8, 1, 1, 2, 1, 3, 1, 1, 50, 50, 0, 20 },
		};
		for (int v = 0; v < variants.Length; v++)
		{
			var vr = variants[v];
			int mode = (int)vr[1], wx = (int)vr[2], wy = (int)vr[3], vx = (int)vr[4], vy = (int)vr[5], pw = (int)vr[6], gx = (int)vr[7], gy = (int)vr[8], bx = (int)vr[9], by = (int)vr[10];
			IntPtr mdc = CreateEnhMetaFileW(screen, tmp, ref frame, null);
			SetMapMode(mdc, mode);
			if (mode == 8) { SetWindowExtEx(mdc, wx, wy, IntPtr.Zero); SetViewportExtEx(mdc, vx, vy, IntPtr.Zero); }
			if (vx < 0) SetViewportOrgEx(mdc, W, 0, IntPtr.Zero);
			IntPtr p = CreatePen(0, pw, 0x202020);
			IntPtr op = SelectObject(mdc, p);
			for (int i = 0; i < gx; i++)
				for (int j = 0; j < gy; j++)
				{
					int lx = bx + i, ly = by + j;
					MoveToEx(mdc, lx, ly, IntPtr.Zero); LineTo(mdc, lx + (vr.Length > 11 ? (int)vr[11] : 0), ly + (vr.Length > 12 ? (int)vr[12] : 0));
				}
			SelectObject(mdc, op); DeleteObject(p);
			IntPtr emf = CloseEnhMetaFile(mdc);
			DeleteEnhMetaFile(emf);
			if (v > 0) js.Append(',');
			js.Append("{\"v\":\"").Append((string)vr[0]).Append("\",\"map\":[").Append(mode).Append(',').Append(wx).Append(',').Append(wy).Append(',').Append(vx).Append(',').Append(vy).Append(',').Append(pw).Append("],\"dots\":").Append(SheetPaths(tmp, true, true)).Append('}');
		}
		var bytes = System.Text.Encoding.UTF8.GetBytes(js.Append(']').ToString());
		using (var file = File.Create(Path.Combine(dir, "compat-dot-grid.json.gz")))
		using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(bytes, 0, bytes.Length);
		ReleaseDC(IntPtr.Zero, screen);
	}


	/**
	 * Native `GetPath` of a RoundRect record played back in `GM_COMPATIBLE` under maps that scale one axis only
	 * (`compat-roundrect-sweep.json.gz`): per map and axis, 10 offsets of the box edge, 16 box extents (20 to 35 units) and 16 corner extents
	 * (1 to 16) in both arc directions, a cosmetic pen. Each entry is `[dir, l, t, r, b, cw, ch, x0, y0, x3, y3, x4, y4, ...]`: the
	 * record and the path's eight corner end points (the figure's points 0, 3, 4, 7, 8, 11, 12 and 15, which with the straight edges
	 * between them fix the corner half extents and the box).
	 */
	public static void RoundRectSweep(string dir)
	{
		IntPtr screen = GetDC(IntPtr.Zero);
		double mmX = GetDeviceCaps(screen, 4) * 100.0 / GetDeviceCaps(screen, 8), mmY = GetDeviceCaps(screen, 6) * 100.0 / GetDeviceCaps(screen, 10);
		var frame = new RECT { Right = (int)Math.Round(W * mmX), Bottom = (int)Math.Round(H * mmY) };
		string tmp = Path.Combine(Path.GetTempPath(), "rrsweep.emf");
		// window extent, viewport extent of the scaled axis
		int[][] scales = { new[] { 4, 3 }, new[] { 3, 4 }, new[] { 10, 7 }, new[] { 7, 10 }, new[] { 3, 5 }, new[] { 2, 3 }, new[] { 5, 3 } };
		var js = new System.Text.StringBuilder("[");
		bool firstMap = true;
		foreach (var sc in scales)
			for (int axis = 0; axis < 3; axis++)
				for (int cw = 1; cw <= 2; cw++)
				{
					int arcDir = cw;
					IntPtr mdc = CreateEnhMetaFileW(screen, tmp, ref frame, null);
					SetMapMode(mdc, 8);
					SetWindowExtEx(mdc, axis != 1 ? sc[0] : 1, axis != 0 ? sc[0] : 1, IntPtr.Zero);
					SetViewportExtEx(mdc, axis != 1 ? sc[1] : 1, axis != 0 ? sc[1] : 1, IntPtr.Zero);
					SetArcDirection(mdc, arcDir);
					IntPtr p = CreatePen(0, 0, 0x202020);
					IntPtr op = SelectObject(mdc, p);
					for (int off = 0; off < 10; off++)
						for (int h = 20; h < 36; h++)
							for (int ch = 1; ch <= 16; ch++)
							{
								int a0 = 3 + off, a1 = a0 + h;
								// the other axis: a fixed 40 by 12 unit box and corner
								if (axis == 1) RoundRect(mdc, 3, a0, 43, a1, 12, ch);
								else RoundRect(mdc, a0, 3, a1, 43, ch, 12);
							}
					SelectObject(mdc, op); DeleteObject(p);
					IntPtr emf = CloseEnhMetaFile(mdc);
					DeleteEnhMetaFile(emf);
					IntPtr hemf = GetEnhMetaFileW(tmp);
					IntPtr dc, bmp;
					Surface(screen, out dc, out bmp);
					var rect = new RECT { Right = W, Bottom = H };
					var section = new System.Text.StringBuilder();
					int count = 0;
					EnumEnhMetaFile(dc, hemf, delegate(IntPtr hdc, IntPtr table, IntPtr rec, int n, IntPtr data)
					{
						int type = Marshal.ReadInt32(rec);
						if (type == 44)
						{
							SaveDC(hdc);
							BeginPath(hdc);
							PlayEnhMetaFileRecord(hdc, table, rec, n);
							EndPath(hdc);
							SetGraphicsMode(hdc, 2); ModifyWorldTransform(hdc, IntPtr.Zero, 1);
							SetMapMode(hdc, 8); SetWindowExtEx(hdc, 16, 16, IntPtr.Zero); SetViewportExtEx(hdc, 1, 1, IntPtr.Zero);
							SetWindowOrgEx(hdc, 0, 0, IntPtr.Zero); SetViewportOrgEx(hdc, 0, 0, IntPtr.Zero);
							int np = GetPath(hdc, null, null, 0);
							var q = new Point[np]; var u = new byte[np];
							if (np > 0) GetPath(hdc, q, u, np);
							RestoreDC(hdc, -1);
							if (count++ > 0) section.Append(',');
							section.Append('[').Append(arcDir);
							for (int k = 0; k < 6; k++) section.Append(',').Append(Marshal.ReadInt32(rec, 8 + 4 * k));
							foreach (int k in new[] { 0, 3, 4, 7, 8, 11, 12, 15 }) section.Append(',').Append(np > k ? q[k].X : -1).Append(',').Append(np > k ? q[k].Y : -1);
							section.Append(",").Append(np).Append("]");
						}
						PlayEnhMetaFileRecord(hdc, table, rec, n);
						return 1;
					}, IntPtr.Zero, ref rect);
					DeleteEnhMetaFile(hemf); DeleteDC(dc); DeleteObject(bmp);
					if (!firstMap) js.Append(',');
					firstMap = false;
					js.Append("{\"window\":").Append(sc[0]).Append(",\"viewport\":").Append(sc[1]).Append(",\"axis\":").Append(axis).Append(",\"dir\":").Append(arcDir).Append(",\"records\":[").Append(section).Append("]}");
				}
		var bytes = System.Text.Encoding.UTF8.GetBytes(js.Append(']').ToString());
		using (var file = File.Create(Path.Combine(dir, "compat-roundrect-sweep.json.gz")))
		using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(bytes, 0, bytes.Length);
		ReleaseDC(IntPtr.Zero, screen);
	}

	/**
	 * The same RoundRect boxes recorded in three ways and played back, native `GetPath` of each (`compat-roundrect-modes.json.gz`): a
	 * `GM_COMPATIBLE` map (the record stores the call's right and bottom less one, so the call is made one unit larger), a
	 * `GM_ADVANCED` map, and `GM_ADVANCED` with an identity map and a float world scale. Per scale (window x, viewport x), mode, and
	 * box (left 3 + 0..9, extent 12..39, corners 1 to 20): [left, right, corner, the eight corner end points x, y, point count].
	 */
	public static void RoundRectModes(string dir)
	{
		IntPtr screen = GetDC(IntPtr.Zero);
		double mmX = GetDeviceCaps(screen, 4) * 100.0 / GetDeviceCaps(screen, 8), mmY = GetDeviceCaps(screen, 6) * 100.0 / GetDeviceCaps(screen, 10);
		var frame = new RECT { Right = (int)Math.Round(W * mmX), Bottom = (int)Math.Round(H * mmY) };
		string tmp = Path.Combine(Path.GetTempPath(), "rrmodes.emf");
		int[][] scales = { new[] { 3, 4 }, new[] { 10, 11 }, new[] { 16, 21 }, new[] { 3, 5 } };
		var js = new System.Text.StringBuilder("[");
		bool first = true;
		foreach (var sc in scales)
			for (int mode = 0; mode < 3; mode++)
			{
				IntPtr mdc = CreateEnhMetaFileW(screen, tmp, ref frame, null);
				if (mode == 0) { SetMapMode(mdc, 8); SetWindowExtEx(mdc, sc[0], 1, IntPtr.Zero); SetViewportExtEx(mdc, sc[1], 1, IntPtr.Zero); }
				else if (mode == 1) { SetGraphicsMode(mdc, 2); SetMapMode(mdc, 8); SetWindowExtEx(mdc, sc[0], 1, IntPtr.Zero); SetViewportExtEx(mdc, sc[1], 1, IntPtr.Zero); }
				else { SetGraphicsMode(mdc, 2); var xf = new Xform { M11 = (float)sc[1] / sc[0], M22 = 1 }; SetWorldTransform(mdc, ref xf); }
				IntPtr p = CreatePen(0, 0, 0x202020);
				IntPtr op = SelectObject(mdc, p);
				for (int off = 0; off < 10; off++)
					for (int w = 12; w < 40; w++)
						for (int c = 1; c <= 20; c++) RoundRect(mdc, 3 + off, 3, 3 + off + w + (mode == 0 ? 1 : 0), 43, c, 12);
				SelectObject(mdc, op); DeleteObject(p);
				IntPtr emf = CloseEnhMetaFile(mdc);
				DeleteEnhMetaFile(emf);
				IntPtr hemf = GetEnhMetaFileW(tmp);
				IntPtr dc, bmp;
				Surface(screen, out dc, out bmp);
				var rect = new RECT { Right = W, Bottom = H };
				var section = new System.Text.StringBuilder();
				int count = 0;
				EnumEnhMetaFile(dc, hemf, delegate(IntPtr hdc, IntPtr table, IntPtr rec, int n, IntPtr data)
				{
					if (Marshal.ReadInt32(rec) == 44)
					{
						SaveDC(hdc);
						BeginPath(hdc);
						PlayEnhMetaFileRecord(hdc, table, rec, n);
						EndPath(hdc);
						SetGraphicsMode(hdc, 2); ModifyWorldTransform(hdc, IntPtr.Zero, 1);
						SetMapMode(hdc, 8); SetWindowExtEx(hdc, 16, 16, IntPtr.Zero); SetViewportExtEx(hdc, 1, 1, IntPtr.Zero);
						SetWindowOrgEx(hdc, 0, 0, IntPtr.Zero); SetViewportOrgEx(hdc, 0, 0, IntPtr.Zero);
						int np = GetPath(hdc, null, null, 0);
						var q = new Point[np]; var u = new byte[np];
						if (np > 0) GetPath(hdc, q, u, np);
						RestoreDC(hdc, -1);
						if (count++ > 0) section.Append(',');
						section.Append('[').Append(Marshal.ReadInt32(rec, 8)).Append(',').Append(Marshal.ReadInt32(rec, 16)).Append(',').Append(Marshal.ReadInt32(rec, 24));
						foreach (int k in new[] { 0, 3, 4, 7, 8, 11, 12, 15 }) section.Append(',').Append(np > k ? q[k].X : -1).Append(',').Append(np > k ? q[k].Y : -1);
						section.Append(',').Append(np).Append(']');
					}
					PlayEnhMetaFileRecord(hdc, table, rec, n);
					return 1;
				}, IntPtr.Zero, ref rect);
				DeleteEnhMetaFile(hemf); DeleteDC(dc); DeleteObject(bmp);
				if (!first) js.Append(',');
				first = false;
				js.Append("{\"window\":").Append(sc[0]).Append(",\"viewport\":").Append(sc[1]).Append(",\"mode\":").Append(mode).Append(",\"records\":[").Append(section).Append("]}");
			}
		var bytes = System.Text.Encoding.UTF8.GetBytes(js.Append(']').ToString());
		using (var file = File.Create(Path.Combine(dir, "compat-roundrect-modes.json.gz")))
		using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(bytes, 0, bytes.Length);
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
