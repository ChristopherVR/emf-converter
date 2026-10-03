// Public DrawImage controls isolate phase stepping, premultiplication and pass arithmetic.
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.Text; using System.Globalization;
public static class BicubicArithmeticProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static byte[] Bytes(Bitmap b){var d=b.LockBits(new Rectangle(0,0,b.Width,b.Height),ImageLockMode.ReadOnly,b.PixelFormat);var a=new byte[b.Width*b.Height*4];try{for(int y=0;y<b.Height;y++)Marshal.Copy(IntPtr.Add(d.Scan0,y*d.Stride),a,y*b.Width*4,b.Width*4);}finally{b.UnlockBits(d);}return a;}
 public static void Run(string directory){var json=new StringBuilder("[");var rng=new Random(7293);for(int pattern=0;pattern<4;pattern++)using(var src=new Bitmap(8,8,PixelFormat.Format32bppArgb)){
 for(int y=0;y<8;y++)for(int x=0;x<8;x++){Color c=pattern==0?Color.FromArgb(255,rng.Next(256),rng.Next(256),rng.Next(256)):pattern==1?Color.FromArgb(rng.Next(256),rng.Next(256),rng.Next(256),rng.Next(256)):pattern==2?Color.FromArgb(255,x==3?255:0,x==3?255:0,x==3?255:0):Color.FromArgb(255,y==3?255:0,y==3?255:0,y==3?255:0);src.SetPixel(x,y,c);}
 foreach(float sx in new float[]{.75f,1.25f,1.5f,2,3,4})foreach(float sy in new float[]{1,1.5f,3})foreach(float origin in new float[]{0,.25f})using(var dest=new Bitmap(48,48,PixelFormat.Format32bppPArgb)){
 using(var g=Graphics.FromImage(dest)){g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=InterpolationMode.Bicubic;g.PixelOffsetMode=PixelOffsetMode.None;g.DrawImage(src,new RectangleF(4+origin,4+origin,8*sx,8*sy),new RectangleF(0,0,8,8),GraphicsUnit.Pixel);}
 if(json.Length>1)json.Append(',');json.Append("{\"pattern\":").Append(pattern).Append(",\"sx\":").Append(F(sx)).Append(",\"sy\":").Append(F(sy)).Append(",\"origin\":").Append(F(origin)).Append(",\"srcBgra\":\"").Append(Convert.ToBase64String(Bytes(src))).Append("\",\"bgra\":\"").Append(Convert.ToBase64String(Bytes(dest))).Append("\"}");
 }}var data=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"bicubic-arithmetic.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(data,0,data.Length);}
}
