// Native playback of rotated single-glyph text records (`text-escapement-playback`)
//
// One metafile per face and size holds 50 lines of 8 glyphs ("aegpsR25"), each glyph its own TextOutW record under a
// LOGFONT escapement (= orientation) of 41 + 73 n tenths of a degree (n = 0..49), at 70 pixel steps on a 560 x 3500
// reference surface. One glyph per record keeps GDI's advance rounding out of the comparison, so the played-back ink is
// the glyph shape alone: PlayEnhMetaFile into a white 32bpp DIB (non-antialiased text, ANSI charset). The recording
// carries GM_COMPATIBLE exScale / eyScale, which native playback turns into a horizontal stretch of the text space.
// Output: text-escapement-playback/text-escpb-<face>-<size>.emf and .png (the native playback) and the environment file.
// Environment: ESCPB_FACES (comma list, default Arial,Times New Roman,Tahoma,Segoe UI,Courier New), ESCPB_SIZES (comma
// list of pixel heights, default 12,16,20,36).
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;

public static class TextEscapementPlaybackProbe
{
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] struct BitmapInfoHeader { public int size, w, h; public short planes, bpp; public int comp, sizeImage, xppm, yppm, used, important; }
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("gdi32.dll")] static extern int GetDeviceCaps(IntPtr dc, int index);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateEnhMetaFileW(IntPtr dc, string file, ref Rect frame, string description);
    [DllImport("gdi32.dll")] static extern IntPtr CloseEnhMetaFile(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool DeleteEnhMetaFile(IntPtr emf);
    [DllImport("gdi32.dll")] static extern bool PlayEnhMetaFile(IntPtr dc, IntPtr emf, ref Rect rect);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateFontW(int height, int width, int escapement, int orientation, int weight, uint italic, uint underline, uint strike, uint charset, uint outPrecision, uint clipPrecision, uint quality, uint pitch, string face);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern int SetBkMode(IntPtr dc, int mode);
    [DllImport("gdi32.dll")] static extern uint SetTextColor(IntPtr dc, uint color);
    [DllImport("gdi32.dll")] static extern uint SetTextAlign(IntPtr dc, uint align);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool TextOutW(IntPtr dc, int x, int y, string text, int count);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BitmapInfoHeader info, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] static extern bool PatBlt(IntPtr dc, int x, int y, int w, int h, uint rop);

    const int Width = 560, Height = 3500, Cell = 70, Lines = 50;
    const string Glyphs = "aegpsR25";

    public static void Run(string dir)
    {
        string[] faces = (Environment.GetEnvironmentVariable("ESCPB_FACES") ?? "Arial,Times New Roman,Tahoma,Segoe UI,Courier New").Split(',');
        int[] sizes = (Environment.GetEnvironmentVariable("ESCPB_SIZES") ?? "12,16,20,36").Split(',').Select(int.Parse).ToArray();
        IntPtr screen = GetDC(IntPtr.Zero);
        double mmPerPixelX = GetDeviceCaps(screen, 4) * 100.0 / GetDeviceCaps(screen, 8);
        double mmPerPixelY = GetDeviceCaps(screen, 6) * 100.0 / GetDeviceCaps(screen, 10);
        foreach (string face in faces)
        {
            foreach (int size in sizes)
            {
                string name = "text-escpb-" + face.Replace(" ", "").ToLowerInvariant() + "-" + size;
                var frame = new Rect { R = (int)Math.Round(Width * mmPerPixelX), B = (int)Math.Round(Height * mmPerPixelY) };
                IntPtr recording = CreateEnhMetaFileW(screen, Path.Combine(dir, name + ".emf"), ref frame, null);
                SetBkMode(recording, 1);
                SetTextColor(recording, 0);
                SetTextAlign(recording, 24);
                for (int line = 0; line < Lines; line++)
                {
                    int angle = (41 + 73 * line) % 3600;
                    IntPtr font = CreateFontW(-size, 0, angle, angle, 400, 0, 0, 0, 1, 0, 0, 3, 0, face);
                    IntPtr old = SelectObject(recording, font);
                    for (int c = 0; c < Glyphs.Length; c++) TextOutW(recording, Cell / 2 + c * Cell, Cell / 2 + line * Cell, Glyphs.Substring(c, 1), 1);
                    SelectObject(recording, old);
                    DeleteObject(font);
                }
                IntPtr emf = CloseEnhMetaFile(recording);
                var info = new BitmapInfoHeader { size = 40, w = Width, h = -Height, planes = 1, bpp = 32 };
                IntPtr bits;
                IntPtr dc = CreateCompatibleDC(screen);
                IntPtr dib = CreateDIBSection(screen, ref info, 0, out bits, IntPtr.Zero, 0);
                SelectObject(dc, dib);
                PatBlt(dc, 0, 0, Width, Height, 0x00FF0062);
                var rect = new Rect { R = Width, B = Height };
                PlayEnhMetaFile(dc, emf, ref rect);
                using (var bitmap = new Bitmap(Width, Height, Width * 4, PixelFormat.Format32bppRgb, bits))
                    bitmap.Save(Path.Combine(dir, name + ".png"), ImageFormat.Png);
                DeleteDC(dc);
                DeleteObject(dib);
                DeleteEnhMetaFile(emf);
            }
        }
        ReleaseDC(IntPtr.Zero, screen);
    }
}
