// Start position of a HighQuality horizontal reduction as a function of the destination's left edge, read from noise:
// DrawImage(destRect, srcRect) at (dx, 4) of a grey noise W x 48 bitmap (independent texels) into D x 20 (vertical scale 20/48 as
// in gpx-image-highqualitybicubic), both kernels. Groups:
//   a  W = 64, D 50 .. 63 (every scale a dyadic fraction, so every texel edge is a tie), dx 4 .. 2000 (whole)
//   b  other dyadic scales (48 -> 40, 42, 44; 96 -> 80, 84; 128 -> 104, 116) at dx 4, 98, 300, 700
//   c  64 -> 58 at fractional edges (98 + 1/16 .. 98 + 15/16, 4.5, 300.5, 700.5)
//   d  W = 64, D 52, 58, 59, every whole dx 56 .. 140 and every tenth 150 .. 700
//   e  (group 4) the vertical axis: 48 x 64 noise into 48 x D (D 50, 52, 54, 58, 59) at (4, dy), dy 4 .. 600
// A first version of this probe read single impulse columns at 255 intensities; they resolve a weight only to 1/255 and every
// fitted position interval contained the converter's (a one-unit error moves a weight by under 1/255 in the kernel's tails),
// so noise (sums of several weights times random texels) is used and each destination pixel's position is fitted from its column.
// The draws keep the red channel of columns floor(dx) - 2 .. of the destination bitmap (premultiplied, SourceCopy over transparent).
// Writes hq-reduction-positions.json.gz: {"draws":[[group,kernel,W,D,dx,columns,bitmapH,"base64 red"]...]}.
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.Text; using System.Globalization;
public static class HighQualityReductionPositionProbe {
 // Group 4, the vertical axis: a noise 48 x H (H = 64) bitmap into 48 x D at (4, dy), stored as the rows floor(dy) - 2 .. of the whole
 // width; fields: group, kernel, H, D, dy, columns, stored rows, red.
 static void DrawVertical(StringBuilder json,ref bool first,InterpolationMode kernel,int H,int D,int dy){
  int W=48;
  uint seed=(uint)(W*7919+D*104729+H*13+1);
  using(var src=new Bitmap(W,H,PixelFormat.Format32bppArgb)){
   for(int y=0;y<H;y++)for(int x=0;x<W;x++){seed=seed*1664525u+1013904223u;int v=(int)(seed>>24);src.SetPixel(x,y,Color.FromArgb(255,v,v,v));}
   int bw=W+8,bh=dy+D+10;
   using(var dest=new Bitmap(bw,bh,PixelFormat.Format32bppPArgb)){
    using(var g=Graphics.FromImage(dest)){g.Clear(Color.Transparent);g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=kernel;g.PixelOffsetMode=PixelOffsetMode.None;
     g.DrawImage(src,new RectangleF(4,dy,W,D),new RectangleF(0,0,W,H),GraphicsUnit.Pixel);}
    var bd=dest.LockBits(new Rectangle(0,0,bw,bh),ImageLockMode.ReadOnly,PixelFormat.Format32bppPArgb);
    int cy=dy-2,rows=bh-cy;
    var red=new byte[bw*rows];
    for(int y=0;y<rows;y++)for(int x=0;x<bw;x++)red[y*bw+x]=Marshal.ReadByte(bd.Scan0,(cy+y)*bd.Stride+x*4+2);
    dest.UnlockBits(bd);
    if(!first)json.Append(',');first=false;
    json.Append("[4,").Append((int)kernel).Append(',').Append(H).Append(',').Append(D).Append(',').Append(dy).Append(',').Append(bw).Append(',').Append(rows).Append(",\"").Append(Convert.ToBase64String(red)).Append("\"]");
   }
  }
 }
 public static void Run(string directory){
  var json=new StringBuilder("{\"draws\":[");bool first=true;
  var configs=new List<float[]>();
  foreach(int dx in new int[]{4,10,17,33,50,64,65,98,128,200,255,256,300,511,512,600,1000,1500,2000})for(int D=50;D<=63;D++)configs.Add(new float[]{0,64,D,dx});
  foreach(int dx in new int[]{4,98,300,700})foreach(int[] wd in new int[][]{new int[]{48,40},new int[]{48,42},new int[]{48,44},new int[]{96,80},new int[]{96,84},new int[]{128,104},new int[]{128,116}})configs.Add(new float[]{1,wd[0],wd[1],dx});
  foreach(float dx in new float[]{98.0625f,98.125f,98.25f,98.5f,98.75f,98.875f,98.9375f,4.5f,300.5f,700.5f})configs.Add(new float[]{2,64,58,dx});
  var dxs=new List<int>();for(int v=56;v<=140;v++)dxs.Add(v);for(int v=150;v<=700;v+=10)dxs.Add(v);
  foreach(int dx in dxs)foreach(int D in new int[]{52,58,59})configs.Add(new float[]{3,64,D,dx});
  foreach(int dy in new int[]{4,50,64,65,98,128,256,300,512,600})foreach(int D in new int[]{50,52,54,58,59})configs.Add(new float[]{4,64,D,dy});
  foreach(InterpolationMode kernel in new InterpolationMode[]{InterpolationMode.HighQualityBilinear,InterpolationMode.HighQualityBicubic})
  foreach(float[] c in configs){
   int group=(int)c[0],W=(int)c[1],D=(int)c[2];float dx=c[3];
   if(group==3&&kernel==InterpolationMode.HighQualityBicubic)continue;
   if(group==4){DrawVertical(json,ref first,kernel,W,D,(int)dx);continue;}
   uint seed=(uint)(W*7919+D*104729+1);
   using(var src=new Bitmap(W,48,PixelFormat.Format32bppArgb)){
    for(int y=0;y<48;y++)for(int x=0;x<W;x++){seed=seed*1664525u+1013904223u;int v=(int)(seed>>24);src.SetPixel(x,y,Color.FromArgb(255,v,v,v));}
    int bw=(int)Math.Ceiling(dx)+D+10,bh=40;
    using(var dest=new Bitmap(bw,bh,PixelFormat.Format32bppPArgb)){
     using(var g=Graphics.FromImage(dest)){g.Clear(Color.Transparent);g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=kernel;g.PixelOffsetMode=PixelOffsetMode.None;
      g.DrawImage(src,new RectangleF(dx,4,D,20),new RectangleF(0,0,W,48),GraphicsUnit.Pixel);}
     var bd=dest.LockBits(new Rectangle(0,0,bw,bh),ImageLockMode.ReadOnly,PixelFormat.Format32bppPArgb);
     int cx=(int)Math.Floor(dx)-2,cw=bw-cx;
     var red=new byte[cw*bh];
     for(int y=0;y<bh;y++)for(int x=0;x<cw;x++)red[y*cw+x]=Marshal.ReadByte(bd.Scan0,y*bd.Stride+(cx+x)*4+2);
     dest.UnlockBits(bd);
     if(!first)json.Append(',');first=false;
     json.Append('[').Append(group).Append(',').Append((int)kernel).Append(',').Append(W).Append(',').Append(D).Append(',').Append(dx.ToString("R",CultureInfo.InvariantCulture)).Append(',').Append(cw).Append(',').Append(bh).Append(",\"").Append(Convert.ToBase64String(red)).Append("\"]");
    }
   }
  }
  var data=Encoding.UTF8.GetBytes(json.Append("]}").ToString());
  using(var file=File.Create(Path.Combine(directory,"hq-reduction-positions.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(data,0,data.Length);
 }
}
