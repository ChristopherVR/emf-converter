// Public PathGradientBrush controls for uniform white-to-black path gradients under rotated, sheared and
// anisotropically scaled world and brush transforms. The step count of a uniform path gradient follows
// the device-space bounds; these captures decide whether it follows the transformed boundary's bounds
// or the untransformed bounds carried through the matrix.
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.IO.Compression; using System.Text; using System.Globalization;
public static class PathGradientRotateProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static uint U(Color c){return unchecked((uint)c.ToArgb());}
 static string Bytes(Bitmap bitmap){
  var bits=bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppPArgb);
  try{int w=bitmap.Width,h=bitmap.Height;byte[] d=new byte[w*4*h];for(int y=0;y<h;y++)Marshal.Copy(IntPtr.Add(bits.Scan0,y*bits.Stride),d,y*w*4,w*4);return Convert.ToBase64String(d);}
  finally{bitmap.UnlockBits(bits);}
 }
 // matrix: m11,m12,m21,m22,dx,dy applied as the world transform (kind "world") or the brush transform (kind "brush")
 static void One(StringBuilder json,string name,string kind,string shape,PointF[] pts,PointF center,Color a,Color b,float[] m){
  int W=240,H=240;
  using(var bitmap=new Bitmap(W,H,PixelFormat.Format32bppPArgb))using(var path=new GraphicsPath()){
   path.AddPolygon(pts);
   using(var brush=new PathGradientBrush(path)){
    brush.CenterPoint=center;brush.CenterColor=a;brush.SurroundColors=new Color[]{b};
    using(var g=Graphics.FromImage(bitmap)){
     g.CompositingMode=CompositingMode.SourceCopy;g.SmoothingMode=SmoothingMode.None;g.PixelOffsetMode=PixelOffsetMode.None;g.Clear(Color.Transparent);
     var matrix=new Matrix(m[0],m[1],m[2],m[3],m[4],m[5]);
     if(kind=="world"){g.Transform=matrix;g.FillRectangle(brush,-1000,-1000,3000,3000);}
     else{brush.Transform=matrix;g.FillRectangle(brush,-1000,-1000,3000,3000);}
    }
   }
   if(json.Length>1)json.Append(',');
   json.Append("{\"name\":\"").Append(name).Append("\",\"kind\":\"").Append(kind).Append("\",\"shape\":\"").Append(shape).Append("\",\"w\":").Append(W).Append(",\"h\":").Append(H).Append(",\"matrix\":[");
   for(int i=0;i<6;i++){if(i>0)json.Append(',');json.Append(F(m[i]));}
   json.Append("],\"center\":[").Append(F(center.X)).Append(',').Append(F(center.Y)).Append("],\"a\":").Append(U(a)).Append(",\"b\":").Append(U(b)).Append(",\"points\":[");
   for(int i=0;i<pts.Length;i++){if(i>0)json.Append(',');json.Append('[').Append(F(pts[i].X)).Append(',').Append(F(pts[i].Y)).Append(']');}
   json.Append("],\"bgra\":\"").Append(Bytes(bitmap)).Append("\"}");
  }
 }
 public static void Run(string directory){
  var json=new StringBuilder("[");
  // shapes in a 0..60 x 0..40 box around the origin so every transform stays inside the 240x240 image
  var shapes=new Dictionary<string,PointF[]>();
  shapes["rect"]=new PointF[]{new PointF(-30,-20),new PointF(30,-20),new PointF(30,20),new PointF(-30,20)};
  shapes["tri"]=new PointF[]{new PointF(0,-24),new PointF(34,22),new PointF(-26,18)};
  var centers=new Dictionary<string,PointF>();centers["rect"]=new PointF(4.3f,-2.9f);centers["tri"]=new PointF(2.7f,5.1f);
  double[] angles={0,15,30,45,60,90,120,200};
  foreach(var kv in shapes)foreach(string kind in new string[]{"world","brush"}){
   foreach(double deg in angles){
    double r=deg*Math.PI/180;float c=(float)Math.Cos(r),s=(float)Math.Sin(r);
    One(json,kv.Key+"-"+kind+"-rot"+deg,kind,kv.Key,kv.Value,centers[kv.Key],Color.White,Color.Black,new float[]{c,s,-s,c,119.6f,120.3f});
   }
   // anisotropic scale, shear, and a rotation with anisotropic scale
   One(json,kv.Key+"-"+kind+"-scale1.5x0.7",kind,kv.Key,kv.Value,centers[kv.Key],Color.White,Color.Black,new float[]{1.5f,0,0,0.7f,119.6f,120.3f});
   One(json,kv.Key+"-"+kind+"-shear0.5",kind,kv.Key,kv.Value,centers[kv.Key],Color.White,Color.Black,new float[]{1,0,0.5f,1,119.6f,120.3f});
   One(json,kv.Key+"-"+kind+"-shear-0.4y",kind,kv.Key,kv.Value,centers[kv.Key],Color.White,Color.Black,new float[]{1,-0.4f,0,1,119.6f,120.3f});
   {double r=30*Math.PI/180;float c=(float)Math.Cos(r),s=(float)Math.Sin(r);
    One(json,kv.Key+"-"+kind+"-rot30scale2x1",kind,kv.Key,kv.Value,centers[kv.Key],Color.White,Color.Black,new float[]{2*c,2*s,-s,c,119.6f,120.3f});}
  }
  // a wide rectangle and a grid of shears / mixed matrices (world kind only) to separate the roles of width and height
  shapes["wide"]=new PointF[]{new PointF(-45,-12),new PointF(45,-12),new PointF(45,12),new PointF(-45,12)};centers["wide"]=new PointF(6.3f,-2.2f);
  var matrices=new List<float[]>{
   new float[]{1,0,0.25f,1,119.6f,120.3f},new float[]{1,0,1,1,119.6f,120.3f},new float[]{1,0,2,1,119.6f,120.3f},
   new float[]{1,0.25f,0,1,119.6f,120.3f},new float[]{1,0.5f,0,1,119.6f,120.3f},new float[]{1,1,0,1,119.6f,120.3f},new float[]{1,-1,0,1,119.6f,120.3f},
   new float[]{2,0,0.5f,1,119.6f,120.3f},new float[]{1,0,0.5f,2,119.6f,120.3f},new float[]{1,0.3f,0.4f,1,119.6f,120.3f},new float[]{1.3f,0.2f,-0.5f,0.8f,119.6f,120.3f}};
  foreach(var kv in shapes)foreach(var m in matrices){
   if(kv.Key=="tri")continue;
   One(json,kv.Key+"-world-m"+F(m[0])+"_"+F(m[1])+"_"+F(m[2])+"_"+F(m[3]),"world",kv.Key,kv.Value,centers[kv.Key],Color.White,Color.Black,m);
  }
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"path-gradient-rotated.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
}
