// Independent public PathGradientBrush alpha controls include unequal surround colors and focus scales.
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.IO.Compression; using System.Text; using System.Globalization;
public static class PathGradientAlphaProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 public static void Run(string directory){var json=new StringBuilder("[");var rng=new Random(68319);
 for(int shape=0;shape<2;shape++)for(int center=0;center<2;center++)for(int order=0;order<2;order++)for(int color=0;color<5;color++)for(int varying=0;varying<2;varying++)for(int focus=0;focus<3;focus++)
 using(var bitmap=new Bitmap(100,80,PixelFormat.Format32bppPArgb)){
 PointF[] points=shape==0?new PointF[]{new PointF(9,17),new PointF(86,8),new PointF(57,68)}:new PointF[]{new PointF(14,12),new PointF(77,21),new PointF(39,64)};
 if(order==1)Array.Reverse(points);
 int aa=new int[]{0,255,57,179,255}[color],ba=new int[]{255,0,217,103,255}[color];
 Color a=Color.FromArgb(aa,rng.Next(256),rng.Next(256),rng.Next(256));Color[] b=new Color[3];for(int i=0;i<3;i++)b[i]=i>0&&varying==0?b[0]:Color.FromArgb(varying==0?ba:(ba+i*71)%256,rng.Next(256),rng.Next(256),rng.Next(256));
 PointF c=center==0?new PointF(47,35):new PointF(43,29),f=focus==0?new PointF(0,0):focus==1?new PointF(.5f,.5f):new PointF(.75f,.25f);
 using(var brush=new PathGradientBrush(points))using(var g=Graphics.FromImage(bitmap)){
 brush.CenterPoint=c;brush.CenterColor=a;brush.SurroundColors=b;brush.FocusScales=f;brush.WrapMode=WrapMode.Clamp;
 g.CompositingMode=CompositingMode.SourceCopy;g.SmoothingMode=SmoothingMode.None;g.PixelOffsetMode=PixelOffsetMode.None;g.FillRectangle(brush,0,0,100,80);
 }
 byte[] data=new byte[32000];var bits=bitmap.LockBits(new Rectangle(0,0,100,80),ImageLockMode.ReadOnly,PixelFormat.Format32bppPArgb);try{for(int y=0;y<80;y++)Marshal.Copy(IntPtr.Add(bits.Scan0,y*bits.Stride),data,y*400,400);}finally{bitmap.UnlockBits(bits);}
 if(json.Length>1)json.Append(',');json.Append("{\"shape\":").Append(shape).Append(",\"order\":").Append(order).Append(",\"color\":").Append(color).Append(",\"varying\":").Append(varying).Append(",\"center\":[").Append(F(c.X)).Append(',').Append(F(c.Y)).Append("],\"focus\":[").Append(F(f.X)).Append(',').Append(F(f.Y)).Append("],\"a\":").Append(unchecked((uint)a.ToArgb())).Append(",\"boundaryArgb\":[").Append(unchecked((uint)b[0].ToArgb())).Append(',').Append(unchecked((uint)b[1].ToArgb())).Append(',').Append(unchecked((uint)b[2].ToArgb())).Append("],\"points\":[");
 for(int i=0;i<3;i++){if(i>0)json.Append(',');json.Append('[').Append(F(points[i].X)).Append(',').Append(F(points[i].Y)).Append(']');}
 json.Append("],\"types\":\"AAEB\",\"bgra\":\"").Append(Convert.ToBase64String(data)).Append("\"}");
 }
 var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"path-gradient-alpha.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
}
