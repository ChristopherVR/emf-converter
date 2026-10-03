// Public Windows GDI GetPath controls: fractional PS_INSIDEFRAME RoundRects in both arc directions.
using System;using System.IO;using System.Runtime.InteropServices;using System.Text;
public static class HalfFixRoundRectTranslationProbe {
 [StructLayout(LayoutKind.Sequential)]struct Point{public int X,Y;}
 [DllImport("gdi32.dll")]static extern IntPtr CreateCompatibleDC(IntPtr dc);
 [DllImport("gdi32.dll")]static extern bool DeleteDC(IntPtr dc);
 [DllImport("gdi32.dll")]static extern IntPtr CreatePen(int style,int width,uint color);
 [DllImport("gdi32.dll")]static extern IntPtr SelectObject(IntPtr dc,IntPtr o);
 [DllImport("gdi32.dll")]static extern bool DeleteObject(IntPtr o);
 [DllImport("gdi32.dll")]static extern int SetMapMode(IntPtr dc,int m);
 [DllImport("gdi32.dll")]static extern int SetGraphicsMode(IntPtr dc,int m);
 [DllImport("gdi32.dll")]static extern bool SetWindowExtEx(IntPtr dc,int x,int y,IntPtr o);
 [DllImport("gdi32.dll")]static extern bool SetViewportExtEx(IntPtr dc,int x,int y,IntPtr o);
 [DllImport("gdi32.dll")]static extern int SetArcDirection(IntPtr dc,int direction); [DllImport("gdi32.dll")]static extern bool BeginPath(IntPtr dc);
 [DllImport("gdi32.dll")]static extern bool EndPath(IntPtr dc);
 [DllImport("gdi32.dll")]static extern bool RoundRect(IntPtr dc,int l,int t,int r,int b,int w,int h);
 [DllImport("gdi32.dll")]static extern int GetPath(IntPtr dc,[Out]Point[] p,[Out]byte[] t,int n);
 public static void Run(string dir) {
  Directory.CreateDirectory(dir);
  var json = new StringBuilder("[");
  IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
  try {
   SetGraphicsMode(dc, 2);
   foreach (int direction in new[] { 1, 2 })
   foreach (int scale in new[] { 17, 23 })
   foreach (int shift in new[] { 0, 1024, -1024 })
   for (int sample = 0; sample < 48; sample++) {
    SetArcDirection(dc, direction);
    int width = 3; int l = 20 + shift, t = 30;
    int r = l + 80, b = t + 60;
    int cw = 12, ch = sample + 1;
    SetMapMode(dc, 8);
    SetWindowExtEx(dc, 16, 16, IntPtr.Zero);
    SetViewportExtEx(dc, scale, scale, IntPtr.Zero);
    IntPtr pen = CreatePen(6, width, 0), old = SelectObject(dc, pen);
    try {
     if (!BeginPath(dc) || !RoundRect(dc, l, t, r, b, cw, ch) || !EndPath(dc))
      throw new Exception("RoundRect path capture failed");
     // Read the retained device path in FIX units through the public mapping API.
     SetWindowExtEx(dc, 16, 16, IntPtr.Zero);
     SetViewportExtEx(dc, 1, 1, IntPtr.Zero);
     int count = GetPath(dc, null, null, 0);
     if (count < 0) throw new Exception("GetPath count failed");
     var points = new Point[count];
     var types = new byte[count];
     if (GetPath(dc, points, types, count) != count) throw new Exception("GetPath failed");
     if (json.Length > 1) json.Append(',');
     json.Append("{\"direction\":").Append(direction).Append(",\"scale\":").Append(scale)
      .Append(",\"width\":").Append(width).Append(",\"corner\":[").Append(cw).Append(',').Append(ch)
      .Append("],\"box\":[").Append(l).Append(',').Append(t).Append(',').Append(r).Append(',').Append(b)
      .Append("],\"expected\":[");
     for (int i = 0; i < count; i++) {
      if (i > 0) json.Append(',');
      json.Append(points[i].X).Append(',').Append(points[i].Y).Append(',').Append(types[i]);
     }
     json.Append("]}");
    } finally {
     SelectObject(dc, old);
     DeleteObject(pen);
    }
   }
   byte[] data = Encoding.UTF8.GetBytes(json.Append(']').ToString());
   using (var stream = File.Create(Path.Combine(dir, "roundrect-half-fix-translation.json.gz")))
   using (var zip = new System.IO.Compression.GZipStream(stream, System.IO.Compression.CompressionMode.Compress))
    zip.Write(data, 0, data.Length);
  } finally {
   DeleteDC(dc);
  }
 }
}
