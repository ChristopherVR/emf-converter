// Public PathGradientBrush controls for what the step count and the copies are computed from when the brush paints something
// other than a rectangle: wide pens (horizontal, diagonal, elliptical), single-bit text at several sizes and ellipse and polygon
// fills, each with the same brush as a full-canvas FillRectangle baseline. A uniform path gradient is the brush path's own
// nested copies, so every painted pixel of a pen, glyph or fill should equal the baseline pixel; any difference means the
// step count (or the geometry) follows the filled shape instead.
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Drawing.Text; using System.Runtime.InteropServices; using System.IO; using System.IO.Compression; using System.Text; using System.Globalization;
public static class PathGradientFillProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static string Bytes(Bitmap bitmap){
  var bits=bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
  try{int w=bitmap.Width,h=bitmap.Height;byte[] d=new byte[w*4*h];for(int y=0;y<h;y++)Marshal.Copy(IntPtr.Add(bits.Scan0,y*bits.Stride),d,y*w*4,w*4);return Convert.ToBase64String(d);}
  finally{bitmap.UnlockBits(bits);}
 }
 const int W=200,H=140;
 static void Add(StringBuilder json,string name,PointF[] pts,PointF center,Action<Graphics,PathGradientBrush> draw){
  using(var bitmap=new Bitmap(W,H,PixelFormat.Format32bppArgb))using(var path=new GraphicsPath()){
   path.AddPolygon(pts);
   using(var brush=new PathGradientBrush(path)){
    brush.CenterPoint=center;brush.CenterColor=Color.White;brush.SurroundColors=new Color[]{Color.FromArgb(255,20,10,120)};
    using(var g=Graphics.FromImage(bitmap)){
     g.CompositingMode=CompositingMode.SourceCopy;g.SmoothingMode=SmoothingMode.None;g.PixelOffsetMode=PixelOffsetMode.None;g.TextRenderingHint=TextRenderingHint.SingleBitPerPixelGridFit;g.Clear(Color.Transparent);
     draw(g,brush);
    }
   }
   if(json.Length>1)json.Append(',');
   json.Append("{\"name\":\"").Append(name).Append("\",\"w\":").Append(W).Append(",\"h\":").Append(H).Append(",\"center\":[").Append(F(center.X)).Append(',').Append(F(center.Y)).Append("],\"points\":[");
   for(int i=0;i<pts.Length;i++){if(i>0)json.Append(',');json.Append('[').Append(F(pts[i].X)).Append(',').Append(F(pts[i].Y)).Append(']');}
   json.Append("],\"bgra\":\"").Append(Bytes(bitmap)).Append("\"}");
  }
 }
 public static void Run(string directory){
  var json=new StringBuilder("[");
  var shapes=new Dictionary<string,PointF[]>();
  shapes["rect"]=new PointF[]{new PointF(60,40),new PointF(140,40),new PointF(140,100),new PointF(60,100)};
  shapes["tri"]=new PointF[]{new PointF(100,15),new PointF(175,120),new PointF(25,110)};
  var ell=new PointF[24];for(int i=0;i<24;i++){double a=i*Math.PI/12;ell[i]=new PointF((float)(100+60*Math.Cos(a)),(float)(70+45*Math.Sin(a)));}
  shapes["ell"]=ell;
  foreach(var kv in shapes){
   string s=kv.Key;PointF[] pts=kv.Value;
   float cx=0,cy=0;foreach(var p in pts){cx+=p.X;cy+=p.Y;}cx/=pts.Length;cy/=pts.Length;var c=new PointF(cx,cy);
   Add(json,s+"-base",pts,c,(g,b)=>{g.FillRectangle(b,0,0,W,H);});
   foreach(int w in new int[]{1,6,20}){
    int ww=w;
    Add(json,s+"-penh-"+w,pts,c,(g,b)=>{using(var p=new Pen(b,ww)){g.DrawLine(p,30,70,170,70);}});
    Add(json,s+"-pend-"+w,pts,c,(g,b)=>{using(var p=new Pen(b,ww)){g.DrawLine(p,40,30,160,110);}});
   }
   foreach(int w in new int[]{4,16}){
    int ww=w;
    Add(json,s+"-pene-"+w,pts,c,(g,b)=>{using(var p=new Pen(b,ww)){g.DrawEllipse(p,50,35,100,70);}});
   }
   foreach(int size in new int[]{14,28,56,96}){
    int sz=size;
    Add(json,s+"-text-"+size,pts,c,(g,b)=>{using(var f=new Font("Arial",sz,FontStyle.Regular,GraphicsUnit.Pixel)){g.DrawString("Hg",f,b,10,10);}});
   }
   Add(json,s+"-fille",pts,c,(g,b)=>{g.FillEllipse(b,60,40,80,60);});
   Add(json,s+"-fillp",pts,c,(g,b)=>{g.FillPolygon(b,new PointF[]{new PointF(90,20),new PointF(150,90),new PointF(70,120)});});
   Add(json,s+"-fillr",pts,c,(g,b)=>{g.FillRectangle(b,80,50,30,20);});
  }
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"path-gradient-fills.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
}
