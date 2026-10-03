// Public DrawImage controls isolate every 1/64 source phase on independent noise/alpha images.
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Globalization;
using System.Text;
using System.IO;
using System.IO.Compression;
public static class BicubicPhaseProbe {
 static string F(float v) { return v.ToString("R", CultureInfo.InvariantCulture); }
 static byte[] Bytes(Bitmap b) {
  var d=b.LockBits(new Rectangle(0,0,b.Width,b.Height),ImageLockMode.ReadOnly,b.PixelFormat);
  var a=new byte[b.Width*b.Height*4];
  try { for(int y=0;y<b.Height;y++) Marshal.Copy(IntPtr.Add(d.Scan0,y*d.Stride),a,y*b.Width*4,b.Width*4); }
  finally { b.UnlockBits(d); }
  return a;
 }
 public static void Run(string directory) {
  var json=new StringBuilder("["); var rng=new Random(39821);
  for(int pattern=0;pattern<2;pattern++) using(var src=new Bitmap(12,12,PixelFormat.Format32bppArgb)) {
   for(int y=0;y<12;y++) for(int x=0;x<12;x++) src.SetPixel(x,y,Color.FromArgb(pattern==0?255:rng.Next(256),rng.Next(256),rng.Next(256),rng.Next(256)));
   for(int phase=0;phase<64;phase++) for(int axis=0;axis<3;axis++) using(var dest=new Bitmap(24,24,PixelFormat.Format32bppPArgb)) {
    float sx=2+(axis==1?0:phase/64f), sy=2+(axis==0?0:((phase*17)%64)/64f);
    using(var g=Graphics.FromImage(dest)) {
     g.CompositingMode=CompositingMode.SourceCopy; g.InterpolationMode=InterpolationMode.Bicubic; g.PixelOffsetMode=PixelOffsetMode.None;
     g.DrawImage(src,new RectangleF(4,4,8,8),new RectangleF(sx,sy,8,8),GraphicsUnit.Pixel);
    }
    if(json.Length>1) json.Append(',');
    json.Append("{\"pattern\":").Append(pattern).Append(",\"phase\":").Append(phase).Append(",\"axis\":").Append(axis)
     .Append(",\"srcX\":").Append(F(sx)).Append(",\"srcY\":").Append(F(sy))
     .Append(",\"srcBgra\":\"").Append(Convert.ToBase64String(Bytes(src))).Append("\",\"bgra\":\"").Append(Convert.ToBase64String(Bytes(dest))).Append("\"}");
   }
  }
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());
  using(var file=File.Create(Path.Combine(directory,"bicubic-phases.json.gz"))) using(var zip=new GZipStream(file,CompressionMode.Compress)) zip.Write(bytes,0,bytes.Length);
 }
}
