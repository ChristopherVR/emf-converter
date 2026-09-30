// Native miter/bevel transition thresholds at eight orientations.
// Native GetPath reference for the formerly one-unit RoundRect exceptions.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
public static class MiterProbe
{
	[StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
	[StructLayout(LayoutKind.Sequential)] struct LogBrush {public uint Style,Colour;public IntPtr Hatch;}
	[DllImport("gdi32.dll")] static extern IntPtr ExtCreatePen(uint style,uint width,ref LogBrush brush,uint count,IntPtr dashes);
	[DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc,IntPtr obj);
	[DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
	[DllImport("gdi32.dll")] static extern bool Polyline(IntPtr dc,Point[] points,int count);
	[DllImport("gdi32.dll")] static extern bool WidenPath(IntPtr dc);
	[DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
	[DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
	[DllImport("gdi32.dll")] static extern bool BeginPath(IntPtr dc);
	[DllImport("gdi32.dll")] static extern bool EndPath(IntPtr dc);
	[DllImport("gdi32.dll")] static extern int GetPath(IntPtr dc, [Out] Point[] points, [Out] byte[] types, int count);
	[DllImport("gdi32.dll")] static extern int SetMapMode(IntPtr dc, int mode);
	[DllImport("gdi32.dll")] static extern bool SetViewportExtEx(IntPtr dc, int x, int y, IntPtr old);
	[DllImport("gdi32.dll")] static extern bool SetWindowExtEx(IntPtr dc, int x, int y, IntPtr old);


	[DllImport("gdi32.dll")] static extern bool SetMiterLimit(IntPtr dc, float value, IntPtr old);
	static void Check(bool success) { if (!success) throw new Exception("Native miter probe failed"); }
	static string Float(float value) { return value.ToString("R", System.Globalization.CultureInfo.InvariantCulture); }

	static int Count(IntPtr dc, int delta, int rotation, bool mirror, float limit)
	{
		Check(SetMapMode(dc, 1) != 0); Check(SetMiterLimit(dc, limit, IntPtr.Zero));
		var source = new[] { new Point { X=20, Y=100 }, new Point { X=100, Y=100 }, new Point { X=20, Y=100+delta } };
		for (int k=0; k<3; k++) {
			int x=source[k].X-100, y=source[k].Y-100;
			if (mirror) y=-y;
			for (int j=0; j<rotation; j++) { int old=x; x=-y; y=old; }
			source[k].X=100+x; source[k].Y=100+y;
		}
		Check(BeginPath(dc)); Check(Polyline(dc, source, 3)); Check(EndPath(dc)); Check(WidenPath(dc));
		Check(SetMapMode(dc, 8) != 0); Check(SetWindowExtEx(dc, 16, 16, IntPtr.Zero)); Check(SetViewportExtEx(dc, 1, 1, IntPtr.Zero));
		int count=GetPath(dc, null, null, 0);
		if (count<0) throw new Exception("GetPath failed");
		return count;
	}

	public static void Run(string dir)
	{
		IntPtr dc=CreateCompatibleDC(IntPtr.Zero);
		if (dc==IntPtr.Zero) throw new Exception("CreateCompatibleDC failed");
		var json=new StringBuilder("[");
		try {
			foreach (int width in new[] { 2,5,7,8,12,16,32,64 }) {
				var brush=new LogBrush();
				IntPtr pen=ExtCreatePen(0x12200, (uint)width, ref brush, 0, IntPtr.Zero);
				if (pen==IntPtr.Zero) throw new Exception("ExtCreatePen failed");
				IntPtr old=SelectObject(dc, pen);
				try {
					foreach (int delta in new[] { 16,17,18,20,25,30 })
					for (int rotation=0; rotation<4; rotation++)
					foreach (bool mirror in new[] { false,true }) {
						int bevel=Count(dc, delta, rotation, mirror, 1);
						float lo=1, hi=30;
						for (int i=0; i<24; i++) {
							float mid=(lo+hi)/2;
							if (Count(dc, delta, rotation, mirror, mid)>bevel) hi=mid; else lo=mid;
						}
						float below=hi-.001f, above=hi+.001f;
						int belowCount=Count(dc, delta, rotation, mirror, below), aboveCount=Count(dc, delta, rotation, mirror, above);
						if (belowCount!=bevel || aboveCount!=bevel+1) throw new Exception("Miter threshold did not separate bevel and miter");
						if (json.Length>1) json.Append(',');
						json.Append("{\"width\":").Append(width).Append(",\"delta\":").Append(delta)
							.Append(",\"rotation\":").Append(rotation).Append(",\"mirror\":").Append(mirror?1:0)
							.Append(",\"limit\":").Append(Float(hi)).Append(",\"below\":").Append(Float(below)).Append(",\"above\":").Append(Float(above))
							.Append(",\"belowCount\":").Append(belowCount).Append(",\"aboveCount\":").Append(aboveCount).Append('}');
					}
				} finally { SelectObject(dc, old); DeleteObject(pen); }
			}
		} finally { DeleteDC(dc); }
		File.WriteAllText(Path.Combine(dir, "miter-limits.json"), json.Append(']').ToString());
	}
}
