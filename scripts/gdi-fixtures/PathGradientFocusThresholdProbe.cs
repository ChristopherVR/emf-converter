// Public PathGradientBrush controls that find, in float32 steps, where a pixel exactly on a focused copy's edge changes copy:
// a few axis-aligned white-to-black rectangles (centre on a pixel, so the pixels on the axes read the exact boundary point)
// painted with FocusScales (f, f) for every float32 neighbour (+-8 ulps) of 0.6, 0.3, 0.1, 0.7, 0.2 and 0.4. Whether the tie falls
// inside or outside the copy as f crosses the decimal value, on each side of the centre, is the arithmetic of the focus.
// Output rows are 2 bytes per pixel (red, alpha).
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.IO.Compression; using System.Text; using System.Globalization;
public static class PathGradientFocusThresholdProbe {
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
  float[] foci={0.6f,0.3f,0.1f,0.7f,0.2f,0.4f};
  int[][] sizes={new[]{4,6},new[]{6,8},new[]{12,6},new[]{10,2},new[]{20,6},new[]{40,8},new[]{16,12},new[]{24,20}};
  foreach(float fo in foci)foreach(var sz in sizes)for(int u=-8;u<=8;u++){
   float f=Step(fo,u);
   int w=sz[0],h=sz[1];int W=w+10,H=h+10;
   float cx=W/2,cy=H/2,hw=w/2f,hh=h/2f;
   One(json,"t"+F(fo)+"-"+w+"x"+h+"-"+u,new PointF[]{new PointF(cx-hw,cy-hh),new PointF(cx+hw,cy-hh),new PointF(cx+hw,cy+hh),new PointF(cx-hw,cy+hh)},new PointF(cx,cy),f,W,H);
  }
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"path-gradient-focus-thresholds.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
}
