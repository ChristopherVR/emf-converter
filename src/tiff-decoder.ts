import * as UTIF from 'utif';
import { normalizeGroup3 } from './tiff-group3';
import { validCodecSize, type CodecPixels } from './image-codec-pixels';

export async function decodeTiff(bytes: Uint8Array): Promise<CodecPixels | null> {
	const buffer = bytes.slice().buffer;
	const pages = UTIF.decode(buffer);
	const page = pages.find((p) => p.t256 && p.t257);
	if (!page || !Array.isArray(page.t256) || !Array.isArray(page.t257) || !validCodecSize(Number(page.t256[0]), Number(page.t257[0]))) return null;
	if (Array.isArray(page.t259) && Number(page.t259[0]) === 7) {
		const { decodeJpegTiff } = await import('./tiff-jpeg');
		const jpeg = await decodeJpegTiff(new Uint8Array(buffer), page);
		if (jpeg) return { data: jpeg, width: Number(page.t256[0]), height: Number(page.t257[0]) };
	}
	// The legacy and Adobe Deflate tags encode the same zlib stream.
	// https://gitlab.com/libtiff/libtiff/-/blob/master/libtiff/tiff.h
	if (Array.isArray(page.t259) && page.t259[0] === 32946) page.t259 = [8];
	UTIF.decodeImage(normalizeGroup3(buffer, page), page);
	const width = page.width, height = page.height;
	if (!validCodecSize(width, height)) return null;
	const data = UTIF.toRGBA8(page);
	return data.length === width * height * 4 ? { data: new Uint8ClampedArray(data), width, height } : null;
}
