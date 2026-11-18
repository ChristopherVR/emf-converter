import { parseGIF, decompressFrame, type Frame } from 'gifuct-js';
import { validCodecSize, type CodecPixels } from './image-codec-pixels';

export function decodeGif(bytes: Uint8Array): CodecPixels | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const width = view.getUint16(6, true), height = view.getUint16(8, true);
	if (!validCodecSize(width, height)) return null;
	const gif = parseGIF(bytes.slice().buffer);
	const first = gif.frames.find((frame): frame is Frame => 'image' in frame);
	if (!first || !validCodecSize(first.image.descriptor.width, first.image.descriptor.height)) return null;
	const frame = decompressFrame(first, gif.gct, true);
	const data = new Uint8ClampedArray(width * height * 4);
	// GDI+ fills the logical screen around an offset first frame using its
	// transparent palette entry (including RGB) or the global background.
	const transparent = frame.transparentIndex !== undefined;
	const background = transparent ? frame.colorTable[frame.transparentIndex] : gif.gct?.[gif.lsd.backgroundColorIndex];
	if (background) {
		for (let i = 0; i < data.length; i += 4) {
			data[i] = background[0]; data[i + 1] = background[1]; data[i + 2] = background[2];
			data[i + 3] = transparent ? 0 : 255;
		}
	}
	const { top, left, width: fw, height: fh } = frame.dims;
	for (let y = 0; y < fh && top + y < height; y++) {
		const n = Math.min(fw, width - left);
		if (n > 0) data.set(frame.patch.subarray(y * fw * 4, (y * fw + n) * 4), ((top + y) * width + left) * 4);
	}
	return { data, width, height };
}
