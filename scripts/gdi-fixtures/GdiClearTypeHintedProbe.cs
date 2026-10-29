// Native GDI ExtTextOut ClearType (natural quality) of the program-free private fonts cleartype-hinted-*.ttf
// (build-cleartype-hinted-fonts.py): their glyphs are the grid-fitted outlines our interpreter produces for the glyphs of
// gdi-cleartype-compat.json.gz, so nothing is grid-fitted and the capture isolates the scan converter and the ClearType
// filter. Each glyph is drawn black on white at 32 ppem (one font unit is one 26.6 unit), baseline at (8, 40) of a 56 x 64
// canvas, the layout of the compat captures. Writes gdi-cleartype-hinted.json.gz: [{font, glyph, rgb}].
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class GdiClearTypeHintedProbe
{
    [StructLayout(LayoutKind.Sequential)] struct BITMAPINFOHEADER { public int size, width, height; public short planes, bitCount; public int compression, sizeImage, xppm, yppm, clrUsed, clrImportant; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct LOGFONT { public int h, w, esc, orient, weight; public byte italic, underline, strike, charset, outPrec, clipPrec, quality, pitch; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string face; }
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFOHEADER bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern uint SetTextColor(IntPtr dc, uint c);
    [DllImport("gdi32.dll")] static extern int SetBkMode(IntPtr dc, int m);
    [DllImport("gdi32.dll")] static extern uint SetTextAlign(IntPtr dc, uint a);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateFontIndirectW(ref LOGFONT lf);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool ExtTextOutW(IntPtr dc, int x, int y, uint opts, IntPtr rect, string s, uint n, int[] dx);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern int AddFontResourceExW(string file, uint flags, IntPtr reserved);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool RemoveFontResourceExW(string file, uint flags, IntPtr reserved);
    [DllImport("gdi32.dll")] static extern bool GdiFlush();

    public static void Run(string dir)
    {
        Directory.CreateDirectory(dir);
        string index = File.ReadAllText(Path.Combine(dir, "cleartype-hinted-index.json"));
        var json = new StringBuilder("{\"width\":56,\"height\":64,\"ppem\":32,\"baselineX\":8,\"baselineY\":40,\"quality\":6,\"captures\":[");
        bool first = true;
        // The index maps "S<mode> <smooth|plain>" to its glyph list; the glyph count is the number of [ ... ] triples.
        foreach (string file in Directory.GetFiles(dir, "cleartype-hinted-s*.ttf")) {
            string stem = Path.GetFileNameWithoutExtension(file).Substring("cleartype-hinted-".Length); // s1-smooth
            string[] parts = stem.Split('-');
            string key = "S" + parts[0].Substring(1) + " " + parts[1];
            string face = "Parity CT Hinted " + key;
            int at = index.IndexOf("\"" + key + "\":[");
            int end = index.IndexOf("]]", at);
            int count = 0;
            for (int p = at; p < end; p++) if (index[p] == '[') count++;
            count--; // the list's own bracket
            string fontFile = Path.GetFullPath(file);
            if (AddFontResourceExW(fontFile, 0x10, IntPtr.Zero) == 0) throw new Exception("AddFontResourceEx failed: " + file);
            try {
                int w = 56, h = 64;
                for (int i = 0; i < count; i++) {
                    var bmi = new BITMAPINFOHEADER { size = 40, width = w, height = -h, planes = 1, bitCount = 32 };
                    IntPtr bits; IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
                    IntPtr bmp = CreateDIBSection(dc, ref bmi, 0, out bits, IntPtr.Zero, 0);
                    IntPtr oldBmp = SelectObject(dc, bmp);
                    var white = new byte[w * h * 4]; for (int k = 0; k < white.Length; k++) white[k] = 255; Marshal.Copy(white, 0, bits, white.Length);
                    var lf = new LOGFONT { h = -32, weight = 400, charset = 1, quality = 6, face = face };
                    IntPtr font = CreateFontIndirectW(ref lf); IntPtr oldFont = SelectObject(dc, font);
                    SetBkMode(dc, 1); SetTextColor(dc, 0); SetTextAlign(dc, 24);
                    ExtTextOutW(dc, 8, 40, 0, IntPtr.Zero, ((char)(0xE000 + i)).ToString(), 1, null);
                    GdiFlush();
                    var bgra = new byte[w * h * 4]; Marshal.Copy(bits, bgra, 0, bgra.Length);
                    var rgb = new byte[w * h * 3];
                    for (int p = 0; p < w * h; p++) { rgb[p * 3] = bgra[p * 4 + 2]; rgb[p * 3 + 1] = bgra[p * 4 + 1]; rgb[p * 3 + 2] = bgra[p * 4]; }
                    SelectObject(dc, oldFont); DeleteObject(font); SelectObject(dc, oldBmp); DeleteObject(bmp); DeleteDC(dc);
                    if (!first) json.Append(','); first = false;
                    json.Append("{\"font\":\"").Append(key).Append("\",\"glyph\":").Append(i).Append(",\"rgb\":\"").Append(Convert.ToBase64String(rgb)).Append("\"}");
                }
            } finally { RemoveFontResourceExW(fontFile, 0x10, IntPtr.Zero); }
        }
        json.Append("]}");
        var data = Encoding.UTF8.GetBytes(json.ToString());
        using (var file = File.Create(Path.Combine(dir, "gdi-cleartype-hinted.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(data, 0, data.Length);
    }
}
