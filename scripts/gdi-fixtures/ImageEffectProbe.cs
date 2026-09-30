// Native GDI+ 1.1 effect reference. Run in Windows PowerShell:
// Add-Type -Path scripts/gdi-fixtures/ImageEffectProbe.cs -ReferencedAssemblies System.Drawing
// [ImageEffectProbe]::Run((Resolve-Path src/__fixtures__/gdi).Path)
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.IO;

public static class ImageEffectProbe
{
	[DllImport("gdiplus.dll")] static extern int GdipCreateEffect(Guid guid, out IntPtr effect);
	[DllImport("gdiplus.dll")] static extern int GdipDeleteEffect(IntPtr effect);
	[DllImport("gdiplus.dll")] static extern int GdipSetEffectParameters(IntPtr effect, byte[] parameters, uint size);
	[DllImport("gdiplus.dll")] static extern int GdipCreateBitmapFromScan0(int width, int height, int stride, int format, IntPtr scan, out IntPtr bitmap);
	[DllImport("gdiplus.dll")] static extern int GdipBitmapSetPixel(IntPtr bitmap, int x, int y, int argb);
	[DllImport("gdiplus.dll")] static extern int GdipBitmapGetPixel(IntPtr bitmap, int x, int y, out int argb);
	[DllImport("gdiplus.dll")] static extern int GdipDisposeImage(IntPtr bitmap);
	[DllImport("gdiplus.dll")] static extern int GdipBitmapApplyEffect(IntPtr bitmap, IntPtr effect, IntPtr roi, bool useAux, IntPtr aux, IntPtr auxSize);
	static void Check(int status) { if (status != 0) throw new Exception("GDI+ status " + status); }
	static byte[] Pixels(IntPtr bitmap, int width = 16, int height = 16)
	{
		byte[] data = new byte[width * height * 4];
		for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) {
			int argb; Check(GdipBitmapGetPixel(bitmap, x, y, out argb));
			int o = (y * width + x) * 4;
			data[o] = (byte)(argb >> 16); data[o + 1] = (byte)(argb >> 8); data[o + 2] = (byte)argb; data[o + 3] = (byte)(argb >> 24);
		}
		return data;
	}
	static byte[] Case(string dir, string name, string guid, byte[] parameters, bool ramp = false, bool impulse = false, int width = 16, int height = 16)
	{
		IntPtr bitmap = IntPtr.Zero, effect = IntPtr.Zero;
		try {
			Check(GdipCreateBitmapFromScan0(width, height, 0, 0x26200a, IntPtr.Zero, out bitmap));
			for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) {
				int a = ramp || y < 8 ? 255 : new int[] { 0, 64, 128, 200 }[x % 4];
				int rgb = ramp ? ((y * width + x) & 255) * 0x010101 : ((x * 17) << 16) | ((y * 17) << 8) | ((x * 31 + y * 13) & 255);
				if (impulse) rgb = (x == 0 ? 0xff0000 : 0) | (x == width/2-1 ? 0xff00 : 0) | (x == width-1 ? 0xff : 0);
				Check(GdipBitmapSetPixel(bitmap, x, y, (a << 24) | rgb));
			}
			byte[] source = Pixels(bitmap, width, height);
			Check(GdipCreateEffect(new Guid(guid), out effect));
			Check(GdipSetEffectParameters(effect, parameters, (uint)parameters.Length));
			Check(GdipBitmapApplyEffect(bitmap, effect, IntPtr.Zero, false, IntPtr.Zero, IntPtr.Zero));
			byte[] expected = Pixels(bitmap, width, height);
			if (!ramp) File.WriteAllText(Path.Combine(dir, "effect-" + name + ".json"), "{\"guid\":\"" + guid + "\",\"parameters\":\"" + Convert.ToBase64String(parameters) + "\",\"source\":\"" + Convert.ToBase64String(source) + "\",\"expected\":\"" + Convert.ToBase64String(expected) + "\"}");
			return expected;
		} finally {
			if (effect != IntPtr.Zero) GdipDeleteEffect(effect);
			if (bitmap != IntPtr.Zero) GdipDisposeImage(bitmap);
		}
	}
	public static void Run(string dir)
	{
		using (var init = new Bitmap(1, 1)) {
			float[] matrix = { 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1 };
			byte[] m = new byte[100]; Buffer.BlockCopy(matrix, 0, m, 0, 100);
			Case(dir, "matrix-swap", "718f2615-7933-40e3-a511-5f68fe14dd74", m);
			matrix = new float[] { .8f, .2f, 0, 0, 0, .1f, .7f, .2f, 0, 0, .2f, 0, .9f, 0, 0, 0, 0, 0, .5f, 0, .1f, -.1f, .05f, .2f, 1 };
			Buffer.BlockCopy(matrix, 0, m, 0, 100);
			Case(dir, "matrix-mix", "718f2615-7933-40e3-a511-5f68fe14dd74", m);
			byte[] lut = new byte[1024];
			for (int i = 0; i < 256; i++) { lut[i] = (byte)(255 - i); lut[256 + i] = (byte)(i / 2); lut[512 + i] = (byte)Math.Min(255, i + 30); lut[768 + i] = (byte)i; }
			Case(dir, "lookup", "a7ce72a9-0f7f-40d7-b3cc-d0c02d5c3212", lut);
			int[][] balances = { new int[] { 50, -25, 75 }, new int[] { -100, 100, 0 }, new int[] { 1, -1, 33 }, new int[] { -47, 58, 19 }, new int[] { 99, 41, -3 } };
			for (int i = 0; i < balances.Length; i++) {
				byte[] balance = new byte[12]; Buffer.BlockCopy(balances[i], 0, balance, 0, 12);
				Case(dir, "balance-" + i, "537e597d-251e-48da-9664-29ca496b70f8", balance);
			}
			int[][] levels = { new int[] { 70, 0, 0 }, new int[] { 100, 40, 0 }, new int[] { 100, -40, 0 }, new int[] { 100, 0, 30 }, new int[] { 70, 40, 30 } };
			for (int i = 0; i < levels.Length; i++) {
				byte[] parameters = new byte[12]; Buffer.BlockCopy(levels[i], 0, parameters, 0, 12);
				Case(dir, "levels-" + i, "99c354ec-2a31-4f3a-8c34-17a803b33a25", parameters);
			}
			for (int curve = 0; curve < 8; curve++) {
				byte[] parameters = new byte[12]; Buffer.BlockCopy(new int[] { curve, 0, 40 }, 0, parameters, 0, 12);
				Case(dir, "curve-" + curve, "dd6a0022-58e4-4a67-9d9b-d48eb881a53d", parameters);
			}
			int[][] contrasts = { new int[] { 30, 50 }, new int[] { -73, -1 }, new int[] { 0, 1 }, new int[] { 0, 100 }, new int[] { -73, 100 } };
			for (int i = 0; i < contrasts.Length; i++) {
				byte[] parameters = new byte[8]; Buffer.BlockCopy(contrasts[i], 0, parameters, 0, 8);
				Case(dir, "contrast-" + i, "d3a1dbe1-8ec4-4c17-9f4c-ea97ad1c343d", parameters);
			}
			int[][] tints = { new int[] { 0, 50 }, new int[] { 0, -50 }, new int[] { 120, 50 }, new int[] { -120, -50 }, new int[] { 0, 100 }, new int[] { 45, 0 } };
			for (int i = 0; i < tints.Length; i++) {
				byte[] parameters = new byte[8]; Buffer.BlockCopy(tints[i], 0, parameters, 0, 8);
				Case(dir, "tint-" + i, "1077af00-2848-4441-9489-44ad4c2d7a2c", parameters);
			}
		}
	}
	public static void BalanceSweep(string dir)
	{
		byte[] lookup = new byte[201 * 256];
		using (var init = new Bitmap(1, 1)) for (int value = -100; value <= 100; value++) {
			byte[] parameters = new byte[12];
			Buffer.BlockCopy(new int[] { value, value, value }, 0, parameters, 0, 12);
			byte[] pixels = Case(dir, "balance-sweep-" + value, "537e597d-251e-48da-9664-29ca496b70f8", parameters, true);
			for (int level = 0; level < 256; level++) lookup[(value + 100) * 256 + level] = pixels[level * 4];
		}
		File.WriteAllText(Path.Combine(dir, "effect-balance-sweep.json"), "{\"expected\":\"" + Convert.ToBase64String(lookup) + "\"}");
	}
	public static void ContrastSweep(string dir)
	{
		int[] brightness = { -255, -73, -1, 0, 1, 30, 255 };
		int[] contrast = { -100, -99, -50, -1, 0, 1, 50, 99, 100 };
		byte[] lookup = new byte[brightness.Length * contrast.Length * 256];
		int offset = 0;
		using (var init = new Bitmap(1, 1)) foreach (int b in brightness) foreach (int c in contrast) {
			byte[] parameters = new byte[8]; Buffer.BlockCopy(new int[] { b, c }, 0, parameters, 0, 8);
			byte[] pixels = Case(dir, "contrast-sweep", "d3a1dbe1-8ec4-4c17-9f4c-ea97ad1c343d", parameters, true);
			for (int level = 0; level < 256; level++) lookup[offset++] = pixels[level * 4];
		}
		File.WriteAllText(Path.Combine(dir, "effect-contrast-sweep.json"), "{\"brightness\":[-255,-73,-1,0,1,30,255],\"contrast\":[-100,-99,-50,-1,0,1,50,99,100],\"expected\":\"" + Convert.ToBase64String(lookup) + "\"}");
	}
	public static void CurveSweep(string dir)
	{
		using (var init = new Bitmap(1, 1)) for (int curve = 0; curve < 8; curve++) {
			int min = curve < 2 ? -255 : curve < 6 ? -100 : curve == 6 ? 1 : 0;
			int max = curve == 7 ? 254 : curve < 2 || curve >= 6 ? 255 : 100;
			byte[] lookup = new byte[(max - min + 1) * 256];
			for (int value = min; value <= max; value++) {
				byte[] parameters = new byte[12]; Buffer.BlockCopy(new int[] { curve, 0, value }, 0, parameters, 0, 12);
				byte[] pixels;
				try { pixels = Case(dir, "curve-sweep", "dd6a0022-58e4-4a67-9d9b-d48eb881a53d", parameters, true); }
				catch (Exception e) { throw new Exception("curve " + curve + " value " + value, e); }
				for (int level = 0; level < 256; level++) lookup[(value - min) * 256 + level] = pixels[level * 4];
			}
			File.WriteAllBytes(Path.Combine(dir, "curve-" + curve + ".bin"), lookup);
		}
	}
	public static void LevelsSweep(string dir)
	{
		int[][] settings = new int[1010][];
		int[][] initial = { new int[] { 100, 0, 0 }, new int[] { 70, 0, 0 }, new int[] { 100, 40, 0 }, new int[] { 100, -40, 0 }, new int[] { 100, 0, 30 }, new int[] { 70, 40, 30 }, new int[] { 93, 17, 4 }, new int[] { 0, 0, 0 }, new int[] { 100, 100, 100 }, new int[] { 20, -67, 30 } };
		Array.Copy(initial, settings, initial.Length);
		Random random = new Random(321);
		for (int i = initial.Length; i < settings.Length; i++) settings[i] = new int[] { random.Next(101), random.Next(201) - 100, random.Next(101) };
		byte[] lookup = new byte[settings.Length * 256];
		using (var init = new Bitmap(1, 1)) for (int i = 0; i < settings.Length; i++) {
			byte[] parameters = new byte[12]; Buffer.BlockCopy(settings[i], 0, parameters, 0, 12);
			byte[] pixels = Case(dir, "levels-sweep", "99c354ec-2a31-4f3a-8c34-17a803b33a25", parameters, true);
			for (int level = 0; level < 256; level++) lookup[i * 256 + level] = pixels[level * 4];
		}
		File.WriteAllBytes(Path.Combine(dir, "levels-sweep.bin"), lookup);
		using (var writer = new StreamWriter(Path.Combine(dir, "levels-settings.csv"))) foreach (int[] setting in settings) writer.WriteLine(setting[0] + "," + setting[1] + "," + setting[2]);
	}
	public static void SharpenSweep(string dir)
	{
		float[] radii = { .25f, .5f, 1, 1.5f, 2, 2.5f, 3, 3.5f, 4, 5, 6, 7, 8, 10, 16, 32, 64, 128, 255 };
		float[] amounts = { 0, 10, 30, 50, 100 };
		var json = new System.Text.StringBuilder("{\"radii\":[");
		foreach (float r in radii) { if (json[json.Length-1] != '[') json.Append(','); json.Append(r.ToString(System.Globalization.CultureInfo.InvariantCulture)); }
		json.Append("],\"amounts\":[0,10,30,50,100],\"blur\":[");
		using (var init = new Bitmap(1, 1)) {
			foreach (float r in radii) {
				byte[] parameters = new byte[8]; Buffer.BlockCopy(new float[] {r,0},0,parameters,0,8);
				if (json[json.Length-1] != '[') json.Append(',');
				json.Append('"').Append(Convert.ToBase64String(Case(dir,"blur-probe","633c80a4-1843-482b-9ef2-be2834c5fdd4",parameters,true))).Append('"');
			}
			json.Append("],\"impulseBlur\":[");
			foreach (float r in radii) {
				byte[] parameters = new byte[8]; Buffer.BlockCopy(new float[] {r,0},0,parameters,0,8);
				if (json[json.Length-1] != '[') json.Append(',');
				json.Append('"').Append(Convert.ToBase64String(Case(dir,"blur-impulse","633c80a4-1843-482b-9ef2-be2834c5fdd4",parameters,true,true))).Append('"');
			}
			json.Append("],\"expected\":[");
			foreach (float r in radii) foreach (float a in amounts) {
				byte[] parameters = new byte[8]; Buffer.BlockCopy(new float[] {r,a},0,parameters,0,8);
				if (json[json.Length-1] != '[') json.Append(',');
				json.Append('"').Append(Convert.ToBase64String(Case(dir,"sharpen-probe","63cbf3ee-c526-402c-8f71-62c540bf5142",parameters,true))).Append('"');
			}
		}
		File.WriteAllText(Path.Combine(dir,"effect-sharpen-sweep.json"),json.Append("]}").ToString());
	}
	public static void SharpenAmounts(string dir)
	{
		byte[] pixels = new byte[101 * 1024];
		using (var init = new Bitmap(1, 1)) for (int a=0; a<=100; a++) {
			byte[] parameters = new byte[8]; Buffer.BlockCopy(new float[] {32,a},0,parameters,0,8);
			Buffer.BlockCopy(Case(dir,"sharpen-amount","63cbf3ee-c526-402c-8f71-62c540bf5142",parameters,true),0,pixels,a*1024,1024);
		}
		File.WriteAllText(Path.Combine(dir,"effect-sharpen-amounts.json"),"{\"radius\":32,\"expected\":\""+Convert.ToBase64String(pixels)+"\"}");
	}
	public static void BlurDimensions(string dir)
	{
		int[][] sizes = {new int[]{2,3},new int[]{8,16},new int[]{16,8},new int[]{32,16},new int[]{16,32},new int[]{32,32},new int[]{64,64}};
		float[] radii = {1,3,8,10,16,24,32,64};
		BlurSamples(dir,"effect-blur-dimensions.json",sizes,radii);
	}
	public static void LargeBlur(string dir)
	{
		int[][] sizes = {new int[]{2,3},new int[]{8,16},new int[]{16,8},new int[]{16,16},new int[]{32,32},new int[]{64,64},new int[]{13,21},new int[]{31,17},new int[]{63,65}};
		float[] radii = {16.25f,17,23.49f,23.5f,24,31.5f,32.25f,33,39.5f,40,48,55.5f,56,63.5f,65,80,96,112,129,144,240,255};
		BlurSamples(dir,"effect-blur-large.json",sizes,radii);
		var scan = new System.Text.StringBuilder("[");
		using (var init = new Bitmap(1,1)) for(int quarter=64;quarter<=1020;quarter++) {
			float radius=quarter/4.0f;byte[] parameters=new byte[8];Buffer.BlockCopy(new float[]{radius,0},0,parameters,0,8);
			var pixels=Case(dir,"blur-factors","633c80a4-1843-482b-9ef2-be2834c5fdd4",parameters,true,true);
			if(quarter>64)scan.Append(',');scan.Append("{\"radius\":").Append(radius).Append(",\"row\":\"").Append(Convert.ToBase64String(pixels,0,64)).Append("\"}");
		}
		File.WriteAllText(Path.Combine(dir,"effect-blur-factors.json"),scan.Append(']').ToString());
	}
	public static void HueSweep(string dir)
	{
		const int width = 2560;
		var settings = new System.Collections.Generic.List<int[]>();
		for(int hue=-180;hue<=180;hue++)settings.Add(new int[]{hue,0,0});
		foreach(int hue in new int[]{-180,-120,-90,-60,-30,-1,0,1,30,60,90,120,180}) foreach(int saturation in new int[]{-100,-30,0,60,100}) foreach(int lightness in new int[]{-50,0,50})
			if(saturation!=0 || lightness!=0)settings.Add(new int[]{hue,saturation,lightness});
		byte[] source = new byte[width * 4], results = new byte[settings.Count * width * 4];
		for (int sector = 0; sector < 6; sector++) for (int value = 0; value < 256; value++) {
			int[][] rgb = {new int[]{255,value,0},new int[]{255-value,255,0},new int[]{0,255,value},new int[]{0,255-value,255},new int[]{value,0,255},new int[]{255,0,255-value}};
			int offset = (sector * 256 + value) * 4;
			for(int channel=0;channel<3;channel++)source[offset+channel]=(byte)rgb[sector][channel];source[offset+3]=255;
		}
		var random = new Random(729);
		for(int x=1536;x<width;x++) {for(int channel=0;channel<3;channel++) source[x*4+channel]=(byte)random.Next(256);source[x*4+3]=(byte)new int[]{0,64,128,200,255}[x%5];}
		using(var init = new Bitmap(1,1)) for(int index=0;index<settings.Count;index++)
			Buffer.BlockCopy(EffectPixels(source,"8b2dd6c3-eb07-4d87-a5f0-7108e26a9c5f",settings[index]),0,results,index*width*4,width*4);
		File.WriteAllBytes(Path.Combine(dir,"effect-hue-source.bin"),source);
		var json=new System.Text.StringBuilder("[");for(int i=0;i<settings.Count;i++){if(i>0)json.Append(',');json.Append('[').Append(settings[i][0]).Append(',').Append(settings[i][1]).Append(',').Append(settings[i][2]).Append(']');}
		File.WriteAllText(Path.Combine(dir,"effect-hue-settings.json"),json.Append(']').ToString());
		using(var file=File.Create(Path.Combine(dir,"effect-hue-sweep.bin.gz"))) using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress)) zip.Write(results,0,results.Length);
	}
	static byte[] EffectPixels(byte[] source,string guid,int[] setting)
	{
		IntPtr bitmap=IntPtr.Zero,effect=IntPtr.Zero;int width=source.Length/4;
		try {
			Check(GdipCreateBitmapFromScan0(width,1,0,0x26200a,IntPtr.Zero,out bitmap));
			for(int x=0;x<width;x++){int o=x*4;Check(GdipBitmapSetPixel(bitmap,x,0,(source[o+3]<<24)|(source[o]<<16)|(source[o+1]<<8)|source[o+2]));}
			byte[] parameters=new byte[setting.Length*4];Buffer.BlockCopy(setting,0,parameters,0,parameters.Length);
			Check(GdipCreateEffect(new Guid(guid),out effect));Check(GdipSetEffectParameters(effect,parameters,(uint)parameters.Length));
			Check(GdipBitmapApplyEffect(bitmap,effect,IntPtr.Zero,false,IntPtr.Zero,IntPtr.Zero));return Pixels(bitmap,width,1);
		} finally {if(effect!=IntPtr.Zero)GdipDeleteEffect(effect);if(bitmap!=IntPtr.Zero)GdipDisposeImage(bitmap);}
	}
	public static void TintSweep(string dir)
	{
		byte[] hueSource=File.ReadAllBytes(Path.Combine(dir,"effect-hue-source.bin")),source=new byte[hueSource.Length+256*4];Buffer.BlockCopy(hueSource,0,source,0,hueSource.Length);
		for(int value=0;value<256;value++){int o=hueSource.Length+value*4;source[o]=source[o+1]=source[o+2]=(byte)value;source[o+3]=255;}
		var settings=new System.Collections.Generic.List<int[]>();
		foreach(int hue in new int[]{-180,-120,-90,-60,-45,-30,-1,0,1,30,45,60,90,120,180}) foreach(int amount in new int[]{-100,-50,0,30,50,100})settings.Add(new int[]{hue,amount});
		byte[] results=new byte[settings.Count*source.Length];
		using(var init=new Bitmap(1,1))for(int index=0;index<settings.Count;index++)Buffer.BlockCopy(EffectPixels(source,"1077af00-2848-4441-9489-44ad4c2d7a2c",settings[index]),0,results,index*source.Length,source.Length);
		var json=new System.Text.StringBuilder("[");for(int i=0;i<settings.Count;i++){if(i>0)json.Append(',');json.Append('[').Append(settings[i][0]).Append(',').Append(settings[i][1]).Append(']');}
		File.WriteAllText(Path.Combine(dir,"effect-tint-settings.json"),json.Append(']').ToString());File.WriteAllBytes(Path.Combine(dir,"effect-tint-source.bin"),source);
		using(var file=File.Create(Path.Combine(dir,"effect-tint-sweep.bin.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(results,0,results.Length);
	}
	static void BlurSamples(string dir,string file,int[][] sizes,float[] radii)
	{
		var json = new System.Text.StringBuilder("[");
		using (var init = new Bitmap(1,1)) foreach(int[] size in sizes) foreach(float radius in radii) {
			if(json.Length>1)json.Append(',');
			byte[] parameters = new byte[8]; Buffer.BlockCopy(new float[]{radius,0},0,parameters,0,8);
			json.Append("{\"width\":").Append(size[0]).Append(",\"height\":").Append(size[1]).Append(",\"radius\":").Append(radius).Append(",\"ramp\":\"")
			.Append(Convert.ToBase64String(Case(dir,"blur-dimensions","633c80a4-1843-482b-9ef2-be2834c5fdd4",parameters,true,false,size[0],size[1])))
			.Append("\",\"impulse\":\"").Append(Convert.ToBase64String(Case(dir,"blur-dimensions","633c80a4-1843-482b-9ef2-be2834c5fdd4",parameters,true,true,size[0],size[1]))).Append("\"}");
		}
		File.WriteAllText(Path.Combine(dir,file),json.Append("]").ToString());
	}
}
