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
	[DllImport("gdi32.dll")] static extern bool Ellipse(IntPtr dc, int l, int t, int r, int b);
	[DllImport("gdi32.dll")] static extern bool Arc(IntPtr dc, int l, int t, int r, int b, int x1, int y1, int x2, int y2);
	[DllImport("gdi32.dll")] static extern bool Chord(IntPtr dc, int l, int t, int r, int b, int x1, int y1, int x2, int y2);
	[DllImport("gdi32.dll")] static extern bool Pie(IntPtr dc, int l, int t, int r, int b, int x1, int y1, int x2, int y2);
	[DllImport("gdi32.dll")] static extern int SetArcDirection(IntPtr dc, int direction);
	[DllImport("gdi32.dll")] static extern bool AngleArc(IntPtr dc, int x, int y, uint r, float start, float sweep);
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
	static string ReadFixPath(IntPtr dc) {
		SetMapMode(dc,8);SetWindowExtEx(dc,16,16,IntPtr.Zero);SetViewportExtEx(dc,1,1,IntPtr.Zero);
		int n=GetPath(dc,null,null,0);if(n<0)throw new Exception("GetPath failed");
		var points=new Point[n];var types=new byte[n];GetPath(dc,points,types,n);
		var json=new StringBuilder("[");for(int i=0;i<n;i++){if(i>0)json.Append(',');json.Append(points[i].X).Append(',').Append(points[i].Y).Append(',').Append(types[i]);}
		SetMapMode(dc,1);return json.Append(']').ToString();
	}
	public static void Outline(string dir) {
		IntPtr dc=CreateCompatibleDC(IntPtr.Zero);var json=new StringBuilder("[");
		try {
			foreach(int width in new[]{2,7,10,32})for(int cap=0;cap<3;cap++)for(int join=0;join<3;join++){
				var brush=new LogBrush();IntPtr pen=ExtCreatePen((uint)(0x10000|cap*0x100|join*0x1000),(uint)width,ref brush,0,IntPtr.Zero),old=SelectObject(dc,pen);
				try { for(int shape=0;shape<2;shape++){
					BeginPath(dc);
					if(shape==0)Polyline(dc,new[]{new Point{X=15,Y=20},new Point{X=60,Y=90},new Point{X=90,Y=25}},3);
					else Ellipse(dc,110,15,185,100);
					EndPath(dc);string source=ReadFixPath(dc);if(!WidenPath(dc))throw new Exception("WidenPath failed");
					if(json.Length>1)json.Append(',');json.Append("{\"width\":").Append(width).Append(",\"cap\":").Append(cap).Append(",\"join\":").Append(join).Append(",\"shape\":").Append(shape).Append(",\"source\":").Append(source).Append(",\"expected\":").Append(ReadFixPath(dc)).Append('}');
				}}finally{SelectObject(dc,old);DeleteObject(pen);}
			}
			File.WriteAllText(Path.Combine(dir,"wide-outline-fix.json"),json.Append(']').ToString());
		}finally{DeleteDC(dc);}
	}
	// Perpendicular (half the vector between the two start-side vertices) that WidenPath gives a single flat-capped segment, per pen width
	// in FIX (the pen is created in 1/16-pixel logical units, so fractional and very wide pens are possible) and whole-pixel direction.
	public static void FlatVectors(string dir) {
		IntPtr dc=CreateCompatibleDC(IntPtr.Zero);var random=new Random(8123);var json=new StringBuilder("[");
		int[,] special={{1,0},{0,1},{-1,0},{0,-1},{1,1},{-1,-1},{1,-1},{-1,1},{2,1},{1,2},{5,-12},{-5,12},{3,-7},{7,-3},{-12,5},{4,-1}};
		try {
			SetMapMode(dc,8);SetWindowExtEx(dc,16,16,IntPtr.Zero);SetViewportExtEx(dc,1,1,IntPtr.Zero);
			foreach(int width in new[]{104,112,120,126,128,136,147,200,264,376,520,848,1008,1288,1608,1616,1700,1800,2000,2400,3200}) {
				var brush=new LogBrush();IntPtr pen=ExtCreatePen(0x10000|0x200|0x2000,(uint)width,ref brush,0,IntPtr.Zero);
				if(pen==IntPtr.Zero)throw new Exception("ExtCreatePen failed");IntPtr old=SelectObject(dc,pen);
				try {
					for(int sample=0;sample<40+special.GetLength(0);sample++) {
						int dx,dy;
						if(sample<40){double a=random.NextDouble()*Math.PI*2,len=5+random.NextDouble()*65;dx=(int)Math.Round(Math.Cos(a)*len);dy=(int)Math.Round(Math.Sin(a)*len);if(dx==0&&dy==0)dx=1;}
						else{int k=sample-40;dx=special[k,0]*(k<4?40:k<8?28:k<10?25:6);dy=special[k,1]*(k<4?40:k<8?28:k<10?25:6);}
						var p=new[]{new Point{X=500*16,Y=500*16},new Point{X=(500+dx)*16,Y=(500+dy)*16}};
						if(!BeginPath(dc)||!Polyline(dc,p,2)||!EndPath(dc)||!WidenPath(dc))throw new Exception("WidenPath failed");
						int n=GetPath(dc,null,null,0);var points=new Point[n];var types=new byte[n];GetPath(dc,points,types,n);
						if(json.Length>1)json.Append(',');
						json.Append('[').Append(width).Append(',').Append(dx*16).Append(',').Append(dy*16).Append(',').Append((points[1].X-points[0].X)/2).Append(',').Append((points[1].Y-points[0].Y)/2).Append(']');
					}
				}finally{SelectObject(dc,old);DeleteObject(pen);}
			}
			File.WriteAllText(Path.Combine(dir,"flat-pen-vectors.json"),json.Append(']').ToString());
		}finally{DeleteDC(dc);}
	}
	// Native GetPath of Arc/Chord/Pie on integer device boxes (GM_COMPATIBLE): random arcs, arcs from or to a quadrant boundary, and a 0.096 scale case.
	// arc-paths.json is counter-clockwise (the default arc direction); arc-paths-cw.json repeats every call under AD_CLOCKWISE; arc-precise.json adds arcs
	// on a 40,000 px circle (radius 320,000 FIX), where one FIX is 3 millionths of the radius: single pieces from 0.3 to 85 degrees, arcs through every
	// quadrant, nearly full turns and arcs starting and ending exactly on a quadrant boundary.
	/** Native GetPath of Chord, Pie, Arc, Ellipse and RoundRect under a PS_INSIDEFRAME geometric pen at the WMF 0.96 scale (3800 x 2520 logical units onto 365 x 242 pixels), as `[x, y, type]` triples in FIX. */
	public static void WmfScaledPaths(string dir) {
		IntPtr dc=CreateCompatibleDC(IntPtr.Zero);var rnd=new Random(4242);var js=new StringBuilder("[");string Q=((char)34).ToString();
		var lb=new LogBrush();
		for(int k=0;k<1500;k++){
			int kind=k%5;uint pw=(uint)rnd.Next(30,110);
			int l=rnd.Next(0,3000),t=rnd.Next(0,1900),r=l+rnd.Next(100,800),b=t+rnd.Next(100,600);
			double a1=rnd.NextDouble()*Math.PI*2,a2=rnd.NextDouble()*Math.PI*2;
			double cx=(l+r)/2.0,cy=(t+b)/2.0,rx=(r-l)/2.0,ry=(b-t)/2.0;
			int[] p1={(int)Math.Round(cx+Math.Cos(a1)*rx*1.3),(int)Math.Round(cy-Math.Sin(a1)*ry*1.3)};
			int[] p2={(int)Math.Round(cx+Math.Cos(a2)*rx*1.3),(int)Math.Round(cy-Math.Sin(a2)*ry*1.3)};
			int cw=rnd.Next(10,300),ch=rnd.Next(10,300);
			IntPtr pen=ExtCreatePen(0x10000|6,pw,ref lb,0,IntPtr.Zero);IntPtr old=SelectObject(dc,pen);
			SetMapMode(dc,8);SetWindowExtEx(dc,3800,2520,IntPtr.Zero);SetViewportExtEx(dc,365,242,IntPtr.Zero);
			BeginPath(dc);
			if(kind==0)Chord(dc,l,t,r,b,p1[0],p1[1],p2[0],p2[1]);
			else if(kind==1)Pie(dc,l,t,r,b,p1[0],p1[1],p2[0],p2[1]);
			else if(kind==2)Arc(dc,l,t,r,b,p1[0],p1[1],p2[0],p2[1]);
			else if(kind==3)Ellipse(dc,l,t,r,b);
			else RoundRect(dc,l,t,r,b,cw,ch);
			EndPath(dc);
			// logical = device FIX
			SetWindowExtEx(dc,16,16,IntPtr.Zero);SetViewportExtEx(dc,1,1,IntPtr.Zero);
			int n=GetPath(dc,null,null,0);var q=new Point[n];var u=new byte[n];GetPath(dc,q,u,n);
			SelectObject(dc,old);DeleteObject(pen);
			if(k>0)js.Append(',');
			js.Append("{"+Q+"kind"+Q+":"+kind+","+Q+"pw"+Q+":"+pw+","+Q+"box"+Q+":["+l+","+t+","+r+","+b+"],"+Q+"rad"+Q+":["+p1[0]+","+p1[1]+","+p2[0]+","+p2[1]+"],"+Q+"corner"+Q+":["+cw+","+ch+"],"+Q+"pts"+Q+":[");
			for(int i=0;i<n;i++){if(i>0)js.Append(',');js.Append(q[i].X).Append(',').Append(q[i].Y).Append(',').Append(u[i]);}
			js.Append("]}");
		}
		File.WriteAllText(Path.Combine(dir,"wmf-scaled-paths.json"),js.Append("]").ToString());
	}
	/** Native GetPath in GM_ADVANCED of Chord, Pie, Arc, Ellipse and RoundRect under a PS_INSIDEFRAME pen at fractional scales (window 16, viewport 11 to 29), both arc directions, as `[x, y, type]` triples in FIX. */
	public static void EmfScaledPaths(string dir) {
		IntPtr dc=CreateCompatibleDC(IntPtr.Zero);var rnd=new Random(7771);var js=new StringBuilder("[");string Q=((char)34).ToString();
		SetGraphicsMode(dc,2);
		int[] scales={11,17,22,23,29};
		for(int k=0;k<2400;k++){
			int kind=k%6,scale=scales[rnd.Next(scales.Length)],dr=rnd.Next(0,4)==0?2:1,pw=rnd.Next(2,14);
			int l=rnd.Next(0,300),t=rnd.Next(0,300),r=l+rnd.Next(10,100),b=t+rnd.Next(10,100);
			double a1=rnd.NextDouble()*Math.PI*2,a2=rnd.NextDouble()*Math.PI*2;
			double cx=(l+r)/2.0,cy=(t+b)/2.0,rx=(r-l)/2.0,ry=(b-t)/2.0;
			int[] p1={(int)Math.Round(cx+Math.Cos(a1)*rx*1.3),(int)Math.Round(cy-Math.Sin(a1)*ry*1.3)};
			int[] p2={(int)Math.Round(cx+Math.Cos(a2)*rx*1.3),(int)Math.Round(cy-Math.Sin(a2)*ry*1.3)};
			int cw=rnd.Next(4,40),ch=rnd.Next(4,40);
			SetArcDirection(dc,dr);
			SetMapMode(dc,8);SetWindowExtEx(dc,16,16,IntPtr.Zero);SetViewportExtEx(dc,scale,scale,IntPtr.Zero);
			IntPtr pen=CreatePenNative(6,pw,0);IntPtr old=SelectObject(dc,pen);
			BeginPath(dc);
			if(kind==0)Chord(dc,l,t,r,b,p1[0],p1[1],p2[0],p2[1]);
			else if(kind==1)Pie(dc,l,t,r,b,p1[0],p1[1],p2[0],p2[1]);
			else if(kind==2)Arc(dc,l,t,r,b,p1[0],p1[1],p2[0],p2[1]);
			else if(kind==3)Ellipse(dc,l,t,r,b);
			else if(kind==4)RoundRect(dc,l,t,r,b,cw,ch);
			else Rectangle(dc,l,t,r,b);
			EndPath(dc);
			SetWindowExtEx(dc,16,16,IntPtr.Zero);SetViewportExtEx(dc,1,1,IntPtr.Zero);
			int n=GetPath(dc,null,null,0);var q=new Point[n>0?n:0];var u=new byte[n>0?n:0];if(n>0)GetPath(dc,q,u,n);
			SelectObject(dc,old);DeleteObject(pen);
			if(k>0)js.Append(',');
			js.Append("{"+Q+"kind"+Q+":"+kind+","+Q+"scale"+Q+":"+scale+","+Q+"dir"+Q+":"+dr+","+Q+"pw"+Q+":"+pw+","+Q+"box"+Q+":["+l+","+t+","+r+","+b+"],"+Q+"rad"+Q+":["+p1[0]+","+p1[1]+","+p2[0]+","+p2[1]+"],"+Q+"corner"+Q+":["+cw+","+ch+"],"+Q+"pts"+Q+":[");
			for(int i=0;i<n;i++){if(i>0)js.Append(',');js.Append(q[i].X).Append(',').Append(q[i].Y).Append(',').Append(u[i]);}
			js.Append("]}");
		}
		SetArcDirection(dc,1);
		File.WriteAllText(Path.Combine(dir,"emf-scaled-paths.json"),js.Append("]").ToString());
	}
	/** Native GetPath in GM_COMPATIBLE of RoundRect at the identity scale under a null pen, a one-pixel cosmetic pen, a wide plain pen and a wide geometric pen, both arc directions (emf-roundrect-wide-paths.json.gz): the path ends one pixel short of the call's right and bottom edge (an EMF record stores that edge) and the corner ellipse is scaled onto the drawn box. */
	public static void EmfRoundRectWide(string dir) {
		IntPtr dc=CreateCompatibleDC(IntPtr.Zero);var rnd=new Random(8881);var js=new StringBuilder("[");string Q=((char)34).ToString();
		SetGraphicsMode(dc,1);
		int[] scales={16};
		LogBrush lb=new LogBrush();
		for(int k=0;k<1800;k++){
			int pen=k%4,scale=scales[rnd.Next(scales.Length)],dr=rnd.Next(0,4)==0?2:1,pw=pen>=2?rnd.Next(2,14):1;
			int l=rnd.Next(0,300),t=rnd.Next(0,300),r=l+rnd.Next(10,100),b=t+rnd.Next(10,100);
			int cw=rnd.Next(4,40),ch=rnd.Next(4,40);
			SetArcDirection(dc,dr);
			SetMapMode(dc,8);SetWindowExtEx(dc,16,16,IntPtr.Zero);SetViewportExtEx(dc,scale,scale,IntPtr.Zero);
			IntPtr h=pen==0?CreatePenNative(5,0,0):pen==1?CreatePenNative(0,1,0):pen==2?CreatePenNative(0,pw,0):ExtCreatePen((uint)(0x10000|0x200),(uint)pw,ref lb,0,IntPtr.Zero);
			IntPtr old=SelectObject(dc,h);
			BeginPath(dc);RoundRect(dc,l,t,r,b,cw,ch);EndPath(dc);
			SetWindowExtEx(dc,16,16,IntPtr.Zero);SetViewportExtEx(dc,1,1,IntPtr.Zero);
			int n=GetPath(dc,null,null,0);var q=new Point[n>0?n:0];var u=new byte[n>0?n:0];if(n>0)GetPath(dc,q,u,n);
			SelectObject(dc,old);DeleteObject(h);
			if(k>0)js.Append(',');
			js.Append("{"+Q+"pen"+Q+":"+pen+","+Q+"scale"+Q+":"+scale+","+Q+"dir"+Q+":"+dr+","+Q+"pw"+Q+":"+pw+","+Q+"box"+Q+":["+l+","+t+","+r+","+b+"],"+Q+"corner"+Q+":["+cw+","+ch+"],"+Q+"pts"+Q+":[");
			for(int i=0;i<n;i++){if(i>0)js.Append(',');js.Append(q[i].X).Append(',').Append(q[i].Y).Append(',').Append(u[i]);}
			js.Append("]}");
		}
		SetArcDirection(dc,1);
		var bytes=Encoding.UTF8.GetBytes(js.Append("]").ToString());
		using(var file=File.Create(Path.Combine(dir,"emf-roundrect-wide-paths.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(bytes,0,bytes.Length);
		DeleteDC(dc);
	}
	[DllImport("gdi32.dll")] static extern bool Rectangle(IntPtr dc,int l,int t,int r,int b);
	[DllImport("gdi32.dll",EntryPoint="CreatePen")] static extern IntPtr CreatePenNative(int style,int width,uint color);
	/** Native GetPath of 624 arcs 0.01 to 3 degrees wide on circles of 100,000 to 400,000 FIX radius (`arc-small.json.gz`, `arc-precise.json` layout plus `radius`): both directions, Arc, Chord and Pie. */
	public static void ArcSmall(string dir) {
		IntPtr dc=CreateCompatibleDC(IntPtr.Zero);var rnd=new Random(90210);var js=new StringBuilder("[");
		try {
			Func<int,double,int[]> far=delegate(int size,double deg){double a=deg*Math.PI/180;return new[]{(int)Math.Round(size/2.0+Math.Cos(a)*8e6),(int)Math.Round(size/2.0-Math.Sin(a)*8e6)};};
			double[] sweeps={0.01,0.02,0.05,0.1,0.2,0.3,0.5,0.8,1,1.5,2,2.5,3};
			int[] sizes={12500,25000,40000,50000};
			int n=0;
			foreach(int size in sizes)foreach(double sweep in sweeps)for(int rep=0;rep<12;rep++){
				double start=rep==0?0:rep==1?90*rnd.Next(1,4)-sweep/2:rnd.NextDouble()*360;
				int way=(n%2==1)?2:1;int kind=n%3;
				int[] q1=far(size,start),q2=far(size,way==1?start+sweep:start-sweep);
				if(n>0)js.Append(',');
				js.Append("{\"kind\":").Append(kind).Append(",\"clockwise\":").Append(way==2?"true":"false").Append(",\"radius\":").Append(size*8).Append(",\"sweep\":").Append(sweep.ToString("R",System.Globalization.CultureInfo.InvariantCulture)).Append(",\"box\":[0,0,").Append(size).Append(',').Append(size).Append("],\"radials\":[").Append(q1[0]).Append(',').Append(q1[1]).Append(',').Append(q2[0]).Append(',').Append(q2[1]).Append("],\"expected\":").Append(ArcPath(dc,kind,0,0,size,size,q1[0],q1[1],q2[0],q2[1],way)).Append('}');
				n++;
			}
			var bytes=Encoding.UTF8.GetBytes(js.Append(']').ToString());
			using(var file=File.Create(Path.Combine(dir,"arc-small.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(bytes,0,bytes.Length);
		}finally{DeleteDC(dc);}
	}
	/** Native GetPath of Arcs on boxes of 2^20 to 2^24 pixels, where one FIX is 1e-7 to 1e-9 of the radius, so the control points expose the single precision unit vectors of the arc (`arc-huge.json.gz`, the `arc-small.json.gz` layout with `size` in pixels). Sweeps 0.05 to 3 degrees, both directions, a fifth of the starts on the 0 axis. */
	public static void ArcHuge(string dir) {
		IntPtr dc=CreateCompatibleDC(IntPtr.Zero);var rnd=new Random(77031);var js=new StringBuilder("[");
		try {
			Func<int,double,int[]> far=delegate(int size,double deg){double a=deg*Math.PI/180;return new[]{(int)Math.Round(size/2.0+Math.Cos(a)*8e6),(int)Math.Round(size/2.0-Math.Sin(a)*8e6)};};
			double[] sweeps={0.05,0.2,0.5,1,2,3};
			int[] sizes={1<<20,1<<22,1<<24};
			int n=0;
			foreach(int size in sizes)foreach(double sweep in sweeps)for(int rep=0;rep<40;rep++){
				double start=rep%5==0?0:rnd.NextDouble()*360;
				int way=(rep%2==1)?2:1;
				int[] q1=far(size,start),q2=far(size,way==1?start+sweep:start-sweep);
				if(n>0)js.Append(',');
				js.Append("{\"kind\":0,\"clockwise\":").Append(way==2?"true":"false").Append(",\"radius\":").Append((long)size*8).Append(",\"size\":").Append(size).Append(",\"sweep\":").Append(sweep.ToString("R",System.Globalization.CultureInfo.InvariantCulture)).Append(",\"box\":[0,0,").Append(size).Append(',').Append(size).Append("],\"radials\":[").Append(q1[0]).Append(',').Append(q1[1]).Append(',').Append(q2[0]).Append(',').Append(q2[1]).Append("],\"expected\":").Append(ArcPath(dc,0,0,0,size,size,q1[0],q1[1],q2[0],q2[1],way)).Append('}');
				n++;
			}
			var bytes=Encoding.UTF8.GetBytes(js.Append(']').ToString());
			using(var file=File.Create(Path.Combine(dir,"arc-huge.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(bytes,0,bytes.Length);
		}finally{DeleteDC(dc);}
	}
	public static void ArcPaths(string dir) {
		IntPtr dc=CreateCompatibleDC(IntPtr.Zero);var random=new Random(6047);var json=new StringBuilder("[");var jsonCw=new StringBuilder("[");
		try {
			for(int sample=0;sample<900;sample++) {
				int kind=sample%3,w=12+random.Next(0,240),h=12+random.Next(0,240),l=50+random.Next(0,100),t=50+random.Next(0,100),r=l+w,b=t+h;
				double a1=random.NextDouble()*Math.PI*2,a2=random.NextDouble()*Math.PI*2;
				if(sample%3==1&&sample>=300){a1=Math.Floor(a1/(Math.PI/2))*(Math.PI/2);}
				if(sample>=600){a2=Math.Floor(a2/(Math.PI/2))*(Math.PI/2);}
				Func<double,int[]> pt=delegate(double a){double rad=0.5+random.NextDouble()*1.5;return new[]{(int)Math.Round(l+w/2.0+Math.Cos(a)*w/2.0*rad),(int)Math.Round(t+h/2.0-Math.Sin(a)*h/2.0*rad)};};
				int[] p1=pt(a1),p2=pt(a2);
				string head="{\"kind\":"+kind+",\"box\":["+l+","+t+","+r+","+b+"],\"radials\":["+p1[0]+","+p1[1]+","+p2[0]+","+p2[1]+"],\"expected\":";
				if(json.Length>1){json.Append(',');jsonCw.Append(',');}
				json.Append(head).Append(ArcPath(dc,kind,l,t,r,b,p1[0],p1[1],p2[0],p2[1],1)).Append('}');
				jsonCw.Append(head).Append(ArcPath(dc,kind,l,t,r,b,p1[0],p1[1],p2[0],p2[1],2)).Append('}');
			}
			File.WriteAllText(Path.Combine(dir,"arc-paths.json"),json.Append(']').ToString());
			File.WriteAllText(Path.Combine(dir,"arc-paths-cw.json"),jsonCw.Append(']').ToString());
			var precise=new StringBuilder("[");var rnd=new Random(3319);const int size=40000;
			// radial point at 8 million pixels, rounded to a whole pixel, so the angle is known to ~1e-7 radians
			Func<double,int[]> far=delegate(double deg){double a=deg*Math.PI/180;return new[]{(int)Math.Round(size/2.0+Math.Cos(a)*8e6),(int)Math.Round(size/2.0-Math.Sin(a)*8e6)};};
			double[] sweeps={0.3,0.8,1.5,2.5,2.95,3.05,3.5,6,10,20,30,45,60,75,85,95,120,170,200,265,300,350,356,357.5,359,359.7};
			int n=0;
			foreach(double sweep in sweeps)for(int rep=0;rep<10;rep++){
				double start=rep<2?(rep==0?0:90.0*rnd.Next(1,4)):rnd.NextDouble()*360;
				int way=(n%4==3)?2:1;int kind=n%3;
				int[] q1=far(start),q2=far(way==1?start+sweep:start-sweep);
				if(rep==3){q2=far(Math.Floor((start+sweep)/90)*90);}
				if(precise.Length>1)precise.Append(',');
				precise.Append("{\"kind\":").Append(kind).Append(",\"clockwise\":").Append(way==2?"true":"false").Append(",\"box\":[0,0,").Append(size).Append(',').Append(size).Append("],\"radials\":[").Append(q1[0]).Append(',').Append(q1[1]).Append(',').Append(q2[0]).Append(',').Append(q2[1]).Append("],\"expected\":").Append(ArcPath(dc,kind,0,0,size,size,q1[0],q1[1],q2[0],q2[1],way)).Append('}');
				n++;
			}
			File.WriteAllText(Path.Combine(dir,"arc-precise.json"),precise.Append(']').ToString());
			// AngleArc from the origin (the line from the current position (0, 0) comes first): circle of radius 15 to 214, whole-tenth-degree angles,
			// sweeps up to a turn either way, a fifth of them up to a full turn and a seventh of them under 40 degrees.
			var angle=new StringBuilder("[");var rng=new Random(2718);
			for(int sample=0;sample<600;sample++) {
				int ax=300+rng.Next(0,50),ay=300+rng.Next(0,50),ar=15+rng.Next(0,200);float start=rng.Next(0,3601)/10f,sweep=(rng.Next(0,7001)-3500)/10f;
				if(sample%5==0)sweep=rng.Next(0,3601)/10f;
				if(sample%7==0)sweep=(rng.Next(0,401)/10f)*(rng.Next(0,2)==0?-1:1);
				SetMapMode(dc,1);BeginPath(dc);AngleArc(dc,ax,ay,(uint)ar,start,sweep);EndPath(dc);
				if(angle.Length>1)angle.Append(',');
				angle.Append("{\"x\":").Append(ax).Append(",\"y\":").Append(ay).Append(",\"radius\":").Append(ar).Append(",\"start\":").Append(start.ToString("R",System.Globalization.CultureInfo.InvariantCulture)).Append(",\"sweep\":").Append(sweep.ToString("R",System.Globalization.CultureInfo.InvariantCulture)).Append(",\"expected\":").Append(ReadFixPath(dc)).Append('}');
			}
			File.WriteAllText(Path.Combine(dir,"angle-arc-paths.json"),angle.Append(']').ToString());
		}finally{DeleteDC(dc);}
	}
	// One Arc, Chord or Pie under the given arc direction (1 counter-clockwise, 2 clockwise), read back as FIX `[x,y,type]` triples.
	static string ArcPath(IntPtr dc,int kind,int l,int t,int r,int b,int x1,int y1,int x2,int y2,int direction) {
		SetMapMode(dc,1);SetArcDirection(dc,direction);BeginPath(dc);
		if(kind==0)Arc(dc,l,t,r,b,x1,y1,x2,y2);else if(kind==1)Chord(dc,l,t,r,b,x1,y1,x2,y2);else Pie(dc,l,t,r,b,x1,y1,x2,y2);
		EndPath(dc);SetArcDirection(dc,1);
		return ReadFixPath(dc);
	}
	[DllImport("gdi32.dll")] static extern bool PolyBezier(IntPtr dc,Point[] points,uint count);
	[DllImport("gdi32.dll")] static extern bool PolyBezierTo(IntPtr dc,Point[] points,uint count);
	[DllImport("gdi32.dll")] static extern bool MoveToEx(IntPtr dc,int x,int y,IntPtr old);
	[DllImport("gdi32.dll")] static extern bool LineTo(IntPtr dc,int x,int y);
	// Native WidenPath of wide curves: random Beziers, Arcs, Chords and Pies under flat/square/round caps and several joins, at the identity scale.
	public static void CurveWiden(string dir) {
		IntPtr dc=CreateCompatibleDC(IntPtr.Zero);var random=new Random(5171);var json=new StringBuilder("[");
		int[][] styles={new[]{2,0},new[]{2,2},new[]{2,1},new[]{1,1},new[]{1,2},new[]{1,0},new[]{0,0},new[]{0,2}};
		try {
			for(int sample=0;sample<4*styles.Length*10;sample++) {
				int kind=sample%4;int[] style=styles[(sample/4)%styles.Length];int width=7+random.Next(0,12);
				SetMapMode(dc,1);
				var brush=new LogBrush();IntPtr pen=ExtCreatePen((uint)(0x10000|style[0]*0x100|style[1]*0x1000),(uint)width,ref brush,0,IntPtr.Zero);
				IntPtr old=SelectObject(dc,pen);
				try {
					string head;
					BeginPath(dc);
					if(kind==0){
						var p=new Point[4];for(int i=0;i<4;i++){p[i].X=40+random.Next(0,160);p[i].Y=40+random.Next(0,160);}
						PolyBezier(dc,p,4);
						head="\"kind\":\"bezier\",\"points\":["+string.Join(",",new[]{p[0].X,p[0].Y,p[1].X,p[1].Y,p[2].X,p[2].Y,p[3].X,p[3].Y})+"]";
					} else {
						int w=40+random.Next(0,120),h=40+random.Next(0,120),l=50+random.Next(0,60),t=50+random.Next(0,60);
						Func<int[]> pt=delegate(){double a=random.NextDouble()*Math.PI*2,rad=0.6+random.NextDouble()*1.2;return new[]{(int)Math.Round(l+w/2.0+Math.Cos(a)*w/2.0*rad),(int)Math.Round(t+h/2.0-Math.Sin(a)*h/2.0*rad)};};
						int[] p1=pt(),p2=pt();
						if(kind==1)Arc(dc,l,t,l+w,t+h,p1[0],p1[1],p2[0],p2[1]);else if(kind==2)Chord(dc,l,t,l+w,t+h,p1[0],p1[1],p2[0],p2[1]);else Pie(dc,l,t,l+w,t+h,p1[0],p1[1],p2[0],p2[1]);
						head="\"kind\":\""+(kind==1?"arc":kind==2?"chord":"pie")+"\",\"box\":["+l+","+t+","+(l+w)+","+(t+h)+"],\"radials\":["+p1[0]+","+p1[1]+","+p2[0]+","+p2[1]+"]";
					}
					EndPath(dc);if(!WidenPath(dc))throw new Exception("WidenPath failed");
					if(json.Length>1)json.Append(',');
					json.Append('{').Append(head).Append(",\"cap\":").Append(style[0]).Append(",\"join\":").Append(style[1]).Append(",\"width\":").Append(width).Append(",\"expected\":").Append(ReadFixPath(dc)).Append('}');
				} finally { SelectObject(dc,old);DeleteObject(pen); }
			}
			File.WriteAllText(Path.Combine(dir,"curve-widen.json"),json.Append(']').ToString());
		}finally{DeleteDC(dc);}
	}
	[StructLayout(LayoutKind.Sequential)] struct Xform { public float M11,M12,M21,M22,Dx,Dy; }
	[DllImport("gdi32.dll")] static extern bool SetWorldTransform(IntPtr dc,ref Xform x);
	[DllImport("gdi32.dll")] static extern bool ModifyWorldTransform(IntPtr dc,ref Xform x,uint mode);
	// Native WidenPath of square-capped arcs under world scales and map modes other than one logical unit per pixel
	// (scaled-cap-sweep.json.gz): scale 2, 0.5, 0.75, 1.5, a 30 degree rotation, a 1/16 x anisotropic map mode (one logical unit is a FIX
	// across), and a 2 by 1 anisotropic one. "source" is the arc's device GetPath points (FIX) and "expected" the widened outline, both read
	// back with the transform reset, every 2 degrees of sweep at two start angles. "penDevice" is the pen's device width in pixels.
	public static void ScaledCapSweep(string dir) {
		IntPtr dc=CreateCompatibleDC(IntPtr.Zero);var json=new StringBuilder("[");
		// name, circle centre (logical), radius (logical x, y), pen logical width, setup
		string[] names={"s2","s0.5","s0.75","s1.5","rot30","aniso16","aniso2"};
		try {
			foreach(string name in names)foreach(int start in new[]{0,37})for(int a=2;a<360;a+=2){
				SetGraphicsMode(dc,2);SetMapMode(dc,1);var id=new Xform{M11=1,M22=1};SetWorldTransform(dc,ref id);
				double cx,cy,rx,ry;int width;string setup;
				Action apply;
				if(name=="s2"){cx=100;cy=100;rx=ry=50;width=6;apply=delegate(){var t=new Xform{M11=2,M22=2};SetWorldTransform(dc,ref t);};}
				else if(name=="s0.5"){cx=400;cy=400;rx=ry=200;width=24;apply=delegate(){var t=new Xform{M11=0.5f,M22=0.5f};SetWorldTransform(dc,ref t);};}
				else if(name=="s0.75"){cx=264;cy=264;rx=ry=132;width=16;apply=delegate(){var t=new Xform{M11=0.75f,M22=0.75f};SetWorldTransform(dc,ref t);};}
				else if(name=="s1.5"){cx=128;cy=128;rx=ry=64;width=8;apply=delegate(){var t=new Xform{M11=1.5f,M22=1.5f};SetWorldTransform(dc,ref t);};}
				else if(name=="rot30"){cx=0;cy=0;rx=ry=100;width=12;apply=delegate(){double c=Math.Cos(Math.PI/6),s=Math.Sin(Math.PI/6);var t=new Xform{M11=(float)c,M12=(float)s,M21=(float)-s,M22=(float)c,Dx=300,Dy=300};SetWorldTransform(dc,ref t);};}
				else if(name=="aniso16"){cx=3200;cy=200;rx=1600;ry=100;width=48;apply=delegate(){SetMapMode(dc,8);SetWindowExtEx(dc,16,1,IntPtr.Zero);SetViewportExtEx(dc,1,1,IntPtr.Zero);};}
				else {cx=100;cy=200;rx=100;ry=100;width=12;apply=delegate(){SetMapMode(dc,8);SetWindowExtEx(dc,2,1,IntPtr.Zero);SetViewportExtEx(dc,1,1,IntPtr.Zero);};}
				setup=name;
				Func<int,int[]> rad=delegate(int deg){double r=Math.PI*deg/180.0;return new[]{(int)Math.Round(cx+Math.Cos(r)*rx*10),(int)Math.Round(cy-Math.Sin(r)*ry*10)};};
				int[] p1=rad(start),p2=rad((start+a)%360);
				var brush=new LogBrush();IntPtr pen=ExtCreatePen((uint)(0x10000|1*0x100|0*0x1000),(uint)width,ref brush,0,IntPtr.Zero);
				IntPtr old=SelectObject(dc,pen);
				try {
					apply();
					BeginPath(dc);Arc(dc,(int)(cx-rx),(int)(cy-ry),(int)(cx+rx),(int)(cy+ry),p1[0],p1[1],p2[0],p2[1]);EndPath(dc);
					SetMapMode(dc,1);var idn=new Xform{M11=1,M22=1};SetWorldTransform(dc,ref idn);
					string source=ReadFixPath(dc);
					apply();
					if(!WidenPath(dc))throw new Exception("WidenPath failed");
					SetMapMode(dc,1);SetWorldTransform(dc,ref idn);
					string expected=ReadFixPath(dc);
					if(json.Length>1)json.Append(',');
					json.Append("{\"scale\":\"").Append(setup).Append("\",\"width\":").Append(width).Append(",\"start\":").Append(start).Append(",\"sweep\":").Append(a).Append(",\"source\":").Append(source).Append(",\"expected\":").Append(expected).Append('}');
				} finally { SelectObject(dc,old);DeleteObject(pen);SetMapMode(dc,1);var idn2=new Xform{M11=1,M22=1};SetWorldTransform(dc,ref idn2); }
			}
			var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());
			using(var file=File.Create(Path.Combine(dir,"scaled-cap-sweep.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(bytes,0,bytes.Length);
		}finally{DeleteDC(dc);}
	}
	// Native WidenPath of one square-capped straight segment per logical vector (dx, dy) under the same transforms as ScaledCapSweep
	// (scaled-line-caps.json.gz): "source" is the segment's device points (FIX), "expected" the widened rectangle. Vectors run over
	// -40..40 logical units in both axes (an irregular subset) so the cap extension can be fitted as a function of the vector alone.
	public static void ScaledLineCaps(string dir) {
		IntPtr dc=CreateCompatibleDC(IntPtr.Zero);var json=new StringBuilder("[");
		string[] names={"s1","s2","s0.5","s0.75","s1.5","s0.7","s1.3","s2.5","s0.6","rot30","aniso16","aniso2","c10:7","c4:3","c3:4"};
		int[] comps={-40,-23,-13,-7,-3,-1,0,1,2,3,5,7,10,13,17,23,31,40};
		try {
			foreach(string name in names)foreach(int dx in comps)foreach(int dy in comps){
				if(dx==0&&dy==0)continue;
				SetGraphicsMode(dc,2);SetMapMode(dc,1);var id=new Xform{M11=1,M22=1};SetWorldTransform(dc,ref id);
				int width;Action apply;
				if(name=="s1"){width=12;apply=delegate(){};}
				else if(name=="s2"){width=6;apply=delegate(){var t=new Xform{M11=2,M22=2};SetWorldTransform(dc,ref t);};}
				else if(name=="s0.5"){width=24;apply=delegate(){var t=new Xform{M11=0.5f,M22=0.5f};SetWorldTransform(dc,ref t);};}
				else if(name=="s0.75"){width=16;apply=delegate(){var t=new Xform{M11=0.75f,M22=0.75f};SetWorldTransform(dc,ref t);};}
				else if(name=="s1.5"){width=8;apply=delegate(){var t=new Xform{M11=1.5f,M22=1.5f};SetWorldTransform(dc,ref t);};}
				else if(name=="rot30"){width=12;apply=delegate(){double c=Math.Cos(Math.PI/6),s=Math.Sin(Math.PI/6);var t=new Xform{M11=(float)c,M12=(float)s,M21=(float)-s,M22=(float)c,Dx=300,Dy=300};SetWorldTransform(dc,ref t);};}
				else if(name=="aniso16"){width=48;apply=delegate(){SetMapMode(dc,8);SetWindowExtEx(dc,16,1,IntPtr.Zero);SetViewportExtEx(dc,1,1,IntPtr.Zero);};}
				else if(name.StartsWith("s")){float sc=float.Parse(name.Substring(1),System.Globalization.CultureInfo.InvariantCulture);width=(int)Math.Round(12/sc);apply=delegate(){var t=new Xform{M11=sc,M22=sc};SetWorldTransform(dc,ref t);};}
				else if(name.StartsWith("c")){string[] ab=name.Substring(1).Split((char)58);int wa=int.Parse(ab[0]),vb=int.Parse(ab[1]);width=(int)Math.Round(12.0*wa/vb);apply=delegate(){SetGraphicsMode(dc,1);SetMapMode(dc,8);SetWindowExtEx(dc,wa,wa,IntPtr.Zero);SetViewportExtEx(dc,vb,vb,IntPtr.Zero);};}
				else {width=12;apply=delegate(){SetMapMode(dc,8);SetWindowExtEx(dc,2,1,IntPtr.Zero);SetViewportExtEx(dc,1,1,IntPtr.Zero);};}
				int x0=name=="aniso16"?1600:200,y0=200;
				var brush=new LogBrush();IntPtr pen=ExtCreatePen((uint)(0x10000|1*0x100|0*0x1000),(uint)width,ref brush,0,IntPtr.Zero);
				IntPtr old=SelectObject(dc,pen);
				try {
					apply();
					int sx=name=="aniso16"?dx*16:dx;
					BeginPath(dc);Polyline(dc,new[]{new Point{X=x0,Y=y0},new Point{X=x0+sx,Y=y0+dy}},2);EndPath(dc);
					SetMapMode(dc,1);var idn=new Xform{M11=1,M22=1};SetWorldTransform(dc,ref idn);
					string source=ReadFixPath(dc);
					apply();
					if(!WidenPath(dc))throw new Exception("WidenPath failed");
					SetMapMode(dc,1);SetWorldTransform(dc,ref idn);
					string expected=ReadFixPath(dc);
					if(json.Length>1)json.Append(',');
					json.Append("{\"scale\":\"").Append(name).Append("\",\"width\":").Append(width).Append(",\"dx\":").Append(sx).Append(",\"dy\":").Append(dy).Append(",\"source\":").Append(source).Append(",\"expected\":").Append(expected).Append('}');
				} finally { SelectObject(dc,old);DeleteObject(pen);SetMapMode(dc,1);var idn2=new Xform{M11=1,M22=1};SetWorldTransform(dc,ref idn2); }
			}
			var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());
			using(var file=File.Create(Path.Combine(dir,"scaled-line-caps.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(bytes,0,bytes.Length);
		}finally{DeleteDC(dc);}
	}
	// The device width of a geometric pen under a uniform world scale (scaled-pen-widths.json): a flat-capped horizontal line per logical
	// width 1..40 and scale; "expected" holds the widened rectangle, whose height is the device width in FIX, and "expectedVertical" the same for a vertical line (whose width is the device x width).
	public static void ScaledPenWidths(string dir) {
		IntPtr dc=CreateCompatibleDC(IntPtr.Zero);var json=new StringBuilder("[");
		try {
			foreach(float sc in new[]{0.3f,0.5f,0.7f,0.9f,1.1f,1.3f,1.7f,2f,2.5f,3.3f})for(int width=1;width<=40;width++){
				SetGraphicsMode(dc,2);SetMapMode(dc,1);var id=new Xform{M11=1,M22=1};SetWorldTransform(dc,ref id);
				var brush=new LogBrush();IntPtr pen=ExtCreatePen((uint)(0x10000|2*0x100),(uint)width,ref brush,0,IntPtr.Zero);
				IntPtr old=SelectObject(dc,pen);
				try {
					var t=new Xform{M11=sc,M22=sc};SetWorldTransform(dc,ref t);
					BeginPath(dc);Polyline(dc,new[]{new Point{X=100,Y=100},new Point{X=140,Y=100}},2);EndPath(dc);
					if(!WidenPath(dc))throw new Exception("WidenPath failed");
					SetMapMode(dc,1);SetWorldTransform(dc,ref id);
					string horizontal=ReadFixPath(dc);
					SetWorldTransform(dc,ref t);
					BeginPath(dc);Polyline(dc,new[]{new Point{X=100,Y=100},new Point{X=100,Y=140}},2);EndPath(dc);
					if(!WidenPath(dc))throw new Exception("WidenPath failed");
					SetMapMode(dc,1);SetWorldTransform(dc,ref id);
					if(json.Length>1)json.Append(',');
					json.Append("{\"scale\":").Append(sc.ToString("R",System.Globalization.CultureInfo.InvariantCulture)).Append(",\"width\":").Append(width).Append(",\"expected\":").Append(horizontal).Append(",\"expectedVertical\":").Append(ReadFixPath(dc)).Append('}');
				} finally { SelectObject(dc,old);DeleteObject(pen);SetMapMode(dc,1);var idn2=new Xform{M11=1,M22=1};SetWorldTransform(dc,ref idn2); }
			}
			// The same through a map mode: window/viewport extents 10:7 (scale 0.7) and 16:1 (a logical unit is a FIX), so the world
			// transform's rounding of the width can be told from the map mode's.
			foreach(int[] ext in new[]{new[]{10,7},new[]{16,1},new[]{4,3},new[]{1,3}})for(int width=1;width<=40;width++){
				SetGraphicsMode(dc,2);SetMapMode(dc,1);var id=new Xform{M11=1,M22=1};SetWorldTransform(dc,ref id);
				var brush=new LogBrush();IntPtr pen=ExtCreatePen((uint)(0x10000|2*0x100),(uint)(width*(ext[0]==16?4:1)),ref brush,0,IntPtr.Zero);
				IntPtr old=SelectObject(dc,pen);
				try {
					SetMapMode(dc,8);SetWindowExtEx(dc,ext[0],ext[0],IntPtr.Zero);SetViewportExtEx(dc,ext[1],ext[1],IntPtr.Zero);
					BeginPath(dc);Polyline(dc,new[]{new Point{X=100,Y=100},new Point{X=140,Y=100}},2);EndPath(dc);
					if(!WidenPath(dc))throw new Exception("WidenPath failed");
					SetMapMode(dc,1);
					string horizontal=ReadFixPath(dc);
					SetMapMode(dc,8);SetWindowExtEx(dc,ext[0],ext[0],IntPtr.Zero);SetViewportExtEx(dc,ext[1],ext[1],IntPtr.Zero);
					BeginPath(dc);Polyline(dc,new[]{new Point{X=100,Y=100},new Point{X=100,Y=140}},2);EndPath(dc);
					if(!WidenPath(dc))throw new Exception("WidenPath failed");
					SetMapMode(dc,1);
					if(json.Length>1)json.Append(',');
					json.Append("{\"scale\":\"mm").Append(ext[0]).Append(':').Append(ext[1]).Append("\",\"width\":").Append(width*(ext[0]==16?4:1)).Append(",\"expected\":").Append(horizontal).Append(",\"expectedVertical\":").Append(ReadFixPath(dc)).Append('}');
				} finally { SelectObject(dc,old);DeleteObject(pen);SetMapMode(dc,1); }
			}
			File.WriteAllText(Path.Combine(dir,"scaled-pen-widths.json"),json.Append(']').ToString());
		}finally{DeleteDC(dc);}
	}
	// Native WidenPath of chords whose arc is nearly a whole turn (330 to 359.5 degrees in half-degree steps, so the closing line is a few pixels
	// long) on the ellipse of curve-widen.json sample 206 (box 103,99 to 195,235) and on a circle of radius 100, from four start angles, width 9,
	// every cap and join (chord-closing.json.gz), then the neighbourhood of sample 206: the chord's own GetPath points ("source", FIX) and the widened outline ("expected").
	public static void ChordClosing(string dir) {
		IntPtr dc=CreateCompatibleDC(IntPtr.Zero);var json=new StringBuilder("[");
		int[][] boxes={new[]{103,99,195,235},new[]{100,100,300,300}};
		try {
			foreach(int[] bx in boxes)foreach(double start in new[]{-71.1,0,37,120})for(int half=660;half<=719;half++)for(int cap=0;cap<3;cap++)for(int join=0;join<3;join++){
				double sweep=half/2.0,cx=(bx[0]+bx[2])/2.0,cy=(bx[1]+bx[3])/2.0;
				double a0=Math.PI*start/180.0,a1=Math.PI*(start+sweep)/180.0;
				int[] p1=new[]{(int)Math.Round(cx+Math.Cos(a0)*1000),(int)Math.Round(cy-Math.Sin(a0)*1000)},p2=new[]{(int)Math.Round(cx+Math.Cos(a1)*1000),(int)Math.Round(cy-Math.Sin(a1)*1000)};
				SetMapMode(dc,1);
				var brush=new LogBrush();IntPtr pen=ExtCreatePen((uint)(0x10000|cap*0x100|join*0x1000),(uint)9,ref brush,0,IntPtr.Zero);
				IntPtr old=SelectObject(dc,pen);
				try {
					BeginPath(dc);Chord(dc,bx[0],bx[1],bx[2],bx[3],p1[0],p1[1],p2[0],p2[1]);EndPath(dc);
					string source=ReadFixPath(dc);
					if(!WidenPath(dc))throw new Exception("WidenPath failed");
					if(json.Length>1)json.Append(',');
					json.Append("{\"box\":[").Append(string.Join(",",bx)).Append("],\"start\":").Append(start.ToString("R",System.Globalization.CultureInfo.InvariantCulture)).Append(",\"sweep\":").Append(sweep.ToString("R",System.Globalization.CultureInfo.InvariantCulture)).Append(",\"cap\":").Append(cap).Append(",\"join\":").Append(join).Append(",\"source\":").Append(source).Append(",\"expected\":").Append(ReadFixPath(dc)).Append('}');
				} finally { SelectObject(dc,old);DeleteObject(pen); }
			}
			// The neighbourhood of curve-widen.json sample 206: the same box and start radial (175, 243), the end radial (172, 250) moved by up to 6 pixels each way.
			for(int ddx=-6;ddx<=6;ddx++)for(int ddy=-6;ddy<=6;ddy++)for(int cap=0;cap<3;cap++)for(int join=0;join<3;join++){
				int[] p1=new[]{175,243},p2=new[]{172+ddx,250+ddy};
				SetMapMode(dc,1);
				var brush=new LogBrush();IntPtr pen=ExtCreatePen((uint)(0x10000|cap*0x100|join*0x1000),(uint)9,ref brush,0,IntPtr.Zero);
				IntPtr old=SelectObject(dc,pen);
				try {
					BeginPath(dc);Chord(dc,103,99,195,235,p1[0],p1[1],p2[0],p2[1]);EndPath(dc);
					string source=ReadFixPath(dc);
					if(!WidenPath(dc))throw new Exception("WidenPath failed");
					json.Append(",{\"box\":[103,99,195,235],\"radials\":[175,243,").Append(p2[0]).Append(',').Append(p2[1]).Append("],\"cap\":").Append(cap).Append(",\"join\":").Append(join).Append(",\"source\":").Append(source).Append(",\"expected\":").Append(ReadFixPath(dc)).Append('}');
				} finally { SelectObject(dc,old);DeleteObject(pen); }
			}
			var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());
			using(var file=File.Create(Path.Combine(dir,"chord-closing.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(bytes,0,bytes.Length);
		}finally{DeleteDC(dc);}
	}
	// Native WidenPath of chords whose arc is very short (1 to 15 degrees in half-degree steps on a circle of radius 100 px, so the arc flattens
	// to one or two segments that the closing line retraces), at two widths under every cap and join (chord-sweep.json.gz): the chord's
	// own GetPath points ("source", FIX) and the widened outline ("expected").
	public static void ChordSweep(string dir) {
		IntPtr dc=CreateCompatibleDC(IntPtr.Zero);var json=new StringBuilder("[");
		try {
			foreach(int width in new[]{9,16})foreach(int start in new[]{0,37})for(int tenths=10;tenths<=150;tenths+=5)for(int cap=0;cap<3;cap++)for(int join=0;join<3;join++){
				double a0=Math.PI*start/180.0,a1=Math.PI*(start+tenths/10.0)/180.0;
				int[] p1=new[]{(int)Math.Round(200+Math.Cos(a0)*1000),(int)Math.Round(200-Math.Sin(a0)*1000)},p2=new[]{(int)Math.Round(200+Math.Cos(a1)*1000),(int)Math.Round(200-Math.Sin(a1)*1000)};
				SetMapMode(dc,1);
				var brush=new LogBrush();IntPtr pen=ExtCreatePen((uint)(0x10000|cap*0x100|join*0x1000),(uint)width,ref brush,0,IntPtr.Zero);
				IntPtr old=SelectObject(dc,pen);
				try {
					BeginPath(dc);Chord(dc,100,100,300,300,p1[0],p1[1],p2[0],p2[1]);EndPath(dc);
					string source=ReadFixPath(dc);
					if(!WidenPath(dc))throw new Exception("WidenPath failed");
					if(json.Length>1)json.Append(',');
					json.Append("{\"width\":").Append(width).Append(",\"start\":").Append(start).Append(",\"tenths\":").Append(tenths).Append(",\"cap\":").Append(cap).Append(",\"join\":").Append(join).Append(",\"source\":").Append(source).Append(",\"expected\":").Append(ReadFixPath(dc)).Append('}');
				} finally { SelectObject(dc,old);DeleteObject(pen); }
			}
			var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());
			using(var file=File.Create(Path.Combine(dir,"chord-sweep.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(bytes,0,bytes.Length);
		}finally{DeleteDC(dc);}
	}
	// Native WidenPath of a square-capped, round-joined arc on a circle of radius 100 px, sweeping the end angle in whole degrees
	// (1..359) at two widths and two start angles (arc-cap-sweep.json.gz): the arc's own GetPath points ("source", FIX) and the
	// widened outline ("expected"), isolating the cap extension from every other stage.
	public static void ArcCapSweep(string dir) {
		IntPtr dc=CreateCompatibleDC(IntPtr.Zero);var json=new StringBuilder("[");
		try {
			foreach(int width in new[]{9,16})foreach(int start in new[]{0,37})for(int a=1;a<360;a++){
				int end=(start+a)%360;
				Func<int,int[]> rad=delegate(int deg){double r=Math.PI*deg/180.0;return new[]{(int)Math.Round(200+Math.Cos(r)*1000),(int)Math.Round(200-Math.Sin(r)*1000)};};
				int[] p1=rad(start),p2=rad(end);
				SetMapMode(dc,1);
				var brush=new LogBrush();IntPtr pen=ExtCreatePen((uint)(0x10000|1*0x100|0*0x1000),(uint)width,ref brush,0,IntPtr.Zero);
				IntPtr old=SelectObject(dc,pen);
				try {
					BeginPath(dc);Arc(dc,100,100,300,300,p1[0],p1[1],p2[0],p2[1]);EndPath(dc);
					string source=ReadFixPath(dc);
					if(!WidenPath(dc))throw new Exception("WidenPath failed");
					if(json.Length>1)json.Append(',');
					json.Append("{\"width\":").Append(width).Append(",\"start\":").Append(start).Append(",\"sweep\":").Append(a).Append(",\"source\":").Append(source).Append(",\"expected\":").Append(ReadFixPath(dc)).Append('}');
				} finally { SelectObject(dc,old);DeleteObject(pen); }
			}
			var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());
			using(var file=File.Create(Path.Combine(dir,"arc-cap-sweep.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(bytes,0,bytes.Length);
		}finally{DeleteDC(dc);}
	}
	[DllImport("gdi32.dll",EntryPoint="ExtCreatePen")] static extern IntPtr ExtCreatePenDashes(uint style,uint width,ref LogBrush brush,uint count,uint[] dashes);
	// Native WidenPath of dashed wide pens on Beziers and arcs at the identity scale: the stock dash styles and user-defined patterns
	// under round, square and flat caps, and the pixel-vector dash measurement they reveal (curve-dash.json).
	public static void CurveDash(string dir) {
		IntPtr dc=CreateCompatibleDC(IntPtr.Zero);var random=new Random(9203);var json=new StringBuilder("[");
		int[] stock={1,2,3,4,7};
		try {
			for(int sample=0;sample<300;sample++) {
				int kind=sample%3==2?1:0,style=stock[(sample/3)%stock.Length],cap=(sample/15)%3,width=4+random.Next(0,11);
				uint[] dashes=null;string dashJson="[]";
				if(style==7){int count=2*(1+random.Next(0,2));dashes=new uint[count];for(int i=0;i<count;i++)dashes[i]=(uint)(3+random.Next(0,23));dashJson="["+string.Join(",",Array.ConvertAll(dashes,v=>v.ToString()))+"]";}
				SetMapMode(dc,1);
				var brush=new LogBrush();IntPtr pen=ExtCreatePenDashes((uint)(0x10000|style|cap*0x100),(uint)width,ref brush,dashes==null?0u:(uint)dashes.Length,dashes);
				if(pen==IntPtr.Zero)throw new Exception("ExtCreatePen failed");
				IntPtr old=SelectObject(dc,pen);
				try {
					string head;
					BeginPath(dc);
					if(kind==0){
						var p=new Point[4];for(int i=0;i<4;i++){p[i].X=40+random.Next(0,160);p[i].Y=40+random.Next(0,160);}
						PolyBezier(dc,p,4);
						head="\"kind\":\"bezier\",\"points\":["+string.Join(",",new[]{p[0].X,p[0].Y,p[1].X,p[1].Y,p[2].X,p[2].Y,p[3].X,p[3].Y})+"]";
					} else {
						int w=40+random.Next(0,120),h=40+random.Next(0,120),l=50+random.Next(0,60),t=50+random.Next(0,60);
						Func<int[]> pt=delegate(){double a=random.NextDouble()*Math.PI*2,rad=0.6+random.NextDouble()*1.2;return new[]{(int)Math.Round(l+w/2.0+Math.Cos(a)*w/2.0*rad),(int)Math.Round(t+h/2.0-Math.Sin(a)*h/2.0*rad)};};
						int[] p1=pt(),p2=pt();
						Arc(dc,l,t,l+w,t+h,p1[0],p1[1],p2[0],p2[1]);
						head="\"kind\":\"arc\",\"box\":["+l+","+t+","+(l+w)+","+(t+h)+"],\"radials\":["+p1[0]+","+p1[1]+","+p2[0]+","+p2[1]+"]";
					}
					EndPath(dc);if(!WidenPath(dc))throw new Exception("WidenPath failed");
					if(json.Length>1)json.Append(',');
					json.Append('{').Append(head).Append(",\"style\":").Append(style).Append(",\"cap\":").Append(cap).Append(",\"width\":").Append(width).Append(",\"dashes\":").Append(dashJson).Append(",\"expected\":").Append(ReadFixPath(dc)).Append('}');
				} finally { SelectObject(dc,old);DeleteObject(pen); }
			}
			File.WriteAllText(Path.Combine(dir,"curve-dash.json"),json.Append(']').ToString());
		}finally{DeleteDC(dc);}
	}
	// The neighbourhood of curve-dash.json sample 117 (the Bezier (70,105) (162,65) (147,194) (170,164), width 13, square caps, user style 21 12 9 23):
	// the second control point moved by -2..2 pixels in each axis and the first dash 15..40 pixels long, with the other lengths kept
	// (curve-dash-neighbourhood.json.gz), to find what makes a dash start one FIX away.
	public static void CurveDashNeighbourhood(string dir) {
		IntPtr dc=CreateCompatibleDC(IntPtr.Zero);var json=new StringBuilder("[");
		try {
			for(int dx=-2;dx<=2;dx++)for(int dy=-2;dy<=2;dy++)for(int on=15;on<=40;on++)for(int cap=1;cap<=2;cap++){
				uint[] dashes=new uint[]{(uint)on,12,9,23};
				SetMapMode(dc,1);
				var brush=new LogBrush();IntPtr pen=ExtCreatePenDashes((uint)(0x10000|7|cap*0x100),13u,ref brush,4u,dashes);
				if(pen==IntPtr.Zero)throw new Exception("ExtCreatePen failed");
				IntPtr old=SelectObject(dc,pen);
				try {
					var p=new Point[]{new Point{X=70,Y=105},new Point{X=162+dx,Y=65+dy},new Point{X=147,Y=194},new Point{X=170,Y=164}};
					BeginPath(dc);PolyBezier(dc,p,4);EndPath(dc);
					if(!WidenPath(dc))throw new Exception("WidenPath failed");
					if(json.Length>1)json.Append(',');
					json.Append("{\"points\":[70,105,").Append(162+dx).Append(',').Append(65+dy).Append(",147,194,170,164],\"style\":7,\"cap\":").Append(cap).Append(",\"width\":13,\"dashes\":[").Append(on).Append(",12,9,23],\"expected\":").Append(ReadFixPath(dc)).Append('}');
				} finally { SelectObject(dc,old);DeleteObject(pen); }
			}
			// The neighbourhood of curve-dash.json sample 128 (an Arc on the box 53,53 to 95,210 from the radial (49,169) to (110,107), flat caps, a dotted
			// pen 5 pixels wide): the end radial moved by up to 3 pixels each way, widths 3 to 8, the dash, dot and dash-dot styles.
			foreach(int style in new[]{0,2,3,4})for(int wd=2;wd<=9;wd++)for(int ddx=-3;ddx<=3;ddx++)for(int ddy=-3;ddy<=3;ddy++){
				if(style==0&&(ddx!=0||ddy!=0))continue;
				SetMapMode(dc,1);
				var brush=new LogBrush();IntPtr pen=ExtCreatePenDashes((uint)(0x10000|style|2*0x100),(uint)wd,ref brush,0u,null);
				if(pen==IntPtr.Zero)throw new Exception("ExtCreatePen failed");
				IntPtr old=SelectObject(dc,pen);
				try {
					BeginPath(dc);Arc(dc,53,53,95,210,49,169,110+ddx,107+ddy);EndPath(dc);
					if(!WidenPath(dc))throw new Exception("WidenPath failed");
					json.Append(",{\"kind\":\"arc\",\"box\":[53,53,95,210],\"radials\":[49,169,").Append(110+ddx).Append(',').Append(107+ddy).Append("],\"style\":").Append(style).Append(",\"cap\":2,\"width\":").Append(wd).Append(",\"dashes\":[],\"expected\":").Append(ReadFixPath(dc)).Append('}');
				} finally { SelectObject(dc,old);DeleteObject(pen); }
			}
			var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());
			using(var file=File.Create(Path.Combine(dir,"curve-dash-neighbourhood.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(bytes,0,bytes.Length);
		}finally{DeleteDC(dc);}
	}
	// Native WidenPath of dashed, square-capped arcs under the transforms of ScaledCapSweep (scaled-dash-caps.json.gz): scales 2, 0.5, 0.75,
	// 1.5 and the 1/16 and 2 by 1 anisotropic map modes, a stock PS_DASH pen and a user style, every 6 degrees of sweep at two start angles.
	// "source" is the arc's device GetPath points (FIX), "expected" the widened outline; "dashes" is the user style in logical units (empty for stock).
	public static void ScaledDashCaps(string dir) {
		IntPtr dc=CreateCompatibleDC(IntPtr.Zero);var json=new StringBuilder("[");
		string[] names={"s2","s0.5","s0.75","s1.5","aniso16","aniso2"};
		try {
			foreach(string name in names)foreach(int style in new[]{1,7})foreach(int start in new[]{0,37})for(int a=6;a<360;a+=6){
				SetGraphicsMode(dc,2);SetMapMode(dc,1);var id=new Xform{M11=1,M22=1};SetWorldTransform(dc,ref id);
				double cx,cy,rx,ry;int width;Action apply;uint[] user;
				if(name=="s2"){cx=100;cy=100;rx=ry=50;width=6;user=new uint[]{9,4,3,4};apply=delegate(){var t=new Xform{M11=2,M22=2};SetWorldTransform(dc,ref t);};}
				else if(name=="s0.5"){cx=400;cy=400;rx=ry=200;width=24;user=new uint[]{40,16,8,16};apply=delegate(){var t=new Xform{M11=0.5f,M22=0.5f};SetWorldTransform(dc,ref t);};}
				else if(name=="s0.75"){cx=264;cy=264;rx=ry=132;width=16;user=new uint[]{24,12,8,12};apply=delegate(){var t=new Xform{M11=0.75f,M22=0.75f};SetWorldTransform(dc,ref t);};}
				else if(name=="s1.5"){cx=128;cy=128;rx=ry=64;width=8;user=new uint[]{14,6,4,6};apply=delegate(){var t=new Xform{M11=1.5f,M22=1.5f};SetWorldTransform(dc,ref t);};}
				else if(name=="aniso16"){cx=3200;cy=200;rx=1600;ry=100;width=48;user=new uint[]{480,160,96,160};apply=delegate(){SetMapMode(dc,8);SetWindowExtEx(dc,16,1,IntPtr.Zero);SetViewportExtEx(dc,1,1,IntPtr.Zero);};}
				else {cx=100;cy=200;rx=100;ry=100;width=12;user=new uint[]{20,8,6,8};apply=delegate(){SetMapMode(dc,8);SetWindowExtEx(dc,2,1,IntPtr.Zero);SetViewportExtEx(dc,1,1,IntPtr.Zero);};}
				Func<int,int[]> rad=delegate(int deg){double r=Math.PI*deg/180.0;return new[]{(int)Math.Round(cx+Math.Cos(r)*rx*10),(int)Math.Round(cy-Math.Sin(r)*ry*10)};};
				int[] p1=rad(start),p2=rad((start+a)%360);
				var brush=new LogBrush();IntPtr pen=ExtCreatePenDashes((uint)(0x10000|style|1*0x100),(uint)width,ref brush,style==7?(uint)user.Length:0u,style==7?user:null);
				if(pen==IntPtr.Zero)throw new Exception("ExtCreatePen failed");
				IntPtr old=SelectObject(dc,pen);
				try {
					apply();
					BeginPath(dc);Arc(dc,(int)(cx-rx),(int)(cy-ry),(int)(cx+rx),(int)(cy+ry),p1[0],p1[1],p2[0],p2[1]);EndPath(dc);
					SetMapMode(dc,1);var idn=new Xform{M11=1,M22=1};SetWorldTransform(dc,ref idn);
					string source=ReadFixPath(dc);
					apply();
					if(!WidenPath(dc))throw new Exception("WidenPath failed");
					SetMapMode(dc,1);SetWorldTransform(dc,ref idn);
					string expected=ReadFixPath(dc);
					if(json.Length>1)json.Append(',');
					json.Append("{\"scale\":\"").Append(name).Append("\",\"style\":").Append(style).Append(",\"dashes\":[").Append(style==7?string.Join(",",user):"").Append("],\"width\":").Append(width).Append(",\"start\":").Append(start).Append(",\"sweep\":").Append(a).Append(",\"source\":").Append(source).Append(",\"expected\":").Append(expected).Append('}');
				} finally { SelectObject(dc,old);DeleteObject(pen);SetMapMode(dc,1);var idn2=new Xform{M11=1,M22=1};SetWorldTransform(dc,ref idn2); }
			}
			var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());
			using(var file=File.Create(Path.Combine(dir,"scaled-dash-caps.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(bytes,0,bytes.Length);
		}finally{DeleteDC(dc);}
	}
	// Native WidenPath of the Beziers listed in curve-end-reversal-cases.txt (curve-end-reversal.json.gz; generate-curve-end-reversal.ts writes the list): each
	// line is eight device pixel coordinates of a Bezier whose end tangent (P3 - P2) is exactly opposite to its last flattened segment, so the curve
	// runs past its end point and returns. Every case is widened under the identity map and under a 2 by 1 anisotropic map (the logical points are
	// the device ones scaled back; a 12 unit pen), with square, flat and round caps. "source" is the device GetPath points (FIX), "expected" the outline.
	public static void CurveEndReversal(string dir) {
		IntPtr dc=CreateCompatibleDC(IntPtr.Zero);var json=new StringBuilder("[");
		try {
			foreach(string line in File.ReadAllLines(Path.Combine(dir,"curve-end-reversal-cases.txt"))){
				if(line.Trim().Length==0)continue;
				var f=line.Trim().Split(' ');var v=new int[f.Length];for(int i=0;i<f.Length;i++)v[i]=int.Parse(f[i]);
				foreach(string map in new[]{"id","x2"})foreach(int cap in new[]{1,2,0}){
					SetGraphicsMode(dc,2);SetMapMode(dc,1);
					int mx=map=="x2"?2:1,my=map=="y2"?2:1;
					var p=new Point[4];for(int i=0;i<4;i++)p[i]=new Point{X=v[2*i]*mx,Y=v[2*i+1]*my};
					var brush=new LogBrush();IntPtr pen=ExtCreatePen((uint)(0x10000|cap*0x100),12u,ref brush,0,IntPtr.Zero);
					IntPtr old=SelectObject(dc,pen);
					try {
						if(map!="id"){SetMapMode(dc,8);SetWindowExtEx(dc,mx,my,IntPtr.Zero);SetViewportExtEx(dc,1,1,IntPtr.Zero);}
						BeginPath(dc);PolyBezier(dc,p,4);EndPath(dc);
						SetMapMode(dc,1);string source=ReadFixPath(dc);
						if(map!="id"){SetMapMode(dc,8);SetWindowExtEx(dc,mx,my,IntPtr.Zero);SetViewportExtEx(dc,1,1,IntPtr.Zero);}
						if(!WidenPath(dc))throw new Exception("WidenPath failed");
						SetMapMode(dc,1);string expected=ReadFixPath(dc);
						if(json.Length>1)json.Append(',');
						json.Append("{\"map\":\"").Append(map).Append("\",\"cap\":").Append(cap).Append(",\"width\":12,\"points\":[").Append(string.Join(",",v)).Append("],\"source\":").Append(source).Append(",\"expected\":").Append(expected).Append('}');
					} finally { SelectObject(dc,old);DeleteObject(pen);SetMapMode(dc,1); }
				}
			}
			var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());
			using(var file=File.Create(Path.Combine(dir,"curve-end-reversal.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(bytes,0,bytes.Length);
		}finally{DeleteDC(dc);}
	}
	// Native WidenPath of two-segment polylines whose second segment is a few FIX long, under the 1/16 anisotropic map modes in which one logical
	// unit is one FIX across (tiny-final-segment-lines.json.gz): a 400 unit first segment either way along the map's thin axis, then a second segment of
	// -24..24 units along the same axis (collinear, reversed, or none), square, flat and round caps, a 48 unit pen (3 by 48 pixels).
	// "source" is the device GetPath points (FIX), "expected" the widened outline.
	public static void TinyFinalSegmentLines(string dir) {
		IntPtr dc=CreateCompatibleDC(IntPtr.Zero);var json=new StringBuilder("[");
		try {
			foreach(string map in new[]{"x16","y16"})foreach(int sign in new[]{1,-1})for(int b=-24;b<=24;b++)foreach(int cap in new[]{1,2,0}){
				SetGraphicsMode(dc,2);SetMapMode(dc,1);
				bool x=map=="x16";
				var brush=new LogBrush();IntPtr pen=ExtCreatePen((uint)(0x10000|cap*0x100),48u,ref brush,0,IntPtr.Zero);
				IntPtr old=SelectObject(dc,pen);
				try {
					SetMapMode(dc,8);if(x)SetWindowExtEx(dc,16,1,IntPtr.Zero);else SetWindowExtEx(dc,1,16,IntPtr.Zero);SetViewportExtEx(dc,1,1,IntPtr.Zero);
					int ox=x?1600:200,oy=x?200:1600;
					var p=new Point[3];
					p[0]=new Point{X=ox,Y=oy};
					p[1]=x?new Point{X=ox+sign*400,Y=oy}:new Point{X=ox,Y=oy+sign*400};
					p[2]=x?new Point{X=p[1].X+b,Y=oy}:new Point{X=ox,Y=p[1].Y+b};
					BeginPath(dc);Polyline(dc,p,3);EndPath(dc);
					SetMapMode(dc,1);string source=ReadFixPath(dc);
					SetMapMode(dc,8);if(x)SetWindowExtEx(dc,16,1,IntPtr.Zero);else SetWindowExtEx(dc,1,16,IntPtr.Zero);SetViewportExtEx(dc,1,1,IntPtr.Zero);
					if(!WidenPath(dc))throw new Exception("WidenPath failed");
					SetMapMode(dc,1);string expected=ReadFixPath(dc);
					if(json.Length>1)json.Append(',');
					json.Append("{\"map\":\"").Append(map).Append("\",\"sign\":").Append(sign).Append(",\"b\":").Append(b).Append(",\"cap\":").Append(cap).Append(",\"width\":48,\"source\":").Append(source).Append(",\"expected\":").Append(expected).Append('}');
				} finally { SelectObject(dc,old);DeleteObject(pen);SetMapMode(dc,1); }
			}
			var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());
			using(var file=File.Create(Path.Combine(dir,"tiny-final-segment-lines.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(bytes,0,bytes.Length);
		}finally{DeleteDC(dc);}
	}
	// Native WidenPath of the dashed Beziers listed in dash-cut-tie-cases.txt (written by generate-dash-cut-ties.ts): one case per line,
	// "cap width x0 y0 x1 y1 x2 y2 x3 y3 d0 d1 d2 d3" with a user-style dash array in pixels (zero entries dropped). The generator picks Beziers
	// whose dash cut points sit within 6e-4 FIX of a rounding tie, so the capture reads which way Windows rounds them.
	public static void DashCutTies(string dir) {
		IntPtr dc=CreateCompatibleDC(IntPtr.Zero);var json=new StringBuilder("[");
		try {
			foreach(string line in File.ReadAllLines(Path.Combine(dir,"dash-cut-tie-cases.txt"))){
				if(line.Trim().Length==0)continue;
				var f=line.Trim().Split(' ');var v=new int[f.Length];for(int i=0;i<f.Length;i++)v[i]=int.Parse(f[i]);
				int cap=v[0],width=v[1];var p=new Point[4];for(int i=0;i<4;i++)p[i]=new Point{X=v[2+2*i],Y=v[3+2*i]};
				var dl=new System.Collections.Generic.List<uint>();for(int i=10;i<v.Length;i++)if(v[i]>0)dl.Add((uint)v[i]);
				uint[] dashes=dl.ToArray();
				SetMapMode(dc,1);
				var brush=new LogBrush();IntPtr pen=ExtCreatePenDashes((uint)(0x10000|7|cap*0x100),(uint)width,ref brush,(uint)dashes.Length,dashes);
				if(pen==IntPtr.Zero)throw new Exception("ExtCreatePen failed");
				IntPtr old=SelectObject(dc,pen);
				try {
					BeginPath(dc);PolyBezier(dc,p,4);EndPath(dc);
					if(!WidenPath(dc))throw new Exception("WidenPath failed");
					if(json.Length>1)json.Append(',');
					json.Append("{\"points\":[");for(int i=0;i<8;i++){if(i>0)json.Append(',');json.Append(v[2+i]);}
					json.Append("],\"style\":7,\"cap\":").Append(cap).Append(",\"width\":").Append(width).Append(",\"dashes\":[").Append(string.Join(",",dashes)).Append("],\"expected\":").Append(ReadFixPath(dc)).Append('}');
				} finally { SelectObject(dc,old);DeleteObject(pen); }
			}
			var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());
			using(var file=File.Create(Path.Combine(dir,"dash-cut-ties.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(bytes,0,bytes.Length);
		}finally{DeleteDC(dc);}
	}

	/**
	 * `DashCutTies` with a straight run in front of the curve: a horizontal line of k whole periods of the dash pattern ending at the curve's start, so
	 * every dash cut on the curve falls on the same fractions (the pattern starts again at the curve) but the walk has already travelled k periods.
	 * Reads `dash-lengthened-cases.txt` (lines of `DashCutTies` cases) and writes `dash-lengthened.json.gz` (case, k and the outline).
	 */
	public static void DashLengthened(string dir) {
		IntPtr dc=CreateCompatibleDC(IntPtr.Zero);var json=new StringBuilder("[");
		try {
			int caseIndex=0;
			foreach(string line in File.ReadAllLines(Path.Combine(dir,"dash-lengthened-cases.txt"))){
				if(line.Trim().Length==0)continue;
				var f=line.Trim().Split(' ');var v=new int[f.Length];for(int i=0;i<f.Length;i++)v[i]=int.Parse(f[i]);
				int cap=v[0],width=v[1];var p=new Point[4];for(int i=0;i<4;i++)p[i]=new Point{X=v[2+2*i],Y=v[3+2*i]};
				var dl=new System.Collections.Generic.List<uint>();for(int i=10;i<v.Length;i++)if(v[i]>0)dl.Add((uint)v[i]);
				uint[] dashes=dl.ToArray();int period=0;foreach(uint d in dashes)period+=(int)d;
				foreach(int k in new[]{1,64,512}){
					SetMapMode(dc,1);
					var brush=new LogBrush();IntPtr pen=ExtCreatePenDashes((uint)(0x10000|7|cap*0x100),(uint)width,ref brush,(uint)dashes.Length,dashes);
					IntPtr old=SelectObject(dc,pen);
					try {
						BeginPath(dc);MoveToEx(dc,p[0].X-k*period,p[0].Y,IntPtr.Zero);LineTo(dc,p[0].X,p[0].Y);PolyBezierTo(dc,new[]{p[1],p[2],p[3]},3);EndPath(dc);
						if(!WidenPath(dc))throw new Exception("WidenPath failed");
						if(json.Length>1)json.Append(',');
						json.Append("{\"case\":").Append(caseIndex).Append(",\"k\":").Append(k).Append(",\"period\":").Append(period).Append(",\"points\":[");for(int i=0;i<8;i++){if(i>0)json.Append(',');json.Append(v[2+i]);}
						json.Append("],\"cap\":").Append(cap).Append(",\"width\":").Append(width).Append(",\"dashes\":[").Append(string.Join(",",dashes)).Append("],\"expected\":").Append(ReadFixPath(dc)).Append('}');
					} finally { SelectObject(dc,old);DeleteObject(pen); }
				}
				caseIndex++;
			}
			var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());
			using(var file=File.Create(Path.Combine(dir,"dash-lengthened.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(bytes,0,bytes.Length);
		}finally{DeleteDC(dc);}
	}
}
