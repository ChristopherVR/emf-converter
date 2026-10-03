// Public GDI controls preserving the exact source histogram while changing arrangement.
// arrangement: 0 identity, 1 horizontal mirror, 2 transpose in flattened order,
// 3 odd-stride permutation, 4 cyclic shift by half the frame.
// All permutations are bijections of the same 256x16 pixels.
// pattern codes: positive <1000 = full-range four bands; negative = dark bands;
// 1000+N = N-colour cyclic palette; 2000+N = N-level greyscale ramp.
// They include counterexamples to a simple distinct-colour threshold selector.
// No native implementation is inspected. Run with Windows PowerShell 5.1.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class HalftoneArrangementProbe
{
    [StructLayout(LayoutKind.Sequential)]
    struct BIH { public int size, width, height; public short planes, depth; public int compression, bytes, x, y, colors, important; }
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BIH bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern int SetStretchBltMode(IntPtr dc, int mode);
    [DllImport("gdi32.dll")] static extern bool SetColorAdjustment(IntPtr dc, byte[] ca);
    [DllImport("gdi32.dll")] static extern int StretchDIBits(IntPtr dc, int x, int y, int w, int h, int sx, int sy, int sw, int sh, byte[] bits, ref BIH bmi, uint usage, uint rop);
    [DllImport("gdi32.dll")] static extern bool StretchBlt(IntPtr dc, int x, int y, int w, int h, IntPtr src, int sx, int sy, int sw, int sh, uint rop);
    [DllImport("gdi32.dll")] static extern bool GdiFlush();

    static BIH Header(int w, int h) { return new BIH { size = 40, width = w, height = -h, planes = 1, depth = 32 }; }
    static byte[] Adjustment(int mode) {
        var ca = new byte[24];
        BitConverter.GetBytes((ushort)24).CopyTo(ca, 0);
        BitConverter.GetBytes((ushort)(mode == 1 ? 2 : 0)).CopyTo(ca, 2);
        for (int i = 6; i <= 10; i += 2) BitConverter.GetBytes((ushort)(mode == 2 ? 15000 : 10000)).CopyTo(ca, i);
        BitConverter.GetBytes((ushort)10000).CopyTo(ca, 14);
        return ca;
    }

    public static void Run(string dir) {
        Directory.CreateDirectory(dir);
        var json = new StringBuilder("["); bool first = true;
        foreach (int sw in new[] { 256 }) foreach (int sh in new[] { 16 })
        foreach (int pattern in new[] { 54, 55, 2256, 1128, 1192 }) foreach (int arrangement in new[] { 0, 1, 2, 3, 4 }) foreach (int scale in new[] { 2 })
        foreach (int mode in new[] { 0 }) foreach (bool dib in new[] { false, true }) {
            int w = sw * scale, h = sh * scale;
            var input = new byte[sw * sh * 4];
            for (int y = 0; y < sh; y++) for (int x = 0; x < sw; x++) {

                int i = (y * sw + x) * 4;
                input[i + 3] = 255;
                if (true) {
                    int levels = pattern < 0 ? -pattern : pattern >= 2000 ? pattern - 2000 : pattern >= 1000 ? pattern - 1000 : pattern;
                    int sampleValue = pattern < 0 ? x % levels : (x * levels / sw) * 255 / (levels - 1);
                    input[i] = (byte)(y < 4 || y >= 12 ? sampleValue : 0);
                    input[i + 1] = (byte)(y < 4 || y >= 8 && y < 12 ? sampleValue : 0);
                    input[i + 2] = (byte)(y < 8 ? sampleValue : 0);
                    if (pattern >= 2000) input[i] = input[i + 1] = input[i + 2] = (byte)sampleValue;
                    else if (pattern >= 1000) {
                        int id = ((y * sw + x) * 37) % levels;
                        input[i] = (byte)((id % 8) * 32); input[i + 1] = (byte)(((id / 8) % 8) * 32); input[i + 2] = (byte)((id / 64) * 32);
                    }
                }
            }
            var original = (byte[])input.Clone();
            for (int i = 0; i < sw * sh; i++) {
                int x = i % sw, y = i / sw;
                int index = arrangement == 0 ? i : arrangement == 1 ? y * sw + sw - 1 - x
                    : arrangement == 2 ? x * sh + y : arrangement == 3 ? (i * 37) % (sw * sh)
                    : (i + sw * sh / 2) % (sw * sh);
                Buffer.BlockCopy(original, index * 4, input, i * 4, 4);
            }
            IntPtr src = CreateCompatibleDC(IntPtr.Zero), dst = CreateCompatibleDC(IntPtr.Zero);
            IntPtr sb = IntPtr.Zero, db = IntPtr.Zero, so = IntPtr.Zero, dOld = IntPtr.Zero, sBits, dBits;
            try {
                var sourceHeader = Header(sw, sh); var destHeader = Header(w, h);
                sb = CreateDIBSection(src, ref sourceHeader, 0, out sBits, IntPtr.Zero, 0);
                db = CreateDIBSection(dst, ref destHeader, 0, out dBits, IntPtr.Zero, 0);
                if (sb == IntPtr.Zero || db == IntPtr.Zero) throw new Exception("CreateDIBSection failed");
                so = SelectObject(src, sb); dOld = SelectObject(dst, db);
                Marshal.Copy(input, 0, sBits, input.Length);
                SetStretchBltMode(dst, 4);
                if (!SetColorAdjustment(dst, Adjustment(mode))) throw new Exception("SetColorAdjustment failed");
                if (dib) {
                    if (StretchDIBits(dst, 0, 0, w, h, 0, 0, sw, sh, input, ref sourceHeader, 0, 0x00CC0020) == -1) throw new Exception("StretchDIBits failed");
                } else if (!StretchBlt(dst, 0, 0, w, h, src, 0, 0, sw, sh, 0x00CC0020)) throw new Exception("StretchBlt failed");
                GdiFlush();
                var output = new byte[w * h * 4]; Marshal.Copy(dBits, output, 0, output.Length);
                // Retain a transition line plus the full RGB samples for independent models.
                var line = new byte[pattern != 1 ? h : w];
                for (int k = 0; k < line.Length; k++) line[k] = output[((pattern != 1 ? k * w + w / 2 : h / 2 * w + k)) * 4];
                if (!first) json.Append(','); first = false;
                json.Append("{\"sw\":" + sw + ",\"sh\":" + sh + ",\"pattern\":" + pattern + ",\"arrangement\":" + arrangement + ",\"scale\":" + scale + ",\"mode\":" + mode + ",\"dib\":" + (dib ? "true" : "false") + ",\"line\":\"" + Convert.ToBase64String(line) + "\",\"input\":\"" + Convert.ToBase64String(input) + "\",\"output\":\"" + Convert.ToBase64String(output) + "\"}");
            } finally {
                if (so != IntPtr.Zero) SelectObject(src, so);
                if (dOld != IntPtr.Zero) SelectObject(dst, dOld);
                if (sb != IntPtr.Zero) DeleteObject(sb); if (db != IntPtr.Zero) DeleteObject(db);
                DeleteDC(src); DeleteDC(dst);
            }
        }
        var data = Encoding.UTF8.GetBytes(json.Append(']').ToString());
        using (var file = File.Create(Path.Combine(dir, "halftone-arrangement.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(data, 0, data.Length);
    }
}
