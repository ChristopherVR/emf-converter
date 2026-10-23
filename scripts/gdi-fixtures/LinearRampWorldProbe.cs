// Linear gradient ramp under a WORLD transform: the brush rectangle's x moves in 2^-16 pixel steps under
// Translate(tx, ty) + Rotate(angle) (and a scale), three scanlines of the filled bitmap per step, the brush in Tile
// wrap so every pixel is on the ramp. A pixel's colour changes where its 16.16 ramp coordinate crosses a multiple of 256, so
// the step at which a pixel flips reads its coordinate to a unit whatever the converter's arithmetic. This isolates the matrix
// GDI+ builds from (brush rectangle, brush matrix, world transform) from the brush-matrix sweeps of LinearRampOriginProbe.cs,
// whose world transform is the identity. The world matrix GDI+ holds (Graphics.Transform) is recorded per scene.
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.IO.Compression; using System.Text; using System.Globalization;
public static class LinearRampWorldProbe {
 const int W=160,H=100;
 static string F(float v){return v.ToString("R",CultureInfo.InvariantCulture);}
 static void Scene(StringBuilder json,string name,float tx,float ty,float angle,float scale,float rx,float ry,float rw,float rh,float brushAngle,int[] rows,int steps){
  int lo=-steps,hi=steps;
  var data=new byte[(hi-lo+1)*rows.Length*W*3];var mats=new StringBuilder();
  int o=0;float[] world=null;
  using(var bmp=new Bitmap(W,H,PixelFormat.Format32bppArgb)){
   for(int k=lo;k<=hi;k++){
    using(var b=new LinearGradientBrush(new RectangleF(rx+k/65536f,ry,rw,rh),Color.FromArgb(255,230,40,30),Color.FromArgb(255,20,90,220),brushAngle))using(var g=Graphics.FromImage(bmp)){
     b.WrapMode=WrapMode.Tile;
     g.Clear(Color.Transparent);g.TranslateTransform(tx,ty);g.RotateTransform(angle);if(scale!=1f)g.ScaleTransform(scale,scale);
     if(world==null)world=g.Transform.Elements;
     if(mats.Length>0)mats.Append(',');var el=b.Transform.Elements;mats.Append('[').Append(F(el[0])).Append(',').Append(F(el[1])).Append(',').Append(F(el[2])).Append(',').Append(F(el[3])).Append(',').Append(F(el[4])).Append(',').Append(F(el[5])).Append(']');
     g.ResetTransform();
     g.Transform=new Matrix(world[0],world[1],world[2],world[3],world[4],world[5]);
     g.FillRectangle(b,-400,-400,1200,1200);
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
  json.Append("{\"name\":\"").Append(name).Append("\",\"w\":").Append(W).Append(",\"rows\":[").Append(string.Join(",",Array.ConvertAll(rows,r=>r.ToString()))).Append("],\"first\":").Append(lo).Append(",\"last\":").Append(hi)
   .Append(",\"angle\":").Append(F(angle)).Append(",\"scale\":").Append(F(scale)).Append(",\"tx\":").Append(F(tx)).Append(",\"ty\":").Append(F(ty)).Append(",\"rect\":[").Append(F(rx)).Append(',').Append(F(ry)).Append(',').Append(F(rw)).Append(',').Append(F(rh)).Append("],\"brushAngle\":").Append(F(brushAngle))
   .Append(",\"world\":[").Append(string.Join(",",Array.ConvertAll(world,F))).Append("],\"matrices\":[").Append(mats.ToString()).Append("],\"rgb\":\"").Append(Convert.ToBase64String(data)).Append("\"}");
 }
 public static void Run(string directory){
  var json=new StringBuilder("[");
  int[] rows={3,47,91};
  var rnd=new Random(7);
  // the fixture's own scene, then angles on a grid and random ones, then scaled and offset variants
  Scene(json,"fixture",80f,50f,-25f,1f,-60f,-30f,50f,60f,0f,rows,48);
  for(int a=-175;a<=175;a+=5)Scene(json,"angle",80f,50f,a,1f,-60f,-30f,50f,60f,0f,rows,24);
  for(int i=0;i<60;i++){float a=(float)(rnd.NextDouble()*360-180);Scene(json,"random",(float)(40+rnd.NextDouble()*80),(float)(30+rnd.NextDouble()*40),a,1f,-60f,-30f,50f,60f,0f,rows,24);}
  for(int i=0;i<30;i++){float a=(float)(rnd.NextDouble()*360-180);Scene(json,"scaled",(float)(40+rnd.NextDouble()*80),(float)(30+rnd.NextDouble()*40),a,(float)(0.5+rnd.NextDouble()*1.5),-40f,-20f,60f,40f,(float)(rnd.NextDouble()*90),rows,24);}
  var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());
  using(var file=File.Create(Path.Combine(directory,"linear-ramp-world.json.gz")))using(var gzip=new GZipStream(file,CompressionMode.Compress))gzip.Write(bytes,0,bytes.Length);
 }
}
