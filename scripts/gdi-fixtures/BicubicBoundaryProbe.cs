// Where the unit-scale plain Bicubic DrawImage stops copying: an opaque noise bitmap drawn 1:1 through
// DrawImage(destRect, srcRect) with the source rectangle's offset swept in 1/4096 texel steps around a whole texel
// (so the 1/64 boundary at +-64/4096 is crossed in single steps), then classified by comparing the destination with
// the draw at offset 0 (a copy at a whole destination offset).
//
// Part 1 (sweep): a 12 x 12 bitmap, sizes 8 x 8 and 5 x 7 at six fractional destination offsets, and every size from
// 1 x 1 to 10 x 10 at a whole one, the offset swept along x, along y or along both from -80/4096 to 80/4096. Each draw
// keeps the 10 x 10 window of the 24 x 24 destination around the rectangle so the converter can classify it as the
// copy or the convolution (src/emf-plus-bicubic-arithmetic.fixture.test.ts replays it).
// Part 2 (independent offsets): sizes 8 x 8, 5 x 7, 8 x 4, 6 x 6, 4 x 8 and 3 x 3 with the two offsets swept
// independently over -66..66 around the boundaries.
// Part 3 (sizes): a 48 x 48 bitmap, rectangle sizes from 1 to 32 (powers of two and others) at two whole destination
// offsets, the x offset at the boundary (63, 64, 65) against a set of y offsets; only whether the destination equals
// the draw at offset 0 is kept.
// Writes bicubic-boundary.json.gz: {"src" (12 x 12 x BGRA, base64),"draws":[{"axis" (0 x, 1 y, 2 both, 3 independent),
// "destFrac","w","h","k" (offset in 1/4096; "k2" along y),"srcX","srcY","destX","destY","bgra" (10 x 10 window at
// (3, 3))}],"big" (the 48 x 48 bitmap),"sizes":[{"w","h","destX","destY","k","k2","same"}]} where same is 1 when the draw equals the offset-0 draw.
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.Text; using System.Globalization;
public static class BicubicBoundaryProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static byte[] Bytes(Bitmap b){var d=b.LockBits(new Rectangle(0,0,b.Width,b.Height),ImageLockMode.ReadOnly,b.PixelFormat);var a=new byte[b.Width*b.Height*4];try{for(int y=0;y<b.Height;y++)Marshal.Copy(IntPtr.Add(d.Scan0,y*d.Stride),a,y*b.Width*4,b.Width*4);}finally{b.UnlockBits(d);}return a;}
 static byte[] Draw(Bitmap src,int dim,float dx,float dy,int w,int h,float sx,float sy){
  using(var dest=new Bitmap(dim,dim,PixelFormat.Format32bppPArgb)){
   using(var g=Graphics.FromImage(dest)){g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=InterpolationMode.Bicubic;g.PixelOffsetMode=PixelOffsetMode.None;
    g.DrawImage(src,new RectangleF(dx,dy,w,h),new RectangleF(sx,sy,w,h),GraphicsUnit.Pixel);}
   return Bytes(dest);}
 }
 public static void Run(string directory){
  var rng=new Random(55123);
  using(var src=new Bitmap(12,12,PixelFormat.Format32bppArgb))using(var big=new Bitmap(48,48,PixelFormat.Format32bppArgb)){
   for(int y=0;y<12;y++)for(int x=0;x<12;x++)src.SetPixel(x,y,Color.FromArgb(255,rng.Next(256),rng.Next(256),rng.Next(256)));
   for(int y=0;y<48;y++)for(int x=0;x<48;x++)big.SetPixel(x,y,Color.FromArgb(255,rng.Next(256),rng.Next(256),rng.Next(256)));
   var json=new StringBuilder("{\"src\":\"").Append(Convert.ToBase64String(Bytes(src))).Append("\",\"draws\":[");bool first=true;
   var configs=new List<float[]>();
   foreach(float destFrac in new float[]{0,1/16f,1/8f,1/4f,1/2f,3/4f})foreach(int[] size in new int[][]{new[]{8,8},new[]{5,7}})
    for(int axis=0;axis<3;axis++)for(int k=-80;k<=80;k++)configs.Add(new float[]{destFrac,size[0],size[1],axis,k,k});
   for(int w=1;w<=10;w++)for(int h=1;h<=10;h++)if(!((w==8&&h==8)||(w==5&&h==7)))
    for(int axis=0;axis<3;axis++)foreach(int k in new int[]{-66,-65,-64,-63,-1,0,1,62,63,64,65,66})configs.Add(new float[]{0,w,h,axis,k,k});
   foreach(int[] size in new int[][]{new[]{8,8},new[]{5,7},new[]{8,4},new[]{6,6},new[]{4,8},new[]{3,3}})
    foreach(int kx in new int[]{-66,-65,-64,-63,-33,-32,-31,-1,0,1,31,32,33,63,64,65,66})foreach(int ky in new int[]{-66,-65,-64,-63,-33,-32,-31,-1,0,1,31,32,33,63,64,65,66})
     configs.Add(new float[]{0,size[0],size[1],3,kx,ky});
   foreach(var cfg in configs){
    float destFrac=cfg[0];int w=(int)cfg[1],h=(int)cfg[2];int axis=(int)cfg[3];int k=(int)cfg[4],k2=(int)cfg[5];
    float sx=2+(axis!=1?k/4096f:0),sy=2+(axis==3?k2/4096f:axis!=0?k/4096f:0);float dx=4+destFrac,dy=4+destFrac;
    var all=Draw(src,24,dx,dy,w,h,sx,sy);var win=new byte[10*10*4];
    for(int y=0;y<10;y++)Buffer.BlockCopy(all,((3+y)*24+3)*4,win,y*40,40);
    if(!first)json.Append(',');first=false;
    json.Append("{\"axis\":").Append(axis).Append(",\"destFrac\":").Append(F(destFrac)).Append(",\"w\":").Append(w).Append(",\"h\":").Append(h).Append(",\"k\":").Append(k).Append(",\"k2\":").Append(k2)
     .Append(",\"srcX\":").Append(F(sx)).Append(",\"srcY\":").Append(F(sy)).Append(",\"destX\":").Append(F(dx)).Append(",\"destY\":").Append(F(dy)).Append(",\"bgra\":\"").Append(Convert.ToBase64String(win)).Append("\"}");
   }
   json.Append("],\"big\":\"").Append(Convert.ToBase64String(Bytes(big))).Append("\",\"sizes\":[");first=true;
   foreach(float[] dest in new float[][]{new[]{4f,4f},new[]{7f,9f}})
   foreach(int w in new int[]{1,2,3,4,5,6,7,8,12,16,24,32})foreach(int h in new int[]{1,2,3,4,5,6,7,8,12,16,24,32}){
    if(dest[0]+w>46||dest[1]+h>46)continue;
    var refImg=Draw(big,64,dest[0],dest[1],w,h,2,2);
    foreach(int kx in new int[]{63,64,65})foreach(int ky in new int[]{-64,-63,-33,-32,-31,-1,0,1,31,32,33,63}){
     if(2+w+1>48||2+h+1>48)continue;
     var img=Draw(big,64,dest[0],dest[1],w,h,2+kx/4096f,2+ky/4096f);bool same=true;for(int i=0;i<img.Length;i++)if(img[i]!=refImg[i]){same=false;break;}
     if(!first)json.Append(',');first=false;
     json.Append("{\"w\":").Append(w).Append(",\"h\":").Append(h).Append(",\"destX\":").Append(F(dest[0])).Append(",\"destY\":").Append(F(dest[1])).Append(",\"k\":").Append(kx).Append(",\"k2\":").Append(ky).Append(",\"same\":").Append(same?1:0).Append('}');
    }
   }
   json.Append("]}");
   var data=Encoding.UTF8.GetBytes(json.ToString());
   using(var file=File.Create(Path.Combine(directory,"bicubic-boundary.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(data,0,data.Length);
  }
 }
}
