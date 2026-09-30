// Records both the effect input and GDI+'s baked output in one Dual metafile.
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;

public static class ExpandedBlurProbe
{
	[StructLayout(LayoutKind.Sequential)] struct RectF { public float X, Y, Width, Height; }
	[DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
	[DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
	[DllImport("gdiplus.dll", CharSet=CharSet.Unicode)] static extern int GdipRecordMetafileFileName(string file, IntPtr dc, int type, ref RectF frame, int unit, string description, out IntPtr image);
	[DllImport("gdiplus.dll")] static extern int GdipCreateBitmapFromScan0(int width, int height, int stride, int format, IntPtr scan, out IntPtr image);
	[DllImport("gdiplus.dll")] static extern int GdipBitmapSetPixel(IntPtr image, int x, int y, int argb);
	[DllImport("gdiplus.dll")] static extern int GdipGetImageGraphicsContext(IntPtr image, out IntPtr graphics);
	[DllImport("gdiplus.dll")] static extern int GdipSetPageUnit(IntPtr graphics, int unit);
	[DllImport("gdiplus.dll")] static extern int GdipDeleteGraphics(IntPtr graphics);
	[DllImport("gdiplus.dll")] static extern int GdipDisposeImage(IntPtr image);
	[DllImport("gdiplus.dll")] static extern int GdipCreateMatrix2(float a, float b, float c, float d, float x, float y, out IntPtr matrix);
	[DllImport("gdiplus.dll")] static extern int GdipDeleteMatrix(IntPtr matrix);
	[DllImport("gdiplus.dll")] static extern int GdipCreateEffect(Guid guid, out IntPtr effect);
	[DllImport("gdiplus.dll")] static extern int GdipDeleteEffect(IntPtr effect);
	[DllImport("gdiplus.dll")] static extern int GdipSetEffectParameters(IntPtr effect, byte[] parameters, uint size);
	[DllImport("gdiplus.dll")] static extern int GdipDrawImageFX(IntPtr graphics, IntPtr image, ref RectF rect, IntPtr matrix, IntPtr effect, IntPtr attributes, int unit);
	static void Check(int status) { if(status!=0) throw new Exception("GDI+ status " + status); }
	public static void Run(string dir)
	{
		using(var init=new Bitmap(1,1)) {
			IntPtr dc=GetDC(IntPtr.Zero), metafile=IntPtr.Zero, graphics=IntPtr.Zero, matrix=IntPtr.Zero;
			try {
				var frame=new RectF{Width=64,Height=64};
				Check(GdipRecordMetafileFileName(Path.Combine(dir,"effect-blur-expanded.emf"),dc,5,ref frame,2,null,out metafile));
				Check(GdipGetImageGraphicsContext(metafile,out graphics));Check(GdipSetPageUnit(graphics,2));
				Check(GdipCreateMatrix2(1,0,0,1,0,0,out matrix));
				for(int pattern=0;pattern<3;pattern++) {
					IntPtr image=IntPtr.Zero;
					try {
						Check(GdipCreateBitmapFromScan0(64,64,0,0x26200a,IntPtr.Zero,out image));
						for(int y=0;y<64;y++)for(int x=0;x<64;x++) {
							int rgb=pattern==0?((y*64+x)&255)*0x010101:((x==0?255:0)<<16)|((x==31?255:0)<<8)|(x==63?255:0);
							if(pattern==2)rgb=(x*4<<16)|(y*4<<8)|((x*31+y*13)&255);
							int alpha=pattern<2||y<32?255:new int[]{0,64,128,200}[x%4];
							Check(GdipBitmapSetPixel(image,x,y,(alpha<<24)|rgb));
						}
						foreach(float radius in new float[]{1,3,10,19,20,32,40,64,80,81,160,255})
						foreach(var source in new RectF[]{
							new RectF{Width=64,Height=64},
							new RectF{X=24,Y=24,Width=15,Height=15},
							new RectF{X=0,Y=8,Width=31,Height=39},
							new RectF{X=24,Y=0,Width=15,Height=15},
							new RectF{X=24,Y=8,Width=15,Height=39},
							new RectF{X=8,Y=0,Width=39,Height=31},
							new RectF{X=0,Y=0,Width=31,Height=39},
							new RectF{X=0,Y=24,Width=15,Height=15},
							new RectF{X=49,Y=24,Width=15,Height=15},
							new RectF{X=24,Y=49,Width=15,Height=15},
							new RectF{X=24,Y=0,Width=15,Height=64},
							new RectF{X=48,Y=24,Width=15,Height=15},
							new RectF{X=24,Y=48,Width=15,Height=15},
							new RectF{X=1.5f,Y=8.5f,Width=29.5f,Height=38.5f}}) {
							IntPtr effect=IntPtr.Zero;var rect=source;
							try {
								Check(GdipCreateEffect(new Guid("633c80a4-1843-482b-9ef2-be2834c5fdd4"),out effect));
								byte[] parameters=new byte[8];Buffer.BlockCopy(new float[]{radius},0,parameters,0,4);parameters[4]=1;
								Check(GdipSetEffectParameters(effect,parameters,8));Check(GdipDrawImageFX(graphics,image,ref rect,matrix,effect,IntPtr.Zero,2));
							} finally {if(effect!=IntPtr.Zero)GdipDeleteEffect(effect);}
						}
					} finally {if(image!=IntPtr.Zero)GdipDisposeImage(image);}
				}
			} finally {
				if(matrix!=IntPtr.Zero)GdipDeleteMatrix(matrix);if(graphics!=IntPtr.Zero)GdipDeleteGraphics(graphics);
				if(metafile!=IntPtr.Zero)GdipDisposeImage(metafile);ReleaseDC(IntPtr.Zero,dc);
			}
		}
	}
}
