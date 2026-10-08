// Native encoded-image references for the bundled decoder regression test.
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;

public static class CodecProbe
{
	public static void AdvancedReferences(string dir)
	{
		foreach (string name in new[] { "deflate-strips", "deflate-legacy-strips", "deflate-predictor-strips", "uncompressed-tiles", "deflate-tiles", "deflate-legacy-tiles", "jpeg-ycbcr-strips", "jpeg-rgb-tiles", "jpeg-ycbcr-tiles", "jpeg-rgb-strips", "jpeg-cmyk-strips" })
			Reference(Path.Combine(dir, "codec-tiff-" + name + ".bin"));
		foreach (string name in new[] { "444", "422", "420", "progressive", "rgb", "grey", "cmyk-patches", "cmyk-noadobe", "cmyk-ramps", "cmyk-photo", "cmyk-photo-420", "ycck-patches", "ycck-photo", "ycck-photo-420", "arithmetic" })
			Reference(Path.Combine(dir, "codec-jpeg-" + name + ".bin"));
		// GDI+ refuses a 12-bit JPEG ("Unsupported JPEG data precision 12"), so only the metafile playback is recorded.
		foreach (string name in new[] { "12bit", "arithmetic", "cmyk-photo" })
			JpegPlayback(dir, name);
	}
	/// <summary>
	/// Records an EMF+ metafile that draws a placeholder JPEG, swaps the embedded JPEG bytes for codec-jpeg-NAME.bin
	/// and writes GDI+'s playback of it (a magenta surface, the metafile on it) as codec-jpeg-NAME-playback.png.
	/// </summary>
	static void JpegPlayback(string dir, string name)
	{
		string emf = Path.Combine(dir, "codec-jpeg-" + name + "-playback.emf");
		byte[] replacement = File.ReadAllBytes(Path.Combine(dir, "codec-jpeg-" + name + ".bin"));
		using (var surface = new Bitmap(300, 200))
		using (var host = Graphics.FromImage(surface))
		{
			IntPtr hdc = host.GetHdc();
			try
			{
				using (var recording = new Metafile(emf, hdc, EmfType.EmfPlusOnly))
				using (var g = Graphics.FromImage(recording))
				using (var placeholder = Image.FromFile(Path.Combine(dir, "codec-jpeg-444.bin")))
				{
					g.Clear(Color.White);
					g.DrawImage(placeholder, new Rectangle(20, 10, 260, 170));
				}
			}
			finally { host.ReleaseHdc(hdc); }
		}
		byte[] source = File.ReadAllBytes(emf);
		var patched = new MemoryStream();
		int position = 0;
		while (position < source.Length)
		{
			int type = BitConverter.ToInt32(source, position), size = BitConverter.ToInt32(source, position + 4);
			byte[] record = new byte[size];
			Array.Copy(source, position, record, 0, size);
			if (type == 70 && size > 16 && record[12] == 'E' && record[13] == 'M' && record[14] == 'F' && record[15] == '+')
				record = PatchComment(record, replacement);
			patched.Write(record, 0, record.Length);
			position += size;
		}
		byte[] result = patched.ToArray();
		BitConverter.GetBytes(result.Length).CopyTo(result, 48);
		File.WriteAllBytes(emf, result);
		using (var mf = new Metafile(emf))
		using (var output = new Bitmap(300, 200, PixelFormat.Format32bppArgb))
		using (var g = Graphics.FromImage(output))
		{
			g.Clear(Color.Magenta);
			g.DrawImage(mf, new Rectangle(0, 0, mf.Width, mf.Height), 0, 0, mf.Width, mf.Height, GraphicsUnit.Pixel);
			// The whole 300 x 200 surface (the magenta margin right and below the metafile is the probe's own background, not
			// playback output) is kept as .surface.png; the reference is the metafile's own extent, as the converter renders it.
			output.Save(Path.Combine(dir, "codec-jpeg-" + name + "-playback.surface.png"), ImageFormat.Png);
			using (var cropped = output.Clone(new Rectangle(0, 0, mf.Width, mf.Height), PixelFormat.Format32bppArgb))
				cropped.Save(Path.Combine(dir, "codec-jpeg-" + name + "-playback.png"), ImageFormat.Png);
		}
	}
	/// <summary>Rebuilds an EMR_COMMENT holding EMF+ records with the JPEG inside its image object replaced.</summary>
	static byte[] PatchComment(byte[] comment, byte[] jpeg)
	{
		var records = new MemoryStream();
		int end = 12 + BitConverter.ToInt32(comment, 8), position = 16;
		while (position < end)
		{
			ushort type = BitConverter.ToUInt16(comment, position), flags = BitConverter.ToUInt16(comment, position + 2);
			int size = BitConverter.ToInt32(comment, position + 4), dataSize = BitConverter.ToInt32(comment, position + 8);
			byte[] body = new byte[size];
			Array.Copy(comment, position, body, 0, size);
			if (type == 0x4008 && ((flags >> 8) & 0x7f) == 5)
			{
				int start = 12;
				while (!(body[start] == 0xff && body[start + 1] == 0xd8 && body[start + 2] == 0xff)) start++;
				int length = start - 12 + jpeg.Length;
				length += (4 - length % 4) % 4;
				var rebuilt = new byte[12 + length];
				BitConverter.GetBytes(type).CopyTo(rebuilt, 0);
				BitConverter.GetBytes(flags).CopyTo(rebuilt, 2);
				BitConverter.GetBytes(rebuilt.Length).CopyTo(rebuilt, 4);
				BitConverter.GetBytes(length).CopyTo(rebuilt, 8);
				Array.Copy(body, 12, rebuilt, 12, start - 12);
				Array.Copy(jpeg, 0, rebuilt, start, jpeg.Length);
				body = rebuilt;
			}
			records.Write(body, 0, body.Length);
			position += size;
		}
		int payload = 4 + (int)records.Length, total = 12 + payload;
		total += (4 - total % 4) % 4;
		var output = new byte[total];
		BitConverter.GetBytes(70).CopyTo(output, 0);
		BitConverter.GetBytes(total).CopyTo(output, 4);
		BitConverter.GetBytes(payload).CopyTo(output, 8);
		output[12] = (byte)'E'; output[13] = (byte)'M'; output[14] = (byte)'F'; output[15] = (byte)'+';
		records.ToArray().CopyTo(output, 16);
		return output;
	}
	static void Reference(string path)
	{
		using (var decoded = Image.FromFile(path))
			decoded.Save(Path.ChangeExtension(path, ".png"), ImageFormat.Png);
	}
	/// <summary>Decodes every .jpg in a directory to a PNG next to it; a file GDI+ cannot decode gets a .failed.txt holding the error.</summary>
	public static void DecodeDirectory(string dir)
	{
		foreach (string path in Directory.GetFiles(dir, "*.jpg"))
		{
			try { Reference(path); }
			catch (Exception e) { File.WriteAllText(Path.ChangeExtension(path, ".failed.txt"), e.GetType().Name + ": " + e.Message); }
		}
	}
	/// <summary>
	/// Decodes every codec-jpeg-arith-*.bin (written by arith-jpeg-encoder.ts) to a PNG next to it. A variant GDI+
	/// refuses gets a .failed.txt holding the error instead, so the refused set is part of the capture.
	/// </summary>
	public static void ArithmeticReferences(string dir)
	{
		foreach (string path in Directory.GetFiles(dir, "codec-jpeg-arith-*.bin"))
		{
			string png = Path.ChangeExtension(path, ".png"), failed = Path.ChangeExtension(path, ".failed.txt");
			if (File.Exists(png)) File.Delete(png);
			if (File.Exists(failed)) File.Delete(failed);
			try { Reference(path); }
			catch (Exception e) { File.WriteAllText(failed, e.GetType().Name + ": " + e.Message); }
		}
	}
	/// <summary>Playback of an EMF+ DrawImage of each named codec-jpeg-NAME.bin, as JpegPlayback records it.</summary>
	public static void ArithmeticPlayback(string dir, string[] names)
	{
		foreach (string name in names) JpegPlayback(dir, name);
	}
	static void GifFrame(BinaryWriter writer, bool transparent, int transparentIndex, int left, int top, int width, int height, byte[] pixels, bool localPalette = false)
	{
		writer.Write(new byte[] { 0x21, 0xf9, 4, (byte)(transparent ? 1 : 0), 1, 0, (byte)transparentIndex, 0, 0x2c });
		writer.Write((ushort)left); writer.Write((ushort)top);
		writer.Write((ushort)width); writer.Write((ushort)height); writer.Write((byte)(localPalette ? 0x81 : 0));
		if (localPalette) writer.Write(new byte[] { 255, 255, 0, 0, 0, 0, 0, 255, 255, 255, 0, 255 });
		// Clear before each pixel keeps every LZW code three bits wide.
		var codes = new System.Collections.Generic.List<int>();
		foreach (byte pixel in pixels) { codes.Add(4); codes.Add(pixel); }
		codes.Add(5);
		byte[] data = new byte[(codes.Count * 3 + 7) / 8];
		for (int i = 0; i < codes.Count; i++) for (int bit = 0; bit < 3; bit++)
			if ((codes[i] & (1 << bit)) != 0) data[(i * 3 + bit) / 8] |= (byte)(1 << ((i * 3 + bit) % 8));
		writer.Write((byte)2); writer.Write((byte)data.Length); writer.Write(data); writer.Write((byte)0);
	}
	static void OffsetGif(string dir, bool transparent, int background, int transparentIndex, bool localPalette = false)
	{
		string path = Path.Combine(dir, "codec-gif-offset-" + (transparent ? "transparent" : "opaque") + (background != 0 ? "-background" : "") + (transparentIndex != 0 ? "-index" : "") + (localPalette ? "-local" : "") + ".bin");
		using (var writer = new BinaryWriter(File.Create(path))) {
			writer.Write(System.Text.Encoding.ASCII.GetBytes("GIF89a"));
			writer.Write((ushort)4); writer.Write((ushort)3);
			writer.Write(new byte[] { 0x81, (byte)background, 0, 0, 0, 255, 255, 0, 0, 0, 255, 0, 255, 255, 255 });
			GifFrame(writer, transparent, transparentIndex, 1, 1, 2, 2, new byte[] { 0, 1, 2, 3 }, localPalette);
			GifFrame(writer, false, 0, 0, 0, 4, 3, new byte[] { 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2 });
			writer.Write((byte)0x3b);
		}
		Reference(path);
	}
	public static void Extended(string dir)
	{
		OffsetGif(dir, false, 0, 0); OffsetGif(dir, true, 0, 0);
		OffsetGif(dir, true, 3, 0); OffsetGif(dir, true, 0, 1);
		OffsetGif(dir, false, 3, 0);
		OffsetGif(dir, false, 3, 0, true); OffsetGif(dir, true, 3, 0, true);
		ImageCodecInfo codec = Array.Find(ImageCodecInfo.GetImageEncoders(), c => c.FormatID == ImageFormat.Tiff.Guid);
		using (var first = new Bitmap(16, 16)) using (var second = new Bitmap(16, 16)) {
			for (int y = 0; y < 16; y++) for (int x = 0; x < 16; x++) {
				first.SetPixel(x, y, Color.FromArgb(255, x * 17, y * 17, 255 - x * 17));
				second.SetPixel(x, y, Color.Lime);
			}
			string compressed = Path.Combine(dir, "codec-tiff-lzw.bin");
			using (var parameters = new EncoderParameters(1)) {
				parameters.Param[0] = new EncoderParameter(Encoder.Compression, (long)EncoderValue.CompressionLZW);
				first.Save(compressed, codec, parameters);
			}
			Reference(compressed);
			string multiple = Path.Combine(dir, "codec-tiff-multipage.bin");
			using (var parameters = new EncoderParameters(1)) {
				parameters.Param[0] = new EncoderParameter(Encoder.SaveFlag, (long)EncoderValue.MultiFrame);
				first.Save(multiple, codec, parameters);
				parameters.Param[0] = new EncoderParameter(Encoder.SaveFlag, (long)EncoderValue.FrameDimensionPage);
				first.SaveAdd(second, parameters);
				parameters.Param[0] = new EncoderParameter(Encoder.SaveFlag, (long)EncoderValue.Flush);
				first.SaveAdd(parameters);
			}
			Reference(multiple);
		}
	}
	public static void Run(string dir)
	{
		using (var bitmap = new Bitmap(16, 16))
		{
			for (int y = 0; y < 16; y++) for (int x = 0; x < 16; x++)
				bitmap.SetPixel(x, y, Color.FromArgb(255, x * 17, y * 17, 255 - x * 17));
			var formats = new[] { ImageFormat.Jpeg, ImageFormat.Gif, ImageFormat.Tiff };
			var names = new[] { "jpeg", "gif", "tiff" };
			for (int i = 0; i < formats.Length; i++)
			{
				string path = Path.Combine(dir, "codec-" + names[i] + ".bin");
				bitmap.Save(path, formats[i]);
				using (var decoded = Image.FromFile(path))
					decoded.Save(Path.Combine(dir, "codec-" + names[i] + ".png"), ImageFormat.Png);
			}
		}
		Extended(dir);
	}
	public static void CompressionVariants(string dir)
	{
		ImageCodecInfo codec = Array.Find(ImageCodecInfo.GetImageEncoders(), c => c.FormatID == ImageFormat.Tiff.Guid);
		// An odd width exercises the bit and scanline padding in fax/RLE data.
		using (var bitmap = new Bitmap(37, 19, PixelFormat.Format1bppIndexed)) {
			var palette = bitmap.Palette;
			palette.Entries[0] = Color.Black; palette.Entries[1] = Color.White; bitmap.Palette = palette;
			var bits = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height), ImageLockMode.WriteOnly, bitmap.PixelFormat);
			try {
				var data = new byte[bits.Stride * bitmap.Height];
				for (int y = 0; y < bitmap.Height; y++) for (int x = 0; x < bitmap.Width; x++)
					if ((x / 3 + y / 2) % 2 == 0 || x == y) data[y * bits.Stride + x / 8] |= (byte)(128 >> (x % 8));
				System.Runtime.InteropServices.Marshal.Copy(data, 0, bits.Scan0, data.Length);
			} finally { bitmap.UnlockBits(bits); }
			var modes = new[] { EncoderValue.CompressionNone, EncoderValue.CompressionRle, EncoderValue.CompressionCCITT3, EncoderValue.CompressionCCITT4 };
			var names = new[] { "none", "packbits", "ccitt3", "ccitt4" };
			for (int i = 0; i < modes.Length; i++) {
				string path = Path.Combine(dir, "codec-tiff-bilevel-" + names[i] + ".bin");
				using (var parameters = new EncoderParameters(1)) {
					parameters.Param[0] = new EncoderParameter(Encoder.Compression, (long)modes[i]);
					bitmap.Save(path, codec, parameters);
				}
				Reference(path);
			}
		}
	}
}
