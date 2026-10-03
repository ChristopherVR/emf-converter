// Public DrawImagePoints controls independently vary unscaled axes, crops, mirror and alpha.
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.Text; using System.Globalization;
public static class HighQualityIndependentProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static byte[] Bytes(Bitmap b){var d=b.LockBits(new Rectangle(0,0,b.Width,b.Height),ImageLockMode.ReadOnly,b.PixelFormat);var a=new byte[b.Width*b.Height*4];try{for(int y=0;y<b.Height;y++)Marshal.Copy(IntPtr.Add(d.Scan0,y*d.Stride),a,y*b.Width*4,b.Width*4);}finally{b.UnlockBits(d);}return a;}
 public static void Run(string directory){var json=new StringBuilder("[");var rng=new Random(392871);for(int pattern=0;pattern<2;pattern++)using(var src=new Bitmap(13,11,PixelFormat.Format32bppArgb)){
 for(int y=0;y<11;y++)for(int x=0;x<13;x++)src.SetPixel(x,y,Color.FromArgb(pattern==0?255:rng.Next(256),rng.Next(256),rng.Next(256),rng.Next(256)));
 foreach(InterpolationMode kernel in new InterpolationMode[]{InterpolationMode.HighQualityBilinear,InterpolationMode.HighQualityBicubic})
 for(int scale=0;scale<6;scale++)for(int crop=0;crop<2;crop++)for(int mirror=0;mirror<2;mirror++)foreach(float origin in new float[]{0,.375f})using(var dest=new Bitmap(64,64,PixelFormat.Format32bppPArgb)){
 float a=new float[]{1,2.25f,1,.625f,1,2.25f}[scale],d=new float[]{2.25f,1,.625f,1,1,1.5f}[scale],e=8+origin,f=8+origin;
 if(mirror==1){a=-a;e=45+origin;}
 float sx=crop==0?0:2,sy=crop==0?0:1,sw=crop==0?13:9,sh=crop==0?11:7;
 PointF p0=new PointF(a*sx+e,d*sy+f),p1=new PointF(a*(sx+sw)+e,d*sy+f),p2=new PointF(a*sx+e,d*(sy+sh)+f);
 using(var g=Graphics.FromImage(dest)){g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=kernel;g.PixelOffsetMode=PixelOffsetMode.None;g.DrawImage(src,new PointF[]{p0,p1,p2},new RectangleF(sx,sy,sw,sh),GraphicsUnit.Pixel);}
 if(json.Length>1)json.Append(',');json.Append("{\"kernel\":").Append((int)kernel).Append(",\"pattern\":").Append(pattern).Append(",\"crop\":").Append(crop).Append(",\"mirror\":").Append(mirror)
 .Append(",\"srcX\":").Append(F(sx)).Append(",\"srcY\":").Append(F(sy)).Append(",\"srcW\":").Append(F(sw)).Append(",\"srcH\":").Append(F(sh))
 .Append(",\"m\":[").Append(F(a)).Append(",0,0,").Append(F(d)).Append(',').Append(F(e)).Append(',').Append(F(f)).Append("],\"srcBgra\":\"").Append(Convert.ToBase64String(Bytes(src))).Append("\",\"bgra\":\"").Append(Convert.ToBase64String(Bytes(dest))).Append("\"}");
 }}var data=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"hq-independent.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(data,0,data.Length);}
}
