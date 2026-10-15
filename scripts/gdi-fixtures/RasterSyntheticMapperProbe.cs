// Synthetic raster (.fnt) families for isolating the GDI raster font mapper's width and height terms.
//
// RasterMapperProbe.cs measures the installed .fon faces, whose heights, widths and weights all differ at once. Here a
// private family (AddFontResourceEx with FR_PRIVATE) is made of bare version 2.0 .fnt files whose pixel height, internal
// leading, average width, maximum width and weight are chosen by the caller, so one variable can be swept with every
// other held fixed. The glyph bitmaps are blank: only GetTextMetrics (which face and which integer stretch the mapper
// chose) is read.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class RasterSyntheticMapperProbe
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct LogFont { public int h, w, esc, ori, weight; public byte it, ul, so, cs, op, cp, q, pf; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string face; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct TextMetric { public int tmHeight, tmAscent, tmDescent, tmInternalLeading, tmExternalLeading, tmAveCharWidth, tmMaxCharWidth, tmWeight, tmOverhang, tmDigitizedAspectX, tmDigitizedAspectY; public ushort tmFirstChar, tmLastChar, tmDefaultChar, tmBreakChar; public byte tmItalic, tmUnderlined, tmStruckOut, tmPitchAndFamily, tmCharSet; }
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateFontIndirectW(ref LogFont lf);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool GetTextMetricsW(IntPtr dc, out TextMetric tm);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern int AddFontResourceExW(string file, uint flags, IntPtr reserved);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool RemoveFontResourceExW(string file, uint flags, IntPtr reserved);

    public class Spec
    {
        public int Pix, Leading, Avg, Max, Weight = 400, Points = 10, VertRes = 96, HorizRes = 96;
        public bool Italic;
    }

    /// <summary>Spec text "pix:leading:avg:max[:weight[:vertRes[:horizRes]]]" for one face.</summary>
    public static Spec Parse(string s)
    {
        string[] p = s.Split(':');
        var f = new Spec { Pix = int.Parse(p[0]), Leading = int.Parse(p[1]), Avg = int.Parse(p[2]), Max = int.Parse(p[3]) };
        if (p.Length > 4) f.Weight = int.Parse(p[4]);
        if (p.Length > 5) f.VertRes = int.Parse(p[5]);
        if (p.Length > 6) f.HorizRes = int.Parse(p[6]);
        f.Points = (f.Pix - f.Leading) * 72 / f.VertRes;
        return f;
    }

    static byte[] BuildFnt(string family, Spec f)
    {
        const int first = 32, last = 126;
        int count = last - first + 2;
        int cols = (f.Max + 7) / 8;
        int glyphBytes = cols * f.Pix;
        int tableOff = 118;
        int faceOff = tableOff + count * 4;
        int bitsOff = faceOff + family.Length + 1;
        bitsOff = (bitsOff + 1) & ~1;
        int total = bitsOff + (count) * glyphBytes;
        var b = new byte[total];
        Action<int, int> u16 = (o, v) => { b[o] = (byte)v; b[o + 1] = (byte)(v >> 8); };
        Action<int, long> u32 = (o, v) => { u16(o, (int)(v & 0xffff)); u16(o + 2, (int)((v >> 16) & 0xffff)); };
        u16(0, 0x200); u32(2, total);
        u16(66, 0); u16(68, f.Points); u16(70, f.VertRes); u16(72, f.HorizRes);
        u16(74, f.Pix - Math.Max(1, f.Pix / 5)); // ascent
        u16(76, f.Leading); u16(78, 0);
        b[80] = (byte)(f.Italic ? 1 : 0); b[81] = 0; b[82] = 0;
        u16(83, f.Weight); b[85] = 0;
        u16(86, f.Avg == f.Max ? f.Avg : 0); u16(88, f.Pix);
        b[90] = (byte)(f.Avg == f.Max ? 0x30 : 0x31); // FF_MODERN fixed / variable
        u16(91, f.Avg); u16(93, f.Max);
        b[95] = first; b[96] = last; b[97] = (byte)('.' - first); b[98] = (byte)(' ' - first);
        u16(99, cols); u32(101, 0); u32(105, faceOff); u32(109, 0); u32(113, bitsOff);
        for (int i = 0; i < count; i++)
        {
            int w = i == count - 1 ? 0 : f.Avg;
            u16(tableOff + i * 4, w); u16(tableOff + i * 4 + 2, bitsOff + i * glyphBytes);
        }
        var nameBytes = Encoding.ASCII.GetBytes(family);
        Array.Copy(nameBytes, 0, b, faceOff, nameBytes.Length);
        return b;
    }

    /// <summary>
    /// Makes the family, then for each (height, width) request returns "height,width,tmHeight,tmAveCharWidth,tmMaxCharWidth,tmWeight".
    /// Faces are separated by '|' in the face list; heights and widths are comma separated; weight and italic apply to the request.
    /// </summary>
    public static string[] Sweep(string dir, string family, string faceSpecs, int[] heights, int[] widths, int weight)
    {
        Directory.CreateDirectory(dir);
        var files = new List<string>();
        int n = 0;
        foreach (string fs in faceSpecs.Split('|'))
        {
            string path = Path.Combine(dir, family.Replace(' ', '_') + "-" + (n++) + ".fnt");
            File.WriteAllBytes(path, BuildFnt(family, Parse(fs)));
            files.Add(path);
        }
        foreach (string path in files)
            if (AddFontResourceExW(path, 0x10, IntPtr.Zero) == 0) throw new Exception("AddFontResourceEx failed for " + path);
        var output = new List<string>();
        IntPtr screen = GetDC(IntPtr.Zero);
        IntPtr dc = CreateCompatibleDC(screen);
        try
        {
            foreach (int h in heights)
            foreach (int w in widths)
            {
                var lf = new LogFont { h = h, w = w, weight = weight, cs = 1, face = family, q = 3 };
                IntPtr font = CreateFontIndirectW(ref lf);
                IntPtr old = SelectObject(dc, font);
                TextMetric t; GetTextMetricsW(dc, out t);
                output.Add(h + "," + w + "," + t.tmHeight + "," + t.tmAveCharWidth + "," + t.tmMaxCharWidth + "," + t.tmWeight);
                SelectObject(dc, old); DeleteObject(font);
            }
        }
        finally
        {
            DeleteDC(dc); ReleaseDC(IntPtr.Zero, screen);
            foreach (string path in files) { RemoveFontResourceExW(path, 0x10, IntPtr.Zero); try { File.Delete(path); } catch { } }
        }
        return output.ToArray();
    }

    /// <summary>Face tables (pix:leading:avg:max:weight:vertRes:horizRes) of the installed raster families the fixtures use, as GetTextMetrics-visible attributes.</summary>
    static readonly string[] FamilyOrder = { "MS Sans Serif", "MS Serif", "Courier", "Small Fonts", "System", "Fixedsys" };
    static readonly Dictionary<string, string[]> Families = new Dictionary<string, string[]>
    {
        { "MS Sans Serif", new[] { "13:2:5:11:400:96:96", "16:3:7:14:400:96:96", "20:4:8:16:400:96:96", "24:6:9:19:400:96:96", "29:5:12:24:400:96:96", "37:5:16:32:400:96:96", "16:3:7:14:400:120:120", "20:4:8:18:400:120:120", "25:5:10:21:400:120:120", "29:6:12:24:400:120:120", "36:6:15:30:400:120:120", "46:6:20:40:400:120:120" } },
        { "MS Serif", new[] { "13:2:5:11:400:96:96", "16:3:6:14:400:96:96", "19:3:8:18:400:96:96", "21:3:9:17:400:96:96", "27:3:12:23:400:96:96", "35:3:16:33:400:96:96", "16:3:6:14:400:120:120", "20:4:8:18:400:120:120", "23:3:10:21:400:120:120", "27:4:12:23:400:120:120", "33:3:14:30:400:120:120", "43:3:19:39:400:120:120", "10:2:4:8:400:96:96", "11:2:5:9:400:96:96" } },
        { "Courier", new[] { "13:0:8:8:400:96:96", "16:0:9:9:400:96:96", "20:0:12:12:400:96:96", "16:0:9:9:400:120:120", "20:0:12:12:400:120:120", "25:0:15:15:400:120:120" } },
        { "Small Fonts", new[] { "3:0:1:2:400:96:96", "5:1:3:4:400:96:96", "6:1:3:13:400:96:96", "8:1:4:7:400:96:96", "10:2:4:8:400:96:96", "11:2:5:9:400:96:96", "3:0:1:2:400:120:120", "6:1:3:5:400:120:120", "8:1:4:7:400:120:120", "10:2:5:9:400:120:120", "12:2:5:10:400:120:120", "13:2:6:12:400:120:120" } },
        { "System", new[] { "16:3:7:14:700:96:96", "20:4:9:17:700:120:120" } },
        { "Fixedsys", new[] { "15:3:8:8:400:96:96", "20:2:10:10:400:96:96" } },
    };

    static string Ints(IEnumerable<int> values) { return "[" + string.Join(",", values) + "]"; }

    static int RoundHalfUp(int w, int avg, int cap) { return Math.Min(cap, Math.Max(1, (2 * w + avg) / (2 * avg))); }

    /// <summary>
    /// The measurements behind the raster mapper model (src/raster-mapper.ts), written to raster-mapper-synthetic.json.gz:
    /// "replicas" (the six installed families rebuilt as private synthetic families, every lfHeight -130..-4 and 4..130 at
    /// fifteen lfWidth values; they reproduce the native captures of the installed fonts exactly), "single" (one face swept
    /// over lfWidth: the horizontal factor), "gating" (the lfHeight at which a single face takes the next vertical factor,
    /// for character and cell heights and two leadings), "allow" (which vertical factors a face of each height may take),
    /// "pairs" (two faces of one height whose horizontal factors differ: which one wins, for vertical factors 1 to 8) and
    /// "random" (random four-face families, with weights, leading and positive and negative heights).
    /// </summary>
    public static void Run(string outDir)
    {
        string work = Path.Combine(Path.GetTempPath(), "raster-synthetic-" + Guid.NewGuid().ToString("N"));
        var sb = new StringBuilder("{");
        // families (face tables) and replicas
        sb.Append("\"families\":{");
        for (int f = 0; f < FamilyOrder.Length; f++)
        {
            if (f > 0) sb.Append(',');
            sb.Append('"').Append(FamilyOrder[f]).Append("\":[");
            sb.Append(string.Join(",", Array.ConvertAll(Families[FamilyOrder[f]], s => "\"" + s + "\"")));
            sb.Append(']');
        }
        sb.Append("},");
        var heights = new List<int>();
        for (int h = -130; h <= -4; h++) heights.Add(h);
        for (int h = 4; h <= 130; h++) heights.Add(h);
        int[] widths = { 0, 1, 2, 3, 5, 8, 12, 13, 17, 20, 24, 29, 36, 43, 55 };
        sb.Append("\"replicaHeights\":").Append(Ints(heights)).Append(",\"replicaWidths\":").Append(Ints(widths)).Append(",\"replicas\":{");
        for (int f = 0; f < FamilyOrder.Length; f++)
        {
            string[] rows = Sweep(work, "ZZRaster", string.Join("|", Families[FamilyOrder[f]]), heights.ToArray(), widths, 400);
            var tm = new List<int>();
            foreach (string r in rows) { string[] p = r.Split(','); tm.Add(int.Parse(p[2])); tm.Add(int.Parse(p[3])); }
            if (f > 0) sb.Append(',');
            sb.Append('"').Append(FamilyOrder[f]).Append("\":").Append(Ints(tm));
        }
        sb.Append("},");
        // single face: horizontal factor
        sb.Append("\"single\":{");
        int[] singleHeights = { -6, -13, -26 };
        string[] singles = Sweep(work, "ZZRaster", "13:0:8:8", singleHeights, SeqInts(1, 60), 400);
        var singleTm = new List<int>();
        foreach (string r in singles) singleTm.Add(int.Parse(r.Split(',')[3]));
        sb.Append("\"face\":\"13:0:8:8\",\"heights\":").Append(Ints(singleHeights)).Append(",\"avg\":").Append(Ints(singleTm)).Append("},");
        // gating thresholds
        sb.Append("\"gating\":[");
        bool first = true;
        foreach (var mode in new[] { new[] { 0, 0 }, new[] { 0, 3 }, new[] { 1, 2 } })
        {
            bool positive = mode[0] == 1; int il = mode[1];
            for (int pix = 3; pix <= 40; pix++)
            {
                int unit = positive ? pix : pix - il;
                if (unit < 1) continue;
                int max = unit * 6 + 5;
                var hs = new List<int>();
                for (int t = 1; t <= max; t++) hs.Add(positive ? t : -t);
                string[] rows = Sweep(work, "ZZRaster", pix + ":" + il + ":8:8", hs.ToArray(), new[] { 0 }, 400);
                var th = new List<int>();
                int prev = 0;
                foreach (string r in rows)
                {
                    string[] p = r.Split(',');
                    int t = Math.Abs(int.Parse(p[0])); int cell = int.Parse(p[2]);
                    if (cell % pix != 0) break;
                    int ky = cell / pix;
                    if (ky != prev) { if (prev > 0) th.Add(t); prev = ky; }
                }
                if (!first) sb.Append(',');
                first = false;
                sb.Append("[").Append(positive ? 1 : 0).Append(',').Append(pix).Append(',').Append(il).Append(',').Append(Ints(th)).Append(']');
            }
        }
        sb.Append("],");
        // which vertical factors a face may take: a face of height u against an exact unstretched face of avg 300, at the width its own factor would give
        sb.Append("\"allow\":[");
        for (int u = 1; u <= 16; u++)
        {
            var line = new StringBuilder();
            for (int ky = 1; ky <= 8; ky++)
            {
                int t = u * ky; int w = Math.Min(5, ky) * 8;
                string[] rows = Sweep(work, "ZZRaster", t + ":0:300:300|" + u + ":0:8:8", new[] { -t }, new[] { w }, 400);
                line.Append(int.Parse(rows[0].Split(',')[3]) == 300 ? '.' : 'Y');
            }
            if (u > 1) sb.Append(',');
            sb.Append('"').Append(line).Append('"');
        }
        sb.Append("],");
        // pairs
        var rnd = new Random(20261016);
        sb.Append("\"pairs\":[");
        string[] pairNames = { "1-2", "1-3", "1-4", "1-5", "2-3", "2-4", "2-5", "3-4", "3-5", "4-5" };
        bool firstPair = true;
        for (int ky = 1; ky <= 8; ky++)
        foreach (string pn in pairNames)
        {
            int I = int.Parse(pn.Split('-')[0]), J = int.Parse(pn.Split('-')[1]);
            int done = 0, guard = 0;
            while (done < 40 && guard++ < 40000)
            {
                int w = rnd.Next(30, 260);
                int alo = I == 1 ? w / 2 + 1 : (int)Math.Floor(w / (I + 0.5)) + 1;
                int ahi = I == 1 ? w * 2 : (int)Math.Floor(w / (I - 0.5));
                int blo = (int)Math.Floor(w / (J + 0.5)) + 1, bhi = (int)Math.Floor(w / (J - 0.5));
                if (alo > ahi || blo > bhi || blo < 3) continue;
                int a = rnd.Next(alo, ahi + 1), b = rnd.Next(blo, bhi + 1);
                if (RoundHalfUp(w, a, 5) != I || RoundHalfUp(w, b, 5) != J || a * I == b * J) continue;
                int pix = 13;
                string[] rows = Sweep(work, "ZZRaster", pix + ":0:" + a + ":" + a + "|" + pix + ":0:" + b + ":" + b, new[] { -pix * ky }, new[] { w }, 400);
                string[] p = rows[0].Split(',');
                int cell = int.Parse(p[2]), avg = int.Parse(p[3]);
                int win = avg == a * I ? 0 : avg == b * J ? 1 : -1;
                if (win < 0 || cell != pix * ky) continue;
                if (!firstPair) sb.Append(',');
                firstPair = false;
                sb.Append('[').Append(ky).Append(',').Append(I).Append(',').Append(J).Append(',').Append(w).Append(',').Append(a).Append(',').Append(b).Append(',').Append(win).Append(']');
                done++;
            }
        }
        sb.Append("],");
        // random families
        sb.Append("\"random\":[");
        for (int c = 0; c < 30; c++)
        {
            bool weights = c >= 20;
            var specs = new List<string>();
            for (int i = 0; i < 4; i++)
            {
                int pix = rnd.Next(6, 51);
                int il = rnd.Next(0, Math.Max(1, pix / 4) + 1);
                int avg = rnd.Next(2, Math.Max(4, (int)(pix * 0.9)));
                int wt = weights && rnd.Next(0, 3) == 0 ? 700 : 400;
                specs.Add(pix + ":" + il + ":" + avg + ":" + avg + ":" + wt);
            }
            var hs = new List<int>();
            for (int k = 0; k < 10; k++) { int h = rnd.Next(4, 90); hs.Add(c % 2 == 0 ? -h : (rnd.Next(0, 2) == 0 ? h : -h)); }
            int req = weights && rnd.Next(0, 2) == 0 ? 700 : 400;
            var ws = new List<int> { 0 };
            for (int w = 1; w <= 70; w += 3) ws.Add(w);
            string[] rows = Sweep(work, "ZZRaster", string.Join("|", specs), hs.ToArray(), ws.ToArray(), req);
            var tm = new List<int>();
            foreach (string r in rows) { string[] p = r.Split(','); tm.Add(int.Parse(p[2])); tm.Add(int.Parse(p[3])); }
            if (c > 0) sb.Append(',');
            sb.Append("{\"faces\":").Append('[').Append(string.Join(",", specs.ConvertAll(s => "\"" + s + "\""))).Append("],\"request\":").Append(req)
              .Append(",\"heights\":").Append(Ints(hs)).Append(",\"widths\":").Append(Ints(ws)).Append(",\"tm\":").Append(Ints(tm)).Append('}');
        }
        sb.Append("]}");
        try { Directory.Delete(work, true); } catch { }
        using (var file = File.Create(Path.Combine(outDir, "raster-mapper-synthetic.json.gz")))
        using (var gz = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionLevel.Optimal))
        {
            var bytes = new UTF8Encoding(false).GetBytes(sb.ToString());
            gz.Write(bytes, 0, bytes.Length);
        }
    }

    static int[] SeqInts(int from, int to)
    {
        var a = new int[to - from + 1];
        for (int i = 0; i < a.Length; i++) a[i] = from + i;
        return a;
    }
}
