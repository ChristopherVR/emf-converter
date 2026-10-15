// Axis-aligned HighQuality reductions as a function of the scale, the origin and the axis: DrawImage(destRect, srcRect)
// of a grey noise bitmap (independent texels) through both kernels. The native edge arithmetic of a reduction is
// 16.16 fixed point (edge distance in 1/65536 texel times a 16.16 scale, floored to 1/128 destination pixel); these draws
// pin its multiplier (the tent's round(2^32 / step), the cubic's even 2 round(s 32768)), the step's rounding for
// reciprocals that end in .48 (21/40, 29/40) and the horizontal start offset of a fractional origin. Groups:
//   v    vertical: 64 x 40 noise to 64 x h, h 9 to 37 (x is a whole-pixel unit scale), at (4, 4); 64 x 40 to 64 x 20 at the fractional tops 4 + 1/64 .. 4 + 63/64
//   h    horizontal: 40 x 8 noise to w x 8, w 11 to 30 and 40 x 8 to 20 x 8 at the fractional origins 4 + 1/64 .. 4 + 63/64, at (4 or 4 + f, 4)
//   fix  the geometries of gpx-image-highqualitybicubic/-bilinear: 64 x 48 to 25.6 x 21.6 at (64, 6), 64 x 48 to 58 x 20 at (98, 4)
// The draws keep the red channel of the whole destination bitmap (premultiplied, SourceCopy over transparent).
// Writes hq-reduction-grid.json.gz: {"draws":[[group,kernel,srcW,srcH,destX,destY,destW,destH,bitmapW,bitmapH,"base64 red"]...]}.
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.Text; using System.Globalization;
public static class HighQualityReductionGridProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 public static void Run(string directory){
  var configs=new List<float[]>();
  for(int h=9;h<=37;h++)configs.Add(new float[]{0,64,40,4,4,64,h});
  for(int w=11;w<=30;w++)configs.Add(new float[]{1,40,8,4,4,w,8});
  foreach(float f in new float[]{0.015625f,0.03125f,0.046875f,0.0625f,0.125f,0.25f,0.375f,0.5f,0.625f,0.75f,0.875f,0.96875f,0.984375f,0.3f,0.7f})configs.Add(new float[]{1,40,8,4+f,4,20,8});
  foreach(float f in new float[]{0.015625f,0.03125f,0.046875f,0.3f,0.5f,0.7f,0.96875f,0.984375f})configs.Add(new float[]{0,64,40,4,4+f,64,20});
  configs.Add(new float[]{2,64,48,64,6,25.6f,21.6f});
  configs.Add(new float[]{2,64,48,98,4,58,20});
  var json=new StringBuilder("{\"draws\":[");bool first=true;
  foreach(float[] c in configs)foreach(InterpolationMode kernel in new InterpolationMode[]{InterpolationMode.HighQualityBilinear,InterpolationMode.HighQualityBicubic}){
   int group=(int)c[0],W=(int)c[1],H=(int)c[2];float dx=c[3],dy=c[4],dw=c[5],dh=c[6];
   uint seed=(uint)(W*7919+H*104729+1);
   using(var src=new Bitmap(W,H,PixelFormat.Format32bppArgb)){
    for(int y=0;y<H;y++)for(int x=0;x<W;x++){seed=seed*1664525u+1013904223u;int v=(int)(seed>>24);src.SetPixel(x,y,Color.FromArgb(255,v,v,v));}
    int bw=(int)Math.Ceiling(dx+dw)+10,bh=(int)Math.Ceiling(dy+dh)+10;
    using(var dest=new Bitmap(bw,bh,PixelFormat.Format32bppPArgb)){
     using(var g=Graphics.FromImage(dest)){g.Clear(Color.Transparent);g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=kernel;g.PixelOffsetMode=PixelOffsetMode.None;
      g.DrawImage(src,new RectangleF(dx,dy,dw,dh),new RectangleF(0,0,W,H),GraphicsUnit.Pixel);}
     var bd=dest.LockBits(new Rectangle(0,0,bw,bh),ImageLockMode.ReadOnly,PixelFormat.Format32bppPArgb);
     var red=new byte[bw*bh];
     for(int y=0;y<bh;y++)for(int x=0;x<bw;x++)red[y*bw+x]=Marshal.ReadByte(bd.Scan0,y*bd.Stride+x*4+2);
     dest.UnlockBits(bd);
     if(!first)json.Append(',');first=false;
     json.Append('[').Append(group).Append(',').Append((int)kernel).Append(',').Append(W).Append(',').Append(H).Append(',').Append(F(dx)).Append(',').Append(F(dy)).Append(',').Append(F(dw)).Append(',').Append(F(dh)).Append(',').Append(bw).Append(',').Append(bh).Append(",\"").Append(Convert.ToBase64String(red)).Append("\"]");
    }
   }
  }
  var data=Encoding.UTF8.GetBytes(json.Append("]}").ToString());
  using(var file=File.Create(Path.Combine(directory,"hq-reduction-grid.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(data,0,data.Length);
 }
}
