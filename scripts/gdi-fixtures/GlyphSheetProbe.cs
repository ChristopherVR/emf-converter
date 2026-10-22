// Native GGO_BITMAP and GGO_NATIVE of the characters of a string at the given faces and heights (the record format of
// MonoSheetGlyphProbe, for faces and sizes that probe does not cover, for example "Microsoft Sans Serif" behind MS Shell Dlg).
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class GlyphSheetProbe {
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

    
    /** One capture per face, signed height and character: GGO_BITMAP and GGO_NATIVE at NONANTIALIASED_QUALITY. */
    public static void Run(string path, string[] families, int[] sizes, int weight, int italic, string chars) {
        using (var file=File.Create(path))
        using (var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))
        using (var writer=new StreamWriter(zip,new UTF8Encoding(false))) {
            writer.Write('['); bool first=true;
            foreach (string family in families) {
                IntPtr dc=CreateCompatibleDC(IntPtr.Zero);
                try { foreach (int h in sizes) Capture(dc, writer, ref first, family, h, weight, italic, 0, chars); }
                finally { DeleteDC(dc); }
            }
            writer.Write(']');
        }
    }

    static void Capture(IntPtr dc, StreamWriter writer, ref bool first, string family, int height, int weight, int italic, int width, string text) {
        IntPtr font=CreateFont(height,width,0,0,weight,(uint)italic,0,0,1,0,0,3,0,family),old=SelectObject(dc,font);
        try {
            var face=new StringBuilder(100); GetTextFace(dc,100,face);
            if(face.ToString()!=family) throw new Exception("Font fallback: "+face);
            var seen=new System.Collections.Generic.HashSet<char>();
            foreach (char code in text) {
                if(!seen.Add(code))continue;
                var matrix=new Matrix();matrix.xx.value=matrix.yy.value=1;Metrics metrics;
                uint length=GetGlyphOutline(dc,code,1,out metrics,0,null,ref matrix);
                if(length==uint.MaxValue)throw new Exception("GetGlyphOutline failed");
                var data=new byte[length];
                if(length>0&&GetGlyphOutline(dc,code,1,out metrics,length,data,ref matrix)!=length)throw new Exception("Bitmap capture failed");
                // GGO_NATIVE: the hinted outline the bitmap is scan converted from.
                Metrics nm;
                uint nlen=GetGlyphOutline(dc,code,2,out nm,0,null,ref matrix);
                var ndata=new byte[nlen==uint.MaxValue?0:nlen];
                if(ndata.Length>0&&GetGlyphOutline(dc,code,2,out nm,nlen,ndata,ref matrix)!=nlen)throw new Exception("Outline capture failed");
                if(!first)writer.Write(',');first=false;
                writer.Write("{\"face\":\""+family+"\",\"height\":"+height+",\"width\":"+width+",\"weight\":"+weight+",\"italic\":"+(italic!=0?"true":"false")+",\"code\":"+(int)code+",\"x\":"+metrics.origin.x+",\"y\":"+metrics.origin.y+",\"w\":"+metrics.width+",\"h\":"+metrics.height+",\"adv\":"+metrics.advanceX+",\"data\":\""+Convert.ToBase64String(data)+"\",\"outline\":\""+Convert.ToBase64String(ndata)+"\"}");
            }
        } finally { SelectObject(dc,old); DeleteObject(font); }
    }
}
