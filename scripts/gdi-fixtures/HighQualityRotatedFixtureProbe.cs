// The two stages of the `gpx-image-rotated-highqualitybicubic` draw at the fixture's own corner floats, on its source and on noise:
// DrawImage(src, {(30, 10), (90, 30), (15, 55)}) of a 20 x 16 bitmap onto a white 160 x 100 bitmap (the fixture's surface and
// composition), HighQualityBicubic. Per source (the fixture's gradient pattern and 8 noise bitmaps):
//   whole  the one-step native draw
//   mid    the native axis-aligned HighQualityBicubic pre-scale of the source to 64 x 48 (the edge lengths 63.246 and 47.434 rounded up)
//   two    the plain Bicubic draw of that native intermediate to the same three points (the second stage alone)
// The five pixels the converter misses by one level lie 1 to 2 pixels inside the left edge; if `whole` equals `two` the residual is the
// plain rotated Bicubic arithmetic, not the pre-scale.
// Writes hq-rotated-fixture.json.gz: {"draws":[{"seed":n,"src":"base64 BGRA","whole":"base64 BGRA 160x100","mid":"base64 BGRA 64x48","two":"base64 BGRA 160x100"}...]}.
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.Text;
public static class HighQualityRotatedFixtureProbe {
 static byte[] Bytes(Bitmap b){var d=b.LockBits(new Rectangle(0,0,b.Width,b.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);var a=new byte[b.Width*b.Height*4];try{for(int y=0;y<b.Height;y++)Marshal.Copy(IntPtr.Add(d.Scan0,y*d.Stride),a,y*b.Width*4,b.Width*4);}finally{b.UnlockBits(d);}return a;}
 public static void Run(string directory){
  var json=new StringBuilder("{\"draws\":[");
  var pts=new PointF[]{new PointF(30,10),new PointF(90,30),new PointF(15,55)};
  for(int seed=-1;seed<8;seed++){
   using(var src=new Bitmap(20,16,PixelFormat.Format32bppArgb)){
    var rng=new Random(seed+9001);
    for(int y=0;y<16;y++)for(int x=0;x<20;x++){
     if(seed<0){int r=(x*255)/19,g=(y*255)/15,b=((x/4+y/4)%2==0)?40:220;if((x*7+y*3)%11==0){r=255-r;g=255-g;}src.SetPixel(x,y,Color.FromArgb(255,r,g,b));}
     else src.SetPixel(x,y,Color.FromArgb(255,rng.Next(256),rng.Next(256),rng.Next(256)));
    }
    using(var whole=new Bitmap(160,100,PixelFormat.Format32bppArgb))using(var mid=new Bitmap(64,48,PixelFormat.Format32bppPArgb))using(var two=new Bitmap(160,100,PixelFormat.Format32bppArgb)){
     using(var g=Graphics.FromImage(whole)){g.FillRectangle(Brushes.White,0,0,160,100);g.InterpolationMode=InterpolationMode.HighQualityBicubic;g.DrawImage(src,pts);}
     using(var g=Graphics.FromImage(mid)){g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=InterpolationMode.HighQualityBicubic;g.PixelOffsetMode=PixelOffsetMode.None;g.DrawImage(src,new RectangleF(0,0,64,48),new RectangleF(0,0,20,16),GraphicsUnit.Pixel);}
     using(var g=Graphics.FromImage(two)){g.FillRectangle(Brushes.White,0,0,160,100);g.InterpolationMode=InterpolationMode.Bicubic;g.DrawImage(mid,pts);}
     if(seed>-1)json.Append(',');
     json.Append("{\"seed\":").Append(seed).Append(",\"src\":\"").Append(Convert.ToBase64String(Bytes(src))).Append("\",\"whole\":\"").Append(Convert.ToBase64String(Bytes(whole))).Append("\",\"mid\":\"").Append(Convert.ToBase64String(Bytes(mid))).Append("\",\"two\":\"").Append(Convert.ToBase64String(Bytes(two))).Append("\"}");
    }
   }
  }
  var data=Encoding.UTF8.GetBytes(json.Append("]}").ToString());
  using(var file=File.Create(Path.Combine(directory,"hq-rotated-fixture.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(data,0,data.Length);
 }
}
