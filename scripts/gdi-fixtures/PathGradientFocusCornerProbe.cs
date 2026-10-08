// Public PathGradientBrush controls with the centre point ON a vertex of a triangle boundary and a focus: only one fan triangle (centre,
// vertex, vertex) has area, so the copies are the opposite edge scaled about the centre (by one factor for an isotropic focus, by
// a factor per axis for independent FocusScales) and the pixel exactly on a copy's slanted edge can be read per slope with a single
// edge in play. Same geometry as PathGradientCornerProbe.cs. Output rows are 2 bytes per pixel (red, alpha).
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.IO.Compression; using System.Text; using System.Globalization;
public static class PathGradientFocusCornerProbe {
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
   json.Append("],\"ra\":\"").Append(Pack(bitmap)).Append("\"}");
  }
 }
 static void Sweep(StringBuilder json,string prefix,float fx,float fy,int[] heights,int[] widths,int step){
  foreach(int h in heights)foreach(int L in widths)for(int k=-L*16;k<=L*16;k+=step){
   float s=k/16f;
   int W=L+30,H=h+30+(int)Math.Abs(s);
   float cx=15,cy=12+(s<0?(float)Math.Abs(s):0f);
   var v0=new PointF(cx,cy);var v1=new PointF(cx-L/2f,cy+h);var v2=new PointF(cx+L/2f,cy+h+s);
   One(json,prefix+"-"+h+"x"+L+"-"+k,new PointF[]{v0,v2,v1},v0,fx,fy,W,H);
  }
 }
 public static void Run(string directory){
  var json=new StringBuilder("[");
  float[] foci={0.25f,0.5f,0.75f,0.1f,0.3f,0.6f};
  foreach(float fo in foci)Sweep(json,"i"+F(fo),fo,fo,new int[]{10,18},new int[]{8,16},12);
  float[][] pairs={new[]{0.5f,0.25f},new[]{0.25f,0.5f},new[]{0.75f,0.25f},new[]{0.3f,0.6f},new[]{0.5f,0f},new[]{0f,0.5f},new[]{1f,0.5f},new[]{0.5f,1f}};
  foreach(var p in pairs)Sweep(json,"a"+F(p[0])+"_"+F(p[1]),p[0],p[1],new int[]{10,18},new int[]{8,16},12);
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"path-gradient-focus-corners.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
}
