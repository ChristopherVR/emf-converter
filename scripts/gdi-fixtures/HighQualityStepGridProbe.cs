// The 16.16 step of an axis-aligned HighQuality upscale at 1.37x and 1.55x as a function of the source width and height:
// DrawImage(destRect, srcRect) of a grey noise bitmap (independent texels) with destination (4, 4, W s, H s), both
// kernels. The converter's reciprocal rounds 65536 / 1.37 = 47836.496 down while native rounds up for some heights;
// the draw's red channel (whole destination bitmap) is kept so the step of each axis can be fitted per draw.
// Writes hq-step-grid.json.gz: {"draws":[[kernel,W,H,scaleThousandths,destW,destH,bitmapW,bitmapH,"base64 red"]...]}.
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.Text;
public static class HighQualityStepGridProbe {
 public static void Run(string directory){
  var json=new StringBuilder("{\"draws\":[");bool first=true;
  int[] widths=new int[]{8,9,10,11,12,13,14,15,16,17,18,20,22,24,28,32,40};
  int[] heights=new int[]{8,12,16,24,32,48,64,100,200,336};
  foreach(int scaleT in new int[]{1370,1550})
  foreach(InterpolationMode kernel in new InterpolationMode[]{InterpolationMode.HighQualityBilinear,InterpolationMode.HighQualityBicubic})
  foreach(int W in widths)foreach(int H in heights){
   uint seed=(uint)(W*7919+H*104729+1);
   using(var src=new Bitmap(W,H,PixelFormat.Format32bppArgb)){
    for(int y=0;y<H;y++)for(int x=0;x<W;x++){seed=seed*1664525u+1013904223u;int v=(int)(seed>>24);src.SetPixel(x,y,Color.FromArgb(255,v,v,v));}
    float s=scaleT/1000f;float dw=W*s,dh=H*s;
    int bw=(int)Math.Ceiling(dw)+10,bh=(int)Math.Ceiling(dh)+10;
    using(var dest=new Bitmap(bw,bh,PixelFormat.Format32bppPArgb)){
     using(var g=Graphics.FromImage(dest)){g.Clear(Color.Transparent);g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=kernel;g.PixelOffsetMode=PixelOffsetMode.None;
      g.DrawImage(src,new RectangleF(4,4,dw,dh),new RectangleF(0,0,W,H),GraphicsUnit.Pixel);}
     var bd=dest.LockBits(new Rectangle(0,0,bw,bh),ImageLockMode.ReadOnly,PixelFormat.Format32bppPArgb);
     var red=new byte[bw*bh];
     for(int y=0;y<bh;y++)for(int x=0;x<bw;x++)red[y*bw+x]=Marshal.ReadByte(bd.Scan0,y*bd.Stride+x*4+2);
     dest.UnlockBits(bd);
     if(!first)json.Append(',');first=false;
     json.Append('[').Append((int)kernel).Append(',').Append(W).Append(',').Append(H).Append(',').Append(scaleT).Append(',').Append(dw.ToString("R",System.Globalization.CultureInfo.InvariantCulture)).Append(',').Append(dh.ToString("R",System.Globalization.CultureInfo.InvariantCulture)).Append(',').Append(bw).Append(',').Append(bh).Append(",\"").Append(Convert.ToBase64String(red)).Append("\"]");
    }
   }
  }
  var data=Encoding.UTF8.GetBytes(json.Append("]}").ToString());
  using(var file=File.Create(Path.Combine(directory,"hq-step-grid.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(data,0,data.Length);
 }
}
