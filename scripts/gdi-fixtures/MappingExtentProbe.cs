// Run: powershell.exe -NoProfile -Command "Add-Type -Path scripts/gdi-fixtures/MappingExtentProbe.cs; [MappingExtentProbe]::Run('src/__fixtures__/gdi/mapping-extents.json')"
// Native extent state and complete aliased polygon masks after rational scaling.
// Both successful signed updates and rejected updates are captured; references
// are measured from a DIB rather than calculated from the expected extents.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class MappingExtentProbe
{
    [StructLayout(LayoutKind.Sequential)] struct Size { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; public Point(int a, int b) { x = a; y = b; } }
    [StructLayout(LayoutKind.Sequential)] struct BitmapInfo { public int size, width, height; public short planes, depth; public int compression, bytes, x, y, colors, important; }
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern int SetMapMode(IntPtr dc, int mode);
    [DllImport("gdi32.dll")] static extern bool SetWindowExtEx(IntPtr dc, int x, int y, IntPtr prev);
    [DllImport("gdi32.dll")] static extern bool SetViewportExtEx(IntPtr dc, int x, int y, IntPtr prev);
    [DllImport("gdi32.dll")] static extern bool SetViewportOrgEx(IntPtr dc, int x, int y, IntPtr prev);
    [DllImport("gdi32.dll")] static extern bool ScaleWindowExtEx(IntPtr dc, int xn, int xd, int yn, int yd, IntPtr prev);
    [DllImport("gdi32.dll")] static extern bool ScaleViewportExtEx(IntPtr dc, int xn, int xd, int yn, int yd, IntPtr prev);
    [DllImport("gdi32.dll")] static extern bool GetWindowExtEx(IntPtr dc, out Size extent);
    [DllImport("gdi32.dll")] static extern bool GetViewportExtEx(IntPtr dc, out Size extent);
    [DllImport("gdi32.dll")] static extern IntPtr GetStockObject(int obj);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BitmapInfo info, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] static extern bool Polygon(IntPtr dc, Point[] points, int count);
    [DllImport("gdi32.dll")] static extern bool GdiFlush();

    public static void Run(string destination)
    {
        int[][] ratios = {
            new[] { 1, 2, 2, 3 }, new[] { -1, 2, 1, 3 }, new[] { 2, -3, 3, -2 },
            new[] { 5, 3, 7, 4 }, new[] { 3, 2, 5, 2 }, new[] { 0, 1, 2, 1 },
            new[] { 2, 1, 0, 1 }, new[] { 1, 0, 3, 2 }, new[] { 3, 2, 1, 0 }
        };
        var json = new StringBuilder("[\n");
        int index = 0;
        foreach (bool viewport in new[] { false, true })
        foreach (int sign in new[] { -1, 1 })
        foreach (int extent in new[] { 1, 3, 5, 7, 11, 31, 101 })
        foreach (int[] ratio in ratios) {
            IntPtr dc = CreateCompatibleDC(IntPtr.Zero), bits;
            var info = new BitmapInfo { size = 40, width = 96, height = -96, planes = 1, depth = 32 };
            IntPtr bitmap = CreateDIBSection(dc, ref info, 0, out bits, IntPtr.Zero, 0);
            if (dc == IntPtr.Zero || bitmap == IntPtr.Zero) throw new Exception("Native DIB creation failed");
            IntPtr old = SelectObject(dc, bitmap);
            try {
                byte[] pixels = new byte[96 * 96 * 4];
                for (int i = 0; i < pixels.Length; i++) pixels[i] = 255;
                Marshal.Copy(pixels, 0, bits, pixels.Length);
                SetMapMode(dc, 8);
                int wx = viewport ? 31 : sign * extent, wy = viewport ? 29 : -sign * (extent + 2);
                int vx = viewport ? sign * extent : 61, vy = viewport ? -sign * (extent + 2) : 59;
                SetWindowExtEx(dc, wx, wy, IntPtr.Zero);
                SetViewportExtEx(dc, vx, vy, IntPtr.Zero);
                int origin = viewport ? 48 : 16;
                SetViewportOrgEx(dc, origin, origin, IntPtr.Zero);
                bool success = viewport
                    ? ScaleViewportExtEx(dc, ratio[0], ratio[1], ratio[2], ratio[3], IntPtr.Zero)
                    : ScaleWindowExtEx(dc, ratio[0], ratio[1], ratio[2], ratio[3], IntPtr.Zero);
                Size win, vp;
                GetWindowExtEx(dc, out win); GetViewportExtEx(dc, out vp);
                SelectObject(dc, GetStockObject(4)); // BLACK_BRUSH
                SelectObject(dc, GetStockObject(8)); // NULL_PEN
                // Use the measured window extent as a logical box so all four
                // device edges are integral. This isolates the scale update
                // from GM_COMPATIBLE's separate fractional-vertex snapping.
                if (!Polygon(dc, new[] { new Point(0, 0), new Point(win.x, 0), new Point(win.x, win.y), new Point(0, win.y) }, 4))
                    throw new Exception("Native Polygon failed");
                GdiFlush();
                Marshal.Copy(bits, pixels, 0, pixels.Length);
                if (index++ != 0) json.Append(",\n");
                json.Append("{\"viewport\":" + (viewport ? "true" : "false") + ",\"initial\":[" + wx + "," + wy + "," + vx + "," + vy + "],\"ratio\":[" + string.Join(",", ratio) + "],\"success\":" + (success ? "true" : "false") + ",\"extent\":[" + win.x + "," + win.y + "," + vp.x + "," + vp.y + "],\"origin\":[" + origin + "," + origin + "],\"spans\":[");
                bool comma = false;
                for (int y = 0; y < 96; y++) {
                    int start = -1;
                    for (int x = 0; x <= 96; x++) {
                        bool black = x < 96 && pixels[(y * 96 + x) * 4] == 0;
                        if (black && start < 0) start = x;
                        if (!black && start >= 0) {
                            if (comma) json.Append(',');
                            json.Append('[').Append(y).Append(',').Append(start).Append(',').Append(x).Append(']');
                            comma = true; start = -1;
                        }
                    }
                }
                json.Append("]}");
            } finally {
                SelectObject(dc, old); DeleteObject(bitmap); DeleteDC(dc);
            }
        }
        json.Append("\n]\n");
        File.WriteAllText(destination, json.ToString(), new UTF8Encoding(false));
        Console.WriteLine("Captured " + index + " native scaling states and masks");
        RunLarge(Path.Combine(Path.GetDirectoryName(destination), "mapping-extents-large.json"));
    }

    static void RunLarge(string destination)
    {
        int[][] cases = {
            new[] { int.MaxValue, 2, 1 }, new[] { int.MaxValue, int.MaxValue - 1, int.MaxValue },
            new[] { int.MaxValue, int.MaxValue - 2, int.MaxValue - 1 }, new[] { int.MinValue, 1, -1 },
            new[] { 1000000007, 1000000009, 1000000011 }, new[] { -1000000007, 1000000009, 1000000011 },
            new[] { 65537, 65537, 3 }, new[] { -65537, 65537, 3 },
            new[] { int.MaxValue, -2, 1 }, new[] { int.MinValue, 2, 1 },
            new[] { 1073741824, 2, 1 }, new[] { 1073741824, 2, -1 }
        };
        var json = new StringBuilder("[\n");
        int index = 0;
        foreach (bool viewport in new[] { false, true })
        foreach (int[] c in cases) {
            IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
            try {
                SetMapMode(dc, 8);
                int wx = viewport ? 31 : c[0], wy = viewport ? 29 : 101;
                int vx = viewport ? c[0] : 61, vy = viewport ? 101 : 59;
                SetWindowExtEx(dc, wx, wy, IntPtr.Zero); SetViewportExtEx(dc, vx, vy, IntPtr.Zero);
                bool success = viewport ? ScaleViewportExtEx(dc, c[1], c[2], 1, 3, IntPtr.Zero)
                    : ScaleWindowExtEx(dc, c[1], c[2], 1, 3, IntPtr.Zero);
                Size win, vp; GetWindowExtEx(dc, out win); GetViewportExtEx(dc, out vp);
                if (index++ != 0) json.Append(",\n");
                json.Append("{\"viewport\":" + (viewport ? "true" : "false") + ",\"initial\":[" + wx + "," + wy + "," + vx + "," + vy + "],\"ratio\":[" + c[1] + "," + c[2] + ",1,3],\"success\":" + (success ? "true" : "false") + ",\"extent\":[" + win.x + "," + win.y + "," + vp.x + "," + vp.y + "]}");
            } finally { DeleteDC(dc); }
        }
        File.WriteAllText(destination, json.Append("\n]\n").ToString(), new UTF8Encoding(false));
        Console.WriteLine("Captured " + index + " native signed 32-bit boundary states");
    }
}
