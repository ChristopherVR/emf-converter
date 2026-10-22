// Per-vertex path gradients built so that every edge colour is exact in any arithmetic: a fan triangle
// (centre C, p0, p1) whose p0-C edge is vertical and whose other two edges are 256 rows tall (y-major,
// t = k / 256), with colours that are multiples of 64, so the colour at each scanline end is a whole
// number of quarter levels. The span between them (cL, cR, n pixels) is then the only inexact stage.
// The vertical edge's x moves on the 1/16 grid (the span's start fraction), the right vertex's x sets
// the span length per row. Whole images are captured (red channel and alpha, two bytes a pixel); the
// other two fans lie above and to the left (p2 is one or two pixels left of C, so C stays inside).
//
//  - `span<i>`: 60 random colour triples, start fractions and widths.
//  - `const_x<i>`, `const_w<i>`: centre 64, p0 192, p1 128 makes the left and right edge colours equal on every
//    row (the colour plane does not change along x), so only the rounding of equal values shows; the start
//    fraction (x) and the right vertex (w) are swept.
// A surround whose three colours are equal is a uniform one (nested copies, not this fan), so the third vertex
// colour of the random cases is drawn apart from the other two where they are equal.
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.IO.Compression; using System.Text; using System.Globalization;
public static class PathGradientSpanProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static string RedAlpha(Bitmap bitmap){
  var bits=bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
  try{
   int w=bitmap.Width,h=bitmap.Height;byte[] row=new byte[w*4];byte[] d=new byte[w*2*h];
   for(int y=0;y<h;y++){Marshal.Copy(IntPtr.Add(bits.Scan0,y*bits.Stride),row,0,w*4);for(int x=0;x<w;x++){d[(y*w+x)*2]=row[x*4+2];d[(y*w+x)*2+1]=row[x*4+3];}}
   return Convert.ToBase64String(d);
  }finally{bitmap.UnlockBits(bits);}
 }
 static void One(StringBuilder json,string name,int W,int H,PointF[] pts,Color[] colors,PointF center,Color centerColor){
  using(var bitmap=new Bitmap(W,H,PixelFormat.Format32bppArgb))using(var path=new GraphicsPath()){
   path.AddPolygon(pts);
   using(var brush=new PathGradientBrush(path)){
    brush.CenterPoint=center;brush.CenterColor=centerColor;brush.SurroundColors=colors;
    using(var g=Graphics.FromImage(bitmap)){
     g.SmoothingMode=SmoothingMode.None;g.PixelOffsetMode=PixelOffsetMode.None;g.Clear(Color.Transparent);
     g.FillRectangle(brush,-W,-H,3*W,3*H);
    }
   }
   if(json.Length>1)json.Append(',');
   json.Append("{\"name\":\"").Append(name).Append("\",\"w\":").Append(W).Append(",\"h\":").Append(H).Append(",\"center\":[").Append(F(center.X)).Append(',').Append(F(center.Y)).Append("],\"centerArgb\":").Append(unchecked((uint)centerColor.ToArgb())).Append(",\"points\":[");
   for(int i=0;i<pts.Length;i++){if(i>0)json.Append(',');json.Append('[').Append(F(pts[i].X)).Append(',').Append(F(pts[i].Y)).Append(']');}
   json.Append("],\"colors\":[");
   for(int i=0;i<colors.Length;i++){if(i>0)json.Append(',');json.Append(unchecked((uint)colors[i].ToArgb()));}
   json.Append("],\"ra\":\"").Append(RedAlpha(bitmap)).Append("\"}");
  }
 }
 static void Fan(StringBuilder json,string name,float x0,float xr,float w2,Color c0,Color c1,Color c2,Color c3){
  var pts=new PointF[]{new PointF(x0,562),new PointF(xr,306),new PointF(x0-w2,10)};
  One(json,name,(int)Math.Ceiling(xr)+16,580,pts,new Color[]{c1,c2,c3},new PointF(x0,50),c0);
 }
 static Color Red(int v){return Color.FromArgb(255,v,0,0);}
 // RunEdges: the edge stage alone. A fan whose left edge is vertical and `s` rows tall, so the first pixel of every span (j = 0) is that
 // edge's colour at row k, a + (b - a) k / s, in the red channel; s = 2 |b - a| makes every odd k an exact half-level tie, and the parameter k / s
 // is a binary fraction only when the odd part of s divides k. `edge0`: the edge runs from the centre (colour a) to vertex 0 (colour b);
 // `edge2`: from vertex 1 (colour a) to the centre (colour b). Names `edge<0|2>_<a>_<b>`.
 public static void RunEdges(string directory){
  var json=new StringBuilder("[");
  int[] P={192,128,64,100,150,200,250,60,90,120,170,220,36,72,48};
  int[] bases={0,13,40,63};
  foreach(int p in P)foreach(int sign in new int[]{1,-1})foreach(int b0 in bases){
   int a=sign>0?b0:b0+p; int b=sign>0?b0+p:b0; if(a<0||b<0||a>255||b>255)continue;
   int S=2*p;
   foreach(int kind in new int[]{0,2}){
    PointF[] pts; PointF center; Color[] colors; Color cc;
    if(kind==0){pts=new PointF[]{new PointF(30,50+S),new PointF(110,50+S/2f),new PointF(29,10)};center=new PointF(30,50);colors=new Color[]{Red(b),Red(128),Red(0)};cc=Red(a);}
    else{pts=new PointF[]{new PointF(110,50+S/2f),new PointF(30,50),new PointF(29,70+S)};center=new PointF(30,50+S);colors=new Color[]{Red(128),Red(a),Red(0)};cc=Red(b);}
    One(json,"edge"+kind+"_"+a+"_"+b,140,90+S+20,pts,colors,center,cc);
   }
  }
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"path-gradient-edge-stage.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
 // RunEdgesMid: the edge between two surround vertices (vertex 0 colour a to vertex 1 colour b, no centre involved), vertical (`mid1y`) and
 // x-major (`mid1x`, down and to the left); the centre is inside the polygon and to the right of the edge, p2 found by search as below.
 public static void RunEdgesMid(string directory){
  var json=new StringBuilder("[");
  int[] P={100,150,60,90,120,36,72,48,64,128,192};
  int[] bases={0,40};
  foreach(int p in P)foreach(int sign in new int[]{1,-1})foreach(int b0 in bases){
   int a=sign>0?b0:b0+p; int b=sign>0?b0+p:b0; if(a<0||b<0||a>255||b>255)continue;
   int S=2*p; int h=(int)Math.Round(S*0.6);
   foreach(int kind in new int[]{0,1}){
    PointF p0,p1,center;
    if(kind==0){p0=new PointF(30,50);p1=new PointF(30,50+S);center=new PointF(100,50+S/2f);}
    else{p0=new PointF(200,100);p1=new PointF(200-S,100+h);center=new PointF(210,100+h/2f);}
    PointF p2=PointF.Empty; bool found=false;
    for(int py=10;py<=100+2*h+S&&!found;py+=10)for(int px=40;px<=300&&!found;px+=10){
     var q=new PointF(px,py);
     float d1=(p1.X-p0.X)*(center.Y-p0.Y)-(p1.Y-p0.Y)*(center.X-p0.X);
     float d2=(q.X-p1.X)*(center.Y-p1.Y)-(q.Y-p1.Y)*(center.X-p1.X);
     float d3=(p0.X-q.X)*(center.Y-q.Y)-(p0.Y-q.Y)*(center.X-q.X);
     if((d1>0&&d2>0&&d3>0)||(d1<0&&d2<0&&d3<0)){p2=q;found=true;}
    }
    if(!found)continue;
    One(json,"mid"+(kind==0?"y":"x")+"_"+a+"_"+b,320,100+2*h+S+60,new PointF[]{p0,p1,p2},new Color[]{Red(a),Red(b),Red(0)},center,Red(128));
   }
  }
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"path-gradient-edge-stage-mid.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
 // RunEdgesMidCentre: RunEdgesMid (vertical edge between two surround vertices) with the CENTRE colour swept as well (round 10: the edge
 // formula is centre-relative and RunEdgesMid fixed the centre at 128). Names `midy_<a>_<b>_c<centre>`.
 public static void RunEdgesMidCentre(string directory){
  var json=new StringBuilder("[");
  int[] P={100,150,60,90,120,36,48,75,105,135};
  int[] bases={0,40};
  int[] centres={0,64,200,255};
  foreach(int p in P)foreach(int sign in new int[]{1,-1})foreach(int b0 in bases)foreach(int cc in centres){
   int a=sign>0?b0:b0+p; int b=sign>0?b0+p:b0; if(a<0||b<0||a>255||b>255)continue;
   int S=2*p; int h=(int)Math.Round(S*0.6);
   PointF p0=new PointF(30,50),p1=new PointF(30,50+S),center=new PointF(100,50+S/2f);
   PointF p2=PointF.Empty; bool found=false;
   for(int py=10;py<=100+2*h+S&&!found;py+=10)for(int px=40;px<=300&&!found;px+=10){
    var q=new PointF(px,py);
    float d1=(p1.X-p0.X)*(center.Y-p0.Y)-(p1.Y-p0.Y)*(center.X-p0.X);
    float d2=(q.X-p1.X)*(center.Y-p1.Y)-(q.Y-p1.Y)*(center.X-p1.X);
    float d3=(p0.X-q.X)*(center.Y-q.Y)-(p0.Y-q.Y)*(center.X-q.X);
    if((d1>0&&d2>0&&d3>0)||(d1<0&&d2<0&&d3<0)){p2=q;found=true;}
   }
   if(!found)continue;
   One(json,"midy_"+a+"_"+b+"_c"+cc,320,100+2*h+S+60,new PointF[]{p0,p1,p2},new Color[]{Red(a),Red(b),Red(0)},center,Red(cc));
  }
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"path-gradient-edge-stage-mid-centre.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
 // RunEdgesX: the same for an x-major edge (|dx| > |dy|): the left edge runs 2 |b - a| columns and about 0.6 of that in rows, so the span
 // start of a row is the edge's colour at column xs = ceil(crossing), k = |xs - floor(first vertex x)| of s = 2 |b - a| steps.
 public static void RunEdgesX(string directory){
  var json=new StringBuilder("[");
  int[] P={100,150,60,90,120,36,72,48,64,128};
  int[] bases={0,40};
  foreach(int p in P)foreach(int sign in new int[]{1,-1})foreach(int b0 in bases){
   int a=sign>0?b0:b0+p; int b=sign>0?b0+p:b0; if(a<0||b<0||a>255||b>255)continue;
   int S=2*p; int h=(int)Math.Round(S*0.6);
   foreach(int kind in new int[]{0,2}){
    PointF[] pts; PointF center; Color[] colors; Color cc;
    // the centre must lie inside the polygon (p0, p1, p2): p2 is the first grid point that makes it so
    PointF p0,p1; if(kind==0){center=new PointF(200,100);p0=new PointF(200-S,100+h);p1=new PointF(260,100+h/3f);}
    else{center=new PointF(200,100+h);p1=new PointF(200-S,100);p0=new PointF(260,100+h/5f);}
    PointF p2=PointF.Empty; bool found=false;
    for(int py=10;py<=100+2*h&&!found;py+=10)for(int px=20;px<=300&&!found;px+=10){
     var q=new PointF(px,py);
     float d1=(p1.X-p0.X)*(center.Y-p0.Y)-(p1.Y-p0.Y)*(center.X-p0.X);
     float d2=(q.X-p1.X)*(center.Y-p1.Y)-(q.Y-p1.Y)*(center.X-p1.X);
     float d3=(p0.X-q.X)*(center.Y-q.Y)-(p0.Y-q.Y)*(center.X-q.X);
     if((d1>0&&d2>0&&d3>0)||(d1<0&&d2<0&&d3<0)){p2=q;found=true;}
    }
    if(!found)continue;
    pts=new PointF[]{p0,p1,p2};
    colors=kind==0?new Color[]{Red(b),Red(128),Red(0)}:new Color[]{Red(128),Red(a),Red(0)}; cc=kind==0?Red(a):Red(b);
    One(json,"edgex"+kind+"_"+a+"_"+b,320,100+2*h+60,pts,colors,center,cc);
   }
  }
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"path-gradient-edge-stage-x.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
 // RunGrid: the flat fan (centre 64, p0 192, p1 128: the colour is 64 + (y - 50) / 4 on every row, whatever x) with the right vertex swept
 // over whole and fractional x, so that the span length n and the exact half-level colour (rows y = 52 + 4 k) are independent of each other
 // (the "const" fans above couple them: one n for each row). Each record keeps the red and alpha bytes of the rows 52 + 4 k, k = 0..63.
 public static void RunGrid(string directory){RunGridColors(directory,64,192,128,0,"path-gradient-flat-grid.json.gz");}
 public static void RunGridColors(string directory,int cc,int c1,int c2,int c3,string fileName){
  var json=new StringBuilder("[");
  float x0=20.25f;
  for(int step=0;step<600;step++){
   float xr=x0+12+step/2f;
   int W=(int)Math.Ceiling(xr)+16,H=580;
   var pts=new PointF[]{new PointF(x0,562),new PointF(xr,306),new PointF(x0-1,10)};
   using(var bitmap=new Bitmap(W,H,PixelFormat.Format32bppArgb))using(var path=new GraphicsPath()){
    path.AddPolygon(pts);
    using(var brush=new PathGradientBrush(path)){
     brush.CenterPoint=new PointF(x0,50);brush.CenterColor=Red(cc);brush.SurroundColors=new Color[]{Red(c1),Red(c2),Red(c3)};
     using(var g=Graphics.FromImage(bitmap)){g.SmoothingMode=SmoothingMode.None;g.PixelOffsetMode=PixelOffsetMode.None;g.Clear(Color.Transparent);g.FillRectangle(brush,-W,-H,3*W,3*H);}
    }
    var bits=bitmap.LockBits(new Rectangle(0,0,W,H),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
    try{
     byte[] row=new byte[W*4];byte[] d=new byte[W*2*64];
     for(int k=0;k<64;k++){Marshal.Copy(IntPtr.Add(bits.Scan0,(52+4*k)*bits.Stride),row,0,W*4);for(int x=0;x<W;x++){d[(k*W+x)*2]=row[x*4+2];d[(k*W+x)*2+1]=row[x*4+3];}}
     if(json.Length>1)json.Append(',');
     json.Append("{\"x0\":").Append(F(x0)).Append(",\"xr\":").Append(F(xr)).Append(",\"w\":").Append(W).Append(",\"ra\":\"").Append(Convert.ToBase64String(d)).Append("\"}");
    }finally{bitmap.UnlockBits(bits);}
   }
  }
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,fileName)))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
 public static void Run(string directory){
  var json=new StringBuilder("[");
  var rnd=new Random(20261016);
  int[] levels={0,64,128,192};
  for(int i=0;i<60;i++){
   int c0,c1,c2,c3;
   do{c0=levels[rnd.Next(4)];c1=levels[rnd.Next(4)];c2=levels[rnd.Next(4)];c3=levels[rnd.Next(4)];}while(c1==c2&&c2==c3);
   float x0=20+rnd.Next(0,16)/16f;
   Fan(json,"span"+i,x0,x0+40+rnd.Next(0,200*16)/16f,1+rnd.Next(0,2),Red(c0),Red(c1),Red(c2),Red(c3));
  }
  for(int i=0;i<16;i++)Fan(json,"const_x"+i,20+i/16f,100.5f,1,Red(64),Red(192),Red(128),Red(0));
  for(int i=0;i<32;i++)Fan(json,"const_w"+i,20.25f,100+i/16f,1,Red(64),Red(192),Red(128),Red(0));
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"path-gradient-span.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
}
