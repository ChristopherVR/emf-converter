// Public PathGradientBrush controls for the pixels that sit exactly on an edge of a nested copy of a uniform
// path gradient: integer-sized rectangles and diamonds centred on a pixel, so that a copy at half scale
// (and at other simple fractions) has an edge exactly on a pixel row, column or diagonal. White to black,
// sized so the step count stays under 256 and every pixel's step can be read from its level.
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.IO.Compression; using System.Text; using System.Globalization;
public static class PathGradientTieProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static string Bytes(Bitmap bitmap){
  var bits=bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppPArgb);
  try{int w=bitmap.Width,h=bitmap.Height;byte[] d=new byte[w*4*h];for(int y=0;y<h;y++)Marshal.Copy(IntPtr.Add(bits.Scan0,y*bits.Stride),d,y*w*4,w*4);return Convert.ToBase64String(d);}
  finally{bitmap.UnlockBits(bits);}
 }
 static void One(StringBuilder json,string name,PointF[] pts,PointF center){
  int W=200,H=140;
  using(var bitmap=new Bitmap(W,H,PixelFormat.Format32bppPArgb))using(var path=new GraphicsPath()){
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
   json.Append("],\"bgra\":\"").Append(Bytes(bitmap)).Append("\"}");
  }
 }
 public static void Run(string directory){
  var json=new StringBuilder("[");
  int[][] rects={new int[]{40,20},new int[]{60,30},new int[]{60,40},new int[]{80,40},new int[]{100,50},new int[]{100,40},new int[]{120,60},new int[]{50,50},new int[]{90,70},new int[]{70,30},new int[]{64,48},new int[]{80,80},new int[]{30,30},new int[]{46,26}};
  foreach(var r in rects){
   float cx=100,cy=70,hw=r[0]/2f,hh=r[1]/2f;
   One(json,"rect-"+r[0]+"x"+r[1],new PointF[]{new PointF(cx-hw,cy-hh),new PointF(cx+hw,cy-hh),new PointF(cx+hw,cy+hh),new PointF(cx-hw,cy+hh)},new PointF(cx,cy));
  }
  int[] halves={20,30,24,40,36,16,50};
  foreach(int h in halves){
   float cx=100,cy=70;
   One(json,"diamond-"+h,new PointF[]{new PointF(cx,cy-h),new PointF(cx+h,cy),new PointF(cx,cy+h),new PointF(cx-h,cy)},new PointF(cx,cy));
  }
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"path-gradient-ties.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
}
