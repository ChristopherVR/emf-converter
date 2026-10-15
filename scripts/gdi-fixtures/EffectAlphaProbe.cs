// Native GDI+ effects on translucent pixels: GdipDrawImageFX of a 256 x 256 source through each effect.
// Source: 256 x 256 ARGB, x = channel value (all three colour channels), y = alpha.
// Each effect is drawn 1:1 with GdipDrawImageFX onto an opaque 32bppARGB backdrop and read back. Two
// variants per effect: a straight-ARGB source over (224, 232, 240), and a 32bppPARGB source (the pixel format the playback results match;
// see emf-plus-effect-alpha.fixture.test.ts) over black, whose result is the premultiplied colour itself.
using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class EffectAlphaProbe {
    [StructLayout(LayoutKind.Sequential)] struct StartupInput { public uint Version; public IntPtr Callback; public int SuppressBackgroundThread; public int SuppressExternalCodecs; }
    [StructLayout(LayoutKind.Sequential)] struct RectF { public float X, Y, Width, Height; }
    [StructLayout(LayoutKind.Sequential)] struct RectI { public int X, Y, Width, Height; }
    [DllImport("gdiplus.dll")] static extern int GdiplusStartup(out IntPtr token, ref StartupInput input, IntPtr output);
    [DllImport("gdiplus.dll")] static extern int GdipCreateEffect(Guid guid, out IntPtr effect);
    [DllImport("gdiplus.dll")] static extern int GdipDeleteEffect(IntPtr effect);
    [DllImport("gdiplus.dll")] static extern int GdipSetEffectParameters(IntPtr effect, IntPtr parameters, uint size);
    [DllImport("gdiplus.dll")] static extern int GdipCreateBitmapFromScan0(int w, int h, int stride, int format, IntPtr scan0, out IntPtr bitmap);
    [DllImport("gdiplus.dll")] static extern int GdipBitmapSetPixel(IntPtr bitmap, int x, int y, int argb);
    [DllImport("gdiplus.dll")] static extern int GdipBitmapGetPixel(IntPtr bitmap, int x, int y, out int argb);
    [DllImport("gdiplus.dll")] static extern int GdipGetImageGraphicsContext(IntPtr image, out IntPtr graphics);
    [DllImport("gdiplus.dll")] static extern int GdipDeleteGraphics(IntPtr graphics);
    [DllImport("gdiplus.dll")] static extern int GdipDisposeImage(IntPtr image);
    [DllImport("gdiplus.dll")] static extern int GdipGraphicsClear(IntPtr graphics, int argb);
    [DllImport("gdiplus.dll")] static extern int GdipCreateMatrix2(float m11, float m12, float m21, float m22, float dx, float dy, out IntPtr matrix);
    [DllImport("gdiplus.dll")] static extern int GdipDeleteMatrix(IntPtr matrix);
    [DllImport("gdiplus.dll")] static extern int GdipDrawImageFX(IntPtr graphics, IntPtr image, ref RectF source, IntPtr xForm, IntPtr effect, IntPtr imageAttributes, int srcUnit);
    [DllImport("gdiplus.dll")] static extern int GdipBitmapApplyEffect(IntPtr bitmap, IntPtr effect, ref RectI roi, int useAuxData, out IntPtr auxData, out int auxDataSize);

    const int Argb32 = 0x0026200A, Pargb32 = 0x000E200B;

    static void Ok(int status, string what) { if (status != 0) throw new InvalidOperationException(what + " failed with GpStatus " + status); }
    static byte[] I(params int[] v) { var r = new byte[v.Length * 4]; for (int i = 0; i < v.Length; i++) BitConverter.GetBytes(v[i]).CopyTo(r, i * 4); return r; }
    static byte[] F(params float[] v) { var r = new byte[v.Length * 4]; for (int i = 0; i < v.Length; i++) BitConverter.GetBytes(v[i]).CopyTo(r, i * 4); return r; }

    static IntPtr Source(int format) {
        IntPtr bmp;
        Ok(GdipCreateBitmapFromScan0(256, 256, 0, format, IntPtr.Zero, out bmp), "create");
        for (int a = 0; a < 256; a++) for (int c = 0; c < 256; c++) Ok(GdipBitmapSetPixel(bmp, c, a, (a << 24) | (c << 16) | (c << 8) | c), "set");
        return bmp;
    }

    static IntPtr Effect(string guid, byte[] parameters) {
        IntPtr effect;
        Ok(GdipCreateEffect(new Guid(guid), out effect), "effect");
        GCHandle pin = GCHandle.Alloc(parameters, GCHandleType.Pinned);
        try { Ok(GdipSetEffectParameters(effect, pin.AddrOfPinnedObject(), (uint)parameters.Length), "params"); } finally { pin.Free(); }
        return effect;
    }

    static string Pixels(IntPtr bmp) {
        var bytes = new byte[256 * 256 * 4];
        for (int y = 0; y < 256; y++) for (int x = 0; x < 256; x++) {
            int argb; Ok(GdipBitmapGetPixel(bmp, x, y, out argb), "get");
            int i = (y * 256 + x) * 4;
            bytes[i] = (byte)argb; bytes[i + 1] = (byte)(argb >> 8); bytes[i + 2] = (byte)(argb >> 16); bytes[i + 3] = (byte)(argb >> 24);
        }
        return Convert.ToBase64String(bytes);
    }

    public static void Run(string directory) {
        IntPtr token; var input = new StartupInput(); input.Version = 1;
        Ok(GdiplusStartup(out token, ref input, IntPtr.Zero), "startup");
        var lut = new byte[1024];
        for (int v = 0; v < 256; v++) { lut[v] = (byte)v; lut[256 + v] = (byte)Math.Round(255 * Math.Sqrt(v / 255.0)); lut[512 + v] = (byte)(255 - v); lut[768 + v] = (byte)v; }
        var cases = new object[][] {
            new object[] { "none", null, null },
            new object[] { "brightnesscontrast-b0-c50", "D3A1DBE1-8EC4-4C17-9F4C-EA97AD1C343D", I(0, 50) },
            new object[] { "brightnesscontrast-b30-c40", "D3A1DBE1-8EC4-4C17-9F4C-EA97AD1C343D", I(30, 40) },
            new object[] { "tint-h60-an50", "1077AF00-2848-4441-9489-44AD4C2D7A2C", I(60, -50) },
            new object[] { "levels-h100-m50-s0", "99C354EC-2A31-4F3A-8C34-17A803B33A25", I(100, 50, 0) },
            new object[] { "colorbalance-100", "537E597D-251E-48DA-9664-29CA496B70F8", I(100, 100, 100) },
            new object[] { "colormatrix-sepia", "718F2615-7933-40E3-A511-5F68FE14DD74", F(0.393f, 0.349f, 0.272f, 0, 0, 0.769f, 0.686f, 0.534f, 0, 0, 0.189f, 0.168f, 0.131f, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1) },
            new object[] { "colorlut-mixed", "A7CE72A9-0F7F-40D7-B3CC-D0C02D5C3212", lut },
            new object[] { "hsl-h30-sn30-l20", "8B2DD6C3-EB07-4D87-A5F0-7108E26A9C5F", I(30, -30, 20) },
        };
        var json = new StringBuilder("[");
        foreach (var c in cases) {
            string name = (string)c[0];
            IntPtr effect = c[1] == null ? IntPtr.Zero : Effect((string)c[1], (byte[])c[2]);
            foreach (int backdrop in new int[] { unchecked((int)0xFFE0E8F0), unchecked((int)0xFF000001) }) {
                // 0xFF000001 selects a premultiplied source onto black (the stored value is then the premultiplied result itself).
                int actual = backdrop == unchecked((int)0xFF000001) ? unchecked((int)0xFF000000) : backdrop;
                bool premultiplied = actual != backdrop;
                IntPtr src = Source(premultiplied ? Pargb32 : Argb32), dst;
                Ok(GdipCreateBitmapFromScan0(256, 256, 0, Argb32, IntPtr.Zero, out dst), "dst");
                IntPtr g; Ok(GdipGetImageGraphicsContext(dst, out g), "ctx");
                Ok(GdipGraphicsClear(g, actual), "clear");
                IntPtr m; Ok(GdipCreateMatrix2(1, 0, 0, 1, 0, 0, out m), "matrix");
                var rect = new RectF(); rect.Width = 256; rect.Height = 256;
                Ok(GdipDrawImageFX(g, src, ref rect, m, effect, IntPtr.Zero, 2), "drawfx");
                GdipDeleteMatrix(m); GdipDeleteGraphics(g);
                if (json.Length > 1) json.Append(',');
                json.Append("{\"name\":\"").Append(name).Append("\",\"kind\":\"drawn\",\"premultiplied\":").Append(premultiplied ? "true" : "false").Append(",\"backdrop\":").Append(((uint)actual).ToString(CultureInfo.InvariantCulture))
                    .Append(",\"bgra\":\"").Append(Pixels(dst)).Append("\"}");
                GdipDisposeImage(dst); GdipDisposeImage(src);
            }
            if (effect != IntPtr.Zero) { GdipDeleteEffect(effect); }
        }
        var data = Encoding.UTF8.GetBytes(json.Append(']').ToString());
        using (var file = File.Create(Path.Combine(directory, "effect-alpha.json.gz")))
        using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress)) zip.Write(data, 0, data.Length);
    }
}
