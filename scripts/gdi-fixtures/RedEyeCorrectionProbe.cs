// Independent synthetic red-eye controls through public GDI+ effect APIs.
using System; using System.Drawing; using System.IO; using System.Runtime.InteropServices; using System.Text;
public static class RedEyeCorrectionProbe {
 [DllImport("gdiplus.dll")] static extern int GdipCreateEffect(Guid guid,out IntPtr effect);
 [DllImport("gdiplus.dll")] static extern int GdipSetEffectParameters(IntPtr effect,IntPtr p,uint size);
 [DllImport("gdiplus.dll")] static extern int GdipDeleteEffect(IntPtr effect);
 [DllImport("gdiplus.dll")] static extern int GdipCreateBitmapFromScan0(int w,int h,int stride,int format,IntPtr scan,out IntPtr bmp);
 [DllImport("gdiplus.dll")] static extern int GdipBitmapSetPixel(IntPtr bmp,int x,int y,int argb);
 [DllImport("gdiplus.dll")] static extern int GdipBitmapGetPixel(IntPtr bmp,int x,int y,out int argb);
 [DllImport("gdiplus.dll")] static extern int GdipBitmapApplyEffect(IntPtr bmp,IntPtr effect,IntPtr roi,bool aux,IntPtr data,IntPtr size);
 [DllImport("gdiplus.dll")] static extern int GdipDisposeImage(IntPtr bmp);
 static void Check(int s){if(s!=0)throw new Exception("GDI+ status "+s);}
 public static void Run(string dir) { Capture(dir, false); Capture(dir, true); }
 static void Capture(string dir, bool heldOut) { Directory.CreateDirectory(dir);var json=new StringBuilder("[");bool first=true;
 using(var init=new Bitmap(1,1)) foreach(int size in heldOut ? new[]{18,28,36} : new[]{16,24,31,40}) foreach(int pattern in new[]{0,1,2,3,4,5}) foreach(int blue in heldOut ? new[]{5,12,24,48} : new[]{0,1,2,3,4,8,16,32}) {
 int w=size,h=size;var source=new byte[w*h*4];IntPtr bmp=IntPtr.Zero,effect=IntPtr.Zero,parameters=IntPtr.Zero;
 try{Check(GdipCreateBitmapFromScan0(w,h,0,0x26200a,IntPtr.Zero,out bmp));
 for(int y=0;y<h;y++)for(int x=0;x<w;x++) {int r=heldOut?220:200,g=blue,b=blue;
 double d=Math.Sqrt((x+.5-w/2.0)*(x+.5-w/2.0)+(y+.5-h/2.0)*(y+.5-h/2.0));
 if((pattern==1 && d<size/(heldOut?5.0:6.0))||(pattern==4 && d<size*(heldOut?.28:.3))||(pattern==5 && d<size*(heldOut?.38:.4))){r=heldOut?120:100;g=0;b=blue;}
 if(pattern==2){g=x<w/2?blue:40;b=blue;}
 if(pattern==3){r=(x*17+y*31)%156+100;g=(x*3+y*5)%64;b=blue;}
 int i=(y*w+x)*4;source[i]=(byte)r;source[i+1]=(byte)g;source[i+2]=(byte)b;source[i+3]=255;Check(GdipBitmapSetPixel(bmp,x,y,unchecked((int)0xff000000)|(r<<16)|(g<<8)|b));}
 Check(GdipCreateEffect(new Guid("74D29D05-69A4-4266-9549-3CC52836B632"),out effect));int head=IntPtr.Size*2,len=head+16;parameters=Marshal.AllocHGlobal(len);Marshal.WriteInt32(parameters,0,1);Marshal.WriteIntPtr(parameters,IntPtr.Size,new IntPtr(parameters.ToInt64()+head));
 Marshal.WriteInt32(parameters,head,0);Marshal.WriteInt32(parameters,head+4,0);Marshal.WriteInt32(parameters,head+8,w);Marshal.WriteInt32(parameters,head+12,h);
 Check(GdipSetEffectParameters(effect,parameters,(uint)len));Check(GdipBitmapApplyEffect(bmp,effect,IntPtr.Zero,false,IntPtr.Zero,IntPtr.Zero));var output=new byte[source.Length];
 for(int y=0;y<h;y++)for(int x=0;x<w;x++){int argb;Check(GdipBitmapGetPixel(bmp,x,y,out argb));int i=(y*w+x)*4;output[i]=(byte)(argb>>16);output[i+1]=(byte)(argb>>8);output[i+2]=(byte)argb;output[i+3]=(byte)(argb>>24);}
 if(!first)json.Append(',');first=false;json.Append("{\"size\":"+size+",\"pattern\":"+pattern+",\"blue\":"+blue+",\"source\":\""+Convert.ToBase64String(source)+"\",\"output\":\""+Convert.ToBase64String(output)+"\"}");
 }finally{if(parameters!=IntPtr.Zero)Marshal.FreeHGlobal(parameters);if(effect!=IntPtr.Zero)GdipDeleteEffect(effect);if(bmp!=IntPtr.Zero)GdipDisposeImage(bmp);}}
 var bytes=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var f=File.Create(Path.Combine(dir,heldOut?"redeye-heldout.json.gz":"redeye-independent.json.gz")))using(var zip=new System.IO.Compression.GZipStream(f,System.IO.Compression.CompressionMode.Compress))zip.Write(bytes,0,bytes.Length);
 }
}
