// Per-destination-pixel weights of an axis-aligned HighQuality DrawImagePoints along one axis, read from impulses:
// the source is opaque black with one white row (or column) t, so the destination red is 255 x the weight of source
// texel t at each destination pixel along the draw's axis and the alpha is the total weight on texels that exist.
// Each layout is a bitmap size and a source rectangle (whole bitmap, inner crops, a crop flush with the origin or a
// crop against the far edge): the draws show how far taps read beyond the rectangle, and at which weights. The other
// axis is a whole-pixel unit scale. axis 0 varies x (optionally mirrored), axis 1 varies y.
// Writes hq-crop-impulse.json.gz: {"draws":[{"kernel","axis","mirror","layout","s","o","t","red" (96 bytes),"alpha"
// (96 bytes)}]} where the bytes run along the draw's axis through the middle of the rectangle on the other axis (8 + its origin + half its size), and
// "layouts" lists [bitmapW, bitmapH, srcX, srcY, srcW, srcH].
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.Text; using System.Globalization;
public static class HighQualityCropImpulseProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 public static void Run(string directory){
  int[][] layouts=new int[][]{
   new[]{32,32,0,0,32,32},new[]{32,32,8,8,16,16},new[]{32,32,0,0,16,16},
   new[]{13,11,2,1,9,7},new[]{32,32,2,1,9,7},new[]{13,11,0,0,13,11},new[]{64,64,8,8,16,16},new[]{16,16,0,0,12,12},new[]{32,32,16,16,16,16},new[]{13,11,4,3,9,8},
   new[]{32,32,0,0,12,12},new[]{16,16,2,2,12,12},new[]{16,16,0,0,10,10},new[]{16,16,0,0,14,14},new[]{16,16,0,0,8,8},new[]{20,20,0,0,12,12},new[]{24,24,0,0,12,12},new[]{32,32,0,0,24,24},new[]{32,32,0,0,16,12},new[]{32,32,0,0,12,16},new[]{16,32,0,0,12,12},new[]{32,16,0,0,12,12}};
  var json=new StringBuilder("{\"layouts\":[");
  for(int i=0;i<layouts.Length;i++){if(i>0)json.Append(',');json.Append('[').Append(string.Join(",",layouts[i])).Append(']');}
  json.Append("],\"draws\":[");bool first=true;
  float[] scales=new float[]{2.25f,1.5f,1f,.625f,3f,2f,.5f};
  float[] origins=new float[]{0,.125f,.375f,.5f,.75f};
  foreach(InterpolationMode kernel in new InterpolationMode[]{InterpolationMode.HighQualityBilinear,InterpolationMode.HighQualityBicubic})
  for(int form=0;form<2;form++)for(int axis=0;axis<2;axis++)for(int mirror=0;mirror<(axis==0?2:1);mirror++)for(int layout=0;layout<layouts.Length;layout++)foreach(float s in scales)foreach(float o in origins){
   int bw=layouts[layout][0],bh=layouts[layout][1],sx=layouts[layout][2],sy=layouts[layout][3],sw=layouts[layout][4],sh=layouts[layout][5];
   for(int t=0;t<(axis==0?bw:bh);t++)using(var src=new Bitmap(bw,bh,PixelFormat.Format32bppArgb))using(var dest=new Bitmap(96,96,PixelFormat.Format32bppPArgb)){
    var sd=src.LockBits(new Rectangle(0,0,bw,bh),ImageLockMode.WriteOnly,PixelFormat.Format32bppArgb);
    for(int y=0;y<bh;y++)for(int x=0;x<bw;x++){byte v=(byte)((axis==0?x:y)==t?255:0);int off=y*sd.Stride+x*4;Marshal.WriteByte(sd.Scan0,off,v);Marshal.WriteByte(sd.Scan0,off+1,v);Marshal.WriteByte(sd.Scan0,off+2,v);Marshal.WriteByte(sd.Scan0,off+3,255);}
    src.UnlockBits(sd);
    float a=1,d=1,e=8,f=8;
    if(axis==0){ if(mirror==0){a=s;e=8+o-a*sx;}else{a=-s;e=8+o+s*(sx+sw);} }
    else { d=s; f=8+o-d*sy; }
    PointF p0=new PointF(a*sx+e,d*sy+f),p1=new PointF(a*(sx+sw)+e,d*sy+f),p2=new PointF(a*sx+e,d*(sy+sh)+f);
    using(var g=Graphics.FromImage(dest)){g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=kernel;g.PixelOffsetMode=PixelOffsetMode.None;
     if(form==0)g.DrawImage(src,new PointF[]{p0,p1,p2},new RectangleF(sx,sy,sw,sh),GraphicsUnit.Pixel);
     else{float dw=Math.Abs(a)*sw,dh=d*sh;float dl=Math.Min(p0.X,p1.X),dt=p0.Y;
      var destRect=a>0?new RectangleF(dl,dt,dw,dh):new RectangleF(dl+dw,dt,-dw,dh);
      g.DrawImage(src,destRect,new RectangleF(sx,sy,sw,sh),GraphicsUnit.Pixel);}}
    var bd=dest.LockBits(new Rectangle(0,0,96,96),ImageLockMode.ReadOnly,PixelFormat.Format32bppPArgb);
    var red=new byte[96];var alpha=new byte[96];
    for(int i=0;i<96;i++){
     int line=axis==0?8+sy+sh/2:8+sx+sw/2;int px=axis==0?i:line,py=axis==0?line:i;
     red[i]=Marshal.ReadByte(bd.Scan0,py*bd.Stride+px*4+2);alpha[i]=Marshal.ReadByte(bd.Scan0,py*bd.Stride+px*4+3);}
    dest.UnlockBits(bd);
    if(!first)json.Append(',');first=false;
    json.Append("{\"kernel\":").Append((int)kernel).Append(",\"axis\":").Append(axis).Append(",\"form\":").Append(form).Append(",\"mirror\":").Append(mirror).Append(",\"layout\":").Append(layout)
     .Append(",\"s\":").Append(F(s)).Append(",\"o\":").Append(F(o)).Append(",\"t\":").Append(t)
     .Append(",\"red\":\"").Append(Convert.ToBase64String(red)).Append("\",\"alpha\":\"").Append(Convert.ToBase64String(alpha)).Append("\"}");
   }
  }
  var data=Encoding.UTF8.GetBytes(json.Append("]}").ToString());
  using(var file=File.Create(Path.Combine(directory,"hq-crop-impulse.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(data,0,data.Length);
 }
}
