// Native GetPath reference for the formerly one-unit RoundRect exceptions.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
public static class PathProbe
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
	[DllImport("gdi32.dll")] static extern bool RoundRect(IntPtr dc, int l, int t, int r, int b, int w, int h);
	[DllImport("gdi32.dll")] static extern int SetArcDirection(IntPtr dc, int direction);
	[DllImport("gdi32.dll")] static extern int SetMapMode(IntPtr dc, int mode);
	[DllImport("gdi32.dll")] static extern int SetGraphicsMode(IntPtr dc, int mode);
	[DllImport("gdi32.dll")] static extern bool SetViewportExtEx(IntPtr dc, int x, int y, IntPtr old);
	[DllImport("gdi32.dll")] static extern bool SetWindowExtEx(IntPtr dc, int x, int y, IntPtr old);
	static readonly int[,] Boxes = { {20,20,40,40}, {30,50,55,35}, {60,60,35,45}, {70,70,50,70}, {75,75,75,85}, {80,80,81,81}, {90,90,95,85} };
	static readonly int[,] Corners = { {10,10},{-30,-30},{5,2},{3,5},{6,4},{8,9},{0,7},{10,10},{-30,-30},{15,12},{7,9},{15,12},{3,4},{2,1},{4,4}, {10,10},{-30,-30},{5,2},{3,5},{6,4},{8,9},{0,7},{10,10},{-30,-30} };
	static int call;
	static void Draw(IntPtr dc, int l, int t, int r, int b) { RoundRect(dc,l,t,r,b,Corners[call,0],Corners[call,1]); call++; }
	static void Sequence(IntPtr dc) {
		for(int i=0;i<7;i++) Draw(dc,Boxes[i,0],Boxes[i,1],Boxes[i,2],Boxes[i,3]);
		SetArcDirection(dc,2);
		for(int i=0;i<2;i++) Draw(dc,Boxes[i,0],Boxes[i,1],Boxes[i,2],Boxes[i,3]);
		SetArcDirection(dc,1);
	}
	public static void Run(string dir) {
		IntPtr dc=CreateCompatibleDC(IntPtr.Zero); call=0;
		try {
			BeginPath(dc); Sequence(dc);
			SetMapMode(dc,8); SetViewportExtEx(dc,-2,2,IntPtr.Zero);
			Draw(dc,20,20,40,40); Draw(dc,30,50,55,35);
			SetViewportExtEx(dc,3,-3,IntPtr.Zero);
			Draw(dc,20,20,40,40); Draw(dc,30,50,55,35);
			SetWindowExtEx(dc,-20,20,IntPtr.Zero);
			Draw(dc,20,20,40,40); Draw(dc,24,22,21,20);
			SetMapMode(dc,1); SetGraphicsMode(dc,2); Sequence(dc); EndPath(dc);
			int n=GetPath(dc,null,null,0); if(n<0) throw new Exception("GetPath failed");
			var points=new Point[n];var types=new byte[n];GetPath(dc,points,types,n);
			var json=new StringBuilder("[");
			for(int i=0;i<n;i++){if(i>0)json.Append(',');json.Append(points[i].X).Append(',').Append(points[i].Y).Append(',').Append(types[i]);}
			File.WriteAllText(Path.Combine(dir,"roundrect-path.json"),json.Append(']').ToString());
			SetMapMode(dc,8); SetWindowExtEx(dc,16,16,IntPtr.Zero); SetViewportExtEx(dc,1,1,IntPtr.Zero);
			GetPath(dc,points,types,n); json=new StringBuilder("[");
			for(int i=0;i<n;i++){if(i>0)json.Append(',');json.Append(points[i].X).Append(',').Append(points[i].Y).Append(',').Append(types[i]);}
			File.WriteAllText(Path.Combine(dir,"roundrect-path-fix.json"),json.Append(']').ToString());
		} finally { DeleteDC(dc); }
	}
	public static void Wide(string dir) {
		IntPtr dc=CreateCompatibleDC(IntPtr.Zero);var random=new Random(4147);var json=new StringBuilder("[");
		try {
			foreach(int width in new[]{2,5,7,8,12,16,32,64})for(int cap=0;cap<3;cap++)for(int join=0;join<3;join++)for(int sample=0;sample<(join==2?57:16);sample++) {
				SetMapMode(dc,1);
				var p=new Point[3];for(int i=0;i<3;i++){p[i].X=random.Next(20,161);p[i].Y=random.Next(20,161);}
				if(sample>=16){p[0].X=20;p[0].Y=100;p[1].X=100;p[1].Y=100;p[2].X=20;p[2].Y=101+sample-16;}
				var brush=new LogBrush();IntPtr pen=ExtCreatePen((uint)(0x10000|cap*0x100|join*0x1000),(uint)width,ref brush,0,IntPtr.Zero);
				if(pen==IntPtr.Zero)throw new Exception("ExtCreatePen failed");IntPtr old=SelectObject(dc,pen);
				try {
					if(!BeginPath(dc)||!Polyline(dc,p,3)||!EndPath(dc)||!WidenPath(dc))throw new Exception("WidenPath failed");
					SetMapMode(dc,8);SetWindowExtEx(dc,16,16,IntPtr.Zero);SetViewportExtEx(dc,1,1,IntPtr.Zero);
					int n=GetPath(dc,null,null,0);if(n<0)throw new Exception("GetPath widened path failed");
					var points=new Point[n];var types=new byte[n];GetPath(dc,points,types,n);
					if(json.Length>1)json.Append(',');json.Append("{\"width\":").Append(width).Append(",\"cap\":").Append(cap).Append(",\"join\":").Append(join).Append(",\"source\":[");
					for(int i=0;i<3;i++){if(i>0)json.Append(',');json.Append(p[i].X*16).Append(',').Append(p[i].Y*16);}json.Append("],\"expected\":[");
					for(int i=0;i<n;i++){if(i>0)json.Append(',');json.Append(points[i].X).Append(',').Append(points[i].Y).Append(',').Append(types[i]);}json.Append("]}");
				}finally{SelectObject(dc,old);DeleteObject(pen);}
			}
			File.WriteAllText(Path.Combine(dir,"wide-path-fix.json"),json.Append(']').ToString());
		}finally{DeleteDC(dc);}
	}
}
