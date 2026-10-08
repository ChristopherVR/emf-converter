// Axis-aligned HighQualityBicubic upscale by exactly 128/127 of rows chosen (generate-hq-cubic-source.ts) so that
// many destination values sum to nearly a half level: the rounded result then tells which side of the half the
// native integer weights put the sum. Reads hq-cubic-weights-source.bin (rows x 1016 x RGB) from the output
// directory and writes hq-cubic-weights.json.gz ({"rows","srcW","destW","dest"}: rows x 1024 x RGB, base64).
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.Text;
public static class HighQualityCubicWeightProbe {
 public static void Run(string directory,string sourceDirectory){
  const int SW=1016, DW=1024;
  var src=File.ReadAllBytes(Path.Combine(sourceDirectory,"hq-cubic-weights-source.bin"));
  int rows=src.Length/(SW*3);int H=rows*7;
  using(var bmp=new Bitmap(SW,H,PixelFormat.Format32bppArgb))
  using(var dest=new Bitmap(DW,H,PixelFormat.Format32bppPArgb)){
   var d=bmp.LockBits(new Rectangle(0,0,SW,H),ImageLockMode.WriteOnly,PixelFormat.Format32bppArgb);
   var line=new byte[SW*4];
   for(int y=0;y<H;y++){for(int x=0;x<SW;x++){int sr=y/7;line[x*4]=src[(sr*SW+x)*3+2];line[x*4+1]=src[(sr*SW+x)*3+1];line[x*4+2]=src[(sr*SW+x)*3];line[x*4+3]=255;}Marshal.Copy(line,0,IntPtr.Add(d.Scan0,y*d.Stride),SW*4);}
   bmp.UnlockBits(d);
   using(var g=Graphics.FromImage(dest)){g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=InterpolationMode.HighQualityBicubic;g.PixelOffsetMode=PixelOffsetMode.None;g.DrawImage(bmp,new RectangleF(0,0,DW,H),new RectangleF(0,0,SW,H),GraphicsUnit.Pixel);}
   var o=dest.LockBits(new Rectangle(0,0,DW,H),ImageLockMode.ReadOnly,PixelFormat.Format32bppPArgb);
   var outBytes=new byte[DW*rows*3];var l2=new byte[DW*4];
   for(int y=0;y<rows;y++){Marshal.Copy(IntPtr.Add(o.Scan0,(y*7+3)*o.Stride),l2,0,DW*4);for(int x=0;x<DW;x++){outBytes[(y*DW+x)*3]=l2[x*4+2];outBytes[(y*DW+x)*3+1]=l2[x*4+1];outBytes[(y*DW+x)*3+2]=l2[x*4];}}
   dest.UnlockBits(o);
   var json=new StringBuilder("{\"rows\":").Append(rows).Append(",\"srcW\":").Append(SW).Append(",\"destW\":").Append(DW).Append(",\"source\":\"").Append(Convert.ToBase64String(src)).Append("\",\"dest\":\"").Append(Convert.ToBase64String(outBytes)).Append("\"}");
   var data=Encoding.UTF8.GetBytes(json.ToString());
   using(var file=File.Create(Path.Combine(directory,"hq-cubic-weights.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(data,0,data.Length);
  }
 }
}
