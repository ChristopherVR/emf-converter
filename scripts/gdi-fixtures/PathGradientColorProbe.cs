// Public PathGradientBrush controls isolate channel interpolation and ellipse wrap geometry.
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.IO.Compression; using System.Text; using System.Globalization;
public static class PathGradientColorProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 public static void Run(string directory){var json=new StringBuilder("[");
 for(int shape=0;shape<4;shape++)for(int center=0;center<2;center++)for(int color=0;color<3;color++)foreach(WrapMode wrap in new WrapMode[]{WrapMode.Clamp,WrapMode.Tile,WrapMode.TileFlipX,WrapMode.TileFlipY,WrapMode.TileFlipXY})
 using(var path=new GraphicsPath())using(var bitmap=new Bitmap(100,80,PixelFormat.Format32bppPArgb)){
 if(shape==0)path.AddPolygon(new PointF[]{new PointF(13,11),new PointF(82,17),new PointF(48,67)});
 if(shape==1)path.AddPolygon(new PointF[]{new PointF(78,9),new PointF(19,16),new PointF(61,63)});
 if(shape==2)path.AddEllipse(17,13,59,47);
 if(shape==3)path.AddEllipse(12.25f,9.5f,61.5f,51.25f);
 Color a=color==0?Color.White:color==1?Color.FromArgb(255,217,63,144):Color.FromArgb(99,217,63,144),b=color==0?Color.Black:color==1?Color.FromArgb(255,17,189,81):Color.FromArgb(213,17,189,81);
 PointF c=center==0?new PointF(47,37):new PointF(42.5f,32.25f);
 using(var brush=new PathGradientBrush(path))using(var g=Graphics.FromImage(bitmap)){
 brush.CenterPoint=c;brush.CenterColor=a;brush.SurroundColors=new Color[]{b};brush.WrapMode=wrap;
 g.CompositingMode=CompositingMode.SourceCopy;g.SmoothingMode=SmoothingMode.None;g.PixelOffsetMode=PixelOffsetMode.None;g.FillRectangle(brush,0,0,100,80);
 }
 byte[] data=new byte[32000];var bits=bitmap.LockBits(new Rectangle(0,0,100,80),ImageLockMode.ReadOnly,PixelFormat.Format32bppPArgb);try{for(int y=0;y<80;y++)Marshal.Copy(IntPtr.Add(bits.Scan0,y*bits.Stride),data,y*400,400);}finally{bitmap.UnlockBits(bits);}
 if(json.Length>1)json.Append(',');json.Append("{\"shape\":").Append(shape).Append(",\"wrap\":").Append((int)wrap).Append(",\"color\":").Append(color).Append(",\"center\":[").Append(F(c.X)).Append(',').Append(F(c.Y)).Append("],\"a\":").Append(unchecked((uint)a.ToArgb())).Append(",\"b\":").Append(unchecked((uint)b.ToArgb())).Append(",\"points\":[");
 for(int i=0;i<path.PointCount;i++){if(i>0)json.Append(',');json.Append('[').Append(F(path.PathPoints[i].X)).Append(',').Append(F(path.PathPoints[i].Y)).Append(']');}
 json.Append("],\"types\":\"").Append(Convert.ToBase64String(path.PathTypes)).Append("\",\"bgra\":\"").Append(Convert.ToBase64String(data)).Append("\"}");
 }
 var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"path-gradient-colors.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
}
