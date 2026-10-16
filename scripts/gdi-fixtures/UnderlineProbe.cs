// Native GDI+ DrawString underline and strike-out bars under TextRenderingHintAntiAlias.
// Each case draws "        x" (eight spaces and an x, so the bar is visible with no glyph ink in its rows) and
// records, for the bar's rows, the column profile at x = 10 + size (inside the bar) and the per-column ink sums of the
// first and last three columns of the bar. Values are 255 - green with TextContrast 0, i.e. plain coverage.
using System;using System.Drawing;using System.Drawing.Imaging;using System.Drawing.Text;using System.Globalization;using System.IO;using System.Text;using System.Runtime.InteropServices;
public static class UnderlineProbe {
 public static void Run(string dir) {
  var json=new StringBuilder("[");
  var inv=CultureInfo.InvariantCulture;
  string[] faces={"Arial","Segoe UI","Times New Roman","Courier New","Tahoma"};
  int[] styles={4,5,6,8,12};
  int[] sizes={6,7,8,9,10,11,12,13,14,16,18,20,21,22,24,28,32,40,48,64};
  float[][] phases={new[]{0f,0f},new[]{0f,0.25f},new[]{0f,0.5f},new[]{0f,0.75f},new[]{0.25f,0f},new[]{0.25f,0.25f},new[]{0.25f,0.5f},new[]{0.25f,0.75f},new[]{0.5f,0f},new[]{0.5f,0.25f},new[]{0.5f,0.5f},new[]{0.5f,0.75f},new[]{0f,0.125f},new[]{0f,0.375f},new[]{0f,0.625f},new[]{0f,0.875f}};
  foreach(string face in faces) foreach(int style in styles) foreach(int size in sizes) foreach(float[] ph in phases) {
   float ox=ph[0],oy=ph[1];
   int w=600,h=size*3+20;
   using(var bmp=new Bitmap(w,h,PixelFormat.Format32bppArgb))using(var font=new Font(face,size,(FontStyle)style,GraphicsUnit.Pixel)){
    using(var g=Graphics.FromImage(bmp)){g.Clear(Color.White);g.TextRenderingHint=TextRenderingHint.AntiAlias;g.TextContrast=0;g.DrawString("        x",font,Brushes.Black,new PointF(10+ox,8+oy));}
    var bits=bmp.LockBits(new Rectangle(0,0,w,h),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);var px=new byte[w*h*4];Marshal.Copy(bits.Scan0,px,0,px.Length);bmp.UnlockBits(bits);
    int cx=10+size;
    var col=new StringBuilder();int y0=-1,y1=-1;
    for(int y=0;y<h;y++){int v=255-px[(y*w+cx)*4+1];if(v!=0){col.Append(y).Append(':').Append(v).Append(' ');if(y0<0)y0=y;y1=y;}}
    var left=new StringBuilder();var right=new StringBuilder();
    if(y0>=0){
     var tot=new int[w];int first=-1,last=-1;
     for(int x=0;x<w;x++){int s=0;for(int y=y0;y<=y1;y++)s+=255-px[(y*w+x)*4+1];tot[x]=s;if(s>0){if(first<0)first=x;last=x;}}
     for(int x=first;x<first+3&&x<w;x++)left.Append(x).Append(':').Append(tot[x]).Append(' ');
     for(int x=Math.Max(first,last-2);x<=last;x++)right.Append(x).Append(':').Append(tot[x]).Append(' ');
    }
    if(json.Length>1)json.Append(',');
    json.Append("{\"face\":\"").Append(face).Append("\",\"style\":").Append(style).Append(",\"size\":").Append(size).Append(",\"ox\":").Append(ox.ToString(inv)).Append(",\"oy\":").Append(oy.ToString(inv)).Append(",\"col\":\"").Append(col.ToString().Trim()).Append("\",\"left\":\"").Append(left.ToString().Trim()).Append("\",\"right\":\"").Append(right.ToString().Trim()).Append("\"}");
   }
  }
  byte[] data=Encoding.UTF8.GetBytes(json.Append(']').ToString());
  using(var file=File.Create(Path.Combine(dir,"text-underline.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(data,0,data.Length);
 }
}
