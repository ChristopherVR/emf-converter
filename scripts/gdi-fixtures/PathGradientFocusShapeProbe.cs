// Public PathGradientBrush controls for uniform white-to-black path gradients with independent
// horizontal and vertical FocusScales on axis-aligned shapes (a rectangle, a diamond and a triangle)
// sized so the step count stays under 256 and every pixel's step can be read from its level.
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.IO.Compression; using System.Text; using System.Globalization;
public static class PathGradientFocusShapeProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static string Bytes(Bitmap bitmap){
  var bits=bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppPArgb);
  try{int w=bitmap.Width,h=bitmap.Height;byte[] d=new byte[w*4*h];for(int y=0;y<h;y++)Marshal.Copy(IntPtr.Add(bits.Scan0,y*bits.Stride),d,y*w*4,w*4);return Convert.ToBase64String(d);}
  finally{bitmap.UnlockBits(bits);}
 }
 static void One(StringBuilder json,string name,PointF[] pts,PointF center,float fx,float fy){
  int W=200,H=120;
  using(var bitmap=new Bitmap(W,H,PixelFormat.Format32bppPArgb))using(var path=new GraphicsPath()){
   path.AddPolygon(pts);
   using(var brush=new PathGradientBrush(path)){
    brush.CenterPoint=center;brush.CenterColor=Color.White;brush.SurroundColors=new Color[]{Color.Black};
    brush.FocusScales=new PointF(fx,fy);
    using(var g=Graphics.FromImage(bitmap)){
     g.CompositingMode=CompositingMode.SourceCopy;g.SmoothingMode=SmoothingMode.None;g.PixelOffsetMode=PixelOffsetMode.None;g.Clear(Color.Transparent);
     g.FillRectangle(brush,0,0,W,H);
    }
   }
   if(json.Length>1)json.Append(',');
   json.Append("{\"name\":\"").Append(name).Append("\",\"w\":").Append(W).Append(",\"h\":").Append(H).Append(",\"focus\":[").Append(F(fx)).Append(',').Append(F(fy)).Append("],\"center\":[").Append(F(center.X)).Append(',').Append(F(center.Y)).Append("],\"points\":[");
   for(int i=0;i<pts.Length;i++){if(i>0)json.Append(',');json.Append('[').Append(F(pts[i].X)).Append(',').Append(F(pts[i].Y)).Append(']');}
   json.Append("],\"bgra\":\"").Append(Bytes(bitmap)).Append("\"}");
  }
 }
 public static void Run(string directory){
  var json=new StringBuilder("[");
  var shapes=new Dictionary<string,PointF[]>();var centers=new Dictionary<string,PointF>();
  shapes["rect"]=new PointF[]{new PointF(50,35),new PointF(150,35),new PointF(150,85),new PointF(50,85)};centers["rect"]=new PointF(100,60);
  shapes["rectoff"]=new PointF[]{new PointF(50,35),new PointF(150,35),new PointF(150,85),new PointF(50,85)};centers["rectoff"]=new PointF(85,50);
  shapes["diamond"]=new PointF[]{new PointF(100,20),new PointF(140,60),new PointF(100,100),new PointF(60,60)};centers["diamond"]=new PointF(100,60);
  shapes["tri"]=new PointF[]{new PointF(50,95),new PointF(150,95),new PointF(100,20)};centers["tri"]=new PointF(100,70);
  float[][] foci={new float[]{0.75f,0.25f},new float[]{0.25f,0.75f},new float[]{0.5f,0f},new float[]{0f,0.5f},new float[]{1f,0.25f},new float[]{0.25f,1f},new float[]{0.5f,0.5f},new float[]{0.9f,0.1f},new float[]{0.6f,0.3f},new float[]{0.2f,0.8f}};
  foreach(var kv in shapes)foreach(var f in foci)One(json,kv.Key+"-"+F(f[0])+"-"+F(f[1]),kv.Value,centers[kv.Key],f[0],f[1]);
  // random triangles and quads (integer vertices) with random anisotropic focus; bounds kept under 100x75 so the step count stays under 256
  var rnd=new Random(20261009);
  for(int i=0;i<40;i++){
   int n=i%4==3?4:3;
   var pts=new PointF[n];
   float cx=100+rnd.Next(-10,11),cy=60+rnd.Next(-8,9);
   var ang=new double[n];for(int a=0;a<n;a++)ang[a]=(a+rnd.NextDouble()*0.6)*2*Math.PI/n;
   for(int a=0;a<n;a++){double r=18+rnd.NextDouble()*22;pts[a]=new PointF((float)Math.Round(cx+r*Math.Cos(ang[a])*1.2),(float)Math.Round(cy+r*Math.Sin(ang[a])));}
   var centre=new PointF(cx+rnd.Next(-4,5),cy+rnd.Next(-4,5));
   float fx=(float)(rnd.Next(0,11))/10f,fy=(float)(rnd.Next(0,11))/10f;
   if(fx==fy)fy=Math.Min(1f,fy+0.3f);
   One(json,"rnd"+i,pts,centre,fx,fy);
  }
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"path-gradient-focus-shapes.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
}
