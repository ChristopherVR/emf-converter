// Public PathGradientBrush controls for the tip pixels of a uniform path gradient: a triangle whose apex and an ellipse whose
// whole outline sit at every 1/16 pixel offset (16 x 16), white to black, clamped (WrapMode.Clamp) and tiled (WrapMode.Tile,
// with the offset kept inside the bounds so the tile bounds stay on whole pixels). Output rows are 2 bytes per pixel (red, alpha).
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.IO.Compression; using System.Text; using System.Globalization;
public static class PathGradientTipProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static string Pack(Bitmap bitmap){
  var bits=bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
  try{int w=bitmap.Width,h=bitmap.Height;byte[] raw=new byte[w*4];byte[] d=new byte[w*2*h];
   for(int y=0;y<h;y++){Marshal.Copy(IntPtr.Add(bits.Scan0,y*bits.Stride),raw,0,w*4);for(int x=0;x<w;x++){d[(y*w+x)*2]=raw[x*4+2];d[(y*w+x)*2+1]=raw[x*4+3];}}
   return Convert.ToBase64String(d);}
  finally{bitmap.UnlockBits(bits);}
 }
 const int W=70,H=60;
 static void One(StringBuilder json,string name,GraphicsPath path,WrapMode wrap){
  using(var bitmap=new Bitmap(W,H,PixelFormat.Format32bppArgb))
  using(var brush=new PathGradientBrush(path)){
   brush.CenterColor=Color.White;brush.SurroundColors=new Color[]{Color.Black};brush.WrapMode=wrap;
   var c=brush.CenterPoint;
   using(var g=Graphics.FromImage(bitmap)){
    g.CompositingMode=CompositingMode.SourceCopy;g.SmoothingMode=SmoothingMode.None;g.PixelOffsetMode=PixelOffsetMode.None;g.Clear(Color.Transparent);
    g.FillRectangle(brush,0,0,W,H);
   }
   PointF[] pts;byte[] types;
   using(var flat=(GraphicsPath)path.Clone()){flat.Flatten();pts=flat.PathPoints;types=flat.PathTypes;}
   if(json.Length>1)json.Append(',');
   json.Append("{\"name\":\"").Append(name).Append("\",\"w\":").Append(W).Append(",\"h\":").Append(H).Append(",\"center\":[").Append(F(c.X)).Append(',').Append(F(c.Y)).Append("],\"points\":[");
   for(int i=0;i<pts.Length;i++){if(i>0)json.Append(',');json.Append('[').Append(F(pts[i].X)).Append(',').Append(F(pts[i].Y)).Append(']');}
   json.Append("],\"types\":[");
   for(int i=0;i<types.Length;i++){if(i>0)json.Append(',');json.Append((int)types[i]);}
   json.Append("],\"ra\":\"").Append(Pack(bitmap)).Append("\"}");
  }
 }
 public static void Run(string directory){
  var json=new StringBuilder("[");
  for(int ox=0;ox<16;ox++)for(int oy=0;oy<16;oy++){
   float dx=ox/16f,dy=oy/16f;
   // triangle: apex up at (30+dx, 8+dy), base at y=44 from x=10 to x=52; clamp and tile (apex offset horizontal only for the tile so the bounds stay whole)
   using(var p=new GraphicsPath()){p.AddPolygon(new PointF[]{new PointF(30+dx,8+dy),new PointF(52,44),new PointF(10,44)});One(json,"tc-"+ox+"-"+oy,p,WrapMode.Clamp);}
   if(oy==0)using(var p=new GraphicsPath()){p.AddPolygon(new PointF[]{new PointF(30+dx,8),new PointF(52,44),new PointF(10,44)});One(json,"tt-"+ox,p,WrapMode.Tile);}
   // ellipse: whole outline shifted by (dx, dy)
   using(var p=new GraphicsPath()){p.AddEllipse(10+dx,8+dy,44,36);One(json,"ec-"+ox+"-"+oy,p,WrapMode.Clamp);}
   if(oy==0&&ox==0)using(var p=new GraphicsPath()){p.AddEllipse(10,8,44,36);One(json,"et-0",p,WrapMode.Tile);}
  }
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"path-gradient-tips.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
}
