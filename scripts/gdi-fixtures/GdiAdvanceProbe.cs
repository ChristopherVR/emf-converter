// Native GDI integer advance of every character U+0020..U+00FF of five faces at every em height -6..-128 and every cell
// height 6..96, through GetCharWidth32 and GetGlyphOutline(GGO_METRICS): the width an EMF records as Dx and a WMF replays
// without. Compact output: one record per face and signed height, "adv" lists the GetCharWidth32 values for the characters
// in order, "ggo" the gmCellIncX of GGO_METRICS (they must agree).
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class GdiAdvanceProbe {
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
    [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] static extern bool GetCharWidth32W(IntPtr dc, uint first, uint last, int[] widths);

    public static void Run(string path, int weight, int italic) {
        using (var file=File.Create(path))
        using (var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))
        using (var writer=new StreamWriter(zip,new UTF8Encoding(false))) {
            writer.Write('['); bool first=true;
            foreach (string family in new[] {"Arial","Times New Roman","Courier New","Segoe UI","Tahoma"}) {
                IntPtr dc=CreateCompatibleDC(IntPtr.Zero);
                try {
                    for (int k = 0; k < 2; k++) {
                        for (int n = k == 0 ? 6 : 6; n <= (k == 0 ? 128 : 96); n++) {
                            int height = k == 0 ? -n : n;
                            IntPtr font=CreateFont(height,0,0,0,weight,(uint)italic,0,0,1,0,0,3,0,family),old=SelectObject(dc,font);
                            try {
                                var face=new StringBuilder(100); GetTextFace(dc,100,face);
                                if(face.ToString()!=family) throw new Exception("Font fallback: "+face);
                                var widths=new int[0xE0];
                                if(!GetCharWidth32W(dc,0x20,0xFF,widths)) throw new Exception("GetCharWidth32 failed");
                                var ggo=new int[0xE0];
                                for (uint c = 0x20; c <= 0xFF; c++) {
                                    var matrix=new Matrix();matrix.xx.value=matrix.yy.value=1;Metrics m;
                                    uint r=GetGlyphOutline(dc,c,0,out m,0,null,ref matrix);
                                    ggo[c-0x20]= r==uint.MaxValue ? -1 : m.advanceX;
                                }
                                if(!first)writer.Write(',');first=false;
                                writer.Write("{\"face\":\""+family+"\",\"height\":"+height+",\"weight\":"+weight+",\"italic\":"+(italic!=0?"true":"false")+",\"adv\":["+string.Join(",",widths)+"],\"ggo\":["+string.Join(",",ggo)+"]}");
                            } finally { SelectObject(dc,old); DeleteObject(font); }
                        }
                    }
                } finally { DeleteDC(dc); }
            }
            writer.Write(']');
        }
    }
}
