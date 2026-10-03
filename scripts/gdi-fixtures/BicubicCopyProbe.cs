// Public DrawImage captures test unit-scale copy eligibility around 1/64.
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Globalization;
using System.Text;
using System.IO;
using System.IO.Compression;
public static class BicubicCopyProbe {
 static string F(float v) { return v.ToString("R", CultureInfo.InvariantCulture); }
 static byte[] Bytes(Bitmap b) {
  var d=b.LockBits(new Rectangle(0,0,b.Width,b.Height),ImageLockMode.ReadOnly,b.PixelFormat);
  var a=new byte[b.Width*b.Height*4];
  try { for(int y=0;y<b.Height;y++) Marshal.Copy(IntPtr.Add(d.Scan0,y*d.Stride),a,y*b.Width*4,b.Width*4); }
  finally { b.UnlockBits(d); }
  return a;
 }
 public static void Run(string directory) {
  var json=new StringBuilder("["); var rng=new Random(198327);
  for(int pattern=0;pattern<2;pattern++) using(var src=new Bitmap(13,11,PixelFormat.Format32bppArgb)) {
   for(int y=0;y<11;y++) for(int x=0;x<13;x++) src.SetPixel(x,y,Color.FromArgb(pattern==0?255:rng.Next(256),rng.Next(256),rng.Next(256),rng.Next(256)));
   for(int layout=0;layout<3;layout++) foreach(int phase in new int[]{-513,-257,-256,-255,-129,-1,0,1,129,255,256,257,513})
   for(int axis=0;axis<4;axis++) foreach(float scale in new float[]{1,1+1/1024f,1-1/1024f}) using(var dest=new Bitmap(24,24,PixelFormat.Format32bppPArgb)) {
    float dx=layout==0?3:3.25f, dy=layout==0?5:5.75f;
    float baseX=layout==1?2.25f:2, baseY=layout==1?1.75f:1;
    float sx=baseX+(axis==1?0:phase/16384f), sy=baseY+(axis==0?0:axis==1?phase/16384f:axis==2?phase/16384f:129/16384f);
    float sw=layout==0?8:5, sh=layout==0?8:7;
    using(var g=Graphics.FromImage(dest)) {
     g.CompositingMode=CompositingMode.SourceCopy; g.InterpolationMode=InterpolationMode.Bicubic; g.PixelOffsetMode=PixelOffsetMode.None;
     g.DrawImage(src,new RectangleF(dx,dy,sw*scale,sh*scale),new RectangleF(sx,sy,sw,sh),GraphicsUnit.Pixel);
    }
    if(json.Length>1) json.Append(',');
    json.Append("{\"pattern\":").Append(pattern).Append(",\"layout\":").Append(layout).Append(",\"phase\":").Append(phase).Append(",\"axis\":").Append(axis)
     .Append(",\"scale\":").Append(F(scale)).Append(",\"srcX\":").Append(F(sx)).Append(",\"srcY\":").Append(F(sy))
     .Append(",\"srcW\":").Append(F(sw)).Append(",\"srcH\":").Append(F(sh)).Append(",\"dx\":").Append(F(dx)).Append(",\"dy\":").Append(F(dy))
     .Append(",\"srcBgra\":\"").Append(Convert.ToBase64String(Bytes(src))).Append("\",\"bgra\":\"").Append(Convert.ToBase64String(Bytes(dest))).Append("\"}");
   }
  }
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());
  using(var file=File.Create(Path.Combine(directory,"bicubic-copy.json.gz"))) using(var zip=new GZipStream(file,CompressionMode.Compress)) zip.Write(bytes,0,bytes.Length);
 }
}
