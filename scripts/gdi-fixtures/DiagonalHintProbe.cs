// Public GDI GetGlyphOutline controls for private generated TrueType diagnostic fonts.
using System;using System.Runtime.InteropServices;using System.IO;using System.Text;
public static class DiagonalHintProbe {
 [StructLayout(LayoutKind.Sequential)]struct Fixed{public ushort fract;public short value;}
 [StructLayout(LayoutKind.Sequential)]struct Mat{public Fixed xx,xy,yx,yy;}
 [StructLayout(LayoutKind.Sequential)]struct Point{public int x,y;}
 [StructLayout(LayoutKind.Sequential)]struct Metrics{public uint blackX,blackY;public Point origin;public short incX,incY;}
 [DllImport("gdi32.dll",CharSet=CharSet.Unicode)]static extern int AddFontResourceEx(string file,uint flags,IntPtr reserved);
 [DllImport("gdi32.dll",CharSet=CharSet.Unicode)]static extern bool RemoveFontResourceEx(string file,uint flags,IntPtr reserved);
 [DllImport("gdi32.dll")]static extern IntPtr CreateCompatibleDC(IntPtr dc);
 [DllImport("gdi32.dll")]static extern bool DeleteDC(IntPtr dc);
 [DllImport("gdi32.dll",CharSet=CharSet.Unicode)]static extern IntPtr CreateFont(int height,int width,int escape,int orientation,int weight,uint italic,uint underline,uint strike,uint charset,uint outprec,uint clipprec,uint quality,uint pitch,string face);
 [DllImport("gdi32.dll")]static extern IntPtr SelectObject(IntPtr dc,IntPtr o);
 [DllImport("gdi32.dll")]static extern bool DeleteObject(IntPtr o);
 [DllImport("gdi32.dll",CharSet=CharSet.Unicode)]static extern int GetTextFace(IntPtr dc,int n,StringBuilder face);
 [DllImport("gdi32.dll",CharSet=CharSet.Unicode)]static extern uint GetGlyphOutline(IntPtr dc,uint ch,uint format,out Metrics gm,uint len,byte[] buf,ref Mat mat);
 public static void Run(string dir) {
  var json = new StringBuilder("[");
  foreach (string kind in new[] { "movement", "projection", "vectors" }) {
   string file = Path.Combine(dir, "diagonal-" + kind + ".ttf");
   string family = "Parity Diagonal " + char.ToUpperInvariant(kind[0]) + kind.Substring(1);
   if (AddFontResourceEx(file, 16, IntPtr.Zero) == 0) throw new Exception("Private font load failed");
   IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
   try {
    foreach (int size in new[] { 16, 23, 32, 41 }) {
     IntPtr font = CreateFont(-size, 0, 0, 0, 400, 0, 0, 0, 1, 4, 0, 0, 0, family);
     IntPtr old = SelectObject(dc, font);
     try {
      var face = new StringBuilder(100);
      GetTextFace(dc, 100, face);
      if (face.ToString() != family) throw new Exception("Font fallback: " + face);
      for (uint glyph = 0; glyph < 36; glyph++) {
       var matrix = new Mat();
       matrix.xx.value = matrix.yy.value = 1;
       Metrics metrics;
       uint length = GetGlyphOutline(dc, 0xE000 + glyph, 2, out metrics, 0, null, ref matrix);
       if (length == 0xFFFFFFFF) throw new Exception("GetGlyphOutline count failed");
       var data = new byte[length];
       if (GetGlyphOutline(dc, 0xE000 + glyph, 2, out metrics, length, data, ref matrix) != length)
        throw new Exception("GetGlyphOutline failed");
       if (json.Length > 1) json.Append(',');
       json.Append("{\"kind\":\"").Append(kind).Append("\",\"size\":").Append(size)
        .Append(",\"index\":").Append(glyph + 1).Append(",\"native\":\"")
        .Append(Convert.ToBase64String(data)).Append("\"}");
      }
     } finally {
      SelectObject(dc, old);
      DeleteObject(font);
     }
    }
   } finally {
    DeleteDC(dc);
    RemoveFontResourceEx(file, 16, IntPtr.Zero);
   }
  }
  byte[] bytes = Encoding.UTF8.GetBytes(json.Append(']').ToString());
  using (var file = File.Create(Path.Combine(dir, "text-diagonal-hinting.json.gz")))
  using (var zip = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Compress))
   zip.Write(bytes, 0, bytes.Length);
 }
}
