// Public DrawImagePoints controls: impulse, two-impulse and noise sources drawn rotated under the
// high-quality kernels, to separate an area-integrated footprint from filtering along the source axes.
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.Text; using System.Globalization;
public static class HighQualityRotatedProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static byte[] Bytes(Bitmap b){var d=b.LockBits(new Rectangle(0,0,b.Width,b.Height),ImageLockMode.ReadOnly,b.PixelFormat);var a=new byte[b.Width*b.Height*4];try{for(int y=0;y<b.Height;y++)Marshal.Copy(IntPtr.Add(d.Scan0,y*d.Stride),a,y*b.Width*4,b.Width*4);}finally{b.UnlockBits(d);}return a;}
 static bool On(int pattern,int x,int y){
  if(pattern==0)return x==5&&y==5;
  if(pattern==1)return (x==4&&y==4)||(x==7&&y==7);
  return (x==4&&y==7)||(x==7&&y==4);
 }
 public static void Run(string directory){var json=new StringBuilder("[");var rng=new Random(88121);
 for(int pattern=0;pattern<4;pattern++)using(var src=new Bitmap(12,12,PixelFormat.Format32bppArgb)){
 for(int y=0;y<12;y++)for(int x=0;x<12;x++){Color c;
  if(pattern<3){int v=On(pattern,x,y)?255:0;c=Color.FromArgb(255,v,v,v);}
  else c=Color.FromArgb(255,rng.Next(256),rng.Next(256),rng.Next(256));
  src.SetPixel(x,y,c);}
 foreach(InterpolationMode kernel in new InterpolationMode[]{InterpolationMode.HighQualityBilinear,InterpolationMode.HighQualityBicubic})
 foreach(PixelOffsetMode pom in new PixelOffsetMode[]{PixelOffsetMode.None,PixelOffsetMode.Half})
 foreach(float deg in new float[]{0,10,30,45,60})
 foreach(float[] sc in new float[][]{new float[]{1.5f,1.5f},new float[]{2,2},new float[]{3,3},new float[]{2,3},new float[]{1.25f,1.25f},new float[]{1.1f,1.1f}})
 using(var dest=new Bitmap(96,96,PixelFormat.Format32bppPArgb)){
  double r=deg*Math.PI/180,cs=Math.Cos(r),sn=Math.Sin(r);float su=sc[0]*12,sv=sc[1]*12;
  float ox=40,oy=20;
  PointF p0=new PointF(ox,oy),p1=new PointF(ox+(float)(cs*su),oy+(float)(sn*su)),p2=new PointF(ox-(float)(sn*sv),oy+(float)(cs*sv));
  if(deg==0){p1=new PointF(ox+su,oy);p2=new PointF(ox,oy+sv);}
  using(var g=Graphics.FromImage(dest)){g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=kernel;g.PixelOffsetMode=pom;g.DrawImage(src,new PointF[]{p0,p1,p2},new RectangleF(0,0,12,12),GraphicsUnit.Pixel);}
  // Two-step controls: scale to the destination extent axis-aligned with the same kernel, then draw that bitmap rotated with the plain kernel.
  int W=(int)Math.Ceiling(su-1e-4),H=(int)Math.Ceiling(sv-1e-4);string two="";
  foreach(PixelOffsetMode pom1 in new PixelOffsetMode[]{PixelOffsetMode.None,pom})using(var mid=new Bitmap(W,H,PixelFormat.Format32bppPArgb))using(var dest2=new Bitmap(96,96,PixelFormat.Format32bppPArgb)){
   using(var g=Graphics.FromImage(mid)){g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=kernel;g.PixelOffsetMode=pom1;g.DrawImage(src,new RectangleF(0,0,W,H),new RectangleF(0,0,12,12),GraphicsUnit.Pixel);}
   using(var g=Graphics.FromImage(dest2)){g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=kernel==InterpolationMode.HighQualityBicubic?InterpolationMode.Bicubic:InterpolationMode.Bilinear;g.PixelOffsetMode=pom;g.DrawImage(mid,new PointF[]{p0,p1,p2},new RectangleF(0,0,W,H),GraphicsUnit.Pixel);}
   two+=",\"two"+(int)pom1+"\":\""+Convert.ToBase64String(Bytes(dest2))+"\",\"mid"+(int)pom1+"\":\""+Convert.ToBase64String(Bytes(mid))+"\"";
   if(pom1==pom)break;
  }
  if(json.Length>1)json.Append(',');
  json.Append("{\"kernel\":").Append((int)kernel).Append(",\"pom\":").Append((int)pom).Append(",\"pattern\":").Append(pattern).Append(",\"deg\":").Append(F(deg)).Append(",\"sx\":").Append(F(sc[0])).Append(",\"sy\":").Append(F(sc[1]))
  .Append(",\"p\":[").Append(F(p0.X)).Append(',').Append(F(p0.Y)).Append(',').Append(F(p1.X)).Append(',').Append(F(p1.Y)).Append(',').Append(F(p2.X)).Append(',').Append(F(p2.Y))
  .Append("],\"srcBgra\":\"").Append(Convert.ToBase64String(Bytes(src))).Append("\",\"bgra\":\"").Append(Convert.ToBase64String(Bytes(dest))).Append("\"").Append(two).Append(",\"mid\":[").Append(W).Append(',').Append(H).Append("]}");
 }}
 var data=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"hq-rotated.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(data,0,data.Length);}
}
