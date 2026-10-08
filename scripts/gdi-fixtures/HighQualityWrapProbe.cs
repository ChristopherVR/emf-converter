// High-quality DrawImagePoints with an ImageAttributes WrapMode: a 12 x 12 noise image drawn rotated (25 and 45
// degrees), sheared and axis-aligned at 1.55x, 2.25x and 0.625x, with every wrap mode (Clamp with a transparent and an
// opaque clamp colour, Tile, TileFlipX, TileFlipY, TileFlipXY) and without attributes, both kernels, opaque and
// alpha noise. Writes hq-wrap.json.gz: [{"kernel","wrap","clamp","deg","sx","sy","pattern","p":[x0,y0,x1,y1,x2,y2],"srcBgra","bgra"}]
// (a 96 x 96 canvas, premultiplied BGRA).
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.Text; using System.Globalization;
public static class HighQualityWrapProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static byte[] Bytes(Bitmap b){var d=b.LockBits(new Rectangle(0,0,b.Width,b.Height),ImageLockMode.ReadOnly,b.PixelFormat);var a=new byte[b.Width*b.Height*4];try{for(int y=0;y<b.Height;y++)Marshal.Copy(IntPtr.Add(d.Scan0,y*d.Stride),a,y*b.Width*4,b.Width*4);}finally{b.UnlockBits(d);}return a;}
 public static void Run(string directory){
  var json=new StringBuilder("[");var rng=new Random(88123);
  const int N=12;
  for(int pattern=0;pattern<2;pattern++)using(var src=new Bitmap(N,N,PixelFormat.Format32bppArgb)){
   for(int y=0;y<N;y++)for(int x=0;x<N;x++)src.SetPixel(x,y,Color.FromArgb(pattern==0?255:rng.Next(256),rng.Next(256),rng.Next(256),rng.Next(256)));
   // geometry: (degrees, sx, sy, shear) -> three points of the destination parallelogram
   var shapes=new float[][]{ new float[]{25,1.55f,1.55f,0}, new float[]{45,1.55f,1.55f,0}, new float[]{0,1.55f,1.55f,0}, new float[]{0,2.25f,2.25f,0}, new float[]{0,.625f,.625f,0}, new float[]{25,2.35f,1.55f,0}, new float[]{0,1.55f,1.55f,.3f} };
   foreach(InterpolationMode kernel in new InterpolationMode[]{InterpolationMode.HighQualityBilinear,InterpolationMode.HighQualityBicubic})
   foreach(var sh in shapes)
   for(int mode=0;mode<7;mode++){
    // mode: 0 no attributes, 1 Clamp transparent, 2 Clamp opaque red, 3 Tile, 4 TileFlipX, 5 TileFlipY, 6 TileFlipXY
    double a=sh[0]*Math.PI/180,c=Math.Cos(a),s=Math.Sin(a);float w=N*sh[1],h=N*sh[2];
    float cx=48,cy=48; // image centre
    // top-left corner so that the image centre lands on (cx,cy)
    double ux=c*w,uy=s*w,vx=-s*h+sh[3]*w,vy=c*h;
    PointF p0=new PointF((float)(cx-ux/2-vx/2),(float)(cy-uy/2-vy/2));
    PointF p1=new PointF((float)(p0.X+ux),(float)(p0.Y+uy)),p2=new PointF((float)(p0.X+vx),(float)(p0.Y+vy));
    using(var dest=new Bitmap(96,96,PixelFormat.Format32bppPArgb)){
     using(var g=Graphics.FromImage(dest)){g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=kernel;g.PixelOffsetMode=PixelOffsetMode.None;
      if(mode==0)g.DrawImage(src,new PointF[]{p0,p1,p2},new RectangleF(0,0,N,N),GraphicsUnit.Pixel);
      else using(var ia=new ImageAttributes()){
       if(mode==1)ia.SetWrapMode(WrapMode.Clamp,Color.FromArgb(0,0,0,0));
       else if(mode==2)ia.SetWrapMode(WrapMode.Clamp,Color.FromArgb(255,255,0,0));
       else ia.SetWrapMode(mode==3?WrapMode.Tile:mode==4?WrapMode.TileFlipX:mode==5?WrapMode.TileFlipY:WrapMode.TileFlipXY);
       g.DrawImage(src,new PointF[]{p0,p1,p2},new RectangleF(0,0,N,N),GraphicsUnit.Pixel,ia);}
     }
     if(json.Length>1)json.Append(',');
     json.Append("{\"kernel\":").Append((int)kernel).Append(",\"wrap\":").Append(mode).Append(",\"deg\":").Append(F(sh[0])).Append(",\"sx\":").Append(F(sh[1])).Append(",\"sy\":").Append(F(sh[2])).Append(",\"shear\":").Append(F(sh[3])).Append(",\"pattern\":").Append(pattern)
      .Append(",\"p\":[").Append(F(p0.X)).Append(',').Append(F(p0.Y)).Append(',').Append(F(p1.X)).Append(',').Append(F(p1.Y)).Append(',').Append(F(p2.X)).Append(',').Append(F(p2.Y)).Append("],\"srcBgra\":\"").Append(Convert.ToBase64String(Bytes(src))).Append("\",\"bgra\":\"").Append(Convert.ToBase64String(Bytes(dest))).Append("\"}");
    }
   }
  }
  var data=Encoding.UTF8.GetBytes(json.Append(']').ToString());
  using(var file=File.Create(Path.Combine(directory,"hq-wrap.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(data,0,data.Length);
 }
}
