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
