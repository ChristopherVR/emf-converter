// Public HALFTONE held-out 2D RGB impulses, diagonal steps, tiles and ramps.
// Anisotropic enlargement and translated destination draws isolate run phase.
// Full source data and only the central native output are retained.
// This crop cannot establish whole-image parity or independent alpha parity.
// Scale is horizontal percent; vertical percent is 590 minus scale.
// Rounded destination extents are recorded explicitly.
// No native implementation is inspected. Run with Windows PowerShell 5.1.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public static class HalftoneRun2DProbe
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
        foreach (int sw in new[] { 173, 257, 191 })
        foreach (int pattern in new[] { 0, 1, 2, 3, 4, 5 }) foreach (int scale in new[] { 210, 275, 340, 380, 225, 315 })
        foreach (int mode in new[] { 0, 1, 2 }) foreach (bool dib in new[] { false, true }) foreach (int translation in new[] { -3, 5 }) {
            if (sw == 191 ? pattern < 4 || scale != 225 && scale != 315 : pattern >= 4 || scale == 225 || scale == 315) continue;
            int sh = sw == 173 ? 47 : sw == 257 ? 41 : 53;
            int verticalScale = 590 - scale;
            int w = (sw * scale + 50) / 100, h = (sh * verticalScale + 50) / 100;
            int canvasW = w + 16, canvasH = h + 16;
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
                    int xx = x - sw / 2, yy = y - sh / 2;
                    if (pattern == 0) {
                        input[i] = (byte)(xx == -2 && yy == 1 ? 101 : 0);
                        input[i + 1] = (byte)(xx == 1 && yy == -2 ? 127 : 0);
                        input[i + 2] = (byte)(xx == 0 && yy == 0 ? 191 : 0);
                    } else if (pattern == 1) {
                        input[i] = (byte)(xx + 2 * yy < 0 ? 63 : 159);
                        input[i + 1] = (byte)(2 * xx - yy < 0 ? 96 : 191);
                        input[i + 2] = (byte)(xx - yy < 0 ? 127 : 31);
                    } else if (pattern == 2) {
                        input[i] = (byte)((x / 3 + y / 2) % 2 == 0 ? 63 : 159);
                        input[i + 1] = (byte)((x / 2 + y / 3) % 2 == 0 ? 127 : 191);
                        input[i + 2] = (byte)((x + y) % 3 == 0 ? 31 : 96);
                    } else if (pattern == 4) {
                        uint hash = unchecked((uint)(x * 73856093) ^ (uint)(y * 19349663));
                        hash = unchecked(hash * 1664525 + 1013904223);
                        input[i] = (byte)(32 + ((hash >> 4) & 127));
                        input[i + 1] = (byte)(63 + ((hash >> 12) & 127));
                        input[i + 2] = (byte)(31 + ((hash >> 20) & 127));
                    } else if (pattern == 5) {
                        input[i] = (byte)(Math.Abs(xx - 1) <= 2 && Math.Abs(yy + 1) <= 3 ? 191 : 31);
                        input[i + 1] = (byte)(xx + yy <= 2 && xx + yy >= -2 ? 159 : 63);
                        input[i + 2] = (byte)(xx * xx + yy * yy <= 16 ? 127 : 0);
                    } else {
                        input[i] = (byte)(32 + (x + 3 * y) % 128);
                        input[i + 1] = (byte)(63 + (2 * x + y) % 128);
                        input[i + 2] = (byte)(31 + (3 * x + 2 * y) % 160);
                    }
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
                var sourceHeader = Header(sw, sh); var destHeader = Header(canvasW, canvasH);
                sb = CreateDIBSection(src, ref sourceHeader, 0, out sBits, IntPtr.Zero, 0);
                db = CreateDIBSection(dst, ref destHeader, 0, out dBits, IntPtr.Zero, 0);
                if (sb == IntPtr.Zero || db == IntPtr.Zero) throw new Exception("CreateDIBSection failed");
                so = SelectObject(src, sb); dOld = SelectObject(dst, db);
                Marshal.Copy(input, 0, sBits, input.Length);
                SetStretchBltMode(dst, 4);
                if (!SetColorAdjustment(dst, Adjustment(mode))) throw new Exception("SetColorAdjustment failed");
                if (dib) {
                    if (StretchDIBits(dst, translation, translation, w, h, 0, 0, sw, sh, input, ref sourceHeader, 0, 0x00CC0020) == -1) throw new Exception("StretchDIBits failed");
                } else if (!StretchBlt(dst, translation, translation, w, h, src, 0, 0, sw, sh, 0x00CC0020)) throw new Exception("StretchBlt failed");
                GdiFlush();
                var fullOutput = new byte[canvasW * canvasH * 4]; Marshal.Copy(dBits, fullOutput, 0, fullOutput.Length);
                int cropX = (int)Math.Ceiling((sw / 2 - 8.0) * w / sw), cropY = (int)Math.Ceiling((sh / 2 - 6.0) * h / sh);
                int cropW = (int)Math.Floor((sw / 2 + 8.0) * w / sw) - cropX;
                int cropH = (int)Math.Floor((sh / 2 + 6.0) * h / sh) - cropY;
                var output = new byte[cropW * cropH * 4];
                for (int y = 0; y < cropH; y++) Buffer.BlockCopy(fullOutput, ((cropY + y + translation) * canvasW + cropX + translation) * 4, output, y * cropW * 4, cropW * 4);
                if (!first) json.Append(','); first = false;
                json.Append("{\"translation\":" + translation + ",\"sw\":" + sw + ",\"sh\":" + sh + ",\"pattern\":" + pattern + ",\"dw\":" + w + ",\"dh\":" + h + ",\"cropX\":" + cropX + ",\"cropY\":" + cropY + ",\"cropW\":" + cropW + ",\"cropH\":" + cropH + ",\"scale\":" + scale + ",\"mode\":" + mode + ",\"dib\":" + (dib ? "true" : "false") + ",\"sourceId\":" + sourceId + ",\"output\":\"" + Convert.ToBase64String(output) + "\"}");
            } finally {
                if (so != IntPtr.Zero) SelectObject(src, so);
                if (dOld != IntPtr.Zero) SelectObject(dst, dOld);
                if (sb != IntPtr.Zero) DeleteObject(sb); if (db != IntPtr.Zero) DeleteObject(db);
                DeleteDC(src); DeleteDC(dst);
            }
        }
        var data = Encoding.UTF8.GetBytes("{\"sources\":" + sources.Append(']').ToString() + ",\"captures\":" + json.Append(']').ToString() + "}");
        using (var file = File.Create(Path.Combine(dir, "halftone-run-2d.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(data, 0, data.Length);
    }
}
