// Independent native monochrome stub controls: build-mono-stub-fonts.py.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class MonoStubProbe {
    [StructLayout(LayoutKind.Sequential)] struct Fixed { public ushort fraction; public short value; }
    [StructLayout(LayoutKind.Sequential)] struct Matrix { public Fixed xx, xy, yx, yy; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct Metrics { public uint width, height; public Point origin; public short advanceX, advanceY; }
    [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] static extern int AddFontResourceEx(string file, uint flags, IntPtr reserved);
    [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] static extern bool RemoveFontResourceEx(string file, uint flags, IntPtr reserved);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateFont(int height, int width, int escapement, int orientation, int weight, uint italic, uint underline, uint strikeout, uint charset, uint outPrecision, uint clipPrecision, uint quality, uint pitch, string face);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] static extern int GetTextFace(IntPtr dc, int count, StringBuilder face);
    [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] static extern uint GetGlyphOutline(IntPtr dc, uint code, uint format, out Metrics metrics, uint length, byte[] buffer, ref Matrix matrix);

    public static void Run(string directory) {
        Run(directory, "mono-stub", "mono-stubs.json.gz");
    }

    public static void Run(string directory, string prefix, string output) {
        Run(directory, prefix, output, 512, new[] {8,12,16,20,24,32,40});
    }

    public static void Run(string directory, string prefix, string output, int count, int[] sizes) {
        using (var file=File.Create(Path.Combine(directory,output)))
        using (var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))
        using (var writer=new StreamWriter(zip,new UTF8Encoding(false))) {
            writer.Write('['); bool first=true;
            foreach (int mode in new[] {1,5}) {
                string path=Path.Combine(directory,prefix+"-st"+mode+".ttf"), family="Parity Mono Stub ST"+mode;
                if (AddFontResourceEx(path,16,IntPtr.Zero)==0) throw new Exception("Private font load failed");
                IntPtr dc=CreateCompatibleDC(IntPtr.Zero);
                try {
                    foreach (int ppem in sizes) {
                        IntPtr font=CreateFont(-ppem,0,0,0,400,0,0,0,1,4,0,3,0,family),old=SelectObject(dc,font);
                        try {
                            var face=new StringBuilder(100); GetTextFace(dc,100,face);
                            if(face.ToString()!=family) throw new Exception("Font fallback: "+face);
                            for (uint index=0;index<count;index++) {
                                var matrix=new Matrix();matrix.xx.value=matrix.yy.value=1;Metrics metrics;
                                uint length=GetGlyphOutline(dc,0xE000+index,1,out metrics,0,null,ref matrix);
                                if(length==uint.MaxValue)throw new Exception("GetGlyphOutline failed");
                                var data=new byte[length];
                                if(length>0 && GetGlyphOutline(dc,0xE000+index,1,out metrics,length,data,ref matrix)!=length)throw new Exception("Bitmap capture failed");
                                if(!first)writer.Write(',');first=false;
                                writer.Write("{\"mode\":"+mode+",\"ppem\":"+ppem+",\"index\":"+index+",\"x\":"+metrics.origin.x+",\"y\":"+metrics.origin.y+",\"w\":"+metrics.width+",\"h\":"+metrics.height+",\"data\":\""+Convert.ToBase64String(data)+"\"}");
                            }
                        } finally {SelectObject(dc,old);DeleteObject(font);}
                    }
                } finally {DeleteDC(dc);RemoveFontResourceEx(path,16,IntPtr.Zero);}
            }
            writer.Write(']');
        }
    }
}
