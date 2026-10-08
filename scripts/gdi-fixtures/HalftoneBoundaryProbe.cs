// Batch HALFTONE StretchBlt / StretchDIBits probe for boundary isolation of the enlargement branch.
// No native implementation is inspected. Run with Windows PowerShell 5.1.
//
// Input file, version 1: int32 count (> 0), int32 keepOutput, then per image int32 sw, sh, scale
// followed by sw*sh BGRA bytes; the whole bitmap is stretched by an integer scale with StretchBlt.
// Input file, version 2: int32 -count, int32 keepOutput, then per image int32 bw, bh (bitmap size),
// sx, sy, sw, sh (source rectangle), dw, dh (destination size), flags (bit 0: StretchDIBits instead of
// StretchBlt; bit 1: SetStretchBltMode HALFTONE is skipped, i.e. COLORONCOLOR), followed by bw*bh*4 BGRA bytes.
//
// Output file: int32 count, then per image int32 sw, sh, scale (dw / sw, or 0 when not an integer),
// int32 badBlocks (-1 when the scale is not an integer), sh int32 non-uniform block counts per block
// row, sw int32 per block column, and (when keepOutput) the raw destination BGRA (dw*dh*4 bytes).
// A block is scale x scale destination pixels; a replicated-branch image has no non-uniform block.
using System;
using System.IO;
using System.Runtime.InteropServices;

public static class HalftoneBoundaryProbe
{
    [StructLayout(LayoutKind.Sequential)]
    struct BIH { public int size, width, height; public short planes, depth; public int compression, bytes, x, y, colors, important; }
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BIH bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern int SetStretchBltMode(IntPtr dc, int mode);
    [DllImport("gdi32.dll")] static extern int StretchDIBits(IntPtr dc, int x, int y, int w, int h, int sx, int sy, int sw, int sh, byte[] bits, ref BIH bmi, uint usage, uint rop);
    [DllImport("gdi32.dll")] static extern bool StretchBlt(IntPtr dc, int x, int y, int w, int h, IntPtr src, int sx, int sy, int sw, int sh, uint rop);
    [DllImport("gdi32.dll")] static extern bool GdiFlush();

    static BIH Header(int w, int h) { return new BIH { size = 40, width = w, height = -h, planes = 1, depth = 32 }; }

    public static void Run(string inPath, string outPath) {
        using (var r = new BinaryReader(File.OpenRead(inPath)))
        using (var o = new BinaryWriter(File.Create(outPath))) {
            int first = r.ReadInt32(); bool v2 = first < 0; int count = v2 ? -first : first, keep = r.ReadInt32();
            o.Write(count);
            for (int n = 0; n < count; n++) {
                int bw, bh, sx = 0, sy = 0, sw, sh, dw, dh, flags = 0;
                if (v2) {
                    bw = r.ReadInt32(); bh = r.ReadInt32(); sx = r.ReadInt32(); sy = r.ReadInt32(); sw = r.ReadInt32(); sh = r.ReadInt32();
                    dw = r.ReadInt32(); dh = r.ReadInt32(); flags = r.ReadInt32();
                } else {
                    sw = r.ReadInt32(); sh = r.ReadInt32(); int sc = r.ReadInt32(); bw = sw; bh = sh; dw = sw * sc; dh = sh * sc;
                }
                var input = r.ReadBytes(bw * bh * 4);
                bool integer = dw % sw == 0 && dh % sh == 0 && dw / sw == dh / sh; int scale = integer ? dw / sw : 0;
                IntPtr src = CreateCompatibleDC(IntPtr.Zero), dst = CreateCompatibleDC(IntPtr.Zero);
                IntPtr sb = IntPtr.Zero, db = IntPtr.Zero, so = IntPtr.Zero, dOld = IntPtr.Zero, sBits, dBits;
                try {
                    var sourceHeader = Header(bw, bh); var destHeader = Header(dw, dh);
                    sb = CreateDIBSection(src, ref sourceHeader, 0, out sBits, IntPtr.Zero, 0);
                    db = CreateDIBSection(dst, ref destHeader, 0, out dBits, IntPtr.Zero, 0);
                    if (sb == IntPtr.Zero || db == IntPtr.Zero) throw new Exception("CreateDIBSection failed");
                    so = SelectObject(src, sb); dOld = SelectObject(dst, db);
                    Marshal.Copy(input, 0, sBits, input.Length);
                    SetStretchBltMode(dst, (flags & 2) != 0 ? 3 : 4);
                    if ((flags & 1) != 0) {
                        // StretchDIBits reads the source rectangle from a top-down DIB: y is counted from the top row.
                        if (StretchDIBits(dst, 0, 0, dw, dh, sx, sy, sw, sh, input, ref sourceHeader, 0, 0x00CC0020) == -1) throw new Exception("StretchDIBits failed");
                    } else if (!StretchBlt(dst, 0, 0, dw, dh, src, sx, sy, sw, sh, 0x00CC0020)) throw new Exception("StretchBlt failed");
                    GdiFlush();
                    var output = new byte[dw * dh * 4]; Marshal.Copy(dBits, output, 0, output.Length);
                    var rows = new int[sh]; var cols = new int[sw]; int bad = integer ? 0 : -1;
                    if (integer) for (int by = 0; by < sh; by++) for (int bx = 0; bx < sw; bx++) {
                        bool changed = false; int b0 = ((by * scale) * dw + bx * scale) * 4;
                        for (int dy = 0; dy < scale && !changed; dy++) for (int dx = 0; dx < scale && !changed; dx++) {
                            int b1 = ((by * scale + dy) * dw + bx * scale + dx) * 4;
                            if (output[b1] != output[b0] || output[b1 + 1] != output[b0 + 1] || output[b1 + 2] != output[b0 + 2]) changed = true;
                        }
                        if (changed) { rows[by]++; cols[bx]++; bad++; }
                    }
                    o.Write(sw); o.Write(sh); o.Write(scale); o.Write(bad);
                    foreach (var v in rows) o.Write(v);
                    foreach (var v in cols) o.Write(v);
                    if (keep != 0) o.Write(output);
                } finally {
                    if (so != IntPtr.Zero) SelectObject(src, so);
                    if (dOld != IntPtr.Zero) SelectObject(dst, dOld);
                    if (sb != IntPtr.Zero) DeleteObject(sb); if (db != IntPtr.Zero) DeleteObject(db);
                    DeleteDC(src); DeleteDC(dst);
                }
            }
        }
    }
}
