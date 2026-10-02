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
}
