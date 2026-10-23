import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';

import { encodeWebp } from './webp-encoder';

/** Decodes a WebP through @napi-rs/canvas (libwebp) to straight RGBA. */
async function decode(webp: Uint8Array): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
	const img = await loadImage(Buffer.from(webp));
	const canvas = createCanvas(img.width, img.height);
	const ctx = canvas.getContext('2d');
	ctx.drawImage(img, 0, 0);
	const id = ctx.getImageData(0, 0, img.width, img.height);
	return { data: id.data, width: img.width, height: img.height };
}

/** Deterministic pseudo-random bytes. */
function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s >>> 24;
	};
}

/** Synthetic metafile-like image: flat fills, lines, a gradient, noise-free text-ish strokes. */
function syntheticImage(w: number, h: number, alpha: boolean): Uint8Array {
	const px = new Uint8Array(w * h * 4);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			let r = 255;
			let g = 255;
			let b = 255;
			let a = alpha ? 0 : 255;
			if (x > w / 4 && x < w / 2 && y > h / 4 && y < (3 * h) / 4) {
				[r, g, b, a] = [200, 30, 30, 255];
			}
			if (x >= w / 2 && y > h / 3) {
				[r, g, b, a] = [(x * 255) / w, (y * 255) / h, 128, alpha ? 128 + ((x + y) % 100) : 255];
			}
			if ((x + y) % 17 === 0) {
				[r, g, b, a] = [0, 0, 0, 255];
			}
			px[i] = r;
			px[i + 1] = g;
			px[i + 2] = b;
			px[i + 3] = a;
		}
	}
	return px;
}

describe('encodeWebp lossless', () => {
	it.each([
		[1, 1, false],
		[1, 1, true],
		[1, 37, true],
		[41, 1, false],
		[2, 2, false],
		[17, 13, true],
		[64, 64, false],
		[333, 217, true],
		[333, 217, false],
	])('decodes %sx%s (alpha %s) to exactly the input pixels', async (w, h, alpha) => {
		const src = syntheticImage(w, h, alpha);
		const webp = encodeWebp(src, w, h);
		expect(String.fromCharCode(...webp.subarray(0, 4))).toBe('RIFF');
		expect(String.fromCharCode(...webp.subarray(8, 16))).toBe('WEBPVP8L');
		const out = await decode(webp);
		expect([out.width, out.height]).toEqual([w, h]);
		// Premultiplication inside the canvas only loses information where alpha < 255.
		for (let i = 0; i < w * h; i++) {
			const a = src[i * 4 + 3];
			expect(out.data[i * 4 + 3]).toBe(a);
			if (a === 255) {
				expect([...out.data.subarray(i * 4, i * 4 + 3)]).toEqual([...src.subarray(i * 4, i * 4 + 3)]);
			}
		}
	});

	it('is exact for random noise and for a many-colour (non-palette) image', async () => {
		const next = rng(7);
		const w = 90;
		const h = 70;
		const noise = new Uint8Array(w * h * 4);
		for (let i = 0; i < noise.length; i++) {
			noise[i] = next();
		}
		for (let i = 3; i < noise.length; i += 4) {
			noise[i] = 255;
		}
		const out = await decode(encodeWebp(noise, w, h));
		expect([...out.data]).toEqual([...noise]);
	});

	it('is exact when pixels repeat at every short 2-D neighbourhood offset', async () => {
		const w = 97;
		const h = 120;
		const next = rng(11);
		const src = new Uint8Array(w * h * 4);
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				src.set([next(), next(), next(), 255], (y * w + x) * 4);
			}
		}
		// Overwrite 16-pixel runs with copies from (dx, dy) = every offset in -8..8 x 1..8.
		let k = 0;
		for (let dy = 1; dy <= 8; dy++) {
			for (let dx = -8; dx <= 8; dx++, k++) {
				const y = 10 + dy + Math.floor(k / 5) * 9;
				const x = 10 + (k % 5) * 18;
				for (let i = 0; i < 16 && y < h; i++) {
					const from = ((y - dy) * w + (x + i - dx)) * 4;
					src.copyWithin((y * w + x + i) * 4, from, from + 4);
				}
			}
		}
		const out = await decode(encodeWebp(src, w, h));
		expect([...out.data]).toEqual([...src]);
	});

	it('is exact for a few-colour image (palette route, bundled indices)', async () => {
		const w = 55;
		const h = 33;
		const next = rng(3);
		const src = new Uint8Array(w * h * 4);
		const colours = [
			[255, 255, 255],
			[0, 0, 0],
			[255, 0, 0],
		];
		for (let i = 0; i < w * h; i++) {
			const c = colours[(next() >> 5) % 3];
			src.set([c[0], c[1], c[2], 255], i * 4);
		}
		const out = await decode(encodeWebp(src, w, h));
		expect([...out.data]).toEqual([...src]);
	});

	it('signals no alpha in the header for fully opaque pixels, and alpha otherwise', () => {
		const opaque = encodeWebp(syntheticImage(8, 8, false), 8, 8);
		const translucent = encodeWebp(syntheticImage(8, 8, true), 8, 8);
		// VP8L payload starts at byte 20: signature, then 14+14 size bits, then the alpha bit.
		const alphaBit = (webp: Uint8Array): number => (webp[24] >> 4) & 1;
		expect(alphaBit(opaque)).toBe(0);
		expect(alphaBit(translucent)).toBe(1);
	});

	it('rejects bad dimensions and short buffers', () => {
		expect(() => encodeWebp(new Uint8Array(4), 0, 1)).toThrow(RangeError);
		expect(() => encodeWebp(new Uint8Array(4), 1, 16384)).toThrow(RangeError);
		expect(() => encodeWebp(new Uint8Array(3), 1, 1)).toThrow(RangeError);
	});
});
