// Which pre-scale size a rotated HighQuality DrawImage uses when an edge's device length is a whole number or
// within a few float32 steps of one: 16 x 16 noise drawn through DrawImagePoints to a rotated (and for the
// anisotropic set sheared-free) quad, PixelOffsetMode None and Half, both kernels. The record keeps the three
// points as float32 and the bounding box of the covered pixels, so the converter can be run over every candidate
// intermediate size (the native None draw equals the pre-scale plus plain-kernel draw; the Half draw is fitted).
// Writes hq-half-length.json.gz: {"srcBgra","draws":[{"pom","kernel","deg","su","sv","p":[x0,y0,x1,y1,x2,y2],"x","y","w","h","bgra"}]}
// where bgra is the w x h premultiplied window at (x, y) of the 224 x 224 destination.
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.Text; using System.Globalization;
public static class HighQualityHalfLengthProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static byte[] Bytes(Bitmap b){var d=b.LockBits(new Rectangle(0,0,b.Width,b.Height),ImageLockMode.ReadOnly,b.PixelFormat);var a=new byte[b.Width*b.Height*4];try{for(int y=0;y<b.Height;y++)Marshal.Copy(IntPtr.Add(d.Scan0,y*d.Stride),a,y*b.Width*4,b.Width*4);}finally{b.UnlockBits(d);}return a;}
 public static void Run(string directory){
  var json=new StringBuilder();var rng=new Random(60417);
  using(var src=new Bitmap(16,16,PixelFormat.Format32bppArgb)){
   for(int y=0;y<16;y++)for(int x=0;x<16;x++)src.SetPixel(x,y,Color.FromArgb(255,rng.Next(256),rng.Next(256),rng.Next(256)));
   json.Append("{\"srcBgra\":\"").Append(Convert.ToBase64String(Bytes(src))).Append("\",\"draws\":[");bool first=true;
   var scales=new List<float[]>();
   foreach(float s in new float[]{.5f,.75f,1.5f,2f,2.5f,3f})scales.Add(new[]{s,s});
   scales.Add(new[]{.5f,1.5f});scales.Add(new[]{1.5f,.5f});scales.Add(new[]{.5f,2f});scales.Add(new[]{2f,.75f});scales.Add(new[]{.75f,3f});scales.Add(new[]{2.5f,.5f});
   foreach(InterpolationMode kernel in new InterpolationMode[]{InterpolationMode.HighQualityBilinear,InterpolationMode.HighQualityBicubic})
   foreach(PixelOffsetMode pom in new PixelOffsetMode[]{PixelOffsetMode.None,PixelOffsetMode.Half})
   foreach(float deg in new float[]{15,20,30,40,45,50,60,75,100,135,160})
   foreach(var sc in scales){
    using(var dest=new Bitmap(224,224,PixelFormat.Format32bppPArgb)){
     double r=deg*Math.PI/180,cs=Math.Cos(r),sn=Math.Sin(r);float su=sc[0]*16,sv=sc[1]*16;float ox=100,oy=60;
     PointF p0=new PointF(ox,oy),p1=new PointF(ox+(float)(cs*su),oy+(float)(sn*su)),p2=new PointF(ox-(float)(sn*sv),oy+(float)(cs*sv));
     using(var g=Graphics.FromImage(dest)){g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=kernel;g.PixelOffsetMode=pom;g.DrawImage(src,new PointF[]{p0,p1,p2},new RectangleF(0,0,16,16),GraphicsUnit.Pixel);}
     var all=Bytes(dest);int x0=999,y0=999,x1=-1,y1=-1;
     for(int y=0;y<224;y++)for(int x=0;x<224;x++)if(all[(y*224+x)*4+3]!=0){x0=Math.Min(x0,x);y0=Math.Min(y0,y);x1=Math.Max(x1,x);y1=Math.Max(y1,y);}
     if(x1<0)continue;
     x0=Math.Max(0,x0-3);y0=Math.Max(0,y0-3);x1=Math.Min(223,x1+3);y1=Math.Min(223,y1+3);
     int w=x1-x0+1,h=y1-y0+1;var win=new byte[w*h*4];
     for(int y=0;y<h;y++)Buffer.BlockCopy(all,((y0+y)*224+x0)*4,win,y*w*4,w*4);
     if(!first)json.Append(',');first=false;
     json.Append("{\"pom\":").Append((int)pom).Append(",\"kernel\":").Append((int)kernel).Append(",\"deg\":").Append(F(deg)).Append(",\"su\":").Append(F(sc[0])).Append(",\"sv\":").Append(F(sc[1]))
      .Append(",\"p\":[").Append(F(p0.X)).Append(',').Append(F(p0.Y)).Append(',').Append(F(p1.X)).Append(',').Append(F(p1.Y)).Append(',').Append(F(p2.X)).Append(',').Append(F(p2.Y))
      .Append("],\"x\":").Append(x0).Append(",\"y\":").Append(y0).Append(",\"w\":").Append(w).Append(",\"h\":").Append(h).Append(",\"bgra\":\"").Append(Convert.ToBase64String(win)).Append("\"}");
    }
   }
   json.Append("]}");
  }
  var data=Encoding.UTF8.GetBytes(json.ToString());
  using(var file=File.Create(Path.Combine(directory,"hq-half-length.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(data,0,data.Length);
 }
}
