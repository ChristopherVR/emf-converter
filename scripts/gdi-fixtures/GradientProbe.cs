using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Globalization;

public static class GradientProbe
{
	public static void Run(string dir)
	{
		float[] positions={.1f,.2f,.25f,.3f,.5f,.6f,.75f,.9f};
		float[] factors={.1f,.2f,.25f,.3f,.5f,.6f,.8f,.9f};
		var random=new Random(1172);var json=new System.Text.StringBuilder("[");
		for(int colour=0;colour<68;colour++) {
			Color a=Color.FromArgb(colour<64?255:random.Next(256),random.Next(256),random.Next(256),random.Next(256));
			Color b=Color.FromArgb(colour<64?255:random.Next(256),random.Next(256),random.Next(256),random.Next(256));
			foreach(float position in positions)foreach(float factor in factors)
			using(var brush=new LinearGradientBrush(new RectangleF(0,0,4096,1),a,b,0f))using(var bitmap=new Bitmap(4097,1,PixelFormat.Format32bppPArgb)) {
				brush.WrapMode=WrapMode.TileFlipX;brush.Blend=new Blend{Positions=new float[]{0,position,1},Factors=new float[]{0,factor,1}};
				using(var g=Graphics.FromImage(bitmap)){g.CompositingMode=CompositingMode.SourceCopy;g.PixelOffsetMode=PixelOffsetMode.None;g.FillRectangle(brush,0,0,4097,1);}
				byte[] knots=new byte[17*4];var bits=bitmap.LockBits(new Rectangle(0,0,4097,1),ImageLockMode.ReadOnly,PixelFormat.Format32bppPArgb);
				try {for(int k=0;k<=16;k++){IntPtr pixel=IntPtr.Add(bits.Scan0,k*256*4);knots[k*4]=Marshal.ReadByte(pixel,2);knots[k*4+1]=Marshal.ReadByte(pixel,1);knots[k*4+2]=Marshal.ReadByte(pixel,0);knots[k*4+3]=Marshal.ReadByte(pixel,3);}}
				finally{bitmap.UnlockBits(bits);}
				if(json.Length>1)json.Append(',');json.Append("{\"a\":").Append(unchecked((uint)a.ToArgb())).Append(",\"b\":").Append(unchecked((uint)b.ToArgb()))
				.Append(",\"position\":").Append(position.ToString("R",CultureInfo.InvariantCulture)).Append(",\"factor\":").Append(factor.ToString("R",CultureInfo.InvariantCulture))
				.Append(",\"knots\":\"").Append(Convert.ToBase64String(knots)).Append("\"}");
			}
		}
		byte[] data=System.Text.Encoding.UTF8.GetBytes(json.Append(']').ToString());
		using(var file=File.Create(Path.Combine(dir,"gradient-blend-knots.json.gz")))using(var zip=new System.IO.Compression.GZipStream(file,System.IO.Compression.CompressionMode.Compress))zip.Write(data,0,data.Length);
	}
}
