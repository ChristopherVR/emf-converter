// Native encoded-image references for the bundled decoder regression test.
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;

public static class CodecProbe
{
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
	}
}
