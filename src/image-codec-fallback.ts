/** Bundled pixel decoders for environments without Canvas image decoding. */
import { decodeJpegPixels } from './jpeg-decoder';
import { parseGIF, decompressFrame, type Frame } from 'gifuct-js';
import * as UTIF from 'utif';
import { normalizeGroup3 } from './tiff-group3';
import { decodeJpegTiff } from './tiff-jpeg';

interface Pixels { data: Uint8ClampedArray; width: number; height: number }
const validSize = (w: number, h: number): boolean => Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w <= 8192 && h <= 8192;

/** First frame/page, as GDI+ initially draws a multiframe image. */
export function decodeImageCodecFallback(bytes: Uint8Array): Pixels | null {
	try {
		if (bytes[0] === 0xff && bytes[1] === 0xd8) {
			const p = decodeJpegPixels(bytes);
			return validSize(p.width, p.height) ? { ...p, data: new Uint8ClampedArray(p.data) } : null;
		}
		if (bytes.length >= 13 && String.fromCharCode(...bytes.subarray(0, 6)).match(/^GIF8[79]a$/)) {
			const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			const width = v.getUint16(6, true), height = v.getUint16(8, true);
			if (!validSize(width, height)) return null;
			const gif = parseGIF(bytes.slice().buffer);
			const f = gif.frames.find((f): f is Frame => 'image' in f);
			if (!f || !validSize(f.image.descriptor.width, f.image.descriptor.height)) return null;
			const frame = decompressFrame(f, gif.gct, true);
			const data = new Uint8ClampedArray(width * height * 4);
			// GDI+ fills the logical screen around an offset first frame. With
			// transparency it uses that palette entry (including its RGB), otherwise
			// the global background colour. Later animation frames are not selected.
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
		if (bytes.length >= 8 && ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 42 && bytes[3] === 0) || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 42))) {
			const buffer = bytes.slice().buffer;
			const pages = UTIF.decode(buffer);
			const page = pages.find((p) => p.t256 && p.t257);
			if (!page || !Array.isArray(page.t256) || !Array.isArray(page.t257) || !validSize(Number(page.t256[0]), Number(page.t257[0]))) return null;
			const jpeg = decodeJpegTiff(new Uint8Array(buffer), page);
			if (jpeg) return { data: jpeg, width: Number(page.t256[0]), height: Number(page.t257[0]) };
			// The legacy and Adobe Deflate tags encode the same zlib stream.
			// https://gitlab.com/libtiff/libtiff/-/blob/master/libtiff/tiff.h
			if (Array.isArray(page.t259) && page.t259[0] === 32946) page.t259 = [8];
			UTIF.decodeImage(normalizeGroup3(buffer, page), page);
			const width = page.width, height = page.height;
			if (!validSize(width, height)) return null;
			const data = UTIF.toRGBA8(page);
			return data.length === width * height * 4 ? { data: new Uint8ClampedArray(data), width, height } : null;
		}
	} catch { /* Invalid/unsupported images leave the draw undecoded. */ }
	return null;
}
