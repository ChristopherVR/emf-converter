// Public GDI GetGlyphOutline bitmaps (GGO_BITMAP and GGO_GRAY4_BITMAP) of the program-free glyphs of
// raster-polygons*.ttf and raster-bars.ttf (build-raster-fonts.py). A font of size 4 * s rendered monochrome is
// the 4x4 oversampling grid of the same font at size s, so these records expose the scan converter's dropout
// control sample by sample, with no coverage counting in the way. The raster-polygons-stN fonts carry a prep
// program (SCANCTRL 0x1ff, SCANTYPE N) so dropout control is on at every size.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class RasterMonoProbe
{
    [StructLayout(LayoutKind.Sequential)] struct Fixed { public ushort fract; public short value; }
    [StructLayout(LayoutKind.Sequential)] struct Mat { public Fixed xx, xy, yx, yy; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct Metrics { public uint blackX, blackY; public Point origin; public short incX, incY; }
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern int AddFontResourceEx(string file, uint flags, IntPtr reserved);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool RemoveFontResourceEx(string file, uint flags, IntPtr reserved);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateFont(int height, int width, int escape, int orientation, int weight, uint italic, uint underline, uint strike, uint charset, uint outprec, uint clipprec, uint quality, uint pitch, string face);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern int GetTextFace(IntPtr dc, int n, StringBuilder face);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern uint GetGlyphOutline(IntPtr dc, uint ch, uint format, out Metrics gm, uint len, byte[] buf, ref Mat mat);

    static int[] Range(int from, int to) { var l = new List<int>(); for (int i = from; i <= to; i++) l.Add(i); return l.ToArray(); }

    public static void Run(string dir)
    {
        using (var file = File.Create(Path.Combine(dir, "text-raster-mono.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress))
        using (var writer = new StreamWriter(zip, new UTF8Encoding(false)))
        {
            writer.Write("[");
            bool first = true;
            // Sizes either side of the 32 ppem default-dropout boundary and a spread of smaller and larger ones.
            int[] ppems = { 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 24, 28, 32, 33, 34, 36, 40 };
            first = Capture(writer, first, dir, "raster-polygons.ttf", "Parity Raster Polygons", 256, "polygons", ppems, ppems);
            first = Capture(writer, first, dir, "raster-bars.ttf", "Parity Raster Bars", 272, "bars", new[] { 128 }, new[] { 32 });
            foreach (int st in new[] { 0, 1, 4, 5 })
                first = Capture(writer, first, dir, "raster-polygons-st" + st + ".ttf", "Parity Raster Polygons ST" + st, 256, "st" + st, ppems, ppems);
            writer.Write("]");
        }
    }

    static bool Capture(StreamWriter writer, bool first, string dir, string fontFile, string family, int count, string tag, int[] monoPpems, int[] grayPpems)
    {
        string path = Path.Combine(dir, fontFile);
        if (AddFontResourceEx(path, 16, IntPtr.Zero) == 0) throw new Exception("Private font load failed: " + path);
        IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
        try {
            foreach (int format in new[] { 1, 5 })
            foreach (int ppem in format == 1 ? monoPpems : grayPpems) {
                IntPtr font = CreateFont(-ppem, 0, 0, 0, 400, 0, 0, 0, 1, 4, 0, format == 1 ? 3u : 4u, 0, family);
                IntPtr old = SelectObject(dc, font);
                try {
                    var face = new StringBuilder(100);
                    GetTextFace(dc, 100, face);
                    if (face.ToString() != family) throw new Exception("Font fallback: " + face);
                    for (uint glyph = 0; glyph < count; glyph++) {
                        var matrix = new Mat();
                        matrix.xx.value = matrix.yy.value = 1;
                        Metrics metrics;
                        uint length = GetGlyphOutline(dc, 0xE000 + glyph, (uint)format, out metrics, 0, null, ref matrix);
                        if (length == 0xFFFFFFFF) throw new Exception("GetGlyphOutline count failed");
                        var data = new byte[length];
                        if (length > 0 && GetGlyphOutline(dc, 0xE000 + glyph, (uint)format, out metrics, length, data, ref matrix) != length)
                            throw new Exception("GetGlyphOutline failed");
                        if (!first) writer.Write(',');
                        first = false;
                        writer.Write("{\"set\":\"" + tag + "\",\"ppem\":" + ppem + ",\"format\":" + format + ",\"index\":" + glyph +
                            ",\"x\":" + metrics.origin.x + ",\"y\":" + metrics.origin.y + ",\"w\":" + metrics.blackX + ",\"h\":" + metrics.blackY +
                            ",\"inc\":" + metrics.incX + ",\"data\":\"" + Convert.ToBase64String(data) + "\"}");
                    }
                } finally {
                    SelectObject(dc, old);
                    DeleteObject(font);
                }
            }
        } finally {
            DeleteDC(dc);
            RemoveFontResourceEx(path, 16, IntPtr.Zero);
        }
        return first;
    }
}
