// Public PathGradientBrush controls with the centre point ON a vertex of a triangle boundary, so that only one fan triangle (centre,
// vertex, vertex) has area and the colour is one linear function: white at the centre, black along the opposite edge. The
// opposite edge takes every slope from the sweep (vertex 1 at (w1, h), vertex 2 at (w2, h), w2 - w1 a multiple of 1/16 up to
// the height), so the pixel exactly on a nested copy's slanted edge can be read per slope with a single edge in play.
// Output rows are 2 bytes per pixel (red, alpha).
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.IO.Compression; using System.Text; using System.Globalization;
public static class PathGradientCornerProbe {
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
  // Centre (and vertex 0) at (cx, cy); the opposite edge is the horizontal-ish line from (cx+a, cy+h) to (cx+a+L, cy+h+s) for a set of
  // widths L, heights h and slopes s (s a multiple of 1/16 up to L).
  int[] heights={10,14,18,22};
  int[] widths={8,12,16,20,24};
  foreach(int h in heights)foreach(int L in widths)for(int k=-L*16;k<=L*16;k+=6){
   float s=k/16f;
   int W=L+30,H=h+30+(int)Math.Abs(s);
   float cx=15,cy=12+(s<0?(float)Math.Abs(s):0f);
   var v0=new PointF(cx,cy);var v1=new PointF(cx-L/2f,cy+h);var v2=new PointF(cx+L/2f,cy+h+s);
   // clockwise from the centre: v0, v2, v1 (y down) keeps the winding of the earlier sweeps
   One(json,"c-"+h+"x"+L+"-"+k,new PointF[]{v0,v2,v1},v0,W,H);
  }
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"path-gradient-corners.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
}
