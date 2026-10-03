// Public native playback into a surface covering both the original reference
// and the recorded device bounds. Original reference PNGs remain untouched.
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

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

    static bool CaptureGdi(string source, string destination, int width, int height, Rect rect)
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
            bool success = PlayEnhMetaFile(dc, metafile, ref rect);
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

    public static bool Capture(string dir, string name, int width, int height, int originX, int originY, bool plus)
    {
        string source = Path.Combine(dir, name + ".emf");
        using (var original = new Bitmap(Path.Combine(dir, name + ".png"))) {
            if (!plus) {
                var rect = new Rect { left = -originX, top = -originY,
                    right = original.Width - originX, bottom = original.Height - originY };
                return CaptureGdi(source, Path.Combine(dir, name + ".extent.png"), width, height, rect);
            }
        }
        using (var output = new Bitmap(width, height))
        using (var graphics = Graphics.FromImage(output)) {
            graphics.Clear(Color.White);
            using (var metafile = new Metafile(source))
                graphics.DrawImage(metafile, new Rectangle(0, 0, width, height),
                    originX, originY, width, height, GraphicsUnit.Pixel);
            output.Save(Path.Combine(dir, name + ".extent.png"), ImageFormat.Png);
        }
        return true;
    }
}
