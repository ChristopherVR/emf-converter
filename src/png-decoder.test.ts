/**
 * The dependency-free PNG decoder: every colour type, bit depth, filter,
 * Adam7 interlacing and tRNS, against PNGs assembled here from known
 * samples, plus round trips through the encoder and `@napi-rs/canvas`, and
 * the built-in inflater against Node's zlib.
 */
import { deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { decodePng, inflateZlibSync } from './png-decoder';
import { encodePng } from './png-encoder';

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const b of bytes) {
		crc ^= b;
		for (let k = 0; k < 8; k++) {
			crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(body.length, 0);
	head.write(type, 4, 'latin1');
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
	return Buffer.concat([head, body, crc]);
}

const ADAM7 = [
	[0, 0, 8, 8],
	[4, 0, 8, 8],
	[0, 4, 4, 8],
	[2, 0, 4, 4],
	[0, 2, 2, 4],
	[1, 0, 2, 2],
	[0, 1, 1, 2],
];

/**
 * Builds a PNG from raw samples (`samples[y][x]` = channel values at full
 * precision), packing bits MSB first, with filter `filter` on every row.
 */
function buildPng(opts: {
	width: number;
	height: number;
	depth: number;
	colorType: number;
	samples: number[][][];
	interlace?: boolean;
	filter?: number;
	plte?: number[];
	trns?: number[];
}): Uint8Array {
	const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[opts.colorType]!;
	const bpp = Math.max(1, (channels * opts.depth) >> 3);
	const passes = opts.interlace ? ADAM7 : [[0, 0, 1, 1]];
	const raw: number[] = [];
	for (const [px, py, sx, sy] of passes) {
		const xs: number[] = [];
		for (let x = px; x < opts.width; x += sx) xs.push(x);
		const ys: number[] = [];
		for (let y = py; y < opts.height; y += sy) ys.push(y);
		if (!xs.length || !ys.length) continue;
		let prev: number[] | null = null;
		for (const y of ys) {
			const bits: number[] = [];
			for (const x of xs) {
				for (const v of opts.samples[y][x]) {
					for (let b = opts.depth - 1; b >= 0; b--) bits.push((v >> b) & 1);
				}
			}
			while (bits.length % 8) bits.push(0);
			const line: number[] = [];
			for (let i = 0; i < bits.length; i += 8) line.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
			const f = opts.filter ?? 0;
			const out = line.map((v, i) => {
				const a = i >= bpp ? line[i - bpp] : 0;
				const up = prev ? prev[i] : 0;
				const c = prev && i >= bpp ? prev[i - bpp] : 0;
				const p = a + up - c;
				const pr = Math.abs(p - a) <= Math.abs(p - up) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - up) <= Math.abs(p - c) ? up : c;
				const pred = [0, a, up, (a + up) >> 1, pr][f];
				return (v - pred) & 0xff;
			});
			raw.push(f, ...out);
			prev = line;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(opts.width, 0);
	ihdr.writeUInt32BE(opts.height, 4);
	ihdr[8] = opts.depth;
	ihdr[9] = opts.colorType;
	ihdr[12] = opts.interlace ? 1 : 0;
	const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
	if (opts.plte) parts.push(chunk('PLTE', Uint8Array.from(opts.plte)));
	if (opts.trns) parts.push(chunk('tRNS', Uint8Array.from(opts.trns)));
	const z = deflateSync(Uint8Array.from(raw));
	// Split the data over two IDAT chunks, as encoders may.
	parts.push(chunk('IDAT', z.subarray(0, z.length >> 1)), chunk('IDAT', z.subarray(z.length >> 1)), chunk('IEND', new Uint8Array(0)));
	return new Uint8Array(Buffer.concat(parts));
}

const W = 11;
const H = 9;

describe('decodePng', () => {
	for (const interlace of [false, true]) {
		for (const filter of [0, 1, 2, 3, 4]) {
			it(`decodes 8-bit RGBA (filter ${filter}, interlace ${interlace})`, async () => {
				const samples = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => [x * 23, y * 27, (x * y * 7) & 255, 128 + x]));
				const png = await decodePng(buildPng({ width: W, height: H, depth: 8, colorType: 6, samples, interlace, filter }));
				expect(Array.from(png!.data)).toEqual(samples.flat(2));
			});
		}
	}

	it.each([1, 2, 4, 8, 16])('decodes %i-bit greyscale with a tRNS key', async (depth) => {
		const max = (1 << depth) - 1;
		const samples = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => [(x + y) % (max + 1)]));
		const png = await decodePng(buildPng({ width: W, height: H, depth, colorType: 0, samples, interlace: depth === 4, trns: [0, 0] }));
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				const v = samples[y][x][0];
				const g = depth === 16 ? v >> 8 : Math.round((v * 255) / max);
				expect(Array.from(png!.data.slice((y * W + x) * 4, (y * W + x) * 4 + 4))).toEqual([g, g, g, v === 0 ? 0 : 255]);
			}
		}
	});

	it.each([1, 2, 4, 8])('decodes %i-bit palette images with per-entry alpha', async (depth) => {
		const n = 1 << depth;
		const plte = Array.from({ length: n * 3 }, (_, i) => (i * 37) & 255);
		const trns = Array.from({ length: Math.min(n, 3) }, (_, i) => i * 100);
		const samples = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => [(x * 3 + y) % n]));
		const png = await decodePng(buildPng({ width: W, height: H, depth, colorType: 3, samples, plte, trns, interlace: depth === 2 }));
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				const i = samples[y][x][0];
				expect(Array.from(png!.data.slice((y * W + x) * 4, (y * W + x) * 4 + 4))).toEqual([
					plte[i * 3],
					plte[i * 3 + 1],
					plte[i * 3 + 2],
					i < trns.length ? trns[i] : 255,
				]);
			}
		}
	});

	it('decodes 16-bit RGB, grey+alpha and RGBA (high byte kept)', async () => {
		const rgb = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => [x * 5000, y * 7000, 65535 - x * 3000]));
		const a = await decodePng(buildPng({ width: W, height: H, depth: 16, colorType: 2, samples: rgb, filter: 4 }));
		expect(Array.from(a!.data.slice(0, 8))).toEqual([0, 0, 255, 255, 19, 0, 244, 255]);
		const ga = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => [x * 20, y * 25]));
		const b = await decodePng(buildPng({ width: W, height: H, depth: 8, colorType: 4, samples: ga, interlace: true }));
		expect(Array.from(b!.data.slice(4 * (2 * W + 3), 4 * (2 * W + 3) + 4))).toEqual([60, 60, 60, 50]);
		const rgba = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => [x * 5000, y * 7000, 100, 65535]));
		const c = await decodePng(buildPng({ width: W, height: H, depth: 16, colorType: 6, samples: rgba }));
		expect(Array.from(c!.data.slice(4, 8))).toEqual([19, 0, 0, 255]);
	});

	it('round-trips the encoder and agrees with @napi-rs/canvas', async () => {
		const napi = await import('@napi-rs/canvas');
		const data = Uint8ClampedArray.from({ length: 37 * 19 * 4 }, (_, i) => (i % 4 === 3 ? 255 : (i * 29) & 0xff));
		const png = await encodePng(data, 37, 19);
		expect(Array.from((await decodePng(png))!.data)).toEqual(Array.from(data));
		const c = napi.createCanvas(37, 19);
		c.getContext('2d').putImageData(new napi.ImageData(data, 37, 19), 0, 0);
		const viaNapi = await decodePng(new Uint8Array(c.toBuffer('image/png')));
		expect(Array.from(viaNapi!.data)).toEqual(Array.from(data));
	});

	it('rejects data that is not a PNG', async () => {
		expect(await decodePng(new Uint8Array([1, 2, 3]))).toBeNull();
	});
});

describe('inflateZlibSync', () => {
	it.each([0, 1, 6, 9])('inflates zlib level %i streams', (level) => {
		const input = Uint8Array.from({ length: 70000 }, (_, i) => (i % 251 < 120 ? i & 7 : (i * 13) & 255));
		expect(Array.from(inflateZlibSync(new Uint8Array(deflateSync(input, { level }))))).toEqual(Array.from(input));
	});
});
