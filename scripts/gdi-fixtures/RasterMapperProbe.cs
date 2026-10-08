// Which raster (.fon) size does the font mapper pick, and does it depend on the installed set?
//
// For every raster face the fixtures use (and Helv / Tms Rmn / MS Shell Dlg, which are substituted) this selects a
// 400-weight non-antialiased font at every lfHeight from -60 to 60 into a memory DC and records GetTextMetrics, plus
// the metrics of the stock SYSTEM_FONT, SYSTEM_FIXED_FONT and OEM_FIXED_FONT. Output: raster-mapper.json.
// On a machine at 144 dpi System and Fixedsys come from the 20 pixel 8514sys.fon / 8514fix.fon faces next to the
// 16 and 15 pixel vgasys.fon / vgafix.fon ones; the committed originals (a 96 dpi session) only used the latter.
using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class RasterMapperProbe
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct LogFont { public int h, w, esc, ori, weight; public byte it, ul, so, cs, op, cp, q, pf; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string face; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct TextMetric { public int tmHeight, tmAscent, tmDescent, tmInternalLeading, tmExternalLeading, tmAveCharWidth, tmMaxCharWidth, tmWeight, tmOverhang, tmDigitizedAspectX, tmDigitizedAspectY; public ushort tmFirstChar, tmLastChar, tmDefaultChar, tmBreakChar; public byte tmItalic, tmUnderlined, tmStruckOut, tmPitchAndFamily, tmCharSet; }
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr GetStockObject(int index);
    [DllImport("gdi32.dll")] static extern int GetDeviceCaps(IntPtr dc, int index);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateFontIndirectW(ref LogFont lf);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool GetTextMetricsW(IntPtr dc, out TextMetric tm);

    static string Metrics(IntPtr dc)
    {
        TextMetric t;
        GetTextMetricsW(dc, out t);
        return "\"tmHeight\":" + t.tmHeight + ",\"tmAscent\":" + t.tmAscent + ",\"tmInternalLeading\":" + t.tmInternalLeading + ",\"tmAveCharWidth\":" + t.tmAveCharWidth
            + ",\"tmMaxCharWidth\":" + t.tmMaxCharWidth + ",\"aspectX\":" + t.tmDigitizedAspectX + ",\"aspectY\":" + t.tmDigitizedAspectY + ",\"tmWeight\":" + t.tmWeight;
    }

    public static void Run(string dir)
    {
        string[] faces = { "MS Sans Serif", "MS Serif", "Courier", "Small Fonts", "System", "Terminal", "Fixedsys", "Helv", "Tms Rmn", "MS Shell Dlg" };
        IntPtr screen = GetDC(IntPtr.Zero);
        IntPtr dc = CreateCompatibleDC(screen);
        var json = new StringBuilder();
        json.Append("{\"logPixelsX\":").Append(GetDeviceCaps(screen, 88)).Append(",\"logPixelsY\":").Append(GetDeviceCaps(screen, 90)).Append(",\"stock\":{");
        string[] stockNames = { "SYSTEM_FONT", "SYSTEM_FIXED_FONT", "OEM_FIXED_FONT" };
        int[] stock = { 13, 16, 10 };
        for (int i = 0; i < stock.Length; i++)
        {
            IntPtr old = SelectObject(dc, GetStockObject(stock[i]));
            if (i > 0) json.Append(',');
            json.Append('"').Append(stockNames[i]).Append("\":{").Append(Metrics(dc)).Append('}');
            SelectObject(dc, old);
        }
        json.Append("},\"rows\":[");
        bool first = true;
        foreach (string face in faces)
        {
            for (int h = -60; h <= 60; h++)
            {
                if (h == 0) continue;
                var lf = new LogFont { h = h, weight = 400, cs = 1, face = face, q = 3 };
                IntPtr font = CreateFontIndirectW(ref lf);
                IntPtr old = SelectObject(dc, font);
                if (!first) json.Append(',');
                first = false;
                json.Append("{\"face\":\"").Append(face).Append("\",\"height\":").Append(h).Append(',').Append(Metrics(dc)).Append('}');
                SelectObject(dc, old); DeleteObject(font);
            }
        }
        json.Append("]}");
        DeleteDC(dc);
        ReleaseDC(IntPtr.Zero, screen);
        File.WriteAllText(Path.Combine(dir, "raster-mapper.json"), json.ToString(), new UTF8Encoding(false));
    }
}
