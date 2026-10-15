// Native GDI ExtTextOut ClearType glyph by glyph under the three width modes: default/ClearType quality (5, backward-
// compatible "bi-level" widths), ClearType natural quality (6) and ANTIALIASED quality (4), with GetCharWidth32 and
// GetCharABCWidths of each, for Arial, Segoe UI and Tahoma at 9 to 24 px. Each glyph is drawn black on white with the
// baseline at (8, 40) of a 56 x 64 canvas, cropped to its ink (as base64 RGB), beside the widths.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class GdiClearTypeCompatProbe
{
    [StructLayout(LayoutKind.Sequential)] struct BITMAPINFOHEADER { public int size, width, height; public short planes, bitCount; public int compression, sizeImage, xppm, yppm, clrUsed, clrImportant; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct LOGFONT { public int h, w, esc, orient, weight; public byte italic, underline, strike, charset, outPrec, clipPrec, quality, pitch; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string face; }
    [StructLayout(LayoutKind.Sequential)] struct ABC { public int a; public uint b; public int c; }
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
    [DllImport("gdi32.dll")] static extern bool GetCharWidth32W(IntPtr dc, uint first, uint last, int[] buffer);
    [DllImport("gdi32.dll")] static extern bool GetCharABCWidthsW(IntPtr dc, uint first, uint last, [Out] ABC[] abc);
    [DllImport("gdi32.dll")] static extern bool GdiFlush();

    public static void Run(string dir)
    {
        Directory.CreateDirectory(dir);
        string[] faces = { "Arial", "Segoe UI", "Tahoma" };
        int[] qualities = { 5, 6, 4 };
        string chars = "HmgnaoeiltrsuvbfxyAVWX0123@&%$";
        var json = new StringBuilder("[");
        bool first = true;
        int w = 56, h = 64;
        foreach (string face in faces) foreach (int size in new[] { 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 24 }) foreach (int quality in qualities) {
            var bmi = new BITMAPINFOHEADER { size = 40, width = w, height = -h, planes = 1, bitCount = 32 };
            IntPtr bits; IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
            IntPtr bmp = CreateDIBSection(dc, ref bmi, 0, out bits, IntPtr.Zero, 0);
            IntPtr oldBmp = SelectObject(dc, bmp);
            var lf = new LOGFONT { h = -size, weight = 400, charset = 1, quality = (byte)quality, face = face };
            IntPtr font = CreateFontIndirectW(ref lf); IntPtr oldFont = SelectObject(dc, font);
            SetBkMode(dc, 1); SetTextColor(dc, 0); SetTextAlign(dc, 24);
            foreach (char ch in chars) {
                var white = new byte[w * h * 4]; for (int k = 0; k < white.Length; k++) white[k] = 255; Marshal.Copy(white, 0, bits, white.Length);
                ExtTextOutW(dc, 8, 40, 0, IntPtr.Zero, ch.ToString(), 1, null);
                GdiFlush();
                var bgra = new byte[w * h * 4]; Marshal.Copy(bits, bgra, 0, bgra.Length);
                int x0 = w, y0 = h, x1 = -1, y1 = -1;
                for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) { int o = (y * w + x) * 4; if (bgra[o] != 255 || bgra[o + 1] != 255 || bgra[o + 2] != 255) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
                int cw = Math.Max(0, x1 - x0 + 1), chh = Math.Max(0, y1 - y0 + 1);
                var rgb = new byte[cw * chh * 3];
                for (int y = 0; y < chh; y++) for (int x = 0; x < cw; x++) { int o = ((y0 + y) * w + x0 + x) * 4; int p = (y * cw + x) * 3; rgb[p] = bgra[o + 2]; rgb[p + 1] = bgra[o + 1]; rgb[p + 2] = bgra[o]; }
                var width = new int[1]; GetCharWidth32W(dc, ch, ch, width);
                var abc = new ABC[1]; GetCharABCWidthsW(dc, ch, ch, abc);
                if (!first) json.Append(','); first = false;
                json.Append("{\"face\":\"").Append(face).Append("\",\"size\":").Append(size).Append(",\"quality\":").Append(quality).Append(",\"code\":").Append((int)ch)
                    .Append(",\"width\":").Append(width[0]).Append(",\"abc\":[").Append(abc[0].a).Append(',').Append(abc[0].b).Append(',').Append(abc[0].c)
                    .Append("],\"x\":").Append(x0).Append(",\"y\":").Append(y0).Append(",\"w\":").Append(cw).Append(",\"h\":").Append(chh).Append(",\"rgb\":\"").Append(Convert.ToBase64String(rgb)).Append("\"}");
            }
            SelectObject(dc, oldFont); DeleteObject(font); SelectObject(dc, oldBmp); DeleteObject(bmp); DeleteDC(dc);
        }
        json.Append(']');
        var data = Encoding.UTF8.GetBytes(json.ToString());
        using (var file = File.Create(Path.Combine(dir, "gdi-cleartype-compat.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(data, 0, data.Length);
    }
}
