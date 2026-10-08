// Public PathGradientBrush controls for TILED path gradients under a rotation, shear or scale of the brush or the world: the
// white-to-black rectangle of PathGradientTileProbe.cs (whole and fractional bounds) in Tile and TileFlipX, painted over a
// 200 x 160 canvas through a brush transform (rotation, shear, scale with rotation) or a world rotation. Native renders the
// gradient into a tile bitmap and draws it as a texture (see docs/outstanding-work.md); this separates the bitmap size and
// origin from the texture mapping. Output rows are 2 bytes per pixel (red, alpha).
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.IO.Compression; using System.Text; using System.Globalization;
public static class PathGradientTileRotateProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static string Pack(Bitmap bitmap){
  var bits=bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
  try{int w=bitmap.Width,h=bitmap.Height;byte[] raw=new byte[w*4];byte[] d=new byte[w*2*h];
   for(int y=0;y<h;y++){Marshal.Copy(IntPtr.Add(bits.Scan0,y*bits.Stride),raw,0,w*4);for(int x=0;x<w;x++){d[(y*w+x)*2]=raw[x*4+2];d[(y*w+x)*2+1]=raw[x*4+3];}}
   return Convert.ToBase64String(d);}
  finally{bitmap.UnlockBits(bits);}
 }
 public static void Run(string directory){
  var json=new StringBuilder("[");
  float[][] geoms={new float[]{40f,30f,20f,15f},new float[]{40.5f,30.25f,20.5f,15.5f},new float[]{24f,24f,20.3f,15.7f}};
  WrapMode[] wraps={WrapMode.Tile,WrapMode.TileFlipX};
  // transform kinds: brush rotate / shear / scale+rotate, world rotate
  string[] kinds={"brot10","brot30","brot45","brot90","brot-20","bshear","bscalerot","wrot30","wrot90"};
  int W=200,H=160;
  foreach(var gm in geoms)foreach(var wrap in wraps)foreach(var kind in kinds){
   float w=gm[0],h=gm[1],x0=gm[2],y0=gm[3];
   using(var bitmap=new Bitmap(W,H,PixelFormat.Format32bppArgb))using(var path=new GraphicsPath()){
    path.AddRectangle(new RectangleF(x0,y0,w,h));
    using(var brush=new PathGradientBrush(path)){
     brush.WrapMode=wrap;brush.CenterPoint=new PointF(x0+w/2f,y0+h/2f);brush.CenterColor=Color.White;brush.SurroundColors=new Color[]{Color.Black};
     using(var g=Graphics.FromImage(bitmap)){
      g.CompositingMode=CompositingMode.SourceCopy;g.SmoothingMode=SmoothingMode.None;g.PixelOffsetMode=PixelOffsetMode.None;g.Clear(Color.Transparent);
      if(kind=="brot10")brush.RotateTransform(10f);
      else if(kind=="brot30")brush.RotateTransform(30f);
      else if(kind=="brot45")brush.RotateTransform(45f);
      else if(kind=="brot90")brush.RotateTransform(90f);
      else if(kind=="brot-20")brush.RotateTransform(-20f);
      else if(kind=="bshear")brush.MultiplyTransform(new Matrix(1f,0f,0.3f,1f,0f,0f));
      else if(kind=="bscalerot"){brush.ScaleTransform(1.5f,1.5f);brush.RotateTransform(30f);}
      else if(kind=="wrot30")g.RotateTransform(30f);
      else if(kind=="wrot90")g.RotateTransform(90f);
      g.FillRectangle(brush,-200,-200,600,600);
     }
    }
    if(json.Length>1)json.Append(',');
    json.Append("{\"name\":\"rect-").Append(F(w)).Append('x').Append(F(h)).Append('-').Append(F(x0)).Append('-').Append(F(y0)).Append('-').Append(wrap).Append('-').Append(kind).Append("\",\"w\":").Append(W).Append(",\"h\":").Append(H).Append(",\"wrap\":").Append((int)wrap).Append(",\"kind\":\"").Append(kind).Append("\",\"bounds\":[").Append(F(x0)).Append(',').Append(F(y0)).Append(',').Append(F(w)).Append(',').Append(F(h)).Append("],\"ra\":\"").Append(Pack(bitmap)).Append("\"}");
   }
  }
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"path-gradient-tile-rotations.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
}
