// GetGlyphOutline(GGO_METRICS) advance (gmCellIncX) of every instruction-prefix variant of the fonts built by
// build-hint-prefix-font.py: variant k of glyph j (character U+E000 + 256 * j + k) is native's state after the first k
// instructions of that glyph program, so the advance as a function of k shows which instruction moves the advance phantom
// point. Output: JSON array of {"size":h,"glyph":j,"variant":k,"adv":w}.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class PrefixAdvanceProbe {
    [StructLayout(LayoutKind.Sequential)] struct Fixed { public ushort fract; public short value; }
    [StructLayout(LayoutKind.Sequential)] struct Mat { public Fixed xx, xy, yx, yy; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct Metrics { public uint blackX, blackY; public Point origin; public short incX, incY; }
    [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] static extern int AddFontResourceEx(string file, uint flags, IntPtr reserved);
    [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] static extern bool RemoveFontResourceEx(string file, uint flags, IntPtr reserved);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateFont(int height, int width, int esc, int orient, int weight, uint italic, uint underline, uint strike, uint charset, uint outprec, uint clipprec, uint quality, uint pitch, string face);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
    [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] static extern int GetTextFace(IntPtr dc, int n, StringBuilder face);
    [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] static extern uint GetGlyphOutline(IntPtr dc, uint ch, uint format, out Metrics gm, uint len, byte[] buf, ref Mat mat);

    public static void Run(string fontFile, string family, int[] sizes, int glyphs, string output) {
        if (AddFontResourceEx(fontFile, 16, IntPtr.Zero) == 0) throw new Exception("Private font load failed");
        IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
        var json = new StringBuilder("[");
        try {
            foreach (int size in sizes) {
                IntPtr font = CreateFont(size, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 3, 0, family);
                IntPtr old = SelectObject(dc, font);
                try {
                    var face = new StringBuilder(100); GetTextFace(dc, 100, face);
                    if (face.ToString() != family) throw new Exception("Font fallback: " + face);
                    for (int j = 0; j < glyphs; j++) for (int k = 0; k < 256; k++) {
                        Metrics gm; var mat = new Mat(); mat.xx.value = mat.yy.value = 1;
                        uint length = GetGlyphOutline(dc, (uint)(0xE000 + 256 * j + k), 0, out gm, 0, null, ref mat);
                        if (length == 0xFFFFFFFF) continue;
                        if (json.Length > 1) json.Append(',');
                        json.Append("{\"size\":").Append(size).Append(",\"glyph\":").Append(j).Append(",\"variant\":").Append(k).Append(",\"adv\":").Append(gm.incX).Append("}");
                    }
                } finally { SelectObject(dc, old); DeleteObject(font); }
            }
        } finally { DeleteDC(dc); RemoveFontResourceEx(fontFile, 16, IntPtr.Zero); }
        File.WriteAllText(output, json.Append(']').ToString());
    }
}
