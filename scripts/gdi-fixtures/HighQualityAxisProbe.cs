// Axis-aligned HighQualityBilinear/HighQualityBicubic DrawImage: one grey impulse per source cell whose value
// runs 0..255, so the response at each destination phase reads the filter weight to better than 1/255
// (the output as a function of the impulse value steps where value * weight crosses a rounding boundary).
// A second set draws constant images, whose output reveals the sum of the weights and the rounding rule.
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.Text; using System.Globalization;
public static class HighQualityAxisProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static byte[] Bytes(Bitmap b){var d=b.LockBits(new Rectangle(0,0,b.Width,b.Height),ImageLockMode.ReadOnly,b.PixelFormat);var a=new byte[b.Width*b.Height*4];try{for(int y=0;y<b.Height;y++)Marshal.Copy(IntPtr.Add(d.Scan0,y*d.Stride),a,y*b.Width*4,b.Width*4);}finally{b.UnlockBits(d);}return a;}
 public static void Run(string directory){var json=new StringBuilder("[");
 const int stride=8,cells=256,H=8;
 using(var src=new Bitmap(stride*cells,H,PixelFormat.Format32bppArgb)){
  for(int i=0;i<cells;i++)for(int y=0;y<H;y++)for(int x=0;x<stride;x++)src.SetPixel(i*stride+x,y,x==3?Color.FromArgb(255,i,i,i):Color.FromArgb(255,0,0,0));
  foreach(InterpolationMode kernel in new InterpolationMode[]{InterpolationMode.HighQualityBilinear,InterpolationMode.HighQualityBicubic})
  foreach(float sx in new float[]{1.25f,1.5f,2,2.5f,3,4,.75f,.5f,1.1f,1.75f})
  foreach(float sy in new float[]{1,2})
  using(var dest=new Bitmap((int)Math.Ceiling(stride*cells*sx)+8,(int)(H*sy),PixelFormat.Format32bppPArgb)){
   using(var g=Graphics.FromImage(dest)){g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=kernel;g.PixelOffsetMode=PixelOffsetMode.None;g.DrawImage(src,new RectangleF(0,0,stride*cells*sx,H*sy),new RectangleF(0,0,stride*cells,H),GraphicsUnit.Pixel);}
   var all=Bytes(dest);int w=dest.Width,h=dest.Height;int row=h/2;var rowBytes=new byte[w*4];Array.Copy(all,row*w*4,rowBytes,0,w*4);
   if(json.Length>1)json.Append(',');
   json.Append("{\"kernel\":").Append((int)kernel).Append(",\"sx\":").Append(F(sx)).Append(",\"sy\":").Append(F(sy)).Append(",\"w\":").Append(w).Append(",\"h\":").Append(h).Append(",\"row\":").Append(row).Append(",\"bgra\":\"").Append(Convert.ToBase64String(rowBytes)).Append("\"}");
  }
 }
 // constant images: sum of weights and the rounding rule
 foreach(InterpolationMode kernel in new InterpolationMode[]{InterpolationMode.HighQualityBilinear,InterpolationMode.HighQualityBicubic})
 foreach(float sx in new float[]{1.25f,1.5f,2,2.5f,3,4,.75f,.5f})
 using(var src=new Bitmap(16,16,PixelFormat.Format32bppArgb))using(var dest=new Bitmap(64,64,PixelFormat.Format32bppPArgb)){
  var vals=new StringBuilder();
  for(int v=0;v<256;v++){
   for(int y=0;y<16;y++)for(int x=0;x<16;x++)src.SetPixel(x,y,Color.FromArgb(255,v,v,v));
   using(var g=Graphics.FromImage(dest)){g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=kernel;g.PixelOffsetMode=PixelOffsetMode.None;g.Clear(Color.Transparent);g.DrawImage(src,new RectangleF(0,0,16*sx,16*sx),new RectangleF(0,0,16,16),GraphicsUnit.Pixel);}
   var b=Bytes(dest);int cx=(int)(8*sx),cy=(int)(8*sx);var sb=new StringBuilder();
   // centre pixel and a few neighbours (different phases)
   for(int k=0;k<4;k++){int px=cx+k;sb.Append(b[(cy*64+px)*4+1]).Append(k<3?";":"");}
   if(v>0)vals.Append(',');vals.Append('"').Append(sb).Append('"');
  }
  if(json.Length>1)json.Append(',');
  json.Append("{\"constant\":true,\"kernel\":").Append((int)kernel).Append(",\"sx\":").Append(F(sx)).Append(",\"values\":[").Append(vals).Append("]}");
 }
 var data=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"hq-axis.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(data,0,data.Length);}
}
