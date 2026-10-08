// Public PathGradientBrush controls for per-vertex surround colours: triangles (and a quad) whose
// vertices carry independent channels over a black centre, so each colour channel is the weight map of
// one vertex. Captured as whole images so the interpolation along the nested contours' edges is readable.
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.IO.Compression; using System.Text; using System.Globalization;
public static class PathGradientVertexProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static uint U(Color c){return unchecked((uint)c.ToArgb());}
 static string Bytes(Bitmap bitmap){
  var bits=bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppPArgb);
  try{int w=bitmap.Width,h=bitmap.Height;byte[] d=new byte[w*4*h];for(int y=0;y<h;y++)Marshal.Copy(IntPtr.Add(bits.Scan0,y*bits.Stride),d,y*w*4,w*4);return Convert.ToBase64String(d);}
  finally{bitmap.UnlockBits(bits);}
 }
 // pts: polygon vertices; colors: per-vertex surrounds; centre and colour; world = world scale.
 static void One(StringBuilder json,string name,int W,int H,PointF[] pts,Color[] colors,PointF center,Color centerColor,float world){OneX(json,name,W,H,pts,colors,center,centerColor,world,0,0,0);}
 // fx/fy: FocusScales (0 = none); rot: degrees of world rotation about the image centre (applied before the scale)
 static void OneX(StringBuilder json,string name,int W,int H,PointF[] pts,Color[] colors,PointF center,Color centerColor,float world,float fx,float fy,float rot){
  using(var bitmap=new Bitmap(W,H,PixelFormat.Format32bppPArgb))using(var path=new GraphicsPath()){
   path.AddPolygon(pts);
   using(var brush=new PathGradientBrush(path)){
    brush.CenterPoint=center;brush.CenterColor=centerColor;brush.SurroundColors=colors;
    if(fx>0||fy>0)brush.FocusScales=new PointF(fx,fy);
    using(var g=Graphics.FromImage(bitmap)){
     g.CompositingMode=CompositingMode.SourceCopy;g.SmoothingMode=SmoothingMode.None;g.PixelOffsetMode=PixelOffsetMode.None;g.Clear(Color.Transparent);
     if(rot!=0){g.TranslateTransform(W/2f,H/2f);g.RotateTransform(rot);g.TranslateTransform(-W/2f,-H/2f);}
     if(world!=1)g.ScaleTransform(world,world);
     g.FillRectangle(brush,-W/world,-H/world,3*W/world,3*H/world);
    }
   }
   if(json.Length>1)json.Append(',');
   json.Append("{\"name\":\"").Append(name).Append("\",\"w\":").Append(W).Append(",\"h\":").Append(H).Append(",\"world\":").Append(F(world)).Append(",\"focus\":[").Append(F(fx)).Append(',').Append(F(fy)).Append("],\"rotate\":").Append(F(rot)).Append(",\"center\":[").Append(F(center.X)).Append(',').Append(F(center.Y)).Append("],\"centerArgb\":").Append(U(centerColor)).Append(",\"points\":[");
   for(int i=0;i<pts.Length;i++){if(i>0)json.Append(',');json.Append('[').Append(F(pts[i].X)).Append(',').Append(F(pts[i].Y)).Append(']');}
   json.Append("],\"colors\":[");
   for(int i=0;i<colors.Length;i++){if(i>0)json.Append(',');json.Append(U(colors[i]));}
   json.Append("],\"bgra\":\"").Append(Bytes(bitmap)).Append("\"}");
  }
 }
 public static void Run(string directory){
  var json=new StringBuilder("[");
  Color R=Color.FromArgb(255,255,0,0),G=Color.FromArgb(255,0,255,0),B=Color.FromArgb(255,0,0,255),K=Color.Black,Wh=Color.White;
  PointF[] tri={new PointF(50,10),new PointF(88,62),new PointF(12,55)};
  // base: the library triangle with RGB vertices over a black centre, at three scales (N = 2*hypot of the bounds)
  One(json,"rgb-black",100,80,tri,new Color[]{R,G,B},new PointF(48,41),K,1f);
  One(json,"rgb-white",100,80,tri,new Color[]{R,G,B},new PointF(48,41),Wh,1f);
  One(json,"rgb-black-x4",400,320,tri,new Color[]{R,G,B},new PointF(48,41),K,4f);
  One(json,"rgb-black-x0.5",50,40,tri,new Color[]{R,G,B},new PointF(48,41),K,0.5f);
  // orientations: which edge is horizontal / which vertex leads
  PointF[][] shapes={
   new PointF[]{new PointF(50,10),new PointF(88,62),new PointF(12,55)},
   new PointF[]{new PointF(12,55),new PointF(50,10),new PointF(88,62)},
   new PointF[]{new PointF(88,62),new PointF(12,55),new PointF(50,10)},
   new PointF[]{new PointF(10,10),new PointF(90,10),new PointF(50,70)},
   new PointF[]{new PointF(10,70),new PointF(90,70),new PointF(50,10)},
   new PointF[]{new PointF(10,10),new PointF(10,70),new PointF(90,40)},
   new PointF[]{new PointF(90,10),new PointF(90,70),new PointF(10,40)},
   new PointF[]{new PointF(10,10),new PointF(90,15),new PointF(30,70)}};
  PointF[] cs={new PointF(48,41),new PointF(48,41),new PointF(48,41),new PointF(50,30),new PointF(50,50),new PointF(35,40),new PointF(65,40),new PointF(43,32)};
  for(int i=0;i<shapes.Length;i++)One(json,"shape"+i,100,80,shapes[i],new Color[]{R,G,B},cs[i],K,1f);
  // single-channel vertices
  Color r0=Color.FromArgb(255,0,0,0),r1=Color.FromArgb(255,255,0,0);
  for(int i=0;i<4;i++)One(json,"redonly"+i,100,80,shapes[i],new Color[]{r1,r0,r0},cs[i],K,1f);
  One(json,"redonly-b",100,80,shapes[0],new Color[]{r0,r1,r0},cs[0],K,1f);
  One(json,"redonly-c",100,80,shapes[0],new Color[]{r0,r0,r1},cs[0],K,1f);
  // two vertices of one colour, one different: isolates the single slanted edge
  One(json,"two-same",100,80,shapes[0],new Color[]{R,R,B},cs[0],K,1f);
  // quad and pentagon
  One(json,"quad",100,80,new PointF[]{new PointF(15,12),new PointF(85,12),new PointF(80,65),new PointF(20,60)},new Color[]{R,G,B,Wh},new PointF(50,38),K,1f);
  One(json,"pentagon",100,80,new PointF[]{new PointF(50,6),new PointF(92,30),new PointF(76,70),new PointF(24,70),new PointF(8,30)},new Color[]{R,G,B,Color.Yellow,Color.Cyan},new PointF(50,40),K,1f);
  // a very small triangle (N small): steps of several levels
  One(json,"small",30,24,new PointF[]{new PointF(15,2),new PointF(27,20),new PointF(3,18)},new Color[]{R,G,B},new PointF(15,13),K,1f);
  One(json,"small-white",30,24,new PointF[]{new PointF(15,2),new PointF(27,20),new PointF(3,18)},new Color[]{R,G,B},new PointF(15,13),Wh,1f);
  // random star-shaped polygons on a 1/16 grid with random colours: 3 to 6 vertices, centre off the middle.
  // sets: rand = opaque; randa = translucent vertices and centre; randf = opaque with focus scales; randr = opaque, world rotation and scale
  var rnd=new Random(20261008);
  foreach(string set in new string[]{"rand","randa","randf","randr","randt"}){
   int count=set=="rand"?120:set=="randa"?60:set=="randf"?40:set=="randr"?30:10;
   for(int i=0;i<count;i++){
    int n=new int[]{3,3,3,4,5,6}[rnd.Next(6)];
    float cx=32+rnd.Next(-64,65)/16f,cy=32+rnd.Next(-64,65)/16f;
    var angles=new double[n];for(int a=0;a<n;a++)angles[a]=(a+rnd.NextDouble()*0.6)*2*Math.PI/n;
    var pts=new PointF[n];var cols=new Color[n];
    for(int a=0;a<n;a++){
     double r=8+rnd.NextDouble()*14;
     float vx=(float)Math.Round((cx+r*Math.Cos(angles[a]))*16)/16f,vy=(float)Math.Round((cy+r*Math.Sin(angles[a]))*16)/16f;
     pts[a]=new PointF(vx,vy);cols[a]=Color.FromArgb(set=="randa"?rnd.Next(256):255,rnd.Next(256),rnd.Next(256),rnd.Next(256));
    }
    Color centre=Color.FromArgb(set=="randa"?rnd.Next(256):255,rnd.Next(256),rnd.Next(256),rnd.Next(256));
    float fx=0,fy=0,rot=0,world=1f;
    if(set=="randf"){fx=i%2==0?0.5f:0.25f;fy=i%2==0?0.5f:0.75f;}
    if(set=="randr"){rot=new float[]{10,25,30,45,90,-20}[i%6];world=new float[]{1f,0.75f,0.6f}[i%3];}
    if(set=="randt"){
     // one polygon under six transforms: isolates scale, quarter turns and free rotation
     float[] rots={0,0,90,180,45,10},scales={0.75f,0.6f,1f,1f,1f,1f};
     for(int t=0;t<rots.Length;t++)OneX(json,"randt"+i+"_"+t,64,64,pts,cols,new PointF(cx,cy),centre,scales[t],0,0,rots[t]);
     continue;
    }
    OneX(json,set+i,64,64,pts,cols,new PointF(cx,cy),centre,world,fx,fy,rot);
   }
  }
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"path-gradient-vertices.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
}
