// Public DrawImagePoints controls independently vary scale, subrectangles, mirrors, shear and rotation.
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.Text; using System.Globalization;
public static class BicubicIndependentProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static byte[] Bytes(Bitmap b){var d=b.LockBits(new Rectangle(0,0,b.Width,b.Height),ImageLockMode.ReadOnly,b.PixelFormat);var a=new byte[b.Width*b.Height*4];try{for(int y=0;y<b.Height;y++)Marshal.Copy(IntPtr.Add(d.Scan0,y*d.Stride),a,y*b.Width*4,b.Width*4);}finally{b.UnlockBits(d);}return a;}
 public static void Run(string directory){var json=new StringBuilder("[");var rng=new Random(26791);for(int pattern=0;pattern<2;pattern++)using(var src=new Bitmap(11,7,PixelFormat.Format32bppArgb)){
 for(int y=0;y<7;y++)for(int x=0;x<11;x++)src.SetPixel(x,y,Color.FromArgb(pattern==0?255:rng.Next(256),rng.Next(256),rng.Next(256),rng.Next(256)));
 foreach(float sx in new float[]{.625f,1.75f,2.25f,3.125f})foreach(float sy in new float[]{1.25f,2.5f})for(int mode=0;mode<4;mode++)foreach(float origin in new float[]{.125f,.375f})using(var dest=new Bitmap(80,80,PixelFormat.Format32bppPArgb)){
 float a=sx,b=0,c=0,d=sy,e=20+origin,f=20+origin;
 if(mode==1){a=-sx;e=55+origin;}
 if(mode==2){b=.3f;c=.2f;}
 if(mode==3){a=sx*.8660254f;b=sx*.5f;c=-sy*.5f;d=sy*.8660254f;}
 PointF p0=new PointF(a+c+e,b+d+f),p1=new PointF(10*a+c+e,10*b+d+f),p2=new PointF(a+6*c+e,b+6*d+f);
 using(var g=Graphics.FromImage(dest)){g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=InterpolationMode.Bicubic;g.PixelOffsetMode=PixelOffsetMode.None;g.DrawImage(src,new PointF[]{p0,p1,p2},new RectangleF(1,1,9,5),GraphicsUnit.Pixel);}
 if(json.Length>1)json.Append(',');json.Append("{\"pattern\":").Append(pattern).Append(",\"mode\":").Append(mode).Append(",\"m\":[").Append(F(a)).Append(',').Append(F(b)).Append(',').Append(F(c)).Append(',').Append(F(d)).Append(',').Append(F(e)).Append(',').Append(F(f)).Append("],\"srcBgra\":\"").Append(Convert.ToBase64String(Bytes(src))).Append("\",\"bgra\":\"").Append(Convert.ToBase64String(Bytes(dest))).Append("\"}");
 }}var data=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"bicubic-independent.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(data,0,data.Length);}
}
