// Native GDI+ ClearType (ClearTypeGridFit) blend arithmetic. One set of strings is drawn at fixed positions over a flat
// background with a flat colour, so the per-channel coverage of every pixel is identical in all draws. Black text on
// white at TextContrast 0 gives that coverage exactly (out = 255 - coverage); every other draw is a (text colour,
// background, TextContrast) combination whose output the converter's blend is tested against. Like the GpCase
// references, each string is drawn directly onto a 32bpp bitmap (FillRectangle, then DrawString).
using System;using System.Drawing;using System.Drawing.Imaging;using System.Drawing.Text;using System.IO;using System.Text;using System.Runtime.InteropServices;
public static class ClearTypeBlendPlusProbe {
 static int W=330,H=70;
 public static void Run(string dir) {
  var json=new StringBuilder("{\"width\":"+W+",\"height\":"+H+",\"cases\":[");
  int[][] pairs={ new[]{0,0,0,255,255,255}, new[]{255,255,255,0,0,0}, new[]{20,30,90,255,255,255}, new[]{255,255,255,30,40,60}, new[]{200,40,10,40,160,220}, new[]{128,128,128,128,128,128}, new[]{250,250,20,10,10,200}, new[]{10,200,50,240,230,200} };
  bool first=true;
  foreach(int contrast in new[]{0,1,2,3,4,5,6,8,10,12}) foreach(int[] p in pairs) {
   if(!first)json.Append(',');first=false;
   json.Append("{\"contrast\":").Append(contrast).Append(",\"fg\":[").Append(p[0]).Append(',').Append(p[1]).Append(',').Append(p[2]).Append("],\"bg\":[").Append(p[3]).Append(',').Append(p[4]).Append(',').Append(p[5]).Append("],\"rgb\":\"").Append(Draw(contrast,Color.FromArgb(p[0],p[1],p[2]),Color.FromArgb(p[3],p[4],p[5]))).Append("\"}");
  }
  json.Append("]}");
  byte[] data=Encoding.UTF8.GetBytes(json.ToString());
  using(var file=File.Create(Path.Combine(dir,"text-cleartype-blend-plus.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(data,0,data.Length);
 }
 static void DrawText(Graphics g,int contrast,Color fg,Color bg){
  g.PageUnit=GraphicsUnit.Pixel;
  using(var back=new SolidBrush(bg))g.FillRectangle(back,0,0,W,H);
  g.TextRenderingHint=TextRenderingHint.ClearTypeGridFit;g.TextContrast=contrast;
  using(var f1=new Font("Arial",16,FontStyle.Regular,GraphicsUnit.Pixel))using(var f2=new Font("Segoe UI",12,FontStyle.Bold,GraphicsUnit.Pixel))using(var f3=new Font("Times New Roman",22,FontStyle.Italic,GraphicsUnit.Pixel))using(var f4=new Font("Arial",40,FontStyle.Bold,GraphicsUnit.Pixel))using(var b=new SolidBrush(fg)){
   g.DrawString("GDI+ DrawString Ag 0123",f1,b,6,4);
   g.DrawString("Bold Segoe 12 WAVEfk",f2,b,6,28);
   g.DrawString("Italic Times 22",f3,b,150,24);
   g.DrawString("Wavy",f4,b,6,22);
  }
 }
 static string Draw(int contrast,Color fg,Color bg){
  using(var bmp=new Bitmap(W,H,PixelFormat.Format32bppArgb)){
   using(var g=Graphics.FromImage(bmp)){DrawText(g,contrast,fg,bg);}
   var bits=bmp.LockBits(new Rectangle(0,0,W,H),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);var px=new byte[W*H*4];Marshal.Copy(bits.Scan0,px,0,px.Length);bmp.UnlockBits(bits);
   var rgb=new byte[W*H*3];for(int i=0;i<W*H;i++){rgb[i*3]=px[i*4+2];rgb[i*3+1]=px[i*4+1];rgb[i*3+2]=px[i*4];}
   return Convert.ToBase64String(rgb);
  }
 }
}
