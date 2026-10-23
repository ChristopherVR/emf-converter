// GDI GetGlyphOutline(GGO_NATIVE) of installed faces at chosen pixel sizes and lfQuality values: the grid-fitted
// outline native GDI's rasteriser (FontDrvHost) produces, to compare point by point with the converter's hinted outline.
// Hand-run (not part of generate.ps1). Output: JSON array of { face, style, size, quality, code, native (base64 TTPOLYGONHEADER stream) }.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class OutlineProbe
{
    [StructLayout(LayoutKind.Sequential)] struct Fixed { public ushort fract; public short value; }
    [StructLayout(LayoutKind.Sequential)] struct Mat { public Fixed xx, xy, yx, yy; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct Metrics { public uint blackX, blackY; public Point origin; public short incX, incY; }
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateFont(int height, int width, int esc, int orient, int weight, uint italic, uint underline, uint strike, uint charset, uint outprec, uint clipprec, uint quality, uint pitch, string face);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern uint GetGlyphOutline(IntPtr dc, uint ch, uint format, out Metrics gm, uint len, byte[] buf, ref Mat mat);

    /// <param name="styles">Bit 0 bold, bit 1 italic, one entry per capture group.</param>
    public static void Run(string face, int style, int size, uint quality, string chars, string output)
    {
        IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
        IntPtr font = CreateFont(-size, 0, 0, 0, (style & 1) != 0 ? 700 : 400, (uint)((style & 2) != 0 ? 1 : 0), 0, 0, 1, 0, 0, quality, 0, face);
        IntPtr old = SelectObject(dc, font);
        var json = new StringBuilder("[");
        try {
            foreach (char c in chars) {
                var mat = new Mat(); mat.xx.value = mat.yy.value = 1;
                Metrics gm;
                uint length = GetGlyphOutline(dc, c, 2, out gm, 0, null, ref mat);
                if (length == 0xFFFFFFFF) continue;
                var data = new byte[length];
                if (length > 0 && GetGlyphOutline(dc, c, 2, out gm, length, data, ref mat) != length) throw new Exception("GetGlyphOutline failed");
                if (json.Length > 1) json.Append(',');
                json.Append("{\"face\":\"").Append(face).Append("\",\"style\":").Append(style).Append(",\"size\":").Append(size).Append(",\"quality\":").Append(quality)
                    .Append(",\"code\":").Append((int)c).Append(",\"native\":\"").Append(Convert.ToBase64String(data)).Append("\"}");
            }
        } finally { SelectObject(dc, old); DeleteObject(font); DeleteDC(dc); }
        File.WriteAllText(output, json.Append(']').ToString());
    }
}
