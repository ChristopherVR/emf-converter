// Native GDI ExtTextOut ClearType blending: the same Arial string drawn onto a 32bpp DIB section in many
// text colour / background colour pairs. Black on white fixes each pixel channel's coverage level (seven levels);
// the other pairs then give the blend function f(coverage level, text colour, background) directly.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class GdiClearTypeBlendProbe
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
    [DllImport("gdi32.dll")] static extern uint SetBkColor(IntPtr dc, uint c);
    [DllImport("gdi32.dll")] static extern int SetBkMode(IntPtr dc, int m);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateFontIndirectW(ref LOGFONT lf);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool ExtTextOutW(IntPtr dc, int x, int y, uint opts, IntPtr rect, string s, uint n, int[] dx);
    [DllImport("gdi32.dll")] static extern bool GdiFlush();
    [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint param, out uint value, uint ini);

    static byte[] Draw(int quality, int height, string text, uint fg, uint bg, int w, int h, out int[] spi)
    {
        var bmi = new BITMAPINFOHEADER { size = 40, width = w, height = -h, planes = 1, bitCount = 32 };
        IntPtr bits; IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
        IntPtr bmp = CreateDIBSection(dc, ref bmi, 0, out bits, IntPtr.Zero, 0);
        IntPtr oldBmp = SelectObject(dc, bmp);
        var lf = new LOGFONT { h = -height, weight = 400, charset = 1, quality = (byte)quality, face = "Arial" };
        IntPtr font = CreateFontIndirectW(ref lf); IntPtr oldFont = SelectObject(dc, font);
        SetBkMode(dc, 2); SetBkColor(dc, bg); SetTextColor(dc, fg);
        // opaque background through ETO_OPAQUE would change nothing here; fill the surface by ExtTextOut of an empty string with a rect
        var fill = new int[] { 0, 0, w, h }; IntPtr rp = Marshal.AllocHGlobal(16); Marshal.Copy(fill, 0, rp, 4);
        ExtTextOutW(dc, 0, 0, 2, rp, "", 0, null); Marshal.FreeHGlobal(rp);
        SetBkMode(dc, 1);
        ExtTextOutW(dc, 4, 4, 0, IntPtr.Zero, text, (uint)text.Length, null);
        GdiFlush();
        var bgra = new byte[w * h * 4]; Marshal.Copy(bits, bgra, 0, bgra.Length);
        SelectObject(dc, oldFont); DeleteObject(font); SelectObject(dc, oldBmp); DeleteObject(bmp); DeleteDC(dc);
        spi = new int[3]; uint v;
        SystemParametersInfo(0x200A, 0, out v, 0); spi[0] = (int)v; // SPI_GETFONTSMOOTHINGTYPE
        SystemParametersInfo(0x200C, 0, out v, 0); spi[1] = (int)v; // SPI_GETFONTSMOOTHINGCONTRAST
        SystemParametersInfo(0x2012, 0, out v, 0); spi[2] = (int)v; // SPI_GETFONTSMOOTHINGORIENTATION
        var rgb = new byte[w * h * 3];
        for (int i = 0; i < w * h; i++) { rgb[i * 3] = bgra[i * 4 + 2]; rgb[i * 3 + 1] = bgra[i * 4 + 1]; rgb[i * 3 + 2] = bgra[i * 4]; }
        return rgb;
    }

    static uint Colorref(int r, int g, int b) { return (uint)(r | (g << 8) | (b << 16)); }

    public static void Run(string dir)
    {
        Directory.CreateDirectory(dir);
        var json = new StringBuilder("{\"captures\":[");
        int[] sizes = { 12, 16, 24, 40 };
        int[] qualities = { 5, 6, 0 };
        int[][] pairs = {
            new[]{0,0,0, 255,255,255}, new[]{255,255,255, 0,0,0}, new[]{128,128,128, 255,255,255}, new[]{128,128,128, 0,0,0},
            new[]{64,64,64, 255,255,255}, new[]{192,192,192, 255,255,255}, new[]{255,0,0, 255,255,255}, new[]{0,0,255, 255,255,255},
            new[]{0,128,0, 255,255,255}, new[]{255,255,0, 0,0,128}, new[]{0,0,0, 128,128,128}, new[]{0,0,0, 255,0,0},
            new[]{255,255,255, 128,128,128}, new[]{32,32,32, 224,224,224}, new[]{96,96,96, 160,160,160}, new[]{0,0,0, 64,64,64},
            new[]{0,0,0, 192,192,192}, new[]{255,255,255, 64,64,64}, new[]{255,255,255, 192,192,192}, new[]{200,40,90, 20,180,120},
        };
        int[] spi = null; bool first = true;
        foreach (int q in qualities) foreach (int size in sizes) foreach (var p in pairs) {
            if (q != 5 && !(p[0] == 0 && p[3] == 255 && p[1] == 0) && !(p[0] == 128 && p[3] == 255) && !(p[0] == 255 && p[3] == 0 && p[1] == 255)) continue;
            int w = 22 * size / 2 + 12, h = size * 2 + 12;
            var rgb = Draw(q, size, "Hamburgefonstiv 0123 AVWX &@%$", Colorref(p[0], p[1], p[2]), Colorref(p[3], p[4], p[5]), w, h, out spi);
            if (!first) json.Append(','); first = false;
            json.Append("{\"quality\":").Append(q).Append(",\"size\":").Append(size).Append(",\"fg\":[").Append(p[0]).Append(',').Append(p[1]).Append(',').Append(p[2])
                .Append("],\"bg\":[").Append(p[3]).Append(',').Append(p[4]).Append(',').Append(p[5]).Append("],\"w\":").Append(w).Append(",\"h\":").Append(h)
                .Append(",\"rgb\":\"").Append(Convert.ToBase64String(rgb)).Append("\"}");
        }
        json.Append("],\"smoothingType\":").Append(spi[0]).Append(",\"smoothingContrast\":").Append(spi[1]).Append(",\"smoothingOrientation\":").Append(spi[2]).Append('}');
        var data = Encoding.UTF8.GetBytes(json.ToString());
        using (var file = File.Create(Path.Combine(dir, "gdi-cleartype-blend.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(data, 0, data.Length);
    }
}
