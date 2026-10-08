// Which weight phase GDI+ uses for each destination pixel of an axis-aligned HighQuality DrawImage: one noise source
// (independent rows, each replicated over 7 identical rows so the vertical pass is the identity) drawn through many
// horizontal source/destination rectangles with both kernels, mirrored and not. With 48 independent rows a wrong
// phase mismatches a large share of rows, so the phase of each destination column is read off by testing every
// phase against all rows (the analysis is in the unit tests that read hq-phases.json.gz).
// Writes hq-phases.json.gz: {"srcW","rows","src" (rows x srcW x RGB, base64),"draws":[{"kernel","srcX","srcW","destX","destW","bitmapW","dest"}]}
// where destW is negative for a mirrored draw, and dest holds rows x bitmapW x RGB.
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.Text; using System.Globalization;
public static class HighQualityPhaseProbe {
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 public static void Run(string directory){
  const int SW=512, ROWS=48, REP=7; int H=ROWS*REP;
  var rng=new Random(41017); var src=new byte[ROWS*SW*3]; for(int i=0;i<src.Length;i++)src[i]=(byte)rng.Next(256);
  var specs=new List<float[]>(); // srcX, srcW, destX, destW
  // Whole-source draws at assorted scales (upscales, then reductions).
  foreach(float sx in new float[]{1.0078125f,1.01f,1.05f,1.1f,1.2f,1.25f,1.3f,1.37f,1.5f,1.61f,1.77f,1.9f,2f,2.3f,2.77f,3f,3.3f,4.1f,5.3f,7.1f,.9f,.8f,.75f,.65f,.6f,.5f,.4f,.3f})
   specs.Add(new float[]{0,SW,0,SW*sx});
  // Scales whose reciprocal sits just below one half of a 1/65536 step, to read the rounding of the step.
  foreach(double n0 in new double[]{9000,30000,50000})for(int fi=462;fi<=498;fi+=3)specs.Add(new float[]{0,SW,0,(float)(SW*65536.0/(n0+fi/1000.0))});
  // Source sub-rectangles drawn into whole-pixel destinations (the scale is a ratio of two integers).
  foreach(int[] p in new int[][]{new[]{508,512},new[]{504,512},new[]{400,512},new[]{300,512},new[]{450,700},new[]{333,512},new[]{256,700},new[]{500,1000},new[]{499,512},new[]{100,512},new[]{200,300}})specs.Add(new float[]{0,p[0],0,p[1]});
  // Fractional destination origins and fractional source origins.
  foreach(float ox in new float[]{.25f,.5f,.75f,.1f,.9f})specs.Add(new float[]{0,SW,ox,SW*1.5f});
  foreach(float ox in new float[]{.25f,.5f,.75f})specs.Add(new float[]{ox,SW-2,0,(SW-2)*1.5f});
  foreach(float ox in new float[]{3,3.4f,10.25f})specs.Add(new float[]{0,SW,ox,SW*2.3f});
  var grid=new List<float[]>();foreach(int sw0 in new[]{97,100,128,200,256,300,333,400,450,499,500,508})foreach(int dw0 in new[]{512,600,700,1000})if(dw0>sw0*1.0001)grid.Add(new float[]{0,sw0,0,dw0});
  var json=new StringBuilder("{\"srcW\":").Append(SW).Append(",\"rows\":").Append(ROWS).Append(",\"src\":\"").Append(Convert.ToBase64String(src)).Append("\",\"draws\":[");
  bool first=true;
  using(var bmp=new Bitmap(SW,H,PixelFormat.Format32bppArgb)){
   var d=bmp.LockBits(new Rectangle(0,0,SW,H),ImageLockMode.WriteOnly,PixelFormat.Format32bppArgb);var line=new byte[SW*4];
   for(int y=0;y<H;y++){int sr=y/REP;for(int x=0;x<SW;x++){line[x*4]=src[(sr*SW+x)*3+2];line[x*4+1]=src[(sr*SW+x)*3+1];line[x*4+2]=src[(sr*SW+x)*3];line[x*4+3]=255;}Marshal.Copy(line,0,IntPtr.Add(d.Scan0,y*d.Stride),SW*4);}
   bmp.UnlockBits(d);
   foreach(InterpolationMode kernel in new InterpolationMode[]{InterpolationMode.HighQualityBicubic,InterpolationMode.HighQualityBilinear})
   foreach(bool mirror in new bool[]{false,true}){
    var all=new List<float[]>(specs);if(kernel==InterpolationMode.HighQualityBicubic&&!mirror)all.AddRange(grid);
    foreach(var s in all){
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
