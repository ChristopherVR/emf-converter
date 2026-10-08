// Axis-aligned HighQuality DrawImage through many horizontal source/destination rectangles: one noise source
// (24 independent rows of 256 texels, each replicated over 7 identical rows so the vertical pass is the identity)
// drawn at upscales and reductions with both kernels, plain and mirrored (a destination rectangle with a negative
// width), at whole and fractional origins. With independent noise rows a wrong weight phase mismatches a large
// share of the values, so the draws pin the step, the phase, the reduction arithmetic and the mirror rule
// (src/emf-plus-hq-phases.fixture.test.ts replays them).
// Writes hq-phases.json.gz: {"srcW","rows","src" (rows x srcW x RGB, base64),"draws":[{"kernel","srcX","srcW","destX","destW","bitmapW","dest"}]}
// where destW is negative for a mirrored draw, and dest holds rows x bitmapW x RGB.
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.Text; using System.Globalization;
public static class HighQualityPhaseProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 public static void Run(string directory){
  const int SW=256, ROWS=24, REP=7; int H=ROWS*REP;
  var rng=new Random(41017); var src=new byte[ROWS*SW*3]; for(int i=0;i<src.Length;i++)src[i]=(byte)rng.Next(256);
  var specs=new List<float[]>(); // srcX, srcW, destX, destW
  // Whole-source draws at assorted scales: upscales, a unit scale, then reductions (the 0.75 and 0.5 reductions put
  // texel edges exactly on the 1/128 grid).
  foreach(float sx in new float[]{1.0078125f,1.1f,1.25f,1.5f,2f,2.3f,3f,4.1f,1f,.9f,.8f,.75f,.65f,.6f,.5f,.4f,.3f})
   specs.Add(new float[]{0,SW,0,SW*sx});
  // Fractional destination origins (the left edge at a fraction, whole and fractional right edges).
  foreach(float ox in new float[]{.25f,.5f,.75f})specs.Add(new float[]{0,SW,ox,SW*1.5f});
  specs.Add(new float[]{0,SW,.375f,SW}); specs.Add(new float[]{0,SW,3.4f,SW*2.3f}); specs.Add(new float[]{0,SW,5.25f,SW*.75f});
  // Source sub-rectangles drawn into whole-pixel destinations.
  foreach(int[] p in new int[][]{new[]{250,256},new[]{200,256},new[]{100,256},new[]{200,300}})specs.Add(new float[]{0,p[0],0,p[1]});
  var json=new StringBuilder("{\"srcW\":").Append(SW).Append(",\"rows\":").Append(ROWS).Append(",\"src\":\"").Append(Convert.ToBase64String(src)).Append("\",\"draws\":[");
  bool first=true;
  using(var bmp=new Bitmap(SW,H,PixelFormat.Format32bppArgb)){
   var d=bmp.LockBits(new Rectangle(0,0,SW,H),ImageLockMode.WriteOnly,PixelFormat.Format32bppArgb);var line=new byte[SW*4];
   for(int y=0;y<H;y++){int sr=y/REP;for(int x=0;x<SW;x++){line[x*4]=src[(sr*SW+x)*3+2];line[x*4+1]=src[(sr*SW+x)*3+1];line[x*4+2]=src[(sr*SW+x)*3];line[x*4+3]=255;}Marshal.Copy(line,0,IntPtr.Add(d.Scan0,y*d.Stride),SW*4);}
   bmp.UnlockBits(d);
   foreach(InterpolationMode kernel in new InterpolationMode[]{InterpolationMode.HighQualityBicubic,InterpolationMode.HighQualityBilinear})
   foreach(bool mirror in new bool[]{false,true}){
    foreach(var s in specs){
     if(s[3]<=0)continue;
     int bitmapW=(int)Math.Ceiling(s[2]+s[3])+8;
     using(var dest=new Bitmap(bitmapW,H,PixelFormat.Format32bppPArgb)){
      using(var g=Graphics.FromImage(dest)){g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=kernel;g.PixelOffsetMode=PixelOffsetMode.None;
       var srcRect=new RectangleF(s[0],0,s[1],H);
       if(mirror)g.DrawImage(bmp,new RectangleF(s[2]+s[3],0,-s[3],H),srcRect,GraphicsUnit.Pixel);
       else g.DrawImage(bmp,new RectangleF(s[2],0,s[3],H),srcRect,GraphicsUnit.Pixel);}
      var o=dest.LockBits(new Rectangle(0,0,bitmapW,H),ImageLockMode.ReadOnly,PixelFormat.Format32bppPArgb);
      var outBytes=new byte[bitmapW*ROWS*3];var l2=new byte[bitmapW*4];
      for(int y=0;y<ROWS;y++){Marshal.Copy(IntPtr.Add(o.Scan0,(y*REP+3)*o.Stride),l2,0,bitmapW*4);for(int x=0;x<bitmapW;x++){outBytes[(y*bitmapW+x)*3]=l2[x*4+2];outBytes[(y*bitmapW+x)*3+1]=l2[x*4+1];outBytes[(y*bitmapW+x)*3+2]=l2[x*4];}}
      dest.UnlockBits(o);
      if(!first)json.Append(',');first=false;
      json.Append("{\"kernel\":").Append((int)kernel).Append(",\"srcX\":").Append(F(s[0])).Append(",\"srcW\":").Append(F(s[1])).Append(",\"destX\":").Append(F(s[2])).Append(",\"destW\":").Append(F(mirror?-s[3]:s[3])).Append(",\"bitmapW\":").Append(bitmapW).Append(",\"dest\":\"").Append(Convert.ToBase64String(outBytes)).Append("\"}");
     }
    }
   }
  }
  json.Append("]}");
  var data=Encoding.UTF8.GetBytes(json.ToString());
  using(var file=File.Create(Path.Combine(directory,"hq-phases.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(data,0,data.Length);
 }
}
