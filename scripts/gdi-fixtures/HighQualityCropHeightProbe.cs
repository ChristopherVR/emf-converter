// Whether a unit-scale HighQuality DrawImage reads the texel one row past its source rectangle, as a function of
// the rectangle height and the destination's vertical position: the source is opaque white, so the alpha of the
// last covered row is 255 when that row's taps all landed on existing texels and lower when a tap was dropped. The
// draw is the rectangle form (a destination rectangle of the same size, so no matrix is inferred from points) of an
// 8 x H crop at (0, 0) of a 40 x 80 bitmap, at destination top y0 = whole + fraction, with both kernels.
// Writes hq-crop-height.json.gz: {"draws":[[kernel,sh,whole,fractionEighths,lastRow,alphaOfLastRow,alphaOfFirstRow]...]}.
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.Text; using System.Globalization;
public static class HighQualityCropHeightProbe {
 public static void Run(string directory){
  var json=new StringBuilder("{\"draws\":[");bool first=true;
  using(var src=new Bitmap(40,80,PixelFormat.Format32bppArgb)){
   using(var g0=Graphics.FromImage(src))g0.Clear(Color.White);
   foreach(InterpolationMode kernel in new InterpolationMode[]{InterpolationMode.HighQualityBilinear,InterpolationMode.HighQualityBicubic})
   for(int sh=1;sh<=64;sh++)for(int whole=0;whole<64;whole++)for(int eighth=0;eighth<8;eighth++)using(var dest=new Bitmap(32,160,PixelFormat.Format32bppPArgb)){
    float y0=whole+eighth/8f;
    using(var g=Graphics.FromImage(dest)){g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=kernel;g.PixelOffsetMode=PixelOffsetMode.None;
     g.DrawImage(src,new RectangleF(4,y0,8,sh),new RectangleF(0,0,8,sh),GraphicsUnit.Pixel);}
    var bd=dest.LockBits(new Rectangle(0,0,32,160),ImageLockMode.ReadOnly,PixelFormat.Format32bppPArgb);
    int top=-1,bottom=-1,topA=-1,bottomA=-1;
    for(int y=0;y<160;y++){int a=Marshal.ReadByte(bd.Scan0,y*bd.Stride+8*4+3);if(a>0){if(top<0){top=y;topA=a;}bottom=y;bottomA=a;}}
    dest.UnlockBits(bd);
    if(!first)json.Append(',');first=false;
    json.Append('[').Append((int)kernel).Append(',').Append(sh).Append(',').Append(whole).Append(',').Append(eighth).Append(',').Append(bottom).Append(',').Append(bottomA).Append(',').Append(topA).Append(']');
   }
  }
  var data=Encoding.UTF8.GetBytes(json.Append("]}").ToString());
  using(var file=File.Create(Path.Combine(directory,"hq-crop-height.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(data,0,data.Length);
 }
}
