// Per-destination-pixel weights of an axis-aligned HighQuality DrawImage(destRect, srcRect, unit, ImageAttributes) with a
// WrapMode and a source sub-rectangle, read from impulses: the source is opaque grey `bg` (0 or 128; a grey background shows negative lobes as dips) with one white row (or column) t, the
// Clamp colour is opaque green (0,255,0), so the destination red is 255 x the weight of source texel t and the green is that
// plus 255 x the weight on the clamp colour. Each geometry is [bitmapW, bitmapH, srcX, srcY, srcW, srcH, destW, destH]
// with the destination at (8, 8). The bytes run along the draw's axis through the middle of the destination on the other axis.
// Writes hq-wrap-crop.json.gz: {"geoms":[[...]],"draws":[{"kernel","wrap","geom","axis","t","red","green","alpha"}]}.
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.IO; using System.Text;
public static class HighQualityWrapCropProbe {
 public static void Run(string directory){
  int[][] geoms=new int[][]{
   new[]{20,16,2,3,14,10,90,44},new[]{20,16,0,0,20,16,90,44},new[]{20,16,2,3,14,10,45,22},new[]{20,16,2,3,14,10,28,20},
   new[]{20,16,0,0,14,10,90,44},new[]{32,32,8,8,16,16,64,64},new[]{20,16,2,3,14,10,14,10}};
  WrapMode[] wraps=new WrapMode[]{WrapMode.Tile,WrapMode.TileFlipX,WrapMode.TileFlipY,WrapMode.TileFlipXY,WrapMode.Clamp};
  var json=new StringBuilder("{\"geoms\":[");
  for(int i=0;i<geoms.Length;i++){if(i>0)json.Append(',');json.Append('[').Append(string.Join(",",geoms[i])).Append(']');}
  json.Append("],\"draws\":[");bool first=true;
  foreach(InterpolationMode kernel in new InterpolationMode[]{InterpolationMode.HighQualityBilinear,InterpolationMode.HighQualityBicubic})
  for(int w=0;w<wraps.Length;w++)for(int gi=0;gi<geoms.Length;gi++)for(int axis=0;axis<2;axis++)foreach(int bg in new int[]{0,128}){
   int[] G=geoms[gi];int bw=G[0],bh=G[1];
   for(int t=0;t<(axis==0?bw:bh);t++)using(var src=new Bitmap(bw,bh,PixelFormat.Format32bppArgb))using(var dest=new Bitmap(128,128,PixelFormat.Format32bppPArgb)){
    var sd=src.LockBits(new Rectangle(0,0,bw,bh),ImageLockMode.WriteOnly,PixelFormat.Format32bppArgb);
    for(int y=0;y<bh;y++)for(int x=0;x<bw;x++){byte v=(byte)((axis==0?x:y)==t?255:bg);int off=y*sd.Stride+x*4;Marshal.WriteByte(sd.Scan0,off,v);Marshal.WriteByte(sd.Scan0,off+1,v);Marshal.WriteByte(sd.Scan0,off+2,v);Marshal.WriteByte(sd.Scan0,off+3,255);}
    src.UnlockBits(sd);
    using(var g=Graphics.FromImage(dest))using(var ia=new ImageAttributes()){
     g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=kernel;g.PixelOffsetMode=PixelOffsetMode.None;
     if(wraps[w]==WrapMode.Clamp)ia.SetWrapMode(WrapMode.Clamp,Color.FromArgb(255,0,255,0));else ia.SetWrapMode(wraps[w]);
     g.DrawImage(src,new Rectangle(8,8,G[6],G[7]),G[2],G[3],G[4],G[5],GraphicsUnit.Pixel,ia);}
    var bd=dest.LockBits(new Rectangle(0,0,128,128),ImageLockMode.ReadOnly,PixelFormat.Format32bppPArgb);
    int n=axis==0?G[6]:G[7];var red=new byte[n];var green=new byte[n];var alpha=new byte[n];
    for(int i=0;i<n;i++){
     int px=axis==0?8+i:8+G[6]/2,py=axis==0?8+G[7]/2:8+i;int o=py*bd.Stride+px*4;
     red[i]=Marshal.ReadByte(bd.Scan0,o+2);green[i]=Marshal.ReadByte(bd.Scan0,o+1);alpha[i]=Marshal.ReadByte(bd.Scan0,o+3);}
    dest.UnlockBits(bd);
    if(!first)json.Append(',');first=false;
    json.Append("{\"kernel\":").Append((int)kernel).Append(",\"wrap\":").Append((int)wraps[w]).Append(",\"geom\":").Append(gi).Append(",\"bg\":").Append(bg).Append(",\"axis\":").Append(axis).Append(",\"t\":").Append(t)
     .Append(",\"red\":\"").Append(Convert.ToBase64String(red)).Append("\",\"green\":\"").Append(Convert.ToBase64String(green)).Append("\",\"alpha\":\"").Append(Convert.ToBase64String(alpha)).Append("\"}");
   }
  }
  var data=Encoding.UTF8.GetBytes(json.Append("]}").ToString());
  using(var file=File.Create(Path.Combine(directory,"hq-wrap-crop.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(data,0,data.Length);
 }
}
