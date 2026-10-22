// Round 11: a path gradient with DIFFERENT surround colours per vertex (the Gouraud fan of gdiplus.dll) together with a Blend or
// InterpolationColors curve. The converter applies the curve to the centre's weight of the fan triangle (`adjustValue`) or reads the
// preset colours at it (`interpolatePresetColors`); this probe captures those two on library triangles and quads so the reading of the
// disassembly can be checked pixel by pixel. Whole images, premultiplied BGRA, FillRectangle over a larger rectangle.
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.IO.Compression; using System.Text; using System.Globalization;
public static class PathGradientVertexBlendProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static uint U(Color c){return unchecked((uint)c.ToArgb());}
 static string Bytes(Bitmap bitmap){
  var bits=bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppPArgb);
  try{int w=bitmap.Width,h=bitmap.Height;byte[] d=new byte[w*4*h];for(int y=0;y<h;y++)Marshal.Copy(IntPtr.Add(bits.Scan0,y*bits.Stride),d,y*w*4,w*4);return Convert.ToBase64String(d);}
  finally{bitmap.UnlockBits(bits);}
 }
 static void Floats(StringBuilder json,float[] v){json.Append('[');for(int i=0;i<v.Length;i++){if(i>0)json.Append(',');json.Append(F(v[i]));}json.Append(']');}
 static void One(StringBuilder json,string name,PointF[] pts,Color[] colors,PointF center,Color centerColor,float[] blendFactors,float[] blendPositions,Color[] presetColors,float[] presetPositions,float fx,float fy,float rot){
  int W=100,H=80;
  using(var bitmap=new Bitmap(W,H,PixelFormat.Format32bppPArgb))using(var path=new GraphicsPath()){
   path.AddPolygon(pts);
   using(var brush=new PathGradientBrush(path)){
    brush.CenterPoint=center;brush.CenterColor=centerColor;brush.SurroundColors=colors;
    if(blendFactors!=null){var b=new Blend(blendFactors.Length);b.Factors=blendFactors;b.Positions=blendPositions;brush.Blend=b;}
    if(presetColors!=null){var cb=new ColorBlend(presetColors.Length);cb.Colors=presetColors;cb.Positions=presetPositions;brush.InterpolationColors=cb;}
    if(fx>0||fy>0)brush.FocusScales=new PointF(fx,fy);
    using(var g=Graphics.FromImage(bitmap)){
     g.CompositingMode=CompositingMode.SourceCopy;g.SmoothingMode=SmoothingMode.None;g.PixelOffsetMode=PixelOffsetMode.None;g.Clear(Color.Transparent);
     if(rot!=0){g.TranslateTransform(W/2f,H/2f);g.RotateTransform(rot);g.TranslateTransform(-W/2f,-H/2f);}
     g.FillRectangle(brush,-W,-H,3*W,3*H);
    }
   }
   if(json.Length>1)json.Append(',');
   json.Append("{\"name\":\"").Append(name).Append("\",\"w\":").Append(W).Append(",\"h\":").Append(H).Append(",\"focus\":[").Append(F(fx)).Append(',').Append(F(fy)).Append("],\"rotate\":").Append(F(rot)).Append(",\"center\":[").Append(F(center.X)).Append(',').Append(F(center.Y)).Append("],\"centerArgb\":").Append(U(centerColor)).Append(",\"points\":[");
   for(int i=0;i<pts.Length;i++){if(i>0)json.Append(',');json.Append('[').Append(F(pts[i].X)).Append(',').Append(F(pts[i].Y)).Append(']');}
   json.Append("],\"colors\":[");
   for(int i=0;i<colors.Length;i++){if(i>0)json.Append(',');json.Append(U(colors[i]));}
   json.Append("],\"blend\":");
   if(blendFactors==null)json.Append("null");else{json.Append("{\"factors\":");Floats(json,blendFactors);json.Append(",\"positions\":");Floats(json,blendPositions);json.Append('}');}
   json.Append(",\"preset\":");
   if(presetColors==null)json.Append("null");else{json.Append("{\"argb\":[");for(int i=0;i<presetColors.Length;i++){if(i>0)json.Append(',');json.Append(U(presetColors[i]));}json.Append("],\"positions\":");Floats(json,presetPositions);json.Append('}');}
   json.Append(",\"bgra\":\"").Append(Bytes(bitmap)).Append("\"}");
  }
 }
 public static void Run(string directory){
  var json=new StringBuilder("[");
  Color R=Color.FromArgb(255,255,0,0),G=Color.FromArgb(255,0,255,0),B=Color.FromArgb(255,0,0,255),K=Color.Black,Wh=Color.White,Y=Color.FromArgb(255,255,220,0);
  PointF[] tri={new PointF(50,10),new PointF(88,62),new PointF(12,55)};
  PointF[] quad={new PointF(15,12),new PointF(85,15),new PointF(80,66),new PointF(20,60)};
  PointF c=new PointF(48,41);
  Color[] rgb={R,G,B};
  Color[] rgby={R,G,B,Y};
  // Blend curves: factors and positions run from the boundary (0) to the centre (1)
  float[][] bf={new float[]{0f,0.5f,1f},new float[]{0f,0.2f,1f},new float[]{0f,0.8f,1f},new float[]{0.3f,1f},new float[]{0f,1f,0f}};
  float[][] bp={new float[]{0f,0.5f,1f},new float[]{0f,0.7f,1f},new float[]{0f,0.4f,1f},new float[]{0f,1f},new float[]{0f,0.5f,1f}};
  for(int i=0;i<bf.Length;i++){
   One(json,"blend"+i+"-tri-white",tri,rgb,c,Wh,bf[i],bp[i],null,null,0,0,0);
   One(json,"blend"+i+"-tri-black",tri,rgb,c,K,bf[i],bp[i],null,null,0,0,0);
   One(json,"blend"+i+"-quad-white",quad,rgby,new PointF(50,38),Wh,bf[i],bp[i],null,null,0,0,0);
  }
  // InterpolationColors: three and four preset colours (positions from the boundary to the centre)
  Color[][] pc={new Color[]{Color.FromArgb(255,40,40,40),Color.FromArgb(255,250,250,0),Color.FromArgb(255,255,255,255)},new Color[]{K,Color.FromArgb(255,0,160,200),Color.FromArgb(255,230,60,20),Wh}};
  float[][] pp={new float[]{0f,0.5f,1f},new float[]{0f,0.3f,0.6f,1f}};
  for(int i=0;i<pc.Length;i++){
   One(json,"preset"+i+"-tri-white",tri,rgb,c,Wh,null,null,pc[i],pp[i],0,0,0);
   One(json,"preset"+i+"-quad",quad,rgby,new PointF(50,38),Wh,null,null,pc[i],pp[i],0,0,0);
  }
  // control: a uniform surround with the same curves (the one-dimensional ramp)
  One(json,"uniform-blend-tri",tri,new Color[]{R,R,R},c,Wh,bf[1],bp[1],null,null,0,0,0);
  One(json,"uniform-preset-tri",tri,new Color[]{R,R,R},c,Wh,null,null,pc[0],pp[0],0,0,0);
  // a focus with a curve and a rotation
  One(json,"blend1-tri-focus",tri,rgb,c,Wh,bf[1],bp[1],null,null,0.5f,0.5f,0);
  One(json,"blend1-tri-rot",tri,rgb,c,Wh,bf[1],bp[1],null,null,0,0,20);
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());
  using(var file=File.Create(Path.Combine(directory,"path-gradient-vertex-blend.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
}
