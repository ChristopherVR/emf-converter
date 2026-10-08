// Public PathGradientBrush controls for the pixels exactly on a copy's edge when the gradient has an isotropic focus: sheared
// rectangles (slanted edges of every slope) and a triangle family with FocusScales (f, f) for dyadic (0.25, 0.5, 0.75) and
// non-dyadic (0.1, 0.3, 0.6) f, white to black. Output rows are 2 bytes per pixel (red, alpha).
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.IO.Compression; using System.Text; using System.Globalization;
public static class PathGradientFocusTieProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static string Pack(Bitmap bitmap){
  var bits=bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
  try{int w=bitmap.Width,h=bitmap.Height;byte[] raw=new byte[w*4];byte[] d=new byte[w*2*h];
   for(int y=0;y<h;y++){Marshal.Copy(IntPtr.Add(bits.Scan0,y*bits.Stride),raw,0,w*4);for(int x=0;x<w;x++){d[(y*w+x)*2]=raw[x*4+2];d[(y*w+x)*2+1]=raw[x*4+3];}}
   return Convert.ToBase64String(d);}
  finally{bitmap.UnlockBits(bits);}
 }
 static void One(StringBuilder json,string name,PointF[] pts,PointF center,float focus,int W,int H){
  using(var bitmap=new Bitmap(W,H,PixelFormat.Format32bppArgb))using(var path=new GraphicsPath()){
   path.AddPolygon(pts);
   using(var brush=new PathGradientBrush(path)){
    brush.CenterPoint=center;brush.CenterColor=Color.White;brush.SurroundColors=new Color[]{Color.Black};
    brush.FocusScales=new PointF(focus,focus);
    using(var g=Graphics.FromImage(bitmap)){
     g.CompositingMode=CompositingMode.SourceCopy;g.SmoothingMode=SmoothingMode.None;g.PixelOffsetMode=PixelOffsetMode.None;g.Clear(Color.Transparent);
     g.FillRectangle(brush,0,0,W,H);
    }
   }
   if(json.Length>1)json.Append(',');
   json.Append("{\"name\":\"").Append(name).Append("\",\"w\":").Append(W).Append(",\"h\":").Append(H).Append(",\"focus\":").Append(F(focus)).Append(",\"center\":[").Append(F(center.X)).Append(',').Append(F(center.Y)).Append("],\"points\":[");
   for(int i=0;i<pts.Length;i++){if(i>0)json.Append(',');json.Append('[').Append(F(pts[i].X)).Append(',').Append(F(pts[i].Y)).Append(']');}
   json.Append("],\"ra\":\"").Append(Pack(bitmap)).Append("\"}");
  }
 }
 public static void Run(string directory){
  var json=new StringBuilder("[");
  float[] foci={0.25f,0.5f,0.75f,0.1f,0.3f,0.6f};
  int h=12;
  foreach(float fo in foci)foreach(int w in new int[]{6,10,14,18})for(int k=-16*h;k<=16*h;k+=24){
   float d=k/16f;
   int W=w+h+16,H=h+16;
   float x0=8+(d<0?h:0),y0=8;
   var pts=new PointF[]{new PointF(x0,y0),new PointF(x0+w,y0),new PointF(x0+w+d,y0+h),new PointF(x0+d,y0+h)};
   var c=new PointF(x0+(w+d)/2f,y0+h/2f);
   One(json,"p-"+F(fo)+"-"+w+"-"+k,pts,c,fo,W,H);
  }
  // Triangles with the centre off the middle.
  foreach(float fo in foci)for(int i=0;i<24;i++){
   float ax=8+(i%6)*0.5f,ay=6+(i/6)*0.25f;
   var pts=new PointF[]{new PointF(ax,ay),new PointF(36+i/8f,18),new PointF(10,32)};
   var c=new PointF(18+(i%4)*0.75f,19+(i%5)*0.5f);
   One(json,"t-"+F(fo)+"-"+i,pts,c,fo,52,40);
  }
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"path-gradient-focus-ties.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
}
