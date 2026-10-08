// Public PathGradientBrush controls for tiles cut from fractional bounds: a white-to-black path gradient over a rectangle
// (or an ellipse) whose origin and size are fractional, filled in every WrapMode over an area of several tiles. Is a tile
// stepped from its own whole-pixel bounds, from the fractional bounds, or not stepped (a smooth ramp)? Red and alpha only.
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.IO.Compression; using System.Text; using System.Globalization;
public static class PathGradientTileProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static string Pack(Bitmap bitmap){
  var bits=bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
  try{int w=bitmap.Width,h=bitmap.Height;byte[] raw=new byte[w*4];byte[] d=new byte[w*2*h];
   for(int y=0;y<h;y++){Marshal.Copy(IntPtr.Add(bits.Scan0,y*bits.Stride),raw,0,w*4);for(int x=0;x<w;x++){d[(y*w+x)*2]=raw[x*4+2];d[(y*w+x)*2+1]=raw[x*4+3];}}
   return Convert.ToBase64String(d);}
  finally{bitmap.UnlockBits(bits);}
 }
 static void One(StringBuilder json,string name,GraphicsPath path,PointF center,WrapMode wrap,int W,int H,float[] bounds){
  using(var bitmap=new Bitmap(W,H,PixelFormat.Format32bppArgb))
  using(var brush=new PathGradientBrush(path)){
   brush.CenterPoint=center;brush.CenterColor=Color.White;brush.SurroundColors=new Color[]{Color.Black};brush.WrapMode=wrap;
   using(var g=Graphics.FromImage(bitmap)){
    g.CompositingMode=CompositingMode.SourceCopy;g.SmoothingMode=SmoothingMode.None;g.PixelOffsetMode=PixelOffsetMode.None;g.Clear(Color.Transparent);
    g.FillRectangle(brush,0,0,W,H);
   }
   if(json.Length>1)json.Append(',');
   json.Append("{\"name\":\"").Append(name).Append("\",\"w\":").Append(W).Append(",\"h\":").Append(H).Append(",\"wrap\":").Append((int)wrap).Append(",\"bounds\":[").Append(F(bounds[0])).Append(',').Append(F(bounds[1])).Append(',').Append(F(bounds[2])).Append(',').Append(F(bounds[3])).Append("],\"center\":[").Append(F(center.X)).Append(',').Append(F(center.Y)).Append("],\"ra\":\"").Append(Pack(bitmap)).Append("\"}");
  }
 }
 public static void Run(string directory){
  var json=new StringBuilder("[");
  float[][] sizes={new float[]{40f,30f},new float[]{40.5f,30.25f},new float[]{37.75f,22.5f},new float[]{24f,24f}};
  float[][] origins={new float[]{20f,15f},new float[]{20.25f,15f},new float[]{20.5f,15.5f},new float[]{20.3f,15.7f},new float[]{20.75f,15.25f}};
  WrapMode[] wraps={WrapMode.Tile,WrapMode.TileFlipX,WrapMode.TileFlipY,WrapMode.TileFlipXY};
  int W=160,H=120;
  foreach(var sz in sizes)foreach(var o in origins)foreach(var wrap in wraps){
   float w=sz[0],h=sz[1],x0=o[0],y0=o[1];
   using(var path=new GraphicsPath()){
    path.AddRectangle(new RectangleF(x0,y0,w,h));
    One(json,"rect-"+F(w)+"x"+F(h)+"-"+F(x0)+"-"+F(y0)+"-"+wrap,path,new PointF(x0+w/2f,y0+h/2f),wrap,W,H,new float[]{x0,y0,w,h});
   }
  }
  // Ellipses at the same fractional origins, tiled.
  foreach(var o in origins){
   float w=40.5f,h=30.25f,x0=o[0],y0=o[1];
   using(var path=new GraphicsPath()){
    path.AddEllipse(new RectangleF(x0,y0,w,h));
    One(json,"ellipse-"+F(w)+"x"+F(h)+"-"+F(x0)+"-"+F(y0)+"-Tile",path,new PointF(x0+w/2f,y0+h/2f),WrapMode.Tile,W,H,new float[]{x0,y0,w,h});
   }
  }
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"path-gradient-tiles.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
}
