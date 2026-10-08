// Public PathGradientBrush controls for independent FocusScales on small squares and rectangles (white to black, a
// few dozen steps, so every step is several levels): is each nested copy the boundary scaled per axis about the centre,
// or about a corner of the focus rectangle? Output rows are 2 bytes per pixel (red, alpha).
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.IO.Compression; using System.Text; using System.Globalization;
public static class PathGradientFocusSmallProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static string Pack(Bitmap bitmap){
  var bits=bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
  try{int w=bitmap.Width,h=bitmap.Height;byte[] raw=new byte[w*4];byte[] d=new byte[w*2*h];
   for(int y=0;y<h;y++){Marshal.Copy(IntPtr.Add(bits.Scan0,y*bits.Stride),raw,0,w*4);for(int x=0;x<w;x++){d[(y*w+x)*2]=raw[x*4+2];d[(y*w+x)*2+1]=raw[x*4+3];}}
   return Convert.ToBase64String(d);}
  finally{bitmap.UnlockBits(bits);}
 }
 static void One(StringBuilder json,string name,PointF[] pts,PointF center,float fx,float fy,int W,int H){
  using(var bitmap=new Bitmap(W,H,PixelFormat.Format32bppArgb))using(var path=new GraphicsPath()){
   path.AddPolygon(pts);
   using(var brush=new PathGradientBrush(path)){
    brush.CenterPoint=center;brush.CenterColor=Color.White;brush.SurroundColors=new Color[]{Color.Black};brush.FocusScales=new PointF(fx,fy);
    using(var g=Graphics.FromImage(bitmap)){
     g.CompositingMode=CompositingMode.SourceCopy;g.SmoothingMode=SmoothingMode.None;g.PixelOffsetMode=PixelOffsetMode.None;g.Clear(Color.Transparent);
     g.FillRectangle(brush,0,0,W,H);
    }
   }
   if(json.Length>1)json.Append(',');
   json.Append("{\"name\":\"").Append(name).Append("\",\"w\":").Append(W).Append(",\"h\":").Append(H).Append(",\"focus\":[").Append(F(fx)).Append(',').Append(F(fy)).Append("],\"center\":[").Append(F(center.X)).Append(',').Append(F(center.Y)).Append("],\"points\":[");
   for(int i=0;i<pts.Length;i++){if(i>0)json.Append(',');json.Append('[').Append(F(pts[i].X)).Append(',').Append(F(pts[i].Y)).Append(']');}
   json.Append("],\"ra\":\"").Append(Pack(bitmap)).Append("\"}");
  }
 }
 public static void Run(string directory){
  var json=new StringBuilder("[");
  float[][] scales={new float[]{0.5f,0.25f},new float[]{0.25f,0.5f},new float[]{0.5f,0f},new float[]{0f,0.5f},new float[]{0.75f,0.25f},new float[]{1f,0.5f},new float[]{0.5f,1f},new float[]{0.5f,0.5f},new float[]{0.125f,0.375f}};
  int[][] sizes={new int[]{12,12},new int[]{16,16},new int[]{20,10},new int[]{10,20},new int[]{24,24},new int[]{32,16}};
  foreach(var sz in sizes)foreach(var sc in scales){
   int w=sz[0],h=sz[1];int W=w+10,H=h+10;
   float cx=W/2,cy=H/2,hw=w/2f,hh=h/2f;
   var rect=new PointF[]{new PointF(cx-hw,cy-hh),new PointF(cx+hw,cy-hh),new PointF(cx+hw,cy+hh),new PointF(cx-hw,cy+hh)};
   One(json,"sq-"+w+"x"+h+"-"+F(sc[0])+"-"+F(sc[1]),rect,new PointF(cx,cy),sc[0],sc[1],W,H);
   // The centre off the middle of the same rectangle: the focus rectangle is scaled about the centre point, not the middle.
   One(json,"off-"+w+"x"+h+"-"+F(sc[0])+"-"+F(sc[1]),rect,new PointF(cx-hw/2f,cy+hh/4f),sc[0],sc[1],W,H);
  }
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"path-gradient-focus-small.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
}
