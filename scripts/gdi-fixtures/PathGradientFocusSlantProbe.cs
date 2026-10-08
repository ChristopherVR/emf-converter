// Public PathGradientBrush controls that find, in float32 steps of the focus, where a pixel exactly on a focused copy's SLANTED edge
// changes copy: the corner triangle of PathGradientCornerProbe.cs (centre on a vertex, one fan triangle in play, the opposite edge at
// 16 slopes) painted with FocusScales (f, f) for every float32 neighbour (+-8 ulps) of 0.5, 0.6 and 0.3. Ties are read per pixel from
// the sequence of outcomes along the ulps. Output rows are 2 bytes per pixel (red, alpha).
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.IO.Compression; using System.Text; using System.Globalization;
public static class PathGradientFocusSlantProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static string Pack(Bitmap bitmap){
  var bits=bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
  try{int w=bitmap.Width,h=bitmap.Height;byte[] raw=new byte[w*4];byte[] d=new byte[w*2*h];
   for(int y=0;y<h;y++){Marshal.Copy(IntPtr.Add(bits.Scan0,y*bits.Stride),raw,0,w*4);for(int x=0;x<w;x++){d[(y*w+x)*2]=raw[x*4+2];d[(y*w+x)*2+1]=raw[x*4+3];}}
   return Convert.ToBase64String(d);}
  finally{bitmap.UnlockBits(bits);}
 }
 static float Step(float f,int ulps){
  int bits=BitConverter.ToInt32(BitConverter.GetBytes(f),0)+ulps;
  return BitConverter.ToSingle(BitConverter.GetBytes(bits),0);
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
  float[] foci={0.5f,0.6f,0.3f};
  int h=10;
  foreach(float fo in foci)foreach(int L in new int[]{8,16})for(int k=-L*16;k<=L*16;k+=L*2){
   for(int u=-8;u<=8;u++){
    float f=Step(fo,u);
    float s=k/16f;
    int W=L+30,H=h+30+(int)Math.Abs(s);
    float cx=15,cy=12+(s<0?(float)Math.Abs(s):0f);
    var v0=new PointF(cx,cy);var v1=new PointF(cx-L/2f,cy+h);var v2=new PointF(cx+L/2f,cy+h+s);
    One(json,"s"+F(fo)+"-"+L+"-"+k+"-"+u,new PointF[]{v0,v2,v1},v0,f,W,H);
   }
  }
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"path-gradient-focus-slants.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
}
