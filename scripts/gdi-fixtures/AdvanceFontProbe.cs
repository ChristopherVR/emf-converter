// Native integer advance of the program-free private fonts of build-advance-fonts.py: glyph U+E000 + i has the design
// advance i (2048 units per em). For every em height -6..-200 records GetCharWidth32 of all 2047 glyphs, which isolates
// the rounding of a scaled advance from any hinting. Output: {"height": h, "adv": [w(1) .. w(2047)]} records.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class AdvanceFontProbe {
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateFont(int height, int width, int escapement, int orientation, int weight, uint italic, uint underline, uint strikeout, uint charset, uint outPrecision, uint clipPrecision, uint quality, uint pitch, string face);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] static extern int GetTextFace(IntPtr dc, int count, StringBuilder face);
    [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] static extern bool GetCharWidth32W(IntPtr dc, uint first, uint last, int[] widths);
    [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] static extern int AddFontResourceEx(string file, uint flags, IntPtr reserved);
    [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] static extern bool RemoveFontResourceEx(string file, uint flags, IntPtr reserved);

    public static void Run(string fontFile, string family, string outPath, int fromSize, int toSize) {
        if (AddFontResourceEx(fontFile, 16, IntPtr.Zero) == 0) throw new Exception("Private font load failed");
        try {
            using (var file=File.Create(outPath))
            using (var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))
            using (var writer=new StreamWriter(zip,new UTF8Encoding(false))) {
                writer.Write('['); bool first=true;
                IntPtr dc=CreateCompatibleDC(IntPtr.Zero);
                try {
                    for (int n = fromSize; n <= toSize; n++) {
                        IntPtr font=CreateFont(-n,0,0,0,400,0,0,0,1,0,0,3,0,family),old=SelectObject(dc,font);
                        try {
                            var face=new StringBuilder(100); GetTextFace(dc,100,face);
                            if(face.ToString()!=family) throw new Exception("Font fallback: "+face);
                            var widths=new int[2047];
                            if(!GetCharWidth32W(dc,0xE001,0xE7FF,widths)) throw new Exception("GetCharWidth32 failed");
                            if(!first)writer.Write(',');first=false;
                            writer.Write("{\"height\":"+(-n)+",\"adv\":["+string.Join(",",widths)+"]}");
                        } finally { SelectObject(dc,old); DeleteObject(font); }
                    }
                } finally { DeleteDC(dc); }
                writer.Write(']');
            }
        } finally { RemoveFontResourceEx(fontFile, 16, IntPtr.Zero); }
    }
}
