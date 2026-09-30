// Native GetPath reference for the formerly one-unit RoundRect exceptions.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
public static class PathProbe
{
	[StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
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
		} finally { DeleteDC(dc); }
	}
}
