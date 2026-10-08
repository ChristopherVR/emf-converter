// Public PathGradientBrush controls that isolate a single copy edge of a uniform path gradient: one white-to-black
// axis-aligned rectangle per (width, height) pair, centred on a pixel or on a pixel centre, where the pixel whose
// centre sits exactly on the line of a nested copy's edge can be read per step count N = ceil(2 * hypot(w, h)).
// Output rows are 2 bytes per pixel (red, alpha) so a sweep of hundreds of rectangles stays small.
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.IO.Compression; using System.Text; using System.Globalization;
public static class PathGradientEdgeProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static string Pack(Bitmap bitmap){
  var bits=bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
  try{int w=bitmap.Width,h=bitmap.Height;byte[] raw=new byte[w*4];byte[] d=new byte[w*2*h];
   for(int y=0;y<h;y++){Marshal.Copy(IntPtr.Add(bits.Scan0,y*bits.Stride),raw,0,w*4);for(int x=0;x<w;x++){d[(y*w+x)*2]=raw[x*4+2];d[(y*w+x)*2+1]=raw[x*4+3];}}
   return Convert.ToBase64String(d);}
  finally{bitmap.UnlockBits(bits);}
 }
 static void One(StringBuilder json,string name,PointF[] pts,PointF center,int W,int H){
  using(var bitmap=new Bitmap(W,H,PixelFormat.Format32bppArgb))using(var path=new GraphicsPath()){
   path.AddPolygon(pts);
   using(var brush=new PathGradientBrush(path)){
    brush.CenterPoint=center;brush.CenterColor=Color.White;brush.SurroundColors=new Color[]{Color.Black};
    using(var g=Graphics.FromImage(bitmap)){
     g.CompositingMode=CompositingMode.SourceCopy;g.SmoothingMode=SmoothingMode.None;g.PixelOffsetMode=PixelOffsetMode.None;g.Clear(Color.Transparent);
     g.FillRectangle(brush,0,0,W,H);
    }
   }
   if(json.Length>1)json.Append(',');
   json.Append("{\"name\":\"").Append(name).Append("\",\"w\":").Append(W).Append(",\"h\":").Append(H).Append(",\"center\":[").Append(F(center.X)).Append(',').Append(F(center.Y)).Append("],\"points\":[");
   for(int i=0;i<pts.Length;i++){if(i>0)json.Append(',');json.Append('[').Append(F(pts[i].X)).Append(',').Append(F(pts[i].Y)).Append(']');}
   json.Append("],\"ra\":\"").Append(Pack(bitmap)).Append("\"}");
  }
 }
 public static void Run(string directory){
  var json=new StringBuilder("[");
  // Even sizes 2..40 in both axes with the centre on a pixel (offset 0) and on a pixel centre (offset .5).
  foreach(float off in new float[]{0f,0.5f}){
   for(int w=2;w<=40;w+=2)for(int h=2;h<=40;h+=2){
    int W=w+10,H=h+10;
    float cx=W/2+off,cy=H/2+off,hw=w/2f,hh=h/2f;
    One(json,"r"+(off==0f?"i":"h")+"-"+w+"x"+h,new PointF[]{new PointF(cx-hw,cy-hh),new PointF(cx+hw,cy-hh),new PointF(cx+hw,cy+hh),new PointF(cx-hw,cy+hh)},new PointF(cx,cy),W,H);
   }
  }
  // The same rectangles translated by whole pixels and by sixteenths: is the tie rule translation invariant?
  int[][] sizes={new int[]{4,20},new int[]{8,34},new int[]{16,30},new int[]{24,38},new int[]{12,22},new int[]{20,10}};
  float[] shifts={0f,1f,8f,31f,0.0625f,0.5f};
  foreach(var sz in sizes)foreach(float sx in shifts)foreach(float sy in new float[]{0f,1f,3f,0.5f,0.0625f}){
   int w=sz[0],h=sz[1];int W=w+40,H=h+40;
   float cx=W/2+sx,cy=H/2+sy,hw=w/2f,hh=h/2f;
   One(json,"t-"+w+"x"+h+"-"+F(sx)+"-"+F(sy),new PointF[]{new PointF(cx-hw,cy-hh),new PointF(cx+hw,cy-hh),new PointF(cx+hw,cy+hh),new PointF(cx-hw,cy+hh)},new PointF(cx,cy),W,H);
  }
  // The whole sweep again counter-clockwise (centre on a pixel).
  for(int w=2;w<=40;w+=2)for(int h=2;h<=40;h+=2){
   int W=w+10,H=h+10;
   float cx=W/2,cy=H/2,hw=w/2f,hh=h/2f;
   One(json,"c-"+w+"x"+h,new PointF[]{new PointF(cx-hw,cy-hh),new PointF(cx-hw,cy+hh),new PointF(cx+hw,cy+hh),new PointF(cx+hw,cy-hh)},new PointF(cx,cy),W,H);
  }
  // Vertex order: the same rectangle clockwise from each corner and counter-clockwise from each corner.
  int[][] orderSizes={new int[]{4,20},new int[]{8,34},new int[]{12,22},new int[]{16,30},new int[]{24,38},new int[]{20,10},new int[]{24,12},new int[]{36,18}};
  foreach(var sz in orderSizes)for(int ccw=0;ccw<2;ccw++)for(int start=0;start<4;start++){
   int w=sz[0],h=sz[1];int W=w+10,H=h+10;
   float cx=W/2,cy=H/2,hw=w/2f,hh=h/2f;
   var cw=new PointF[]{new PointF(cx-hw,cy-hh),new PointF(cx+hw,cy-hh),new PointF(cx+hw,cy+hh),new PointF(cx-hw,cy+hh)};
   var pts=new PointF[4];
   for(int i=0;i<4;i++)pts[i]=ccw==0?cw[(start+i)%4]:cw[((start-i)%4+4)%4];
   One(json,"o-"+w+"x"+h+"-"+(ccw==0?"cw":"ccw")+start,pts,new PointF(cx,cy),W,H);
  }
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"path-gradient-edges.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
}
