import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { decodePng } from './png-decoder';
import { decodeWebp } from './webp-decoder';

/** A deterministic test picture: gradients, hard edges, a circle, noise and (optionally) soft alpha. */
function paint(width: number, height: number, alpha: boolean, seed = 1) {
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext('2d');
	let s = seed;
	const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
	const g = ctx.createLinearGradient(0, 0, width, height);
	g.addColorStop(0, '#ff3010');
	g.addColorStop(0.5, '#20c040');
	g.addColorStop(1, '#3050ff');
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, width, height);
	ctx.fillStyle = '#fff';
	ctx.fillRect(width * 0.1, height * 0.1, width * 0.3, height * 0.2);
	ctx.fillStyle = '#000';
	ctx.beginPath();
	ctx.arc(width * 0.6, height * 0.6, Math.min(width, height) * 0.3, 0, Math.PI * 2);
	ctx.fill();
	for (let i = 0; i < width * height / 40; i++) {
		ctx.fillStyle = `rgba(${(rnd() * 255) | 0},${(rnd() * 255) | 0},${(rnd() * 255) | 0},${alpha ? rnd().toFixed(2) : 1})`;
		ctx.fillRect(rnd() * width, rnd() * height, 1 + rnd() * 3, 1 + rnd() * 3);
	}
	if (alpha) {
		ctx.globalCompositeOperation = 'destination-out';
		const a = ctx.createLinearGradient(0, 0, width, 0);
		a.addColorStop(0, 'rgba(0,0,0,0)');
		a.addColorStop(1, 'rgba(0,0,0,0.8)');
		ctx.fillStyle = a;
		ctx.fillRect(0, 0, width, height);
	}
	return canvas;
}

/** The canvas backend's own decode (Skia, libwebp inside). */
async function reference(webp: Uint8Array) {
	const image = await loadImage(Buffer.from(webp));
	const c = createCanvas(image.width, image.height);
	const ctx = c.getContext('2d');
	ctx.drawImage(image, 0, 0);
	return { width: image.width, height: image.height, data: ctx.getImageData(0, 0, image.width, image.height).data };
}

function maxDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
	let max = 0;
	for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
	return max;
}

const SIZES: [number, number][] = [[1, 1], [2, 3], [15, 17], [16, 16], [37, 21], [64, 1], [1, 64], [100, 75], [257, 131]];

/** Decodes with both decoders; returns the largest channel differences for opaque and translucent pixels. */
async function compare(webp: Uint8Array, expectSize: [number, number]) {
	const mine = decodeWebp(webp);
	expect(mine).not.toBeNull();
	const ref = await reference(webp);
	expect([mine!.width, mine!.height]).toEqual(expectSize);
	expect([ref.width, ref.height]).toEqual(expectSize);
	let opaque = 0, alphaDiff = 0, soft = 0;
	for (let i = 0; i < ref.data.length; i += 4) {
		alphaDiff = Math.max(alphaDiff, Math.abs(mine!.data[i + 3] - ref.data[i + 3]));
		if (ref.data[i + 3] === 255) {
			for (let c = 0; c < 3; c++) opaque = Math.max(opaque, Math.abs(mine!.data[i + c] - ref.data[i + c]));
		} else if (ref.data[i + 3] > 128) {
			for (let c = 0; c < 3; c++) soft = Math.max(soft, Math.abs(mine!.data[i + c] - ref.data[i + c]));
		}
	}
	return { opaque, alphaDiff, soft };
}

describe('WebP decoder against the canvas backend (libwebp)', () => {
	for (const alpha of [false, true]) {
		for (const quality of [1, 30, 75, 95, 100]) {
			it(`${quality === 100 ? 'lossless' : 'lossy q' + quality}${alpha ? ' with alpha' : ''}, all sizes`, async () => {
				for (const [w, h] of SIZES) {
					const webp = new Uint8Array(await paint(w, h, alpha, w * 31 + h).encode('webp', quality));
					const r = await compare(webp, [w, h]);
					expect(r.alphaDiff).toBe(0);
					// Opaque pixels must be identical, lossy included (same fancy upsampling and loop filter as libwebp).
					expect(r.opaque).toBe(0);
					// Translucent ones only differ by the canvas' premultiplied round trip.
					expect(r.soft).toBeLessThanOrEqual(2);
				}
			});
		}
	}
});

const fixtureDir = new URL('./__fixtures__/webp/', import.meta.url);
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(name, fixtureDir)));
const names = readdirSync(fixtureDir).filter((f) => f.endsWith('.webp')).map((f) => f.slice(0, -5));

describe('WebP decoder against libwebp output (fixtures)', () => {
	it.each(names)('%s decodes to the same RGBA as libwebp', async (name) => {
		const mine = decodeWebp(fixture(`${name}.webp`));
		const ref = (await decodePng(fixture(`${name}.png`)))!;
		expect(mine).not.toBeNull();
		expect([mine!.width, mine!.height]).toEqual([ref.width, ref.height]);
		expect(maxDiff(mine!.data, ref.data)).toBe(0);
	});
});

/** Payload of the first chunk of a WebP file with the given FourCC. */
function chunkOf(file: Uint8Array, type: string): Uint8Array {
	for (let p = 12; p + 8 <= file.length; ) {
		const size = file[p + 4] | (file[p + 5] << 8) | (file[p + 6] << 16) | (file[p + 7] << 24);
		if (String.fromCharCode(...file.subarray(p, p + 4)) === type) return file.subarray(p + 8, p + 8 + size);
		p += 8 + size + (size & 1);
	}
	throw new Error(`no ${type} chunk`);
}

function chunk(type: string, payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(8 + payload.length + (payload.length & 1));
	for (let i = 0; i < 4; i++) out[i] = type.charCodeAt(i);
	new DataView(out.buffer).setUint32(4, payload.length, true);
	out.set(payload, 8);
	return out;
}

function riff(...chunks: Uint8Array[]): Uint8Array {
	const size = 4 + chunks.reduce((n, c) => n + c.length, 0);
	const out = new Uint8Array(8 + size);
	out.set([0x52, 0x49, 0x46, 0x46], 0);
	new DataView(out.buffer).setUint32(4, size, true);
	out.set([0x57, 0x45, 0x42, 0x50], 8);
	let p = 12;
	for (const c of chunks) {
		out.set(c, p);
		p += c.length;
	}
	return out;
}

const le24 = (v: number): number[] => [v & 255, (v >> 8) & 255, (v >> 16) & 255];
const vp8x = (flags: number, w: number, h: number): Uint8Array => chunk('VP8X', new Uint8Array([flags, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]));

describe('WebP container handling', () => {
	it('decodes ALPH with raw data and each prediction filter', () => {
		const lossy = fixture('lossy-17x15.webp');
		const [w, h] = [17, 15];
		const alpha = new Uint8Array(w * h).map((_, i) => (i * 37 + (i % w) * 11 + ((i / w) | 0) * 5) & 255);
		// The encoder side of each filter: subtract the prediction.
		const filtered = (filter: number): Uint8Array => {
			const out = new Uint8Array(alpha.length);
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < w; x++) {
					const i = y * w + x;
					let pred = 0;
					if (y === 0 && x > 0) pred = alpha[i - 1];
					else if (y > 0 && x === 0) pred = alpha[i - w];
					else if (y > 0) {
						const l = alpha[i - 1], t = alpha[i - w], tl = alpha[i - w - 1];
						pred = filter === 1 ? l : filter === 2 ? t : Math.min(255, Math.max(0, l + t - tl));
					}
					out[i] = (alpha[i] - pred) & 255;
				}
			}
			return out;
		};
		const plain = decodeWebp(lossy)!;
		for (const filter of [0, 1, 2, 3]) {
			const payload = new Uint8Array(1 + alpha.length);
			payload[0] = filter << 2;
			payload.set(filter === 0 ? alpha : filtered(filter), 1);
			const px = decodeWebp(riff(vp8x(0x10, w, h), chunk('ALPH', payload), chunk('VP8 ', chunkOf(lossy, 'VP8 '))))!;
			expect(px).not.toBeNull();
			expect(Array.from(px.data.filter((_, i) => i % 4 === 3))).toEqual(Array.from(alpha));
			// Colour is unaffected by the alpha plane.
			expect(px.data.filter((_, i) => i % 4 !== 3)).toEqual(plain.data.filter((_, i) => i % 4 !== 3));
		}
	});

	it('draws the first animation frame at its offset on a transparent canvas', async () => {
		const src = fixture('lossless-photo-alpha.webp');
		const ref = (await decodePng(fixture('lossless-photo-alpha.png')))!;
		const [cw, ch, ox, oy] = [60, 50, 6, 4];
		const anmf = new Uint8Array([...le24(ox / 2), ...le24(oy / 2), ...le24(ref.width - 1), ...le24(ref.height - 1), ...le24(100), 0, ...chunk('VP8L', chunkOf(src, 'VP8L'))]);
		// A second frame must be ignored.
		const px = decodeWebp(riff(vp8x(0x12, cw, ch), chunk('ANIM', new Uint8Array(6)), chunk('ANMF', anmf), chunk('ANMF', anmf)))!;
		expect([px.width, px.height]).toEqual([cw, ch]);
		for (let y = 0; y < ch; y++) {
			for (let x = 0; x < cw; x++) {
				const inside = x >= ox && x < ox + ref.width && y >= oy && y < oy + ref.height;
				const at = (y * cw + x) * 4, rf = ((y - oy) * ref.width + x - ox) * 4;
				expect(Array.from(px.data.subarray(at, at + 4))).toEqual(inside ? Array.from(ref.data.subarray(rf, rf + 4)) : [0, 0, 0, 0]);
			}
		}
	});

	it('returns null for invalid, truncated and oversize input', () => {
		const lossy = fixture('lossy-q75-m6.webp'), lossless = fixture('lossless-photo.webp');
		expect(decodeWebp(new Uint8Array(0))).toBeNull();
		expect(decodeWebp(new Uint8Array(64))).toBeNull();
		expect(decodeWebp(lossy.subarray(0, 30))).toBeNull();
		expect(decodeWebp(lossless.subarray(0, 40))).toBeNull();
		// A VP8X canvas that disagrees with the bitstream.
		expect(decodeWebp(riff(vp8x(0, 20, 20), chunk('VP8 ', chunkOf(lossy, 'VP8 '))))).toBeNull();
		// Declared sizes above the 8192 limit are refused before anything is allocated.
		expect(decodeWebp(riff(chunk('VP8L', new Uint8Array([0x2f, 0xff, 0xff, 0xff, 0x0f]))))).toBeNull();
		expect(decodeWebp(riff(vp8x(0, 9000, 10)))).toBeNull();
	});

	it('does not modify its input', () => {
		const data = fixture('lossy-alpha-lossy.webp');
		const copy = data.slice();
		decodeWebp(data);
		expect(data).toEqual(copy);
	});
});
