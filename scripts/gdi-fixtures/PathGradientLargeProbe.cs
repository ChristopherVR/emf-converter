// Public PathGradientBrush controls with large shapes at fractional (1/16) vertices, white to black: the numerator and denominator of the
// ray-and-edge computation then need more than 24 bits, so a float32 evaluation that rounds its products and differences differs from one
// that does not at the pixels whose copy index sits within a few parts in 10^7 of a half step. Red and alpha only.
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.IO.Compression; using System.Text; using System.Globalization;
public static class PathGradientLargeProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static string Pack(Bitmap bitmap){
  var bits=bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
  try{int w=bitmap.Width,h=bitmap.Height;byte[] raw=new byte[w*4];byte[] d=new byte[w*2*h];
   for(int y=0;y<h;y++){Marshal.Copy(IntPtr.Add(bits.Scan0,y*bits.Stride),raw,0,w*4);for(int x=0;x<w;x++){d[(y*w+x)*2]=raw[x*4+2];d[(y*w+x)*2+1]=raw[x*4+3];}}
   return Convert.ToBase64String(d);}
  finally{bitmap.UnlockBits(bits);}
 }
 static void One(StringBuilder json,string name,PointF[] pts,PointF center,int W,int H){
  using(var bitmap=new Bitmap(W,H,PixelFormat.Format32bppArgb))using(var path=new GraphicsPath()){
   path.AddPolygon(pts);
   using(var brush=new PathGradientBrush(path)){
    brush.CenterPoint=center;brush.CenterColor=Color.White;brush.SurroundColors=new Color[]{Color.Black};
    using(var g=Graphics.FromImage(bitmap)){
     g.CompositingMode=CompositingMode.SourceCopy;g.SmoothingMode=SmoothingMode.None;g.PixelOffsetMode=PixelOffsetMode.None;g.Clear(Color.Transparent);
     g.FillRectangle(brush,0,0,W,H);
    }
   }
   if(json.Length>1)json.Append(',');
   json.Append("{\"name\":\"").Append(name).Append("\",\"w\":").Append(W).Append(",\"h\":").Append(H).Append(",\"center\":[").Append(F(center.X)).Append(',').Append(F(center.Y)).Append("],\"points\":[");
   for(int i=0;i<pts.Length;i++){if(i>0)json.Append(',');json.Append('[').Append(F(pts[i].X)).Append(',').Append(F(pts[i].Y)).Append(']');}
   json.Append("],\"ra\":\"").Append(Pack(bitmap)).Append("\"}");
  }
 }
 public static void Run(string directory){
  var json=new StringBuilder("[");
  var rnd=new Random(20261008);
  // Triangles and quads of 300 to 700 pixels with every vertex and the centre on the 1/16 grid.
  for(int i=0;i<12;i++){
   int n=3+(i%2);
   int W=720,H=520;
   var pts=new PointF[n];
   for(int k=0;k<n;k++){
    double a=2*Math.PI*(k+0.15*rnd.NextDouble())/n+0.3;
    double rx=170+rnd.NextDouble()*180,ry=130+rnd.NextDouble()*120;
    pts[k]=new PointF((float)Math.Round((360+rx*Math.Cos(a))*16)/16f,(float)Math.Round((260+ry*Math.Sin(a))*16)/16f);
   }
   var c=new PointF((float)Math.Round((330+rnd.NextDouble()*60)*16)/16f,(float)Math.Round((235+rnd.NextDouble()*50)*16)/16f);
   One(json,"L-"+i,pts,c,W,H);
  }
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"path-gradient-large.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
}
