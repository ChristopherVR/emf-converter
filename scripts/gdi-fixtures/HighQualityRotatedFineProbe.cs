// Public DrawImagePoints controls for the rotated high-quality pre-scale: a near-axis-aligned shear
// sweep, and a scale sweep that draws the same quad through every candidate intermediate size.
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.Text; using System.Globalization;
public static class HighQualityRotatedFineProbe {
 static byte[] refA,refB;
 static int Diff(byte[] a,byte[] b){int c=0;for(int i=0;i<a.Length;i++)if(a[i]!=b[i])c++;return c;}
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static byte[] Bytes(Bitmap b){var d=b.LockBits(new Rectangle(0,0,b.Width,b.Height),ImageLockMode.ReadOnly,b.PixelFormat);var a=new byte[b.Width*b.Height*4];try{for(int y=0;y<b.Height;y++)Marshal.Copy(IntPtr.Add(d.Scan0,y*d.Stride),a,y*b.Width*4,b.Width*4);}finally{b.UnlockBits(d);}return a;}
 public static void Run(string directory){var json=new StringBuilder("[");var rng=new Random(70211);
 using(var src=new Bitmap(16,16,PixelFormat.Format32bppArgb)){
 for(int y=0;y<16;y++)for(int x=0;x<16;x++)src.SetPixel(x,y,Color.FromArgb(255,rng.Next(256),rng.Next(256),rng.Next(256)));
 string srcB64=Convert.ToBase64String(Bytes(src));
 foreach(InterpolationMode kernel in new InterpolationMode[]{InterpolationMode.HighQualityBilinear,InterpolationMode.HighQualityBicubic}){
  // A. shear sweep
  foreach(float ox in new float[]{30,30.3f})foreach(float shear in new float[]{0,1e-7f,1e-5f,1e-4f,1e-3f,1e-2f,.1f})using(var dest=new Bitmap(96,96,PixelFormat.Format32bppPArgb)){
   bool isRef=shear==0;float su=48,sv=48;PointF p0=new PointF(ox,10.6f),p1=new PointF(ox+su,10.6f+su*shear),p2=new PointF(ox,10.6f+sv);
   using(var g=Graphics.FromImage(dest)){g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=kernel;g.PixelOffsetMode=PixelOffsetMode.None;g.DrawImage(src,new PointF[]{p0,p1,p2},new RectangleF(0,0,16,16),GraphicsUnit.Pixel);}
   if(isRef)refA=Bytes(dest);
   if(json.Length>1)json.Append(',');
   json.Append("{\"set\":\"shear\",\"kernel\":").Append((int)kernel).Append(",\"shear\":").Append(F(shear)).Append(",\"p\":[").Append(F(p0.X)).Append(',').Append(F(p0.Y)).Append(',').Append(F(p1.X)).Append(',').Append(F(p1.Y)).Append(',').Append(F(p2.X)).Append(',').Append(F(p2.Y)).Append("],\"diff\":").Append(Diff(refA,Bytes(dest))).Append(isRef?",\"bgra\":\""+Convert.ToBase64String(Bytes(dest))+"\"":"").Append("}");
  }
  // A2. where a near-axis-aligned quad stops counting as axis-aligned: the far corners' offset against the origin's fractional part
  if(kernel==InterpolationMode.HighQualityBicubic)foreach(float oy in new float[]{10,10.3f,10.6f,10.9f})foreach(int axis in new int[]{0,1})foreach(float d in new float[]{0,.001f,.003f,.005f,.0078f,.01f,.0156f,.02f,.03f,.045f,.0625f,.09f})using(var dest=new Bitmap(96,96,PixelFormat.Format32bppPArgb)){
   bool isRef=d==0;float su=48,sv=48;PointF p0=new PointF(30,oy),p1=new PointF(30+su,oy+(axis==0?d:0)),p2=new PointF(30+(axis==1?d:0),oy+sv);
   using(var g=Graphics.FromImage(dest)){g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=kernel;g.PixelOffsetMode=PixelOffsetMode.None;g.DrawImage(src,new PointF[]{p0,p1,p2},new RectangleF(0,0,16,16),GraphicsUnit.Pixel);}
   if(isRef)refB=Bytes(dest);
   if(json.Length>1)json.Append(',');
   json.Append("{\"set\":\"shear2\",\"kernel\":").Append((int)kernel).Append(",\"oy\":").Append(F(oy)).Append(",\"axis\":").Append(axis).Append(",\"d\":").Append(F(d)).Append(",\"p\":[").Append(F(p0.X)).Append(',').Append(F(p0.Y)).Append(',').Append(F(p1.X)).Append(',').Append(F(p1.Y)).Append(',').Append(F(p2.X)).Append(',').Append(F(p2.Y)).Append("],\"diff\":").Append(Diff(refB,Bytes(dest))).Append(isRef?",\"bgra\":\""+Convert.ToBase64String(Bytes(dest))+"\"":"").Append("}");
  }
  // B. scale sweep with the candidate intermediate sizes
  foreach(PixelOffsetMode pom in new PixelOffsetMode[]{PixelOffsetMode.None,PixelOffsetMode.Half})foreach(float deg in new float[]{20,45})foreach(float[] sc in new float[][]{new float[]{.5f,.5f},new float[]{.75f,.75f},new float[]{.9f,.9f},new float[]{.95f,.95f},new float[]{1,1},new float[]{1.04f,1.04f},new float[]{1.05f,1.05f},new float[]{1.06f,1.06f},new float[]{1.08f,1.08f},new float[]{1.1f,1.1f},new float[]{1.2f,1.2f},new float[]{1.3f,1.3f},new float[]{1.5f,1.5f},new float[]{2,2},new float[]{1,2},new float[]{2,1},new float[]{1.03f,2},new float[]{1.7f,1.3f},new float[]{2.5f,2.5f},new float[]{1.33f,1.33f},new float[]{1.77f,1.77f}})
  using(var dest=new Bitmap(96,96,PixelFormat.Format32bppPArgb)){
   double r=deg*Math.PI/180,cs=Math.Cos(r),sn=Math.Sin(r);float su=sc[0]*16,sv=sc[1]*16;float ox=36,oy=10;
   PointF p0=new PointF(ox,oy),p1=new PointF(ox+(float)(cs*su),oy+(float)(sn*su)),p2=new PointF(ox-(float)(sn*sv),oy+(float)(cs*sv));
   using(var g=Graphics.FromImage(dest)){g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=kernel;g.PixelOffsetMode=pom;g.DrawImage(src,new PointF[]{p0,p1,p2},new RectangleF(0,0,16,16),GraphicsUnit.Pixel);}
   float lu=(float)Math.Sqrt((p1.X-p0.X)*(p1.X-p0.X)+(p1.Y-p0.Y)*(p1.Y-p0.Y)),lv=(float)Math.Sqrt((p2.X-p0.X)*(p2.X-p0.X)+(p2.Y-p0.Y)*(p2.Y-p0.Y));
   int w0=(int)Math.Floor(lu)-1,h0=(int)Math.Floor(lv)-1;string two="";
   if(pom==PixelOffsetMode.None)for(int dw=0;dw<4;dw++)for(int dh=0;dh<4;dh++){
    int W=Math.Max(1,w0+dw),H=Math.Max(1,h0+dh);
    using(var mid=new Bitmap(W,H,PixelFormat.Format32bppPArgb))using(var dest2=new Bitmap(96,96,PixelFormat.Format32bppPArgb)){
     using(var g=Graphics.FromImage(mid)){g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=kernel;g.PixelOffsetMode=PixelOffsetMode.None;g.DrawImage(src,new RectangleF(0,0,W,H),new RectangleF(0,0,16,16),GraphicsUnit.Pixel);}
     using(var g=Graphics.FromImage(dest2)){g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=kernel==InterpolationMode.HighQualityBicubic?InterpolationMode.Bicubic:InterpolationMode.Bilinear;g.PixelOffsetMode=PixelOffsetMode.None;g.DrawImage(mid,new PointF[]{p0,p1,p2},new RectangleF(0,0,W,H),GraphicsUnit.Pixel);}
     two+=(two.Length>0?",":"")+"["+W+","+H+","+Diff(Bytes(dest),Bytes(dest2))+"]";
    }
   }
   if(json.Length>1)json.Append(',');
   json.Append("{\"set\":\"scale\",\"pom\":").Append((int)pom).Append(",\"kernel\":").Append((int)kernel).Append(",\"deg\":").Append(F(deg)).Append(",\"sx\":").Append(F(sc[0])).Append(",\"sy\":").Append(F(sc[1])).Append(",\"lu\":").Append(F(lu)).Append(",\"lv\":").Append(F(lv)).Append(",\"p\":[").Append(F(p0.X)).Append(',').Append(F(p0.Y)).Append(',').Append(F(p1.X)).Append(',').Append(F(p1.Y)).Append(',').Append(F(p2.X)).Append(',').Append(F(p2.Y)).Append("],\"bgra\":\"").Append(Convert.ToBase64String(Bytes(dest))).Append("\",\"two\":[").Append(two).Append("]}");
  }
 }
 json.Insert(1,"{\"set\":\"source\",\"srcBgra\":\""+srcB64+"\"},");
 }
 var data=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"hq-rotated-fine.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(data,0,data.Length);}
}
