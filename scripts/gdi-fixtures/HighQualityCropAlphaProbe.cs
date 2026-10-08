// How much weight an axis-aligned HighQuality DrawImagePoints puts on texels beyond its source rectangle, read from
// alpha: the 40 x 40 source is opaque white, so a destination pixel's alpha is the share of its kernel that landed
// on existing texels, and any shortfall at the rectangle's edge is the taps the draw did not read. One draw per
// rectangle size (1 to 32 each way), rectangle origin (0, 0) or (4, 4), scale pair, fractional destination origin,
// whole destination offset (8, 16, 24 or 40) and kernel, plain and mirrored in x. The record keeps the alpha of the
// first and last covered pixel through the middle of the other axis, along both axes. The draws run in the order
// the HQ_ORDER environment variable names: unset or "0" the nested loop order, "1" the reverse, "2" a seeded
// shuffle, "3" every draw preceded by a throwaway draw of the full bitmap (the results do not depend on it).
// Writes hq-crop-alpha.json.gz: {"draws":[[kernel,mirror,originIndex,scaleIndex,fractionIndex,sw,sh,baseIndex,
// topRow,top,bottom,left,right]...]} where topRow is the first covered row, and top/bottom/left/right the alphas of
// the first and last covered pixel of the middle column and the middle row (-1 if nothing is covered).
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.Text; using System.Globalization;
public static class HighQualityCropAlphaProbe {
 public static void Run(string directory){
  var json=new StringBuilder("{\"scales\":[[1,1],[2.25,2.25],[1,2.25],[2.25,1]],\"fractions\":[0.125,0.375],\"origins\":[[0,0],[4,4]],\"bases\":[8,16,24,40],\"draws\":[");bool first=true;
  float[][] scales=new float[][]{new[]{1f,1f},new[]{2.25f,2.25f},new[]{1f,2.25f},new[]{2.25f,1f}};
  float[] fractions=new float[]{.125f,.375f};
  int[][] origins=new int[][]{new[]{0,0},new[]{4,4}};
  int[] bases=new int[]{8,16,24,40};
  const int SIZE=176;
  string order=Environment.GetEnvironmentVariable("HQ_ORDER")??"0";
  var configs=new List<int[]>();
  foreach(int kernel in new int[]{(int)InterpolationMode.HighQualityBilinear,(int)InterpolationMode.HighQualityBicubic})
  for(int mirror=0;mirror<2;mirror++)for(int oi=0;oi<2;oi++)for(int si=0;si<4;si++)for(int fi=0;fi<2;fi++)for(int bi=0;bi<4;bi++)
  for(int sw=1;sw<=32;sw++)for(int sh=1;sh<=32;sh++)if(origins[oi][0]+sw<=40&&origins[oi][1]+sh<=40)configs.Add(new[]{kernel,mirror,oi,si,fi,sw,sh,bi});
  if(order=="1")configs.Reverse();
  if(order=="2"){var rng=new Random(77);for(int i=configs.Count-1;i>0;i--){int j=rng.Next(i+1);var t=configs[i];configs[i]=configs[j];configs[j]=t;}}
  using(var src=new Bitmap(40,40,PixelFormat.Format32bppArgb))using(var warm=new Bitmap(SIZE,SIZE,PixelFormat.Format32bppPArgb)){
   using(var g0=Graphics.FromImage(src))g0.Clear(Color.White);
   foreach(var c in configs)using(var dest=new Bitmap(SIZE,SIZE,PixelFormat.Format32bppPArgb)){
    InterpolationMode kernel=(InterpolationMode)c[0];int mirror=c[1],oi=c[2],si=c[3],fi=c[4],sw=c[5],sh=c[6],bi=c[7];
    if(order=="3")using(var gw=Graphics.FromImage(warm)){gw.CompositingMode=CompositingMode.SourceCopy;gw.InterpolationMode=kernel;gw.PixelOffsetMode=PixelOffsetMode.None;gw.DrawImage(src,new PointF[]{new PointF(8.3f,8.3f),new PointF(48.3f,8.3f),new PointF(8.3f,48.3f)},new RectangleF(0,0,40,40),GraphicsUnit.Pixel);}
    int sx=origins[oi][0],sy=origins[oi][1];
    float a=scales[si][0],d=scales[si][1],fr=fractions[fi];float bs=bases[bi];float e,f=bs+fr-d*sy;
    if(mirror==0){e=bs+fr-a*sx;}else{e=bs+fr+a*(sx+sw);a=-a;}
    PointF p0=new PointF(a*sx+e,d*sy+f),p1=new PointF(a*(sx+sw)+e,d*sy+f),p2=new PointF(a*sx+e,d*(sy+sh)+f);
    using(var g=Graphics.FromImage(dest)){g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=kernel;g.PixelOffsetMode=PixelOffsetMode.None;
     g.DrawImage(src,new PointF[]{p0,p1,p2},new RectangleF(sx,sy,sw,sh),GraphicsUnit.Pixel);}
    var bd=dest.LockBits(new Rectangle(0,0,SIZE,SIZE),ImageLockMode.ReadOnly,PixelFormat.Format32bppPArgb);
    Func<int,int,int> A=(x,y)=>Marshal.ReadByte(bd.Scan0,y*bd.Stride+x*4+3);
    int x0=999,x1=-1,y0=999,y1=-1;
    for(int y=0;y<SIZE;y++)for(int x=0;x<SIZE;x++)if(A(x,y)>0){x0=Math.Min(x0,x);x1=Math.Max(x1,x);y0=Math.Min(y0,y);y1=Math.Max(y1,y);}
    int top=-1,bottom=-1,left=-1,right=-1;
    if(x1>=0){int mx=(x0+x1)/2,my=(y0+y1)/2;top=A(mx,y0);bottom=A(mx,y1);left=A(x0,my);right=A(x1,my);}
    dest.UnlockBits(bd);
    if(!first)json.Append(',');first=false;
    json.Append('[').Append(c[0]).Append(',').Append(mirror).Append(',').Append(oi).Append(',').Append(si).Append(',').Append(fi).Append(',').Append(sw).Append(',').Append(sh).Append(',').Append(bi).Append(',')
     .Append(y0).Append(',').Append(top).Append(',').Append(bottom).Append(',').Append(left).Append(',').Append(right).Append(']');
   }
  }
  var data=Encoding.UTF8.GetBytes(json.Append("]}").ToString());
  using(var file=File.Create(Path.Combine(directory,"hq-crop-alpha.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(data,0,data.Length);
 }
}
