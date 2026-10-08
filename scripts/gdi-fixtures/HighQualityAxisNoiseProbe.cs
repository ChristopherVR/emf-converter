// Axis-aligned HighQuality DrawImage of a long grey noise row (identical rows), upscaled by assorted factors:
// every destination pixel is a linear combination of a few source texels with weights that depend only on the
// 1/128-texel phase, so thousands of pixels per phase pin the integer weights.
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.Text; using System.Globalization;
public static class HighQualityAxisNoiseProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static byte[] Bytes(Bitmap b){var d=b.LockBits(new Rectangle(0,0,b.Width,b.Height),ImageLockMode.ReadOnly,b.PixelFormat);var a=new byte[b.Width*b.Height*4];try{for(int y=0;y<b.Height;y++)Marshal.Copy(IntPtr.Add(d.Scan0,y*d.Stride),a,y*b.Width*4,b.Width*4);}finally{b.UnlockBits(d);}return a;}
 public static void Run(string directory){var json=new StringBuilder("[");var rng=new Random(60417);
 const int N=1024,H=8;
 using(var src=new Bitmap(N,H,PixelFormat.Format32bppArgb)){
  var vals=new byte[N];for(int x=0;x<N;x++)vals[x]=(byte)rng.Next(256);
  for(int y=0;y<H;y++)for(int x=0;x<N;x++)src.SetPixel(x,y,Color.FromArgb(255,vals[x],vals[x],vals[x]));
  json.Append("{\"source\":\"").Append(Convert.ToBase64String(vals)).Append("\"}");
  foreach(InterpolationMode kernel in new InterpolationMode[]{InterpolationMode.HighQualityBilinear,InterpolationMode.HighQualityBicubic})
  foreach(float sx in new float[]{1.1f,1.2f,1.3f,1.37f,1.5f,1.61f,1.77f,1.9f,2.0f,2.3f,2.77f,3.0f,3.3f,3.9f,4.1f,5.3f,7.1f,.9f,.8f,.7f,.6f,.5f,.4f,.3f,.25f})
  using(var dest=new Bitmap((int)Math.Ceiling(N*sx)+8,H,PixelFormat.Format32bppPArgb)){
   using(var g=Graphics.FromImage(dest)){g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=kernel;g.PixelOffsetMode=PixelOffsetMode.None;g.DrawImage(src,new RectangleF(0,0,N*sx,H),new RectangleF(0,0,N,H),GraphicsUnit.Pixel);}
   var all=Bytes(dest);int w=dest.Width;var row=new byte[w];for(int x=0;x<w;x++)row[x]=all[(4*w+x)*4+1];
   json.Append(",{\"kernel\":").Append((int)kernel).Append(",\"sx\":").Append(F(sx)).Append(",\"w\":").Append(w).Append(",\"row\":\"").Append(Convert.ToBase64String(row)).Append("\"}");
  }
 }
 var data=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"hq-axis-noise.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(data,0,data.Length);}
}
