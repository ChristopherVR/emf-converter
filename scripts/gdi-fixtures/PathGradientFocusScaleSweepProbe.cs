// Public PathGradientBrush controls for the arithmetic of INDEPENDENT FocusScales on a slanted edge. Two integer-vertex triangles (the
// vertices and the centre are whole pixels, so the scaled copy's edge is the only inexact value) are painted white to black with
// FocusScales (f, 0.25) and (0.25, f) while f sweeps in 2e-6 steps around 0.6: a pixel's copy flips at the f where the scaled copy's
// edge crosses it, and the f of the flip read against the exact model gives native's edge offset in pixels. Output rows are 2 bytes per
// pixel (red, alpha).
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.IO.Compression; using System.Text; using System.Globalization;
public static class PathGradientFocusScaleSweepProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static string Pack(Bitmap bitmap){
  var bits=bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
  try{int w=bitmap.Width,h=bitmap.Height;byte[] raw=new byte[w*4];byte[] d=new byte[w*2*h];
   for(int y=0;y<h;y++){Marshal.Copy(IntPtr.Add(bits.Scan0,y*bits.Stride),raw,0,w*4);for(int x=0;x<w;x++){d[(y*w+x)*2]=raw[x*4+2];d[(y*w+x)*2+1]=raw[x*4+3];}}
   return Convert.ToBase64String(d);}
  finally{bitmap.UnlockBits(bits);}
 }
 static void One(StringBuilder json,string name,PointF[] pts,PointF center,PointF focus,int W,int H){
  using(var bitmap=new Bitmap(W,H,PixelFormat.Format32bppArgb))using(var path=new GraphicsPath()){
   path.AddPolygon(pts);
   using(var brush=new PathGradientBrush(path)){
    brush.CenterPoint=center;brush.CenterColor=Color.White;brush.SurroundColors=new Color[]{Color.Black};
    brush.FocusScales=focus;
    using(var g=Graphics.FromImage(bitmap)){
     g.CompositingMode=CompositingMode.SourceCopy;g.SmoothingMode=SmoothingMode.None;g.PixelOffsetMode=PixelOffsetMode.None;g.Clear(Color.Transparent);
     g.FillRectangle(brush,0,0,W,H);
    }
   }
   if(json.Length>1)json.Append(',');
   json.Append("{\"name\":\"").Append(name).Append("\",\"w\":").Append(W).Append(",\"h\":").Append(H).Append(",\"focus\":[").Append(F(focus.X)).Append(',').Append(F(focus.Y)).Append("],\"center\":[").Append(F(center.X)).Append(',').Append(F(center.Y)).Append("],\"points\":[");
   for(int i=0;i<pts.Length;i++){if(i>0)json.Append(',');json.Append('[').Append(F(pts[i].X)).Append(',').Append(F(pts[i].Y)).Append(']');}
   json.Append("],\"ra\":\"").Append(Pack(bitmap)).Append("\"}");
  }
 }
 public static void Run(string directory){
  var json=new StringBuilder("[");
  var shapes=new PointF[][]{
   new[]{new PointF(10,10),new PointF(90,15),new PointF(45,70)},
   new[]{new PointF(12,60),new PointF(88,20),new PointF(60,8)}};
  var centres=new[]{new PointF(50,40),new PointF(55,35)};
  for(int s=0;s<shapes.Length;s++)for(int axis=0;axis<2;axis++)for(int k=-150;k<=150;k++){
   float f=0.6f+k*2e-6f;
   var focus=axis==0?new PointF(f,0.25f):new PointF(0.25f,f);
   One(json,"t"+s+"-a"+axis+"-"+k,shapes[s],centres[s],focus,100,80);
  }
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"path-gradient-focus-scale-sweep.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
}
