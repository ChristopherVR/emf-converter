// Round 11: where the converter's span windows come from. GDI+ asks a path gradient for the spans of the SHAPE it fills, one scanline
// at a time, so a span that starts inside a gradient triangle is interpolated from its own start, not from the triangle's edge. This
// probe fills a per-vertex fan, a uniform ramp with a focus and a tiled brush with shapes that cut the gradient: a small rectangle,
// an ellipse, a polygon, a rectangle half off the surface (aliased, SourceCopy over transparent). Whole images, premultiplied BGRA.
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.IO.Compression; using System.Text; using System.Globalization;
public static class PathGradientClipProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static uint U(Color c){return unchecked((uint)c.ToArgb());}
 static string Bytes(Bitmap bitmap){
  var bits=bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppPArgb);
  try{int w=bitmap.Width,h=bitmap.Height;byte[] d=new byte[w*4*h];for(int y=0;y<h;y++)Marshal.Copy(IntPtr.Add(bits.Scan0,y*bits.Stride),d,y*w*4,w*4);return Convert.ToBase64String(d);}
  finally{bitmap.UnlockBits(bits);}
 }
 static void One(StringBuilder json,string name,PointF[] pts,Color[] colors,PointF center,Color centerColor,float fx,float fy,WrapMode wrap,string shape,float[] args){
  int W=100,H=80;
  using(var bitmap=new Bitmap(W,H,PixelFormat.Format32bppPArgb))using(var path=new GraphicsPath()){
   path.AddPolygon(pts);
   using(var brush=new PathGradientBrush(path)){
    brush.CenterPoint=center;brush.CenterColor=centerColor;brush.SurroundColors=colors;brush.WrapMode=wrap;
    if(fx>0||fy>0)brush.FocusScales=new PointF(fx,fy);
    using(var g=Graphics.FromImage(bitmap)){
     g.CompositingMode=CompositingMode.SourceCopy;g.SmoothingMode=SmoothingMode.None;g.PixelOffsetMode=PixelOffsetMode.None;g.Clear(Color.Transparent);
     if(shape=="rect")g.FillRectangle(brush,args[0],args[1],args[2],args[3]);
     else if(shape=="ellipse")g.FillEllipse(brush,args[0],args[1],args[2],args[3]);
     else if(shape=="poly"){var p=new PointF[args.Length/2];for(int i=0;i<p.Length;i++)p[i]=new PointF(args[2*i],args[2*i+1]);g.FillPolygon(brush,p);}
    }
   }
   if(json.Length>1)json.Append(',');
   json.Append("{\"name\":\"").Append(name).Append("\",\"w\":").Append(W).Append(",\"h\":").Append(H).Append(",\"focus\":[").Append(F(fx)).Append(',').Append(F(fy)).Append("],\"wrap\":").Append((int)wrap).Append(",\"center\":[").Append(F(center.X)).Append(',').Append(F(center.Y)).Append("],\"centerArgb\":").Append(U(centerColor)).Append(",\"points\":[");
   for(int i=0;i<pts.Length;i++){if(i>0)json.Append(',');json.Append('[').Append(F(pts[i].X)).Append(',').Append(F(pts[i].Y)).Append(']');}
   json.Append("],\"colors\":[");
   for(int i=0;i<colors.Length;i++){if(i>0)json.Append(',');json.Append(U(colors[i]));}
   json.Append("],\"shape\":\"").Append(shape).Append("\",\"args\":[");
   for(int i=0;i<args.Length;i++){if(i>0)json.Append(',');json.Append(F(args[i]));}
   json.Append("],\"bgra\":\"").Append(Bytes(bitmap)).Append("\"}");
  }
 }
 public static void Run(string directory){
  var json=new StringBuilder("[");
  Color R=Color.FromArgb(255,255,0,0),G=Color.FromArgb(255,0,255,0),B=Color.FromArgb(255,0,0,255),Wh=Color.White,K=Color.Black;
  PointF[] tri={new PointF(50,10),new PointF(88,62),new PointF(12,55)};
  PointF c=new PointF(48,41);
  var shapes=new List<KeyValuePair<string,float[]>>{
   new KeyValuePair<string,float[]>("rect",new float[]{30,25,40,28}),
   new KeyValuePair<string,float[]>("rect",new float[]{-20,-10,60,50}),
   new KeyValuePair<string,float[]>("ellipse",new float[]{15,12,70,50}),
   new KeyValuePair<string,float[]>("poly",new float[]{50,8,60,30,90,32,66,48,74,74,50,58,26,74,34,48,10,32,40,30}),
  };
  int n=0;
  foreach(var s in shapes){
   One(json,"fan-"+n+"-"+s.Key,tri,new Color[]{R,G,B},c,Wh,0,0,WrapMode.Clamp,s.Key,s.Value);
   One(json,"fan-tile-"+n+"-"+s.Key,tri,new Color[]{R,G,B},c,Wh,0,0,WrapMode.Tile,s.Key,s.Value);
   One(json,"ramp-"+n+"-"+s.Key,tri,new Color[]{R,R,R},c,Wh,0.4f,0.6f,WrapMode.Clamp,s.Key,s.Value);
   One(json,"ramp-tile-"+n+"-"+s.Key,tri,new Color[]{R,R,R},c,Wh,0,0,WrapMode.Tile,s.Key,s.Value);
   n++;
  }
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());
  using(var file=File.Create(Path.Combine(directory,"path-gradient-clip.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
}
