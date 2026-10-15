// Native GGO_BITMAP of every glyph the textx-*-mono size and style sheets draw
// (TxSizeSheet / TxStyleSheet in GdiFixtures.cs), one capture per face, signed
// height, weight, italic, lfWidth and character. Used to classify the residuals of
// those sheets as raster (glyph image) or placement (advance, origin).
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class MonoSheetGlyphProbe {
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

    const string Sample = "Hamburgefonstiv 0123 AVWX &@%$";
    const string Styled = "Styled text: Quick fox jumps 0123";

    public static void Run(string directory, string name) {
        int[] sizes = { -8, -9, -10, -11, -12, -13, -14, -15, -16, -18, -20, -22, -24, -28, -32, -36, -48, -72, 9, 10, 12, 14, 16, 18, 20, 23, 26, 30, 36, 44, 56 };
        int[][] v = {
            new[] { 400, 0, 0 }, new[] { 700, 0, 0 }, new[] { 400, 1, 0 }, new[] { 700, 1, 0 }, new[] { 900, 0, 0 },
            new[] { 300, 0, 0 }, new[] { 600, 0, 0 }, new[] { 100, 0, 0 }, new[] { 400, 0, 4 }, new[] { 400, 0, 12 },
        };
        using (var file=File.Create(Path.Combine(directory,name)))
        using (var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))
        using (var writer=new StreamWriter(zip,new UTF8Encoding(false))) {
            writer.Write('['); bool first=true;
            foreach (string family in new[] {"Arial","Times New Roman","Courier New","Segoe UI","Tahoma"}) {
                IntPtr dc=CreateCompatibleDC(IntPtr.Zero);
                try {
                    foreach (int h in sizes) Capture(dc, writer, ref first, family, h, 400, 0, 0, Sample);
                    foreach (int h in new[] { -11, -17 }) foreach (int[] s in v) {
                        int w = s[2] == 0 ? 0 : (h < -12 ? s[2] + 3 : s[2]);
                        Capture(dc, writer, ref first, family, h, s[0], s[1], w, Styled);
                    }
                } finally { DeleteDC(dc); }
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
