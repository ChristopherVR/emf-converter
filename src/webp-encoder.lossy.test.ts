import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';

import { convertMetafile, convertMetafileToDataUrl,convertMetafileToWebpDataUrl } from './emf-converter';
import { encodePng } from './png-encoder';
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

function fixture(name: string): ArrayBuffer {
	const file = readFileSync(join(__dirname, '__fixtures__', name));
	return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
}

/** Smooth colour image (what the lossy codec is for), optionally with a translucent surround. */
function smoothImage(w: number, h: number, alpha: boolean): Uint8Array {
	const px = new Uint8Array(w * h * 4);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			px[i] = 128 + 100 * Math.sin(x / 9) * Math.cos(y / 13);
			px[i + 1] = (x * 255) / w;
			px[i + 2] = (y * 255) / h;
			const inDisc = (x - w / 2) ** 2 + (y - h / 2) ** 2 < (Math.min(w, h) / 3) ** 2;
			px[i + 3] = alpha ? (inDisc ? 255 : x % 7 === 0 ? 0 : 90) : 255;
		}
	}
	return px;
}

/** PSNR (dB) of the RGB channels over the pixels selected by `use`. */
function psnrWhere(a: ArrayLike<number>, b: ArrayLike<number>, use: (i: number) => boolean): number {
	let se = 0;
	let n = 0;
	for (let i = 0; i < a.length; i += 4) {
		if (!use(i)) {
			continue;
		}
		for (let c = 0; c < 3; c++) {
			se += (a[i + c] - b[i + c]) ** 2;
			n++;
		}
	}
	return se === 0 ? Infinity : 10 * Math.log10((255 * 255) / (se / n));
}

describe('encodeWebp lossy', () => {
	it.each([
		[1, 1],
		[1, 23],
		[19, 1],
		[16, 16],
		[33, 17],
		[333, 217],
	])('decodes %sx%s with small error', async (w, h) => {
		const src = smoothImage(w, h, false);
		const webp = encodeWebp(src, w, h, { lossy: true, quality: 0.9 });
		expect(String.fromCharCode(...webp.subarray(8, 16))).toBe('WEBPVP8 ');
		const out = await decode(webp);
		expect([out.width, out.height]).toEqual([w, h]);
		if (w * h > 64) {
			expect(psnrWhere(src, out.data, () => true)).toBeGreaterThan(36);
		} else {
			for (let i = 0; i < w * h * 4; i++) {
				expect(Math.abs(out.data[i] - src[i])).toBeLessThanOrEqual(24);
			}
		}
	});

	it('trades size for fidelity with the quality setting', async () => {
		const w = 120;
		const h = 90;
		const src = smoothImage(w, h, false);
		const low = encodeWebp(src, w, h, { lossy: true, quality: 0.2 });
		const mid = encodeWebp(src, w, h, { lossy: true });
		const high = encodeWebp(src, w, h, { lossy: true, quality: 1 });
		expect(low.length).toBeLessThan(mid.length);
		expect(mid.length).toBeLessThan(high.length);
		const p = async (webp: Uint8Array): Promise<number> => psnrWhere(src, (await decode(webp)).data, () => true);
		const [pl, pm, ph] = [await p(low), await p(mid), await p(high)];
		expect(pl).toBeLessThan(pm);
		expect(pm).toBeLessThan(ph);
		expect(pm).toBeGreaterThan(36);
		expect(ph).toBeGreaterThan(42);
	});

	it('keeps the alpha plane exactly (ALPH chunk in a VP8X container)', async () => {
		const w = 71;
		const h = 53;
		const src = smoothImage(w, h, true);
		const webp = encodeWebp(src, w, h, { lossy: true, quality: 0.9 });
		expect(String.fromCharCode(...webp.subarray(12, 16))).toBe('VP8X');
		expect(String.fromCharCode(...webp.subarray(30, 34))).toBe('ALPH');
		const out = await decode(webp);
		for (let i = 0; i < w * h; i++) {
			expect(out.data[i * 4 + 3]).toBe(src[i * 4 + 3]);
		}
		expect(psnrWhere(src, out.data, (i) => src[i + 3] === 255)).toBeGreaterThan(34);
	});
});

describe('WebP versus PNG on a real rendering', () => {
	it('lossless WebP of a fixture rendering is smaller than the PNG and decodes to the same pixels', async () => {
		const buffer = fixture('sample-crown.wmf');
		const pngUrl = await convertMetafileToDataUrl(buffer);
		const webpUrl = await convertMetafileToWebpDataUrl(buffer);
		expect(pngUrl).not.toBeNull();
		expect(webpUrl?.startsWith('data:image/webp;base64,')).toBe(true);
		const pngImg = await loadImage(Buffer.from(pngUrl!.split(',')[1], 'base64'));
		const c = createCanvas(pngImg.width, pngImg.height);
		const ctx = c.getContext('2d');
		ctx.drawImage(pngImg, 0, 0);
		const px = ctx.getImageData(0, 0, pngImg.width, pngImg.height).data;
		const png = await encodePng(px, pngImg.width, pngImg.height);
		const webp = Uint8Array.from(Buffer.from(webpUrl!.split(',')[1], 'base64'));
		expect(webp.length).toBeLessThan(png.length);
		const out = await decode(webp);
		expect([out.width, out.height]).toEqual([pngImg.width, pngImg.height]);
		expect([...out.data]).toEqual([...px]);
	});

	it("convertMetafile({ format: 'webp' }) returns WebP bytes, lossless by default", async () => {
		const image = await convertMetafile(new Uint8Array(fixture('sample-gradient-clip.emf')), { format: 'webp' });
		expect(image?.format).toBe('webp');
		expect(image?.mimeType).toBe('image/webp');
		expect(String.fromCharCode(...image!.data.subarray(8, 16))).toBe('WEBPVP8L');
		const out = await decode(image!.data);
		expect([out.width, out.height]).toEqual([image!.width, image!.height]);
	});

	it('convertMetafileToWebpDataUrl can write lossy output', async () => {
		const url = await convertMetafileToWebpDataUrl(fixture('sample-gradient-clip.emf'), { lossless: false, quality: 0.8 });
		expect(url?.startsWith('data:image/webp;base64,')).toBe(true);
		const bytes = Uint8Array.from(Buffer.from(url!.split(',')[1], 'base64'));
		expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe('WEBP');
		expect(String.fromCharCode(...bytes.subarray(12, 16))).not.toBe('VP8L');
		expect((await decode(bytes)).width).toBeGreaterThan(0);
	});
});
