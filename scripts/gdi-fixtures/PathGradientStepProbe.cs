// Public PathGradientBrush controls for the per-pixel arithmetic of a path gradient: whole captured
// rows through a rectangle's centre (the trivially geometric case that exposes the step quantisation)
// and small images of rectangles, triangles and ellipses over several colour pairs, a Blend curve, an
// InterpolationColors preset and world/brush scales.
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.IO.Compression; using System.Text; using System.Globalization;
public static class PathGradientStepProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static uint U(Color c){return unchecked((uint)c.ToArgb());}
 static string Bytes(Bitmap bitmap,int row){
  var bits=bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppPArgb);
  try{
   int w=bitmap.Width,h=bitmap.Height;int y0=row<0?0:row,y1=row<0?h:row+1;byte[] d=new byte[w*4*(y1-y0)];
   for(int y=y0;y<y1;y++)Marshal.Copy(IntPtr.Add(bits.Scan0,y*bits.Stride),d,(y-y0)*w*4,w*4);
   return Convert.ToBase64String(d);
  }finally{bitmap.UnlockBits(bits);}
 }
 static void Fill(Bitmap bitmap,GraphicsPath path,PathGradientBrush brush,float sx,float sy){
  using(var g=Graphics.FromImage(bitmap)){
   g.CompositingMode=CompositingMode.SourceCopy;g.SmoothingMode=SmoothingMode.None;g.PixelOffsetMode=PixelOffsetMode.None;g.Clear(Color.Transparent);
   if(sx!=1||sy!=1)g.ScaleTransform(sx,sy);
   g.FillRectangle(brush,0,0,bitmap.Width/sx,bitmap.Height/sy);
  }
 }
 static void Geometry(StringBuilder json,GraphicsPath path){
  json.Append("\"points\":[");
  for(int i=0;i<path.PointCount;i++){if(i>0)json.Append(',');json.Append('[').Append(F(path.PathPoints[i].X)).Append(',').Append(F(path.PathPoints[i].Y)).Append(']');}
  json.Append("],\"types\":\"").Append(Convert.ToBase64String(path.PathTypes)).Append('"');
 }
 public static void Run(string directory){
  var json=new StringBuilder("[");
  // Whole rows through the centre of white-to-black rectangles: width 2*cx, height 2*h.
  foreach(int h in new int[]{1,7,20,150})foreach(int cx in new int[]{2,3,5,7,10,16,20,29,50,64,100,128,200,250,300,500,512,1000}){
   int W=2*cx,H=2*h;
   using(var bitmap=new Bitmap(W,H,PixelFormat.Format32bppPArgb))using(var path=new GraphicsPath()){
    path.AddRectangle(new RectangleF(0,0,W,H));
    using(var brush=new PathGradientBrush(path)){
     brush.CenterPoint=new PointF(cx,h);brush.CenterColor=Color.White;brush.SurroundColors=new Color[]{Color.Black};
     Fill(bitmap,path,brush,1,1);
    }
    if(json.Length>1)json.Append(',');
    json.Append("{\"kind\":\"row\",\"shape\":\"rect\",\"w\":").Append(W).Append(",\"h\":").Append(H).Append(",\"row\":").Append(h).Append(",\"center\":[").Append(F(cx)).Append(',').Append(F(h)).Append("],\"a\":").Append(U(Color.White)).Append(",\"b\":").Append(U(Color.Black)).Append(',');
    Geometry(json,path);
    json.Append(",\"bgra\":\"").Append(Bytes(bitmap,h)).Append("\"}");
   }
  }
  // 100x80 images. shape 0 rectangle, 1 triangle, 2 ellipse, 3 off-centre triangle; pairs of centre/surround colours.
  uint[][] pairs=new uint[][]{
   new uint[]{U(Color.White),U(Color.Black)},
   new uint[]{U(Color.FromArgb(255,217,63,144)),U(Color.FromArgb(255,17,189,81))},
   new uint[]{U(Color.FromArgb(99,217,63,144)),U(Color.FromArgb(213,17,189,81))},
   new uint[]{U(Color.FromArgb(255,40,200,120)),U(Color.FromArgb(0,40,200,120))}};
  // variant: 0 plain, 1 Blend curve, 2 InterpolationColors preset, 3 world scale 2, 4 world scale 0.5, 5 brush scale 2, 6 focus 0.5
  string[] variantNames=new string[]{"plain","blend","preset","world2","world0.5","brush2","focus"};
  for(int shape=0;shape<4;shape++)for(int pair=0;pair<pairs.Length;pair++)for(int variant=0;variant<variantNames.Length;variant++){
   if(variant>0&&pair>1&&variant!=3)continue;
   if((variant==1||variant==2)&&pair!=1)continue;
   float scale=variant==3?2f:variant==4?0.5f:1f;
   using(var bitmap=new Bitmap(100,80,PixelFormat.Format32bppPArgb))using(var path=new GraphicsPath()){
    // geometry in world units so that device bounds stay inside the bitmap
    float k=variant==3||variant==5?0.5f:variant==4?2f:1f;
    if(shape==0)path.AddRectangle(new RectangleF(20*k,15*k,60*k,40*k));
    else if(shape==1)path.AddPolygon(new PointF[]{new PointF(50*k,10*k),new PointF(88*k,62*k),new PointF(12*k,55*k)});
    else if(shape==2)path.AddEllipse(15*k,12*k,70*k,50*k);
    else path.AddPolygon(new PointF[]{new PointF(30*k,8*k),new PointF(92*k,40*k),new PointF(14*k,70*k)});
    PointF center=shape==0?new PointF(47*k,33*k):shape==1?new PointF(48*k,41*k):shape==2?new PointF(48*k,36*k):new PointF(44*k,38*k);
    uint a=pairs[pair][0],b=pairs[pair][1];
    using(var brush=new PathGradientBrush(path)){
     brush.CenterPoint=center;brush.CenterColor=Color.FromArgb(unchecked((int)a));brush.SurroundColors=new Color[]{Color.FromArgb(unchecked((int)b))};
     string extra="";
     if(variant==1){var blend=new Blend(3);blend.Factors=new float[]{0f,0.2f,1f};blend.Positions=new float[]{0f,0.7f,1f};brush.Blend=blend;extra=",\"blend\":{\"positions\":[0,0.7,1],\"factors\":[0,0.2,1]}";}
     if(variant==2){var cb=new ColorBlend(3);cb.Colors=new Color[]{Color.FromArgb(255,200,30,30),Color.FromArgb(255,250,250,80),Color.FromArgb(255,20,60,200)};cb.Positions=new float[]{0f,0.35f,1f};brush.InterpolationColors=cb;extra=",\"preset\":{\"positions\":[0,0.35,1],\"argb\":["+U(cb.Colors[0])+","+U(cb.Colors[1])+","+U(cb.Colors[2])+"]}";}
     float brushScale=1f;
     if(variant==5){brush.ScaleTransform(2f,2f);brushScale=2f;}
     if(variant==6){brush.FocusScales=new PointF(0.5f,0.5f);extra=",\"focus\":[0.5,0.5]";}
     // brush scale: the path is drawn at half size so the scaled brush still lands on the bitmap
     Fill(bitmap,path,brush,scale,scale);
     if(json.Length>1)json.Append(',');
     json.Append("{\"kind\":\"image\",\"shape\":").Append(shape).Append(",\"pair\":").Append(pair).Append(",\"variant\":\"").Append(variantNames[variant]).Append("\",\"world\":").Append(F(scale)).Append(",\"brushScale\":").Append(F(brushScale)).Append(",\"center\":[").Append(F(center.X)).Append(',').Append(F(center.Y)).Append("],\"a\":").Append(a).Append(",\"b\":").Append(b).Append(extra).Append(',');
     Geometry(json,path);
     json.Append(",\"bgra\":\"").Append(Bytes(bitmap,-1)).Append("\"}");
    }
   }
  }
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"path-gradient-steps.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
}
