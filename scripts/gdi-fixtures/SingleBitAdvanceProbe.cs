// Native GDI+ DrawString advance accumulation under TextRenderingHintSingleBitPerPixel. Strings of one repeated glyph
// are drawn at 10 + fx (fx in sixteenths) so that each glyph's pixel column shows where the accumulated float pen
// position crosses a pixel boundary; the ink columns of the bitmap are recorded.
using System;using System.Drawing;using System.Drawing.Imaging;using System.Drawing.Text;using System.Globalization;using System.IO;using System.Text;using System.Runtime.InteropServices;
public static class SingleBitAdvanceProbe {
 public static void Run(string dir) {
  var json=new StringBuilder("[");
  var inv=CultureInfo.InvariantCulture;
  foreach(string face in new[]{"Arial","Segoe UI","Times New Roman"}) foreach(int size in new[]{12,13,16,20}) foreach(string text in new[]{"llllllllllllllllllllllll","IIIIIIIIIIIIIIIIIIIIIIII","0123456789012345678901234"}) for(int fi=0;fi<16;fi++){
   float fx=fi/16f;
   int w=600,h=size*2+20;
   using(var bmp=new Bitmap(w,h,PixelFormat.Format32bppArgb))using(var font=new Font(face,size,FontStyle.Regular,GraphicsUnit.Pixel)){
    using(var g=Graphics.FromImage(bmp)){g.Clear(Color.White);g.TextRenderingHint=TextRenderingHint.SingleBitPerPixel;g.DrawString(text,font,Brushes.Black,new PointF(10+fx,6));}
    var bits=bmp.LockBits(new Rectangle(0,0,w,h),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);var px=new byte[w*h*4];Marshal.Copy(bits.Scan0,px,0,px.Length);bmp.UnlockBits(bits);
    var cols=new StringBuilder();
    for(int x=0;x<w;x++){bool any=false;for(int y=0;y<h;y++)if(px[(y*w+x)*4+1]!=255){any=true;break;}if(any)cols.Append(x).Append(' ');}
    if(json.Length>1)json.Append(',');
    json.Append("{\"face\":\"").Append(face).Append("\",\"size\":").Append(size).Append(",\"text\":\"").Append(text).Append("\",\"fx\":").Append(fx.ToString(inv)).Append(",\"cols\":\"").Append(cols.ToString().Trim()).Append("\"}");
   }
  }
  byte[] data=Encoding.UTF8.GetBytes(json.Append(']').ToString());
  using(var file=File.Create(Path.Combine(dir,"text-singlebit-advances.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(data,0,data.Length);
 }
}
