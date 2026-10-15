// Linear gradients written with CompositingMode.SourceCopy onto a transparent 32bpp ARGB bitmap: the stored straight colour of a
// translucent pixel isolates GDI+'s premultiplied-to-straight conversion (pixels are read back as red, green, blue and alpha).
// 700 one-pixel-high rows of 70 pixels, each with its own random start and end colour (alphas 1..254, half of them with an
// opaque end), brush rectangle (0, y, 70, 1). Output: gradient-unpremultiply.json.gz = [{ "s": startArgb, "e": endArgb, "px": base64 RGBA row }].
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.IO.Compression; using System.Text; using System.Globalization;
public static class GradientUnpremultiplyProbe {
 public static void Run(string directory){
  const int W=70,N=700;
  var rnd=new Random(2026);
  var json=new StringBuilder("[");
  using(var bitmap=new Bitmap(W,N,PixelFormat.Format32bppArgb))
  using(var g=Graphics.FromImage(bitmap)){
   g.CompositingMode=CompositingMode.SourceCopy;g.SmoothingMode=SmoothingMode.None;g.PixelOffsetMode=PixelOffsetMode.None;g.Clear(Color.Transparent);
   var starts=new int[N];var ends=new int[N];
   for(int i=0;i<N;i++){
    Color s=Color.FromArgb(rnd.Next(1,255),rnd.Next(0,256),rnd.Next(0,256),rnd.Next(0,256));
    Color e=Color.FromArgb(i%2==0?255:rnd.Next(1,255),rnd.Next(0,256),rnd.Next(0,256),rnd.Next(0,256));
    starts[i]=s.ToArgb();ends[i]=e.ToArgb();
    using(var brush=new LinearGradientBrush(new RectangleF(0,i,W,1),s,e,0f))g.FillRectangle(brush,0,i,W,1);
   }
   var bits=bitmap.LockBits(new Rectangle(0,0,W,N),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
   try{
    byte[] raw=new byte[W*4];
    for(int i=0;i<N;i++){
     Marshal.Copy(IntPtr.Add(bits.Scan0,i*bits.Stride),raw,0,W*4);
     byte[] rgba=new byte[W*4];
     for(int x=0;x<W;x++){rgba[x*4]=raw[x*4+2];rgba[x*4+1]=raw[x*4+1];rgba[x*4+2]=raw[x*4];rgba[x*4+3]=raw[x*4+3];}
     if(i>0)json.Append(',');
     json.Append("{\"s\":").Append((uint)starts[i]).Append(",\"e\":").Append((uint)ends[i]).Append(",\"px\":\"").Append(Convert.ToBase64String(rgba)).Append("\"}");
    }
   }finally{bitmap.UnlockBits(bits);}
  }
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());
  using(var file=File.Create(Path.Combine(directory,"gradient-unpremultiply.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
}
