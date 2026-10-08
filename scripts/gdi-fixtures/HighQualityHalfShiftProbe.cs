// Finds which translation of a PixelOffsetMode None draw reproduces a PixelOffsetMode Half draw of the
// same rotated high-quality quad. Writes the best matches only (pixel mismatches against 1/16-pixel shifts).
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.Text; using System.Globalization; using System.Collections.Generic;
public static class HighQualityHalfShiftProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static byte[] Bytes(Bitmap b){var d=b.LockBits(new Rectangle(0,0,b.Width,b.Height),ImageLockMode.ReadOnly,b.PixelFormat);var a=new byte[b.Width*b.Height*4];try{for(int y=0;y<b.Height;y++)Marshal.Copy(IntPtr.Add(d.Scan0,y*d.Stride),a,y*b.Width*4,b.Width*4);}finally{b.UnlockBits(d);}return a;}
 static byte[] Draw(Bitmap src,InterpolationMode kernel,PixelOffsetMode pom,PointF[] pts){return Draw(src,kernel,pom,pts,new RectangleF(0,0,src.Width,src.Height));}
 static byte[] Draw(Bitmap src,InterpolationMode kernel,PixelOffsetMode pom,PointF[] pts,RectangleF sr){using(var dest=new Bitmap(96,96,PixelFormat.Format32bppPArgb)){using(var g=Graphics.FromImage(dest)){g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=kernel;g.PixelOffsetMode=pom;g.DrawImage(src,pts,sr,GraphicsUnit.Pixel);}return Bytes(dest);}}
 static int Diff(byte[] a,byte[] b){int c=0;for(int i=0;i<a.Length;i++)c+=Math.Abs(a[i]-b[i]);return c;}
 public static void Run(string directory){var json=new StringBuilder("[");var rng=new Random(4411);
 using(var src=new Bitmap(16,16,PixelFormat.Format32bppArgb)){
 for(int y=0;y<16;y++)for(int x=0;x<16;x++)src.SetPixel(x,y,Color.FromArgb(255,rng.Next(256),rng.Next(256),rng.Next(256)));
 foreach(InterpolationMode kernel in new InterpolationMode[]{InterpolationMode.HighQualityBilinear,InterpolationMode.HighQualityBicubic})
 foreach(float deg in new float[]{0,.0005f,10,30,45,60,90})
 foreach(float[] sc in new float[][]{new float[]{1,1},new float[]{1.5f,1.5f},new float[]{2,2},new float[]{3,3},new float[]{2,3},new float[]{.5f,.5f}}){
  double r=deg*Math.PI/180,cs=Math.Cos(r),sn=Math.Sin(r);float su=sc[0]*16,sv=sc[1]*16;float ox=36,oy=12;
  PointF p0=new PointF(ox,oy),p1=new PointF(ox+(float)(cs*su),oy+(float)(sn*su)),p2=new PointF(ox-(float)(sn*sv),oy+(float)(cs*sv));
  if(deg==0){p1=new PointF(ox+su,oy);p2=new PointF(ox,oy+sv);}
  var half=Draw(src,kernel,PixelOffsetMode.Half,new PointF[]{p0,p1,p2});
  var results=new List<KeyValuePair<int,string>>();
  for(int ix=-20;ix<=20;ix++)for(int iy=-20;iy<=20;iy++){float dx=ix/16f,dy=iy/16f;
   var none=Draw(src,kernel,PixelOffsetMode.None,new PointF[]{new PointF(p0.X+dx,p0.Y+dy),new PointF(p1.X+dx,p1.Y+dy),new PointF(p2.X+dx,p2.Y+dy)},new RectangleF(-.5f,-.5f,16,16));
   results.Add(new KeyValuePair<int,string>(Diff(half,none),F(dx)+","+F(dy)));
  }
  results.Sort((a,b)=>a.Key.CompareTo(b.Key));
  var sb=new StringBuilder();for(int i=0;i<4;i++){if(i>0)sb.Append(',');sb.Append("[").Append(results[i].Key).Append(",\"").Append(results[i].Value).Append("\"]");}
  if(json.Length>1)json.Append(',');
  json.Append("{\"kernel\":").Append((int)kernel).Append(",\"deg\":").Append(F(deg)).Append(",\"sx\":").Append(F(sc[0])).Append(",\"sy\":").Append(F(sc[1])).Append(",\"p\":[").Append(F(p0.X)).Append(',').Append(F(p0.Y)).Append(',').Append(F(p1.X)).Append(',').Append(F(p1.Y)).Append(',').Append(F(p2.X)).Append(',').Append(F(p2.Y)).Append("],\"best\":[").Append(sb).Append("]}");
 }}
 var data=Encoding.UTF8.GetBytes(json.Append(']').ToString());File.WriteAllBytes(Path.Combine(directory,"hq-half-shift.json"),data);}
}
