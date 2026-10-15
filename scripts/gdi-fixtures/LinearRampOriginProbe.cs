// Linear gradient ramp origin: the brush rectangle's x moves in 2^-16 pixel steps and three scanlines of the
// filled bitmap are kept per step. A pixel's colour changes when its 16.16 ramp coordinate crosses a multiple
// of 256 (the top eight fraction bits select the knot blend), so the step at which each pixel flips reads that
// coordinate to a single unit, whatever the converter's arithmetic. Scenes: the `gpx-lin-sigma` brush (Blend from
// SetSigmaBellShape), the same rectangle without the shape, and the 30 degree brush of the `grad-linear-a30` fixtures.
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.IO.Compression; using System.Text; using System.Globalization;
public static class LinearRampOriginProbe {
 const int W=160,H=100;
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 delegate LinearGradientBrush MakeBrush(float dx);
 static void Scene(StringBuilder json,string name,MakeBrush make,int[] rows,int steps,bool negative){
  int lo=negative?-steps:0,hi=steps;
  var data=new byte[(hi-lo+1)*rows.Length*W*3];var mats=new StringBuilder();Blend blendOut=null;
  int o=0;
  using(var bmp=new Bitmap(W,H,PixelFormat.Format32bppArgb)){
   for(int k=lo;k<=hi;k++){
    using(var b=make(k/65536f))using(var g=Graphics.FromImage(bmp)){if(mats.Length>0)mats.Append(',');var el=b.Transform.Elements;mats.Append('[').Append(F(el[0])).Append(',').Append(F(el[1])).Append(',').Append(F(el[2])).Append(',').Append(F(el[3])).Append(',').Append(F(el[4])).Append(',').Append(F(el[5])).Append(']');if(blendOut==null&&b.Blend!=null)blendOut=b.Blend;
     g.Clear(Color.Transparent);g.FillRectangle(b,0,0,W,H);
    }
    var bits=bmp.LockBits(new Rectangle(0,0,W,H),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
    try{
     foreach(int y in rows){
      byte[] row=new byte[W*4];Marshal.Copy(IntPtr.Add(bits.Scan0,y*bits.Stride),row,0,W*4);
      for(int x=0;x<W;x++){data[o++]=row[x*4+2];data[o++]=row[x*4+1];data[o++]=row[x*4];}
     }
    }finally{bmp.UnlockBits(bits);}
   }
  }
  if(json.Length>1)json.Append(',');
  json.Append("{\"name\":\"").Append(name).Append("\",\"w\":").Append(W).Append(",\"rows\":[").Append(string.Join(",",Array.ConvertAll(rows,r=>r.ToString()))).Append("],\"first\":").Append(lo).Append(",\"last\":").Append(hi).Append(",\"matrices\":[").Append(mats.ToString()).Append("],\"blend\":");
  if(blendOut==null)json.Append("null");
  else{json.Append("{\"factors\":[").Append(string.Join(",",Array.ConvertAll(blendOut.Factors,F))).Append("],\"positions\":[").Append(string.Join(",",Array.ConvertAll(blendOut.Positions,F))).Append("]}");}
  json.Append(",\"rgb\":\"").Append(Convert.ToBase64String(data)).Append("\"}");
 }
 public static void Run(string directory){
  var json=new StringBuilder("[");
  int[] rows={2,12,22};
  Scene(json,"sigma",dx=>{var b=new LinearGradientBrush(new RectangleF(5+dx,0,150,30),Color.FromArgb(255,250,240,10),Color.FromArgb(255,30,0,120),60f);b.SetSigmaBellShape(0.35f,0.9f);return b;},rows,1024,true);
  Scene(json,"plain60",dx=>new LinearGradientBrush(new RectangleF(5+dx,0,150,30),Color.FromArgb(255,250,240,10),Color.FromArgb(255,30,0,120),60f),rows,1024,true);
  Scene(json,"sigma0",dx=>{var b=new LinearGradientBrush(new RectangleF(5+dx,0,150,30),Color.FromArgb(255,250,240,10),Color.FromArgb(255,30,0,120),0f);b.SetSigmaBellShape(0.35f,0.9f);return b;},rows,1024,true);
  Scene(json,"a30",dx=>new LinearGradientBrush(new RectangleF(10+dx,5,110,40),Color.FromArgb(255,230,40,30),Color.FromArgb(255,20,90,220),30f),rows,1024,true);
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());
  using(var file=File.Create(Path.Combine(directory,"linear-ramp-origin.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
}
