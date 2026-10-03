// Public HALFTONE impulse/step/ramp controls with an independent chroma carrier.
// Full source data and only the central native output are retained.
// This crop cannot establish whole-image parity or independent alpha parity.
// Scale is a percent; rounded destination extents are recorded explicitly.
// No native implementation is inspected. Run with Windows PowerShell 5.1.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public static class HalftoneKernelProbe
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
        foreach (int sw in new[] { 64, 128, 256 }) foreach (int sh in new[] { 32 })
        foreach (int pattern in new[] { 0, 1, 2, 3 }) foreach (int scale in new[] { 200, 300, 237 })
        foreach (int mode in new[] { 0, 1, 2 }) foreach (bool dib in new[] { false, true }) {
            int w = (sw * scale + 50) / 100, h = (sh * scale + 50) / 100;
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
                    int value = pattern == 0 || pattern == 1 ? (x == sw / 2 && y == sh / 2 ? 64 : 0)
                        : pattern == 2 ? (x < sw / 2 ? 128 : 0) : (x - 4) * 255 / (sw - 9);
                    input[i + 2] = (byte)value;
                    if (pattern != 0) input[i] = input[i + 1] = (byte)value;
                }
            }
            string sourceKey = sw + ":" + pattern; int sourceId;
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
                int cropX = (int)Math.Ceiling(16.0 * w / sw), cropY = (int)Math.Ceiling(8.0 * h / sh);
                int cropW = (int)Math.Floor((sw - 16.0) * w / sw) - cropX;
                int cropH = (int)Math.Floor(24.0 * h / sh) - cropY;
                var output = new byte[cropW * cropH * 4];
                for (int y = 0; y < cropH; y++) Buffer.BlockCopy(fullOutput, ((cropY + y) * w + cropX) * 4, output, y * cropW * 4, cropW * 4);
                // Retain a transition line plus the full RGB samples for independent models.
                var line = new byte[pattern != 1 ? h : w];
                for (int k = 0; k < line.Length; k++) line[k] = fullOutput[((pattern != 1 ? k * w + w / 2 : h / 2 * w + k)) * 4];
                if (!first) json.Append(','); first = false;
                json.Append("{\"sw\":" + sw + ",\"sh\":" + sh + ",\"pattern\":" + pattern + ",\"dw\":" + w + ",\"dh\":" + h + ",\"cropX\":" + cropX + ",\"cropY\":" + cropY + ",\"cropW\":" + cropW + ",\"cropH\":" + cropH + ",\"scale\":" + scale + ",\"mode\":" + mode + ",\"dib\":" + (dib ? "true" : "false") + ",\"line\":\"" + Convert.ToBase64String(line) + "\",\"sourceId\":" + sourceId + ",\"output\":\"" + Convert.ToBase64String(output) + "\"}");
            } finally {
                if (so != IntPtr.Zero) SelectObject(src, so);
                if (dOld != IntPtr.Zero) SelectObject(dst, dOld);
                if (sb != IntPtr.Zero) DeleteObject(sb); if (db != IntPtr.Zero) DeleteObject(db);
                DeleteDC(src); DeleteDC(dst);
            }
        }
        var data = Encoding.UTF8.GetBytes("{\"sources\":" + sources.Append(']').ToString() + ",\"captures\":" + json.Append(']').ToString() + "}");
        using (var file = File.Create(Path.Combine(dir, "halftone-kernel.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(data, 0, data.Length);
    }
}
