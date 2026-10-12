// Public native DrawString: repeated glyph ink columns expose integer run advances independently of hinting.
using System; using System.Drawing; using System.Drawing.Imaging; using System.Drawing.Text;
using System.IO; using System.Text; using System.Globalization; using System.Runtime.InteropServices;
public static class DrawStringAdvanceProbe {
    [StructLayout(LayoutKind.Sequential)] struct Point { public float x,y; }
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int x,y,w,h; }
    [StructLayout(LayoutKind.Sequential)] struct Bits { public uint w,h; public int stride,format; public IntPtr scan; public UIntPtr reserved; }
    [DllImport("gdiplus.dll")] static extern int GdipCreateBitmapFromScan0(int w,int h,int stride,int format,IntPtr scan,out IntPtr image);
    [DllImport("gdiplus.dll")] static extern int GdipGetImageGraphicsContext(IntPtr image,out IntPtr graphics);
    [DllImport("gdiplus.dll")] static extern int GdipGraphicsClear(IntPtr graphics,int argb);
    [DllImport("gdiplus.dll")] static extern int GdipSetTextRenderingHint(IntPtr graphics,int hint);
    [DllImport("gdiplus.dll")] static extern int GdipSetTextContrast(IntPtr graphics,uint contrast);
    [DllImport("gdiplus.dll",CharSet=CharSet.Unicode)] static extern int GdipCreateFontFamilyFromName(string name,IntPtr collection,out IntPtr family);
    [DllImport("gdiplus.dll")] static extern int GdipCreateFont(IntPtr family,float size,int style,int unit,out IntPtr font);
    [DllImport("gdiplus.dll")] static extern int GdipCreateSolidFill(int argb,out IntPtr brush);
    [DllImport("gdiplus.dll",CharSet=CharSet.Unicode)] static extern int GdipDrawDriverString(IntPtr graphics,string text,int length,IntPtr font,IntPtr brush,Point[] positions,int flags,IntPtr matrix);
    [DllImport("gdiplus.dll")] static extern int GdipBitmapLockBits(IntPtr image,ref Rect rect,uint flags,int format,out Bits bits);
    [DllImport("gdiplus.dll")] static extern int GdipBitmapUnlockBits(IntPtr image,ref Bits bits);
    [DllImport("gdiplus.dll")] static extern int GdipDeleteGraphics(IntPtr graphics);
    [DllImport("gdiplus.dll")] static extern int GdipDeleteFont(IntPtr font);
    [DllImport("gdiplus.dll")] static extern int GdipDeleteFontFamily(IntPtr family);
    [DllImport("gdiplus.dll")] static extern int GdipDeleteBrush(IntPtr brush);
    [DllImport("gdiplus.dll")] static extern int GdipDisposeImage(IntPtr image);
    static void Check(int status){if(status!=0)throw new Exception("GDI+ status "+status);}
    static byte[] Driver(Font managed,string text,Point[] supplied=null) {
        IntPtr image,graphics,family,font,brush;
        Check(GdipCreateBitmapFromScan0(1500,80,0,0x26200a,IntPtr.Zero,out image));Check(GdipGetImageGraphicsContext(image,out graphics));
        Check(GdipCreateFontFamilyFromName(managed.Name,IntPtr.Zero,out family));Check(GdipCreateFont(family,managed.Size,0,2,out font));Check(GdipCreateSolidFill(unchecked((int)0xff000000),out brush));
        try{Check(GdipGraphicsClear(graphics,-1));Check(GdipSetTextRenderingHint(graphics,5));Check(GdipSetTextContrast(graphics,0));
            Check(GdipDrawDriverString(graphics,text,text.Length,font,brush,supplied??new[]{new Point{x=8,y=32}},supplied==null?5:1,IntPtr.Zero));
            var rect=new Rect{w=1500,h=80};Bits bits;Check(GdipBitmapLockBits(image,ref rect,1,0x26200a,out bits));
            var bytes=new byte[1500*80*4];try{for(int y=0;y<80;y++)Marshal.Copy(IntPtr.Add(bits.scan,y*bits.stride),bytes,y*1500*4,1500*4);}finally{Check(GdipBitmapUnlockBits(image,ref bits));}return bytes;
        }finally{GdipDeleteGraphics(graphics);GdipDeleteFont(font);GdipDeleteFontFamily(family);GdipDeleteBrush(brush);GdipDisposeImage(image);}
    }
    public static int Compare(string face,int size,bool typo,char code,int length,float[] advances) {
        using(var image=new Bitmap(1500,80,PixelFormat.Format32bppArgb))using(var font=new Font(face,size,FontStyle.Regular,GraphicsUnit.Pixel))using(var format=typo?StringFormat.GenericTypographic:new StringFormat()) {
            var text=new string(code,length);using(var graphics=Graphics.FromImage(image)){graphics.Clear(Color.White);graphics.TextRenderingHint=TextRenderingHint.ClearTypeGridFit;graphics.TextContrast=0;graphics.DrawString(text,font,Brushes.Black,new PointF(8,8),format);}
            var positions=new Point[length];float x=(float)Math.Round(8+(typo?0:size/6.0));float y=8+(float)Math.Ceiling(size*(double)font.FontFamily.GetCellAscent(FontStyle.Regular)/font.FontFamily.GetEmHeight(FontStyle.Regular));
            for(int i=0;i<length;i++){positions[i]=new Point{x=x,y=y};x+=advances[i];}
            var actual=Driver(font,text,positions);var native=Bytes(image);int different=0;for(int i=0;i<actual.Length;i+=4)if(actual[i]!=native[i]||actual[i+1]!=native[i+1]||actual[i+2]!=native[i+2])different++;return different;
        }
    }
    static byte[] Bytes(Bitmap bitmap) {
        var bits = bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.ReadOnly,bitmap.PixelFormat);
        var bytes=new byte[bitmap.Width*bitmap.Height*4];try{for(int y=0;y<bitmap.Height;y++)Marshal.Copy(IntPtr.Add(bits.Scan0,y*bits.Stride),bytes,y*bitmap.Width*4,bitmap.Width*4);}finally{bitmap.UnlockBits(bits);}return bytes;
    }
    public static void Run(string directory) {
        var json=new StringBuilder("[");
        foreach(string face in new[]{"Arial","Segoe UI","Tahoma","Times New Roman","Courier New"})
        foreach(int size in new[]{12,16,24})
        foreach(bool typo in new[]{false,true})
        foreach(char glyph in new[]{'I','H','n','x','0',' '})
        foreach(int length in new[]{1,2,3,5,8,16,24,40,60})
        foreach(bool driver in new[]{false,true})
        using(var source=new Bitmap(1500,80,PixelFormat.Format32bppArgb))
        using(var font=new Font(face,size,FontStyle.Regular,GraphicsUnit.Pixel))
        using(var format=typo?StringFormat.GenericTypographic:new StringFormat()) {
            var text=new string(glyph,length);float width;
            using(var graphics=Graphics.FromImage(source)) {
                graphics.Clear(Color.White);graphics.TextRenderingHint=TextRenderingHint.ClearTypeGridFit;graphics.TextContrast=0;
                graphics.DrawString(text,font,Brushes.Black,new PointF(8,8),format);
                width=graphics.MeasureString(text,font,new PointF(8,8),format).Width;
            }
            var bytes=driver?Driver(font,text):Bytes(source);var starts=new StringBuilder("[");var ends=new StringBuilder("[");var columns=new StringBuilder("[");bool ink=false;
            for(int x=0;x<1500;x++) {
                bool next=false;for(int y=0;y<80&&!next;y++){int i=(y*1500+x)*4;next=bytes[i]!=255||bytes[i+1]!=255||bytes[i+2]!=255;}
                if(next&&!ink){if(starts.Length>1)starts.Append(',');starts.Append(x);}
                if(!next&&ink){if(ends.Length>1)ends.Append(',');ends.Append(x);}
                ink=next;
                uint hash=2166136261;for(int y=0;y<80;y++){int i=(y*1500+x)*4;for(int ch=0;ch<3;ch++)hash=unchecked((hash^bytes[i+ch])*16777619);}
                if(columns.Length>1)columns.Append(',');columns.Append(hash);
            }
            if(json.Length>1)json.Append(',');
            json.Append("{\"face\":\"").Append(face).Append("\",\"size\":").Append(size)
                .Append(",\"typo\":").Append(typo?"true":"false").Append(",\"code\":").Append((int)glyph)
                .Append(",\"length\":").Append(length).Append(",\"width\":").Append(width.ToString("R",CultureInfo.InvariantCulture))
                .Append(",\"driver\":").Append(driver?"true":"false")
                .Append(",\"starts\":").Append(starts.Append(']')).Append(",\"ends\":").Append(ends.Append(']'))
                .Append(",\"columns\":").Append(columns.Append(']')).Append('}');
        }
        var data=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"text-drawstring-advances.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(data,0,data.Length);
    }
    public static void Mixed(string directory) {
        var json=new StringBuilder("[");
        foreach(string face in new[]{"Arial","Segoe UI","Tahoma","Times New Roman","Courier New"})
        foreach(int size in new[]{12,16,24})foreach(bool typo in new[]{false,true})
        foreach(string text in new[]{"GDI+ DrawString Ag 0123","H I n x 0","IIIHHHnnnxxx000","012301230123","AHnn AHnn AHnn"})
        using(var image=new Bitmap(600,80,PixelFormat.Format32bppArgb))
        using(var font=new Font(face,size,FontStyle.Regular,GraphicsUnit.Pixel))
        using(var format=typo?StringFormat.GenericTypographic:new StringFormat()) {
            using(var graphics=Graphics.FromImage(image)) {
                graphics.Clear(Color.White);graphics.TextRenderingHint=TextRenderingHint.ClearTypeGridFit;graphics.TextContrast=0;
                graphics.DrawString(text,font,Brushes.Black,new PointF(8,8),format);
            }
            var bytes=Bytes(image);for(int i=0;i<bytes.Length;i+=4){byte blue=bytes[i];bytes[i]=bytes[i+2];bytes[i+2]=blue;}
            if(json.Length>1)json.Append(',');json.Append("{\"face\":\"").Append(face).Append("\",\"size\":").Append(size)
                .Append(",\"typo\":").Append(typo?"true":"false").Append(",\"text\":\"").Append(text)
                .Append("\",\"rgba\":\"").Append(Convert.ToBase64String(bytes)).Append("\"}");
        }
        var data=Encoding.UTF8.GetBytes(json.Append(']').ToString());using(var file=File.Create(Path.Combine(directory,"text-drawstring-mixed.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(data,0,data.Length);
    }
}
