// Native uniform and stretched monochrome controls, including the Tahoma
// x affected by 26.6 smart-crossing refinement at height 11, width 4.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class MonoCondensedProbe {
    [StructLayout(LayoutKind.Sequential)] struct Fixed { public ushort fraction; public short value; }
    [StructLayout(LayoutKind.Sequential)] struct Matrix { public Fixed xx, xy, yx, yy; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct Metrics { public uint width, height; public Point origin; public short advanceX, advanceY; }
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateFont(int height, int width, int escapement, int orientation, int weight, uint italic, uint underline, uint strikeout, uint charset, uint outPrecision, uint clipPrecision, uint quality, uint pitch, string face);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] static extern int GetTextFace(IntPtr dc, int count, StringBuilder face);
    [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] static extern uint GetGlyphOutline(IntPtr dc, uint code, uint format, out Metrics metrics, uint length, byte[] buffer, ref Matrix matrix);

    public static void Run(string directory) {
        using (var file=File.Create(Path.Combine(directory,"mono-condensed.json.gz")))
        using (var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))
        using (var writer=new StreamWriter(zip,new UTF8Encoding(false))) {
            writer.Write('['); bool first=true;
            foreach (string family in new[] {"Tahoma","Arial","Segoe UI","Times New Roman","Courier New"}) {
                IntPtr dc=CreateCompatibleDC(IntPtr.Zero);
                try {
                    foreach (int ppem in new[] {11,17})
                    foreach (int width in ppem==11?new[] {0,4,12}:new[] {0,7,15})
                    foreach (int weight in new[] {400,700})
                    foreach (bool italic in new[] {false,true}) {
                        IntPtr font=CreateFont(-ppem,width,0,0,weight,italic?1u:0u,0,0,1,4,0,3,0,family),old=SelectObject(dc,font);
                        try {
                            var face=new StringBuilder(100); GetTextFace(dc,100,face);
                            if(face.ToString()!=family) throw new Exception("Font fallback: "+face);
                            foreach (char code in "xXvWNAZ7<>") {
                                var matrix=new Matrix();matrix.xx.value=matrix.yy.value=1;Metrics metrics;
                                uint length=GetGlyphOutline(dc,code,1,out metrics,0,null,ref matrix);
                                if(length==uint.MaxValue)throw new Exception("GetGlyphOutline failed");
                                var data=new byte[length];
                                if(length>0&&GetGlyphOutline(dc,code,1,out metrics,length,data,ref matrix)!=length)throw new Exception("Bitmap capture failed");
                                if(!first)writer.Write(',');first=false;
                                writer.Write("{\"face\":\""+family+"\",\"ppem\":"+ppem+",\"width\":"+width+",\"weight\":"+weight+",\"italic\":"+(italic?"true":"false")+",\"code\":"+(int)code+",\"x\":"+metrics.origin.x+",\"y\":"+metrics.origin.y+",\"w\":"+metrics.width+",\"h\":"+metrics.height+",\"data\":\""+Convert.ToBase64String(data)+"\"}");
                            }
                        }finally{SelectObject(dc,old);DeleteObject(font);}
                    }
                }finally{DeleteDC(dc);}
            }
            writer.Write(']');
        }
    }
}
