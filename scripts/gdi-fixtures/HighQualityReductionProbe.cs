// Axis-aligned HighQuality reductions (scale below one) of many independent noise rows, so the per-column
// weights can be recovered by least squares to better than 1e-3: 1,200 independent rows of 512 texels, each
// replicated over 7 identical rows (the vertical pass is then the identity), drawn at several reductions with
// both kernels. Writes hq-reductions.json.gz: {"srcW","rows","src","draws":[{"kernel","destW","dest"}]}.
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.Text; using System.Globalization;
public static class HighQualityReductionProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 public static void Run(string directory){
  const int SW=512, ROWS=1200, REP=7; int H=ROWS*REP;
  var rng=new Random(77123); var src=new byte[ROWS*SW*3]; for(int i=0;i<src.Length;i++)src[i]=(byte)rng.Next(256);
  var json=new StringBuilder("{\"srcW\":").Append(SW).Append(",\"rows\":").Append(ROWS).Append(",\"src\":\"").Append(Convert.ToBase64String(src)).Append("\",\"draws\":[");
  bool first=true;
  using(var bmp=new Bitmap(SW,H,PixelFormat.Format32bppArgb)){
   var d=bmp.LockBits(new Rectangle(0,0,SW,H),ImageLockMode.WriteOnly,PixelFormat.Format32bppArgb);var line=new byte[SW*4];
   for(int y=0;y<H;y++){int sr=y/REP;for(int x=0;x<SW;x++){line[x*4]=src[(sr*SW+x)*3+2];line[x*4+1]=src[(sr*SW+x)*3+1];line[x*4+2]=src[(sr*SW+x)*3];line[x*4+3]=255;}Marshal.Copy(line,0,IntPtr.Add(d.Scan0,y*d.Stride),SW*4);}
   bmp.UnlockBits(d);
   foreach(InterpolationMode kernel in new InterpolationMode[]{InterpolationMode.HighQualityBicubic,InterpolationMode.HighQualityBilinear})
   foreach(float sx in new float[]{.9f,.75f,.5f,.3f}){
    int bitmapW=(int)Math.Ceiling(SW*sx)+8;
    using(var dest=new Bitmap(bitmapW,H,PixelFormat.Format32bppPArgb)){
     using(var g=Graphics.FromImage(dest)){g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=kernel;g.PixelOffsetMode=PixelOffsetMode.None;
      g.DrawImage(bmp,new RectangleF(0,0,SW*sx,H),new RectangleF(0,0,SW,H),GraphicsUnit.Pixel);}
     var o=dest.LockBits(new Rectangle(0,0,bitmapW,H),ImageLockMode.ReadOnly,PixelFormat.Format32bppPArgb);
     var outBytes=new byte[bitmapW*ROWS*3];var l2=new byte[bitmapW*4];
     for(int y=0;y<ROWS;y++){Marshal.Copy(IntPtr.Add(o.Scan0,(y*REP+3)*o.Stride),l2,0,bitmapW*4);for(int x=0;x<bitmapW;x++){outBytes[(y*bitmapW+x)*3]=l2[x*4+2];outBytes[(y*bitmapW+x)*3+1]=l2[x*4+1];outBytes[(y*bitmapW+x)*3+2]=l2[x*4];}}
     dest.UnlockBits(o);
     if(!first)json.Append(',');first=false;
     json.Append("{\"kernel\":").Append((int)kernel).Append(",\"sx\":").Append(F(sx)).Append(",\"destW\":").Append(F(SW*sx)).Append(",\"bitmapW\":").Append(bitmapW).Append(",\"dest\":\"").Append(Convert.ToBase64String(outBytes)).Append("\"}");
    }
   }
  }
  json.Append("]}");
  var data=Encoding.UTF8.GetBytes(json.ToString());
  using(var file=File.Create(Path.Combine(directory,"hq-reductions.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(data,0,data.Length);
 }
}
