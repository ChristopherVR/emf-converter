// Native encoded-image references for the bundled decoder regression test.
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;

public static class CodecProbe
{
	public static void AdvancedReferences(string dir)
	{
		foreach (string name in new[] { "deflate-strips", "deflate-legacy-strips", "deflate-predictor-strips", "uncompressed-tiles", "deflate-tiles", "deflate-legacy-tiles", "jpeg-ycbcr-strips", "jpeg-rgb-tiles", "jpeg-ycbcr-tiles", "jpeg-rgb-strips" })
			Reference(Path.Combine(dir, "codec-tiff-" + name + ".bin"));
		foreach (string name in new[] { "444", "422", "420", "progressive", "rgb", "grey" })
			Reference(Path.Combine(dir, "codec-jpeg-" + name + ".bin"));
	}
	static void Reference(string path)
	{
		using (var decoded = Image.FromFile(path))
			decoded.Save(Path.ChangeExtension(path, ".png"), ImageFormat.Png);
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
