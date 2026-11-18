import { validCodecSize, type CodecPixels } from './image-codec-pixels';

/** Replaced by the lite build's decoder-free stand-in. */
export const BUNDLED_IMAGE_CODECS = true;

export async function decodeImageCodecFallback(bytes: Uint8Array): Promise<CodecPixels | null> {
	try {
		if (bytes[0] === 0xff && bytes[1] === 0xd8) {
			const { decodeJpegPixels } = await import('./jpeg-decoder');
			const pixels = await decodeJpegPixels(bytes);
			return validCodecSize(pixels.width, pixels.height) ? { ...pixels, data: new Uint8ClampedArray(pixels.data) } : null;
		}
		if (bytes.length >= 20 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
			const { decodeWebp } = await import('./webp-decoder');
			return decodeWebp(bytes);
		}
		if (bytes.length >= 13 && /^GIF8[79]a$/.test(String.fromCharCode(...bytes.subarray(0, 6)))) {
			const { decodeGif } = await import('./gif-decoder');
			return decodeGif(bytes);
		}
		if (bytes.length >= 8 && ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 42 && bytes[3] === 0) || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 42))) {
			const { decodeTiff } = await import('./tiff-decoder');
			return await decodeTiff(bytes);
		}
	} catch {
		return null;
	}
	return null;
}
