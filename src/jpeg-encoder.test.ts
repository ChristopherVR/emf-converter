import { describe, expect, it } from 'vitest';
import jpegJs from 'jpeg-js';

import { decodeJpegTurbo } from './jpeg-turbo';
import { DEFAULT_JPEG_QUALITY, encodeJpeg } from './jpeg-encoder';

/** A colour gradient, straight RGBA; `detailed` makes it steep with a hard colour edge. */
function testImage(w: number, h: number, alpha = 255, detailed = true): Uint8ClampedArray {
	const px = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			px[i] = detailed ? (x * 255) / Math.max(1, w - 1) : 60 + x * 2;
			px[i + 1] = detailed ? (y * 255) / Math.max(1, h - 1) : 90 + y * 2;
			px[i + 2] = detailed && x > w / 2 && y > h / 2 ? 200 : 40;
			px[i + 3] = alpha;
		}
	}
	return px;
}

/** Peak signal-to-noise ratio of the RGB channels, in dB. */
function psnr(a: ArrayLike<number>, b: ArrayLike<number>): number {
	let se = 0;
	let n = 0;
	for (let i = 0; i < a.length; i += 4) {
		for (let c = 0; c < 3; c++) {
			se += (a[i + c] - b[i + c]) ** 2;
			n++;
		}
	}
	return se === 0 ? Infinity : 10 * Math.log10((255 * 255) / (se / n));
}

describe('encodeJpeg', () => {
	it.each([
		[1, 1, false],
		[7, 5, false],
		[64, 48, false],
		[101, 3, false],
		[1, 1, true],
		[7, 5, true],
		[16, 16, true],
		[33, 17, true],
	])('round-trips a %sx%s image (4:2:0 %s) through two independent decoders', (w, h, sub) => {
		// 4:2:0 averages colour over 2 x 2 pixels, so its image has no steep colour detail.
		const src = testImage(w, h, 255, !sub);
		const jpeg = encodeJpeg(src, w, h, { chromaSubsampling: sub });
		expect([...jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);
		expect([...jpeg.subarray(-2)]).toEqual([0xff, 0xd9]);
		const viaJs = jpegJs.decode(jpeg, { useTArray: true, formatAsRGBA: true });
		expect([viaJs.width, viaJs.height]).toEqual([w, h]);
		expect(psnr(src, viaJs.data)).toBeGreaterThan(30);
		const viaTurbo = decodeJpegTurbo(jpeg);
		expect(viaTurbo).not.toBeNull();
		expect([viaTurbo!.width, viaTurbo!.height]).toEqual([w, h]);
		expect(psnr(src, viaTurbo!.data)).toBeGreaterThan(30);
	});

	it('trades size for fidelity with the quality setting', () => {
		const src = testImage(64, 64);
		const low = encodeJpeg(src, 64, 64, { quality: 0.2 });
		const high = encodeJpeg(src, 64, 64, { quality: 1 });
		expect(low.length).toBeLessThan(high.length);
		const decode = (bytes: Uint8Array) => jpegJs.decode(bytes, { useTArray: true, formatAsRGBA: true }).data;
		expect(psnr(src, decode(high))).toBeGreaterThan(psnr(src, decode(low)));
		expect(psnr(src, decode(high))).toBeGreaterThan(40);
	});

	it('uses the browser default quality and treats a non-finite quality as the default', () => {
		const src = testImage(20, 20);
		expect(DEFAULT_JPEG_QUALITY).toBe(0.92);
		expect(encodeJpeg(src, 20, 20, { quality: NaN })).toEqual(encodeJpeg(src, 20, 20, { quality: 0.92 }));
		expect(encodeJpeg(src, 20, 20)).toEqual(encodeJpeg(src, 20, 20, { quality: 0.92 }));
	});

	it('keeps full-resolution chroma by default and subsamples it on request', () => {
		const src = testImage(32, 32);
		const decode = (bytes: Uint8Array) => jpegJs.decode(bytes, { useTArray: true, formatAsRGBA: true }).data;
		expect(encodeJpeg(src, 32, 32)).toEqual(encodeJpeg(src, 32, 32, { chromaSubsampling: false }));
		const subsampled = encodeJpeg(src, 32, 32, { chromaSubsampling: true });
		expect(subsampled.length).toBeLessThan(encodeJpeg(src, 32, 32).length);
		expect(psnr(src, decode(encodeJpeg(src, 32, 32)))).toBeGreaterThan(psnr(src, decode(subsampled)));
	});

	it('composites transparency over the background colour', () => {
		const clear = new Uint8ClampedArray(16 * 16 * 4);
		const decode = (bytes: Uint8Array) => jpegJs.decode(bytes, { useTArray: true, formatAsRGBA: true }).data;
		const white = decode(encodeJpeg(clear, 16, 16));
		const red = decode(encodeJpeg(clear, 16, 16, { background: [255, 0, 0] }));
		for (let i = 0; i < white.length; i += 4) {
			expect(Math.min(white[i], white[i + 1], white[i + 2])).toBeGreaterThanOrEqual(253);
			expect(red[i]).toBeGreaterThanOrEqual(250);
			expect(Math.max(red[i + 1], red[i + 2])).toBeLessThanOrEqual(5);
		}
	});

	it('rejects empty and oversized dimensions', () => {
		expect(() => encodeJpeg(new Uint8ClampedArray(0), 0, 1)).toThrow(RangeError);
		expect(() => encodeJpeg(new Uint8ClampedArray(4), 70000, 1)).toThrow(RangeError);
	});
});
