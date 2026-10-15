// GGO_NATIVE and GGO_BITMAP of private "instruction prefix" fonts built by
// build-hint-prefix-font.py: variant k is native's grid-fitted state after the first k
// instructions of one glyph program. Output: JSON array of
// {"size":ppem,"variant":k,"native":base64,"bitmap":base64,"x","y","w","h"}.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class PrefixHintProbe {
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

    static byte[] Get(IntPtr dc, uint ch, uint format, out Metrics gm) {
        var mat = new Mat(); mat.xx.value = mat.yy.value = 1;
        uint length = GetGlyphOutline(dc, ch, format, out gm, 0, null, ref mat);
        if (length == 0xFFFFFFFF) return null;
        var data = new byte[length];
        if (length > 0 && GetGlyphOutline(dc, ch, format, out gm, length, data, ref mat) != length) throw new Exception("GetGlyphOutline failed");
        return data;
    }

    /** quality 3 = NONANTIALIASED_QUALITY, 4 = ANTIALIASED; sizes are signed lfHeight values. */
    public static void Run(string fontFile, string family, int[] sizes, int[] widths, int glyphs, uint quality, string output) {
        if (AddFontResourceEx(fontFile, 16, IntPtr.Zero) == 0) throw new Exception("Private font load failed");
        IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
        var json = new StringBuilder("[");
        try {
            for (int si = 0; si < sizes.Length; si++) {
                int size = sizes[si], width = widths[si];
                IntPtr font = CreateFont(size, width, 0, 0, 400, 0, 0, 0, 1, 0, 0, quality, 0, family);
                IntPtr old = SelectObject(dc, font);
                try {
                    var face = new StringBuilder(100); GetTextFace(dc, 100, face);
                    if (face.ToString() != family) throw new Exception("Font fallback: " + face);
                    for (int j = 0; j < glyphs; j++) for (int k = 0; k < 256; k++) {
                        Metrics nm, bm;
                        byte[] outline = Get(dc, (uint)(0xE000 + 256 * j + k), 2, out nm);
                        byte[] bitmap = Get(dc, (uint)(0xE000 + 256 * j + k), 1, out bm);
                        if (outline == null || bitmap == null) continue;
                        if (json.Length > 1) json.Append(',');
                        json.Append("{\"size\":").Append(size).Append(",\"width\":").Append(width).Append(",\"glyph\":").Append(j).Append(",\"variant\":").Append(k)
                            .Append(",\"native\":\"").Append(Convert.ToBase64String(outline))
                            .Append("\",\"bitmap\":\"").Append(Convert.ToBase64String(bitmap))
                            .Append("\",\"x\":").Append(bm.origin.x).Append(",\"y\":").Append(bm.origin.y)
                            .Append(",\"w\":").Append(bm.blackX).Append(",\"h\":").Append(bm.blackY).Append("}");
                    }
                } finally { SelectObject(dc, old); DeleteObject(font); }
            }
        } finally { DeleteDC(dc); RemoveFontResourceEx(fontFile, 16, IntPtr.Zero); }
        byte[] bytes = Encoding.UTF8.GetBytes(json.Append(']').ToString());
        using (var file = File.Create(output))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress))
            zip.Write(bytes, 0, bytes.Length);
    }
}
