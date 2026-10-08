using System;
using System.IO;
using System.Runtime.InteropServices;

/// <summary>
/// Runs Windows ICM (mscms.dll) CMYK -> sRGB on a file of CMYK quads, to learn whether GDI+'s CMYK JPEG conversion is
/// the Windows colour-management module. Input: raw bytes C, M, Y, K per sample (ink amounts); output per variant:
/// raw B, G, R, X per sample. Variants cover every intent, transform flags and both sample polarities.
/// </summary>
public static class IcmProbe
{
	[StructLayout(LayoutKind.Sequential)]
	struct PROFILE { public uint dwType; public IntPtr pProfileData; public uint cbDataSize; }
	[DllImport("mscms.dll", CharSet = CharSet.Unicode, SetLastError = true)]
	static extern IntPtr OpenColorProfileW(ref PROFILE p, uint access, uint share, uint create);
	[DllImport("mscms.dll", SetLastError = true)]
	static extern bool CloseColorProfile(IntPtr h);
	[DllImport("mscms.dll", SetLastError = true)]
	static extern IntPtr CreateMultiProfileTransform(IntPtr[] profiles, uint n, uint[] intents, uint nIntents, uint flags, uint indexPreferredCMM);
	[DllImport("mscms.dll", SetLastError = true)]
	static extern bool DeleteColorTransform(IntPtr t);
	[DllImport("mscms.dll", SetLastError = true)]
	static extern bool TranslateBitmapBits(IntPtr t, byte[] src, uint srcFmt, uint w, uint h, uint srcStride, byte[] dst, uint dstFmt, uint dstStride, IntPtr cb, IntPtr lp);
	[DllImport("mscms.dll", CharSet = CharSet.Unicode, SetLastError = true)]
	static extern bool GetStandardColorSpaceProfileW(string machine, uint id, System.Text.StringBuilder name, ref uint size);
	[DllImport("mscms.dll", SetLastError = true)]
	static extern bool TranslateColors(IntPtr t, byte[] input, uint n, uint ctIn, byte[] output, uint ctOut);

	const uint BM_BGRTRIPLETS = 4, BM_KYMCQUADS = 5, BM_CMYKQUADS = 0x20, BM_xRGBQUADS = 8;

	static IntPtr Open(string path)
	{
		IntPtr str = Marshal.StringToHGlobalUni(path);
		var p = new PROFILE { dwType = 1, pProfileData = str, cbDataSize = (uint)((path.Length + 1) * 2) };
		IntPtr h = OpenColorProfileW(ref p, 1, 1, 3);
		if (h == IntPtr.Zero) throw new Exception("OpenColorProfile " + path + " " + Marshal.GetLastWin32Error());
		return h;
	}

	static void Be32(System.Collections.Generic.List<byte> b, uint v) { b.Add((byte)(v >> 24)); b.Add((byte)(v >> 16)); b.Add((byte)(v >> 8)); b.Add((byte)v); }
	static void Sig(System.Collections.Generic.List<byte> b, string s) { foreach (char c in s) b.Add((byte)c); }
	static void S15(System.Collections.Generic.List<byte> b, double v) { Be32(b, (uint)(int)Math.Round(v * 65536)); }

	/// <summary>A matrix profile whose "RGB" is linear D50 XYZ (red = X / 0.9642, green = Y, blue = Z / 0.8249; gamma 1), so a
	/// 16-bit translation reads out the colour-management module's PCS values.</summary>
	static byte[] XyzProfile()
	{
		double[][] tags = { new[] { 0.9642, 0.0, 0.0 }, new[] { 0.0, 1.0, 0.0 }, new[] { 0.0, 0.0, 0.8249 } };
		var body = new System.Collections.Generic.List<byte>();
		var table = new System.Collections.Generic.List<Tuple<string, int, int>>();
		Action<string, Action<System.Collections.Generic.List<byte>>> add = (sig, write) => {
			while (body.Count % 4 != 0) body.Add(0);
			int start = body.Count;
			write(body);
			table.Add(Tuple.Create(sig, start, body.Count - start));
		};
		Action<System.Collections.Generic.List<byte>> text = b => { Sig(b, "text"); Be32(b, 0); Sig(b, "none"); b.Add(0); };
		add("cprt", text);
		add("desc", b => { Sig(b, "desc"); Be32(b, 0); Be32(b, 5); Sig(b, "xyz"); b.Add(0); for (int i = 0; i < 4 + 4 + 2 + 67; i++) b.Add(0); });
		Action<string, double[]> xyz = (sig, v) => add(sig, b => { Sig(b, "XYZ "); Be32(b, 0); S15(b, v[0]); S15(b, v[1]); S15(b, v[2]); });
		xyz("wtpt", new[] { 0.9642, 1.0, 0.8249 });
		xyz("rXYZ", tags[0]); xyz("gXYZ", tags[1]); xyz("bXYZ", tags[2]);
		foreach (string sig in new[] { "rTRC", "gTRC", "bTRC" }) add(sig, b => { Sig(b, "curv"); Be32(b, 0); Be32(b, 0); });
		int dataStart = 128 + 4 + 12 * table.Count;
		var file = new System.Collections.Generic.List<byte>();
		Be32(file, (uint)(dataStart + body.Count));
		Be32(file, 0); Be32(file, 0x02100000); Sig(file, "mntr"); Sig(file, "RGB "); Sig(file, "XYZ ");
		for (int i = 0; i < 12; i++) file.Add(0);
		Sig(file, "acsp"); Sig(file, "MSFT"); Be32(file, 0); Be32(file, 0); Be32(file, 0); Be32(file, 0); Be32(file, 0); Be32(file, 0); Be32(file, 0);
		Be32(file, 0x0000F6D6); Be32(file, 0x00010000); Be32(file, 0x0000D32D);
		while (file.Count < 128) file.Add(0);
		Be32(file, (uint)table.Count);
		foreach (var t in table) { Sig(file, t.Item1); Be32(file, (uint)(dataStart + t.Item2)); Be32(file, (uint)t.Item3); }
		file.AddRange(body);
		return file.ToArray();
	}

	/// <summary>Translates the CMYK quads of a file to 16-bit linear XYZ (as above) at one intent; writes raw 16-bit little-endian R, G, B words.</summary>
	public static void RunXyz(string input, string output, string cmykProfile, uint intent, uint flags)
	{
		byte[] src = File.ReadAllBytes(input);
		uint n = (uint)(src.Length / 4);
		byte[] profile = XyzProfile();
		IntPtr mem = Marshal.AllocHGlobal(profile.Length);
		Marshal.Copy(profile, 0, mem, profile.Length);
		var p = new PROFILE { dwType = 2, pProfileData = mem, cbDataSize = (uint)profile.Length };
		IntPtr hx = OpenColorProfileW(ref p, 1, 1, 3);
		if (hx == IntPtr.Zero) throw new Exception("OpenColorProfile xyz " + Marshal.GetLastWin32Error());
		IntPtr hc = Open(cmykProfile);
		IntPtr t = CreateMultiProfileTransform(new[] { hc, hx }, 2, new[] { intent, intent }, 2, flags, 0);
		if (t == IntPtr.Zero) throw new Exception("transform " + Marshal.GetLastWin32Error());
		byte[] input2 = new byte[src.Length];
		for (int i = 0; i < src.Length; i += 4) for (int j = 0; j < 4; j++) input2[i + 3 - j] = src[i + j];
		byte[] dst = new byte[n * 6];
		if (!TranslateBitmapBits(t, input2, BM_CMYKQUADS, n, 1, n * 4, dst, 0xA, n * 6, IntPtr.Zero, IntPtr.Zero)) throw new Exception("translate " + Marshal.GetLastWin32Error());
		File.WriteAllBytes(output, dst);
		DeleteColorTransform(t);
	}

	/// <summary>Translates CMYK quads to sRGB with 16-bit output words (BM_16b_RGB), best mode: the colour-management module's
	/// own precision, before any 8-bit rounding.</summary>
	public static void RunSrgb16(string input, string output, string cmykProfile, uint intent, uint flags)
	{
		byte[] src = File.ReadAllBytes(input);
		uint n = (uint)(src.Length / 4);
		var sb = new System.Text.StringBuilder(260);
		uint size = 260;
		if (!GetStandardColorSpaceProfileW(null, 0x73524742, sb, ref size)) throw new Exception("GetStandardColorSpaceProfile " + Marshal.GetLastWin32Error());
		IntPtr hc = Open(cmykProfile), hs = Open(sb.ToString());
		IntPtr t = CreateMultiProfileTransform(new[] { hc, hs }, 2, new[] { intent, intent }, 2, flags, 0);
		if (t == IntPtr.Zero) throw new Exception("transform " + Marshal.GetLastWin32Error());
		byte[] input2 = new byte[src.Length];
		for (int i = 0; i < src.Length; i += 4) for (int j = 0; j < 4; j++) input2[i + 3 - j] = src[i + j];
		byte[] dst = new byte[n * 6];
		if (!TranslateBitmapBits(t, input2, BM_CMYKQUADS, n, 1, n * 4, dst, 0xA, n * 6, IntPtr.Zero, IntPtr.Zero)) throw new Exception("translate " + Marshal.GetLastWin32Error());
		File.WriteAllBytes(output, dst);
		DeleteColorTransform(t);
	}

	/// <summary>16-bit CMYK input through <c>TranslateColors</c> (best mode, RSWOP to sRGB, perceptual): the colour-management
	/// module does accept it. The input file holds little-endian 16-bit words C, M, Y, K per sample; the output holds 16-bit R, G, B
	/// words per sample. Each <c>COLOR</c> is a union whose largest member is <c>{ DWORD; void* }</c>, so it is 8 bytes in a 32-bit
	/// process and 16 in a 64-bit one (a packed array of 8-byte records reads past the buffer and crashes in <c>mscms.dll</c>).</summary>
	public static void RunTranslate16(string input, string output, string cmykProfile, uint flags)
	{
		const uint COLOR_RGB = 2, COLOR_CMYK = 7;
		byte[] raw = File.ReadAllBytes(input);
		int n = raw.Length / 8;
		int stride = IntPtr.Size == 8 ? 16 : 8;
		var sb = new System.Text.StringBuilder(260);
		uint size = 260;
		if (!GetStandardColorSpaceProfileW(null, 0x73524742, sb, ref size)) throw new Exception("GetStandardColorSpaceProfile " + Marshal.GetLastWin32Error());
		IntPtr hc = Open(cmykProfile), hs = Open(sb.ToString());
		IntPtr t = CreateMultiProfileTransform(new[] { hc, hs }, 2, new uint[] { 0, 0 }, 2, flags, 0);
		if (t == IntPtr.Zero) throw new Exception("transform " + Marshal.GetLastWin32Error());
		byte[] result = new byte[n * 6];
		const int chunk = 4096;
		for (int start = 0; start < n; start += chunk)
		{
			int count = Math.Min(chunk, n - start);
			byte[] ci = new byte[count * stride], co = new byte[count * stride];
			for (int i = 0; i < count; i++) Buffer.BlockCopy(raw, (start + i) * 8, ci, i * stride, 8);
			if (!TranslateColors(t, ci, (uint)count, COLOR_CMYK, co, COLOR_RGB)) throw new Exception("TranslateColors " + Marshal.GetLastWin32Error());
			for (int i = 0; i < count; i++) Buffer.BlockCopy(co, i * stride, result, (start + i) * 6, 6);
		}
		File.WriteAllBytes(output, result);
		DeleteColorTransform(t);
	}

	/// <summary>The 8-bit best-mode translation alone (raw B, G, R, X per sample): what GDI+ draws for a CMYK JPEG sample.</summary>
	public static void RunSrgb8(string input, string output, string cmykProfile)
	{
		byte[] src = File.ReadAllBytes(input);
		uint n = (uint)(src.Length / 4);
		var sb = new System.Text.StringBuilder(260);
		uint size = 260;
		if (!GetStandardColorSpaceProfileW(null, 0x73524742, sb, ref size)) throw new Exception("GetStandardColorSpaceProfile " + Marshal.GetLastWin32Error());
		IntPtr hc = Open(cmykProfile), hs = Open(sb.ToString());
		IntPtr t = CreateMultiProfileTransform(new[] { hc, hs }, 2, new uint[] { 0, 0 }, 2, 3, 0);
		if (t == IntPtr.Zero) throw new Exception("transform " + Marshal.GetLastWin32Error());
		byte[] input2 = new byte[src.Length];
		for (int i = 0; i < src.Length; i += 4) for (int j = 0; j < 4; j++) input2[i + 3 - j] = src[i + j];
		byte[] dst = new byte[n * 4];
		if (!TranslateBitmapBits(t, input2, BM_CMYKQUADS, n, 1, n * 4, dst, BM_xRGBQUADS, n * 4, IntPtr.Zero, IntPtr.Zero)) throw new Exception("translate " + Marshal.GetLastWin32Error());
		File.WriteAllBytes(output, dst);
		DeleteColorTransform(t);
	}

	public static void Run(string input, string outDir, string cmykProfile)
	{
		byte[] src = File.ReadAllBytes(input);
		uint n = (uint)(src.Length / 4);
		var sb = new System.Text.StringBuilder(260);
		uint size = 260;
		// 'sRGB' standard colour space id = 'sRGB' = 0x73524742
		if (!GetStandardColorSpaceProfileW(null, 0x73524742, sb, ref size)) throw new Exception("GetStandardColorSpaceProfile " + Marshal.GetLastWin32Error());
		string srgb = sb.ToString();
		Console.WriteLine("sRGB profile: " + srgb);
		IntPtr hc = Open(cmykProfile), hs = Open(srgb);
		Directory.CreateDirectory(outDir);
		foreach (uint intent in new uint[] { 0, 1, 2, 3 })
		foreach (uint flags in new uint[] { 0, 1, 2, 3, 0x20000 /* ENABLE_GAMUT_CHECKING-ish */ })
		foreach (uint fmt in new uint[] { BM_CMYKQUADS })
		foreach (bool invert in new[] { false, true })
		{
			IntPtr t = CreateMultiProfileTransform(new[] { hc, hs }, 2, new[] { intent, intent }, 2, flags, 0);
			if (t == IntPtr.Zero) { Console.WriteLine("transform fail intent " + intent + " flags " + flags + " err " + Marshal.GetLastWin32Error()); continue; }
			byte[] input2 = new byte[src.Length];
			for (int i = 0; i < src.Length; i += 4)
			{
				for (int j = 0; j < 4; j++) {
					byte v = src[i + j];
					int dst = 3 - j;
					input2[i + dst] = invert ? (byte)(255 - v) : v;
				}
			}
			byte[] dst2 = new byte[n * 4];
			bool ok = TranslateBitmapBits(t, input2, fmt, n, 1, n * 4, dst2, BM_xRGBQUADS, n * 4, IntPtr.Zero, IntPtr.Zero);
			string name = "i" + intent + "-f" + flags + "-" + (fmt == BM_CMYKQUADS ? "cmyk" : "kymc") + (invert ? "-inv" : "") + ".bin";
			if (!ok) { Console.WriteLine(name + " translate fail " + Marshal.GetLastWin32Error()); DeleteColorTransform(t); continue; }
			File.WriteAllBytes(Path.Combine(outDir, name), dst2);
			DeleteColorTransform(t);
		}
	}
}
