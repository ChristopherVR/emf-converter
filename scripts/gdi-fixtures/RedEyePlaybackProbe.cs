// Plays back recorded red-eye EMF+ fixtures the way the fixture generator does (GdipCreateMetafileFromFile, GdipDrawImageRectRectI
// with the pixel frame of the committed reference PNG as source rectangle, onto a 32bpp bitmap) so that the call history inside ONE process can be controlled. Run(emfDir, outDir, spec):
// spec is ';'-separated emf base names, played in order in this process; each playback is saved as <outDir>/<index>-<name>.png
// and one line "<index> <name> <pixels differing from the committed <name>.png>" is returned per playback.
using System; using System.Drawing; using System.Drawing.Imaging; using System.IO; using System.Runtime.InteropServices; using System.Text;
public static class RedEyePlaybackProbe {
 [DllImport("gdiplus.dll")] static extern int GdipCreateMetafileFromFile([MarshalAs(UnmanagedType.LPWStr)] string file, out IntPtr mf);
 [DllImport("gdiplus.dll")] static extern int GdipCreateBitmapFromScan0(int w,int h,int stride,int format,IntPtr scan,out IntPtr bmp);
 [DllImport("gdiplus.dll")] static extern int GdipGetImageGraphicsContext(IntPtr image,out IntPtr g);
 [DllImport("gdiplus.dll")] static extern int GdipDrawImageRectRectI(IntPtr g,IntPtr image,int dx,int dy,int dw,int dh,int sx,int sy,int sw,int sh,int unit,IntPtr attr,IntPtr cb,IntPtr data);
 [DllImport("gdiplus.dll")] static extern int GdipDeleteGraphics(IntPtr g);
 [DllImport("gdiplus.dll")] static extern int GdipDisposeImage(IntPtr image);
 [DllImport("gdiplus.dll")] static extern int GdipSaveImageToFile(IntPtr image,[MarshalAs(UnmanagedType.LPWStr)] string file,ref Guid enc,IntPtr p);
 static void Check(int s){if(s!=0)throw new Exception("GDI+ status "+s);}
 public static string Run(string emfDir,string outDir,string spec){
  using(var init=new Bitmap(1,1)){
  Directory.CreateDirectory(outDir);var sb=new StringBuilder();int idx=0;Guid png=new Guid("557cf406-1a04-11d3-9a73-0000f81ef32e");
  foreach(var name in spec.Split(';')){
   IntPtr mf,bmp,g;Check(GdipCreateMetafileFromFile(Path.Combine(emfDir,name+".emf"),out mf));
   int W,H;using(var r0=new Bitmap(Path.Combine(emfDir,name+".png"))){W=r0.Width;H=r0.Height;} // the pixel frame of the recording (the reference size)
   Check(GdipCreateBitmapFromScan0(W,H,0,0x26200a,IntPtr.Zero,out bmp));Check(GdipGetImageGraphicsContext(bmp,out g));
   Check(GdipDrawImageRectRectI(g,mf,0,0,W,H,0,0,W,H,2,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero));GdipDeleteGraphics(g); // source rectangle named in pixels
   string o=Path.Combine(outDir,idx+"-"+name+".png");Check(GdipSaveImageToFile(bmp,o,ref png,IntPtr.Zero));GdipDisposeImage(bmp);GdipDisposeImage(mf);
   int mism=-1;string refp=Path.Combine(emfDir,name+".png");
   if(File.Exists(refp))using(var a=new Bitmap(o))using(var r=new Bitmap(refp)){mism=0;if(a.Width!=r.Width||a.Height!=r.Height)mism=-2;else for(int y=0;y<a.Height;y++)for(int x=0;x<a.Width;x++)if(a.GetPixel(x,y).ToArgb()!=r.GetPixel(x,y).ToArgb())mism++;}
   sb.AppendLine(idx+" "+name+" "+mism);idx++;}
  return sb.ToString();}
 }
}
