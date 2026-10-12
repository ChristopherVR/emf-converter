// Native Windows DrawString baseline controls. Each image comes directly from GDI+.
using System;using System.Drawing;using System.Drawing.Imaging;using System.Drawing.Text;using System.IO;using System.Text;using System.Runtime.InteropServices;using System.Globalization;
public static class DrawStringBaselineProbe {
 public static void Run(string dir) {
  var json=new StringBuilder("[");
  foreach(string face in new[]{"Arial","Segoe UI","Tahoma","Times New Roman","Courier New"})
  foreach(int style in new[]{0,1,2,3})foreach(bool typo in new[]{false,true}) {
   for(int size=7;size<=40;size++) Capture(json,face,style,size,typo,"H",64,80,false);
   foreach(int size in new[]{13,17,19,27,31,39})foreach(string text in new[]{"AV To WA","Hello 0123456789","GDI+ DrawString Ag 0123","Ag"}) Capture(json,face,style,size,typo,text,600,80,true);
  }
  byte[] data=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(dir,"text-drawstring-baseline.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(data,0,data.Length);
 }
 static void Capture(StringBuilder json,string face,int style,int size,bool typo,string text,int w,int h,bool heldout){
  using(var image=new Bitmap(w,h,PixelFormat.Format32bppArgb))using(var font=new Font(face,size,(FontStyle)style,GraphicsUnit.Pixel))using(var format=typo?StringFormat.GenericTypographic:new StringFormat()) {
   using(var g=Graphics.FromImage(image)){g.Clear(Color.White);g.TextRenderingHint=TextRenderingHint.ClearTypeGridFit;g.TextContrast=0;g.DrawString(text,font,Brushes.Black,new PointF(8,8),format);}
   var bits=image.LockBits(new Rectangle(0,0,w,h),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);var rgba=new byte[w*h*4];try{for(int y=0;y<h;y++)Marshal.Copy(IntPtr.Add(bits.Scan0,y*bits.Stride),rgba,y*w*4,w*4);}finally{image.UnlockBits(bits);}for(int p=0;p<rgba.Length;p+=4){byte b=rgba[p];rgba[p]=rgba[p+2];rgba[p+2]=b;}
   if(json.Length>1)json.Append(',');json.Append("{\"face\":\"").Append(face).Append("\",\"style\":").Append(style).Append(",\"size\":").Append(size).Append(",\"typo\":").Append(typo?"true":"false").Append(",\"heldout\":").Append(heldout?"true":"false").Append(",\"text\":\"").Append(text).Append("\",\"width\":").Append(w).Append(",\"height\":").Append(h).Append(",\"rgba\":\"").Append(Convert.ToBase64String(rgba)).Append("\"}");
  }
 }
}
