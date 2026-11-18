// Public native playback into a surface covering both the original reference
// and the painted extent. Off-curve control points in recorded device bounds
// need not enlarge the capture: translating native playback can change its
// device-grid path flattening. Original reference PNGs remain untouched.
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class PlaybackExtentProbe
{
    [StructLayout(LayoutKind.Sequential)]
    struct Rect { public int left, top, right, bottom; }
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr GetEnhMetaFile(string filename);
    [DllImport("gdi32.dll")]
    static extern bool PlayEnhMetaFile(IntPtr dc, IntPtr metafile, ref Rect rect);
    [DllImport("gdi32.dll")]
    static extern bool DeleteEnhMetaFile(IntPtr metafile);
    [StructLayout(LayoutKind.Sequential)]
    struct BitmapInfo { public int size, width, height; public short planes, depth; public int compression, bytes, x, y, colors, important; }
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BitmapInfo info, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool GdiFlush();
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)]
    static extern int AddFontResourceEx(string path, uint flags, IntPtr reserved);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)]
    static extern bool RemoveFontResourceEx(string path, uint flags, IntPtr reserved);

    delegate int RecordCallback(IntPtr dc, IntPtr table, IntPtr record, int handles, IntPtr data);
    [DllImport("gdi32.dll")] static extern bool EnumEnhMetaFile(IntPtr dc, IntPtr metafile, RecordCallback callback, IntPtr data, ref Rect rect);
    [DllImport("gdi32.dll")] static extern bool PlayEnhMetaFileRecord(IntPtr dc, IntPtr table, IntPtr record, int handles);
    static bool CaptureGdi(string source, string destination, int width, int height, Rect rect, bool recordPlayback)
    {
        IntPtr screen = GetDC(IntPtr.Zero), dc = IntPtr.Zero, bitmap = IntPtr.Zero, old = IntPtr.Zero, metafile = IntPtr.Zero;
        try {
            dc = CreateCompatibleDC(screen);
            var info = new BitmapInfo { size = 40, width = width, height = -height, planes = 1, depth = 32 };
            IntPtr bits;
            bitmap = CreateDIBSection(screen, ref info, 0, out bits, IntPtr.Zero, 0);
            if (dc == IntPtr.Zero || bitmap == IntPtr.Zero) throw new Exception("CreateDIBSection failed");
            old = SelectObject(dc, bitmap);
            var pixels = new byte[width * height * 4];
            for (int i = 0; i < pixels.Length; i++) pixels[i] = 255;
            Marshal.Copy(pixels, 0, bits, pixels.Length);
            metafile = GetEnhMetaFile(source);
            if (metafile == IntPtr.Zero) throw new Exception("GetEnhMetaFile failed: " + source);
            bool success;
            if (recordPlayback) {
                // Pass the actual enumeration DC and handle table unchanged,
                // as required by the public PlayEnhMetaFileRecord contract.
                bool recordsSucceeded = true;
                RecordCallback callback = delegate(IntPtr target, IntPtr table, IntPtr record, int handles, IntPtr data) {
                    recordsSucceeded &= PlayEnhMetaFileRecord(target, table, record, handles);
                    return 1;
                };
                success = EnumEnhMetaFile(dc, metafile, callback, IntPtr.Zero, ref rect) && recordsSucceeded;
            } else {
                success = PlayEnhMetaFile(dc, metafile, ref rect);
            }
            GdiFlush();
            Marshal.Copy(bits, pixels, 0, pixels.Length);
            // A GDI DIB has RGB pixels, not an independently defined alpha channel.
            for (int i = 3; i < pixels.Length; i += 4) pixels[i] = 255;
            using (var output = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
                var data = output.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
                try { Marshal.Copy(pixels, 0, data.Scan0, pixels.Length); }
                finally { output.UnlockBits(data); }
                output.Save(destination, ImageFormat.Png);
            }
            return success;
        } finally {
            if (old != IntPtr.Zero) SelectObject(dc, old);
            if (bitmap != IntPtr.Zero) DeleteObject(bitmap);
            if (dc != IntPtr.Zero) DeleteDC(dc);
            if (metafile != IntPtr.Zero) DeleteEnhMetaFile(metafile);
            if (screen != IntPtr.Zero) ReleaseDC(IntPtr.Zero, screen);
        }
    }

    // The current system raster fonts can take precedence over same-name private VGA fonts. Give the exact VGA
    // bitmap resource a private alias, then bind a temporary copy of the recording to that face.
    public static bool CaptureWithVgaFont(string dir, string name, int width, int height, int originX, int originY, string face)
    {
        string fontFile, alias;
        switch (face) {
            case "Fixedsys": fontFile = "vgafix.fon"; alias = "ParityFx"; break;
            case "System": fontFile = "vgasys.fon"; alias = "ParSys"; break;
            default: throw new ArgumentException("Unsupported VGA raster face: " + face);
        }

        string fontDir = Environment.GetEnvironmentVariable("GDI_FIXTURE_FONTS") ??
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "Fonts");
        byte[] font = AliasedVgaFont(Path.Combine(fontDir, fontFile), face, alias);
        string source = Path.Combine(dir, name + ".emf");
        byte[] recording = File.ReadAllBytes(source);
        int aliases = 0;
        for (int p = 0; p < recording.Length;) {
            int type = BitConverter.ToInt32(recording, p), size = BitConverter.ToInt32(recording, p + 4);
            if (size < 8 || size > recording.Length - p) throw new InvalidDataException("Invalid EMF record: " + source);
            // EMR_EXTCREATEFONTINDIRECTW has a 32-character LOGFONTW face name at byte 40.
            if (type == 82 && size >= 104 && Encoding.Unicode.GetString(recording, p + 40, 64).TrimEnd('\0') == face) {
                Encoding.Unicode.GetBytes(alias, 0, alias.Length, recording, p + 40);
                aliases++;
            }
            p += size;
        }
        if (aliases == 0) throw new InvalidDataException("No " + face + " font records: " + source);

        string temp = Path.Combine(Path.GetTempPath(), "gdi-vga-" + Guid.NewGuid().ToString("N"));
        string fontPath = temp + ".fnt", emfPath = temp + ".emf";
        const uint privateFont = 0x10;
        bool registered = false;
        try {
            File.WriteAllBytes(fontPath, font);
            File.WriteAllBytes(emfPath, recording);
            registered = AddFontResourceEx(fontPath, privateFont, IntPtr.Zero) > 0;
            if (!registered) throw new InvalidOperationException("Could not register the private VGA font: " + face);
            using (var original = new Bitmap(Path.Combine(dir, name + ".png"))) {
                var rect = new Rect { left = -originX, top = -originY,
                    right = original.Width - originX, bottom = original.Height - originY };
                return CaptureGdi(emfPath, Path.Combine(dir, name + ".extent.png"), width, height, rect, false);
            }
        } finally {
            if (registered) RemoveFontResourceEx(fontPath, privateFont, IntPtr.Zero);
            File.Delete(emfPath);
            File.Delete(fontPath);
        }
    }

    static byte[] AliasedVgaFont(string path, string face, string alias)
    {
        byte[] fon = File.ReadAllBytes(path);
        int ne = BitConverter.ToInt32(fon, 0x3c);
        int table = ne + BitConverter.ToUInt16(fon, ne + 0x24);
        int shift = BitConverter.ToUInt16(fon, table);
        for (int group = table + 2; BitConverter.ToUInt16(fon, group) != 0;) {
            int type = BitConverter.ToUInt16(fon, group), count = BitConverter.ToUInt16(fon, group + 2);
            int entry = group + 8;
            if (type == 0x8008 && count == 1) {
                int offset = BitConverter.ToUInt16(fon, entry) << shift;
                int size = BitConverter.ToInt32(fon, offset + 2);
                byte[] fnt = new byte[size];
                Buffer.BlockCopy(fon, offset, fnt, 0, size);
                int faceOffset = BitConverter.ToInt32(fnt, 105);
                if (Encoding.ASCII.GetString(fnt, faceOffset, face.Length + 1) != face + '\0')
                    throw new InvalidDataException("Unexpected VGA bitmap face: " + path);
                Encoding.ASCII.GetBytes(alias, 0, alias.Length, fnt, faceOffset);
                return fnt;
            }
            group = entry + count * 12;
        }
        throw new InvalidDataException("Expected one bitmap font resource in " + path);
    }

    public static bool Capture(string dir, string name, int width, int height, int originX, int originY, bool plus, bool nativeFrame = false, bool recordPlayback = false, string suffix = ".extent.png")
    {
        string source = Path.Combine(dir, name + ".emf");
        using (var original = new Bitmap(Path.Combine(dir, name + ".png"))) {
            if (!plus) {
                var rect = new Rect { left = -originX, top = -originY,
                    right = original.Width - originX, bottom = original.Height - originY };
                if (nativeFrame) {
                    // Some old recordings mix virtualised frame coordinates with
                    // physical reference-device caps. Replay their frame at its
                    // recorded device size instead of scaling it to the clipped PNG.
                    byte[] header = File.ReadAllBytes(source);
                    int deviceW = BitConverter.ToInt32(header, 72), deviceH = BitConverter.ToInt32(header, 76);
                    int mmW = BitConverter.ToInt32(header, 80), mmH = BitConverter.ToInt32(header, 84);
                    if (deviceW <= 0 || deviceH <= 0 || mmW <= 0 || mmH <= 0) throw new Exception("Invalid reference-device dimensions");
                    int frameW = BitConverter.ToInt32(header, 32) - BitConverter.ToInt32(header, 24);
                    int frameH = BitConverter.ToInt32(header, 36) - BitConverter.ToInt32(header, 28);
                    rect.right = (int)Math.Round(frameW * (double)deviceW / (mmW * 100.0)) - originX;
                    rect.bottom = (int)Math.Round(frameH * (double)deviceH / (mmH * 100.0)) - originY;
                }
                return CaptureGdi(source, Path.Combine(dir, name + suffix), width, height, rect, recordPlayback);
            }
        }
        using (var output = new Bitmap(width, height))
        using (var graphics = Graphics.FromImage(output)) {
            graphics.Clear(Color.White);
            using (var metafile = new Metafile(source))
                graphics.DrawImage(metafile, new Rectangle(0, 0, width, height),
                    originX, originY, width, height, GraphicsUnit.Pixel);
            output.Save(Path.Combine(dir, name + suffix), ImageFormat.Png);
        }
        return true;
    }

    /// <summary>
    /// Plays one case into a temporary surface (as Capture) and reports "ink,x0,y0,x1,y1,overlapMismatch": the non-white RGB pixel
    /// count and its device bounds (surface coordinates plus the origin), and how many RGB pixels of the original reference PNG
    /// the playback does not reproduce (0 means the original is a valid clipped capture of it). The temporary PNG is deleted.
    /// </summary>
    public static string Survey(string dir, string name, int width, int height, int originX, int originY, bool plus)
    {
        string temporary = Path.Combine(dir, name + ".survey.png");
        Capture(dir, name, width, height, originX, originY, plus, false, false, ".survey.png");
        try {
            int ink = 0, x0 = int.MaxValue, y0 = int.MaxValue, x1 = int.MinValue, y1 = int.MinValue, mismatch = 0;
            using (var native = new Bitmap(temporary))
            using (var original = new Bitmap(Path.Combine(dir, name + ".png"))) {
                int[] n = Pixels(native), o = Pixels(original);
                for (int y = 0; y < native.Height; y++)
                    for (int x = 0; x < native.Width; x++) {
                        int p = n[y * native.Width + x] & 0xFFFFFF;
                        if (p != 0xFFFFFF) { ink++; x0 = Math.Min(x0, x); x1 = Math.Max(x1, x); y0 = Math.Min(y0, y); y1 = Math.Max(y1, y); }
                        int dx = x + originX, dy = y + originY;
                        if (dx >= 0 && dy >= 0 && dx < original.Width && dy < original.Height && (o[dy * original.Width + dx] & 0xFFFFFF) != p) mismatch++;
                    }
            }
            if (ink == 0) return "0,0,0,0,0," + mismatch;
            return string.Format("{0},{1},{2},{3},{4},{5}", ink, x0 + originX, y0 + originY, x1 + originX, y1 + originY, mismatch);
        } finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    static int[] Pixels(Bitmap bitmap)
    {
        var data = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try {
            var result = new int[bitmap.Width * bitmap.Height];
            Marshal.Copy(data.Scan0, result, 0, result.Length);
            return result;
        } finally { bitmap.UnlockBits(data); }
    }
}
