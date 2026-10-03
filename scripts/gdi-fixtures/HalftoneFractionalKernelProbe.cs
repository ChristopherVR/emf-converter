// Public HALFTONE one-dimensional bar responses across source positions and ratios.
// Full source data is deduplicated; only a central native response line is retained.
// Response lines isolate phase/kernel arithmetic, not whole-image or alpha parity.
// Scale is a percent; rounded destination extents are recorded explicitly.
// No native implementation is inspected. Run with Windows PowerShell 5.1.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public static class HalftoneFractionalKernelProbe
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
        var sources = new StringBuilder("["); var sourceIds = new Dictionary<string, int>();
        foreach (int sw in new[] { 128 }) foreach (int sh in new[] { 32 })
        foreach (int pattern in new[] { 0, 1 }) foreach (int offset in new[] { -8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7 }) foreach (int scale in new[] { 200, 237, 250, 300, 325, 400 })
        foreach (int amplitude in new[] { 128, 63, 127, 191 }) foreach (int mode in new[] { 0 }) foreach (bool dib in new[] { false, true }) {
            int w = (sw * scale + 50) / 100, h = (sh * scale + 50) / 100;
            int position = pattern == 0 ? sw / 2 + offset : sh / 2 + offset;
            var input = new byte[sw * sh * 4];
            for (int y = 0; y < sh; y++) for (int x = 0; x < sw; x++) {
                int i = (y * sw + x) * 4;
                input[i + 3] = 255;
                // Rich chroma outside the measured region selects a filtered
                // response without leaking into its central impulse/step taps.
                if (y < 4 || y >= sh - 4 || x < 4 || x >= sw - 4) {
                    input[i] = (byte)((x * 29 + y * 17) & 255);
                    input[i + 1] = (byte)((x * 13 + y * 37) & 255);
                    input[i + 2] = (byte)((x * 43 + y * 11) & 255);
                } else {
                    int value = pattern % 2 == 0 ? (x == position ? amplitude : 0) : (y == position ? amplitude : 0);
                    input[i + 2] = (byte)value;
                    if (pattern >= 2) input[i] = input[i + 1] = (byte)value;
                }
            }
            string sourceKey = sw + ":" + pattern + ":" + offset + ":" + amplitude; int sourceId;
            if (!sourceIds.TryGetValue(sourceKey, out sourceId)) {
                sourceId = sourceIds.Count; sourceIds.Add(sourceKey, sourceId);
                if (sourceId > 0) sources.Append(',');
                sources.Append('"').Append(Convert.ToBase64String(input)).Append('"');
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
                var fullOutput = new byte[w * h * 4]; Marshal.Copy(dBits, fullOutput, 0, fullOutput.Length);
                int sourceLength = pattern == 0 ? sw : sh, destLength = pattern == 0 ? w : h;
                int radius = (int)Math.Ceiling(2.0 * destLength / sourceLength) + 1;
                int centre = (int)Math.Floor((position + 0.5) * destLength / sourceLength - 0.5);
                int start = Math.Max(0, centre - radius), length = Math.Min(destLength, centre + radius + 1) - start;
                int fixedX = (int)Math.Floor((sw / 2.0 + 0.5) * w / sw - 0.5);
                int fixedY = (int)Math.Floor((sh / 2.0 + 0.5) * h / sh - 0.5);
                var output = new byte[length * 4];
                for (int k = 0; k < length; k++) {
                    int x = pattern == 0 ? start + k : fixedX, y = pattern == 0 ? fixedY : start + k;
                    Buffer.BlockCopy(fullOutput, (y * w + x) * 4, output, k * 4, 4);
                }
                if (!first) json.Append(','); first = false;
                json.Append("{\"sw\":" + sw + ",\"sh\":" + sh + ",\"pattern\":" + pattern + ",\"dw\":" + w + ",\"dh\":" + h + ",\"amplitude\":" + amplitude + ",\"offset\":" + offset + ",\"position\":" + position + ",\"start\":" + start + ",\"length\":" + length + ",\"scale\":" + scale + ",\"mode\":" + mode + ",\"dib\":" + (dib ? "true" : "false") + ",\"sourceId\":" + sourceId + ",\"output\":\"" + Convert.ToBase64String(output) + "\"}");
            } finally {
                if (so != IntPtr.Zero) SelectObject(src, so);
                if (dOld != IntPtr.Zero) SelectObject(dst, dOld);
                if (sb != IntPtr.Zero) DeleteObject(sb); if (db != IntPtr.Zero) DeleteObject(db);
                DeleteDC(src); DeleteDC(dst);
            }
        }
        var data = Encoding.UTF8.GetBytes("{\"sources\":" + sources.Append(']').ToString() + ",\"captures\":" + json.Append(']').ToString() + "}");
        using (var file = File.Create(Path.Combine(dir, "halftone-fractional-kernel.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(data, 0, data.Length);
    }
}
