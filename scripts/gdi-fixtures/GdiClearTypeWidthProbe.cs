// Native GDI ExtTextOut captures of the private compatible-width fonts (build-cleartype-width-fonts.py, sets listed in
// ctw-sets.json): every glyph of every font at U+E000 + index, per size and LOGFONT quality (5 = default ClearType with the
// black-and-white advance widths, 6 = CLEARTYPE_NATURAL_QUALITY). Each glyph is drawn black on white with its origin at
// (8, 48) of a 48 x 64 canvas and cropped to its ink (base64 RGB, the seven ClearType levels), beside GetCharWidth32. The
// two qualities differ only in the width mode, so the difference between them is what the mode does to the glyph program.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class GdiClearTypeWidthProbe
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
    [DllImport("gdi32.dll")] static extern bool GetCharWidth32W(IntPtr dc, uint first, uint last, int[] buffer);
    [DllImport("gdi32.dll")] static extern bool GdiFlush();

    const int W = 48, H = 64;

    /// <summary>Captures every set: parallel arrays of set names, font files, families and glyph counts.</summary>
    public static void Run(string dir, string outName, string[] sets, string[] files, string[] families, int[] counts, int[] sizes, int[] qualities)
    {
        Directory.CreateDirectory(dir);
        var json = new StringBuilder("[");
        bool first = true;
        for (int s = 0; s < sets.Length; s++) {
            string path = Path.GetFullPath(Path.Combine(dir, files[s]));
            if (AddFontResourceExW(path, 0x10, IntPtr.Zero) == 0) throw new Exception("AddFontResourceEx failed for " + path);
            try {
                foreach (int size in sizes) foreach (int quality in qualities) {
                    var bmi = new BITMAPINFOHEADER { size = 40, width = W, height = -H, planes = 1, bitCount = 32 };
                    IntPtr bits; IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
                    IntPtr bmp = CreateDIBSection(dc, ref bmi, 0, out bits, IntPtr.Zero, 0);
                    IntPtr oldBmp = SelectObject(dc, bmp);
                    var lf = new LOGFONT { h = -size, weight = 400, charset = 1, quality = (byte)quality, face = families[s] };
                    IntPtr font = CreateFontIndirectW(ref lf); IntPtr oldFont = SelectObject(dc, font);
                    SetBkMode(dc, 1); SetTextColor(dc, 0); SetTextAlign(dc, 24);
                    for (int i = 0; i < counts[s]; i++) {
                        var white = new byte[W * H * 4]; for (int k = 0; k < white.Length; k++) white[k] = 255; Marshal.Copy(white, 0, bits, white.Length);
                        ExtTextOutW(dc, 8, 48, 0, IntPtr.Zero, ((char)(0xE000 + i)).ToString(), 1, null);
                        GdiFlush();
                        var bgra = new byte[W * H * 4]; Marshal.Copy(bits, bgra, 0, bgra.Length);
                        int x0 = W, y0 = H, x1 = -1, y1 = -1;
                        for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) { int o = (y * W + x) * 4; if (bgra[o] != 255 || bgra[o + 1] != 255 || bgra[o + 2] != 255) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
                        int cw = Math.Max(0, x1 - x0 + 1), ch = Math.Max(0, y1 - y0 + 1);
                        var rgb = new byte[cw * ch * 3];
                        for (int y = 0; y < ch; y++) for (int x = 0; x < cw; x++) { int o = ((y0 + y) * W + x0 + x) * 4; int p = (y * cw + x) * 3; rgb[p] = bgra[o + 2]; rgb[p + 1] = bgra[o + 1]; rgb[p + 2] = bgra[o]; }
                        var width = new int[1]; GetCharWidth32W(dc, (uint)(0xE000 + i), (uint)(0xE000 + i), width);
                        if (!first) json.Append(','); first = false;
                        json.Append("{\"set\":\"").Append(sets[s]).Append("\",\"size\":").Append(size).Append(",\"quality\":").Append(quality).Append(",\"index\":").Append(i).Append(",\"width\":").Append(width[0])
                            .Append(",\"x\":").Append(x0).Append(",\"y\":").Append(y0).Append(",\"w\":").Append(cw).Append(",\"h\":").Append(ch).Append(",\"rgb\":\"").Append(Convert.ToBase64String(rgb)).Append("\"}");
                    }
                    SelectObject(dc, oldFont); DeleteObject(font); SelectObject(dc, oldBmp); DeleteObject(bmp); DeleteDC(dc);
                }
            } finally { RemoveFontResourceExW(path, 0x10, IntPtr.Zero); }
        }
        json.Append(']');
        var data = Encoding.UTF8.GetBytes(json.ToString());
        using (var file = File.Create(Path.Combine(dir, outName)))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(data, 0, data.Length);
    }
}
