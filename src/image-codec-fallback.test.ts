import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { decodeImageBytesBuiltIn } from './emf-canvas-helpers';
import { decodePng } from './png-decoder';
import { colorMatrixObject, withEffect } from './__fixtures__/emf-plus-effect-records';
import { effectedDraw } from './emf-plus-draw-image';

vi.mock('@napi-rs/canvas', () => { throw new Error('No native canvas in this test'); });
const bytesFor = (kind: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./__fixtures__/gdi/codec-${kind}.bin`, import.meta.url)));

/** Replace the first compressed image object, maintaining its EMF record sizes. */
function embeddedImage(encoded: Uint8Array): ArrayBuffer {
	const bytes = new Uint8Array(withEffect('gpx-image-rotated-bilinear.emf', colorMatrixObject([0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1])));
	const v = new DataView(bytes.buffer);
	for (let off = 0; off + 16 <= bytes.length; off += v.getUint32(off + 4, true)) {
		const size = v.getUint32(off + 4, true);
		if (v.getUint32(off, true) !== 70 || v.getUint32(off + 12, true) !== 0x2b464d45) continue;
		for (let p = off + 16; p + 12 <= off + size; p += v.getUint32(p + 4, true)) {
			if (v.getUint16(p, true) !== 0x4008 || ((v.getUint16(p + 2, true) >> 8) & 0x7f) !== 5) continue;
			const oldSize = v.getUint32(p + 4, true);
			const newSize = (40 + encoded.length + 3) & ~3;
			const delta = newSize - oldSize;
			const out = new Uint8Array(bytes.length + delta);
			out.set(bytes.subarray(0, p + 40));
			out.set(encoded, p + 40);
			out.set(bytes.subarray(p + oldSize), p + newSize);
			const o = new DataView(out.buffer);
			o.setUint32(p + 4, newSize, true);
			o.setUint32(p + 8, 28 + encoded.length, true);
			o.setUint32(p + 12 + 24, 1, true);
			o.setUint32(off + 4, size + delta, true);
			o.setUint32(off + 8, v.getUint32(off + 8, true) + delta, true);
			o.setUint32(48, out.length, true);
			return out.buffer;
		}
	}
	throw new Error('Image object missing');
}

describe('bundled image codecs without a canvas backend', () => {
	it.each(['deflate-strips', 'deflate-legacy-strips', 'deflate-predictor-strips', 'uncompressed-tiles', 'deflate-tiles', 'deflate-legacy-tiles', 'jpeg-ycbcr-strips', 'jpeg-rgb-strips', 'jpeg-rgb-tiles', 'jpeg-ycbcr-tiles'])('decodes native TIFF %s including partial edge blocks', async (variant) => {
		const kind = `tiff-${variant}`, encoded = bytesFor(kind), original = encoded.slice();
		const decoded = (await decodeImageBytesBuiltIn(encoded))!;
		const reference = (await decodePng(new Uint8Array(readFileSync(new URL(`./__fixtures__/gdi/codec-${kind}.png`, import.meta.url)))))!;
		expect(decoded).not.toBeNull();
		expect([decoded.width, decoded.height]).toEqual([37, 19]);
		let max = 0, sum = 0;
		for (let i = 0; i < decoded.data.length; i++) { const difference = Math.abs(decoded.data[i] - reference.data[i]); max = Math.max(max, difference); sum += difference; }
		expect(max).toBeLessThanOrEqual(0);
		expect(sum / decoded.data.length).toBeLessThanOrEqual(0);
		expect(encoded).toEqual(original);
	});
	it.each(['444', '422', '420', 'progressive', 'rgb', 'grey'])('matches native JPEG %s reconstruction on odd-sized images', async (variant) => {
		const kind = `jpeg-${variant}`, decoded = (await decodeImageBytesBuiltIn(bytesFor(kind)))!;
		const reference = (await decodePng(new Uint8Array(readFileSync(new URL(`./__fixtures__/gdi/codec-${kind}.png`, import.meta.url)))))!;
		expect(decoded).not.toBeNull();
		expect([decoded.width, decoded.height]).toEqual([37, 19]);
		let max = 0, sum = 0;
		for (let i = 0; i < decoded.data.length; i++) { const difference = Math.abs(decoded.data[i] - reference.data[i]); max = Math.max(max, difference); sum += difference; }
		expect(max).toBeLessThanOrEqual(variant === 'rgb' || variant === 'grey' ? 1 : 3);
		expect(sum / decoded.data.length).toBeLessThanOrEqual(0.4);
	});
	it.each(['none', 'packbits', 'ccitt3', 'ccitt4'])('matches native bilevel TIFF %s with odd-width scanlines', async (compression) => {
		const kind = `tiff-bilevel-${compression}`;
		const decoded = (await decodeImageBytesBuiltIn(bytesFor(kind)))!;
		const reference = (await decodePng(new Uint8Array(readFileSync(new URL(`./__fixtures__/gdi/codec-${kind}.png`, import.meta.url)))))!;
		expect(decoded).not.toBeNull();
		expect([decoded.width, decoded.height]).toEqual([37, 19]);
		expect(decoded.data).toEqual(reference.data);
	});
	it.each(['gif-offset-opaque', 'gif-offset-opaque-background', 'gif-offset-transparent', 'gif-offset-transparent-background', 'gif-offset-transparent-index', 'gif-offset-opaque-background-local', 'gif-offset-transparent-background-local', 'tiff-lzw', 'tiff-multipage'])('matches the first native frame/page of %s byte for byte', async (kind) => {
		const decoded = (await decodeImageBytesBuiltIn(bytesFor(kind)))!;
		const reference = (await decodePng(new Uint8Array(readFileSync(new URL(`./__fixtures__/gdi/codec-${kind}.png`, import.meta.url)))))!;
		expect([decoded.width, decoded.height]).toEqual([reference.width, reference.height]);
		expect(decoded.data).toEqual(reference.data);
	});
	it.each(['jpeg', 'gif', 'tiff'])('decodes native %s pixels and applies an SVG image effect', async (kind) => {
		const encoded = bytesFor(kind);
		const decoded = (await decodeImageBytesBuiltIn(encoded))!;
		const reference = (await decodePng(new Uint8Array(readFileSync(new URL(`./__fixtures__/gdi/codec-${kind}.png`, import.meta.url)))))!;
		expect([decoded.width, decoded.height]).toEqual([reference.width, reference.height]);
		let max = 0, sum = 0;
		for (let i = 0; i < decoded.data.length; i++) {
			const d = Math.abs(decoded.data[i] - reference.data[i]);
			max = Math.max(max, d);
			sum += d;
		}
		// Pixel-centred chroma reconstruction leaves small JPEG rounding
		// differences; lossless GIF and TIFF must match byte for byte.
		expect(max).toBeLessThanOrEqual(0);
		expect(sum / decoded.data.length).toBeLessThanOrEqual(0);
		const { convertMetafileToSvg } = await import('./index');
		const svg = (await convertMetafileToSvg(embeddedImage(encoded)))!;
		const image = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(svg);
		expect(image).not.toBeNull();
		const effected = (await decodePng(Buffer.from(image![1], 'base64')))!;
		expect([effected.width, effected.height]).toEqual([16, 16]);
		for (let i = 0; i < decoded.data.length; i += 4) {
			expect(Array.from(effected.data.subarray(i, i + 4))).toEqual([decoded.data[i + 2], decoded.data[i + 1], decoded.data[i], decoded.data[i + 3]]);
		}
	});
	it('returns null for invalid JPEG and TIFF data', async () => {
		expect(await decodeImageBytesBuiltIn(new Uint8Array([255, 216, 255, 217]))).toBeNull();
		expect(await decodeImageBytesBuiltIn(new Uint8Array([73, 73, 42, 0, 255, 255, 255, 127]))).toBeNull();
	});
	it('does not apply an effect to a malformed non-pixel source rectangle', () => {
		const img = { kind: 'plus-image' as const, type: 1, data: null };
		const bitmap = { kind: 'bitmap' as const, width: 1, height: 1, rgba: new Uint8ClampedArray([0, 0, 0, 255]) };
		const transform: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
		const draw = { imageData: new ArrayBuffer(0), transform, dx: 0, dy: 0, dw: 1, dh: 1 };
		expect(effectedDraw(img, bitmap, { kind: 'brightnessContrast', brightness: 255, contrast: 0 }, draw, { unit: 4, srcX: 0, srcY: 0, srcW: 1, srcH: 1, toWorld: () => transform })).toBeNull();
	});
});
