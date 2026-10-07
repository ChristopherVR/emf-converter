/**
 * Arithmetic-coded JPEG encoder, a test tool for the native-reference captures of `src/jpeg-arith.ts`. It is never
 * bundled.
 *
 *   bun scripts/gdi-fixtures/arith-jpeg-encoder.ts <dir> [--control <dir>]
 *
 * writes `codec-jpeg-arith-<variant>.bin` into <dir> (plus `-huffman.bin` copies of the four-component ones) (sequential and progressive arithmetic JPEG with restart
 * intervals, custom DAC conditioning, 4:2:0 and 4:2:2 subsampling, greyscale, CMYK and YCCK), and with `--control`
 * also `<variant>.ctl`: the same quantised coefficients written as sequential Huffman JPEG. A decoder that
 * understands both must produce identical pixels for the two files, which is how `arith-jpeg-verify.py` proves the
 * encoder with Pillow (libjpeg-turbo).
 *
 * The entropy coder is a port of the encoder in libjpeg's `jcarith.c` (Independent JPEG Group, copyright (C)
 * 1991-2020 Thomas G. Lane, Guido Vollbeding; Nils Larsson's arithmetic coding extension), using the probability
 * table of `jaricom.c` that `src/jpeg-arith.ts` carries. This software is based in part on the work of the
 * Independent JPEG Group; see THIRD_PARTY_NOTICES for the IJG license. The forward DCT, quantisation, colour
 * conversion and the Huffman control writer are original and deliberately simple.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATES } from '../../src/jpeg-arith';

const NATURAL = [
	0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43,
	36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

// ---------------------------------------------------------------- source image and coefficients

const LUMA_Q = [
	16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103,
	77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const CHROMA_Q = [
	17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
	...new Array(32).fill(99),
];

/** libjpeg's quality scaling of an Annex K table, in natural order. */
function scaledTable(base: number[], quality: number): number[] {
	const scale = quality < 50 ? 5000 / quality : 200 - quality * 2;
	return base.map(v => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))));
}

interface Rgb {
	width: number;
	height: number;
	r: number[];
	g: number[];
	b: number[];
}

/** The 37 x 19 pattern the other codec-jpeg fixtures are made from (`codec-advanced.py`). */
function patternImage(): Rgb {
	const width = 37, height = 19;
	const image: Rgb = { width, height, r: [], g: [], b: [] };
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			image.r.push((x * 7 + y * 3) % 256);
			image.g.push((y * 13 + x * 2) % 256);
			image.b.push(((255 - x * 5 + y) % 256 + 256) % 256);
		}
	}
	return image;
}

/** A busy 61 x 45 image: smooth gradients plus seeded noise, so quality-100 coefficients reach large magnitudes. */
function noiseImage(): Rgb {
	const width = 61, height = 45;
	let seed = 12345;
	const random = (): number => {
		seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
		return (seed >>> 8) / 16777216;
	};
	const image: Rgb = { width, height, r: [], g: [], b: [] };
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const edge = (x >> 3) % 2 ^ (y >> 3) % 2 ? 255 : 0;
			image.r.push(Math.round(edge * 0.9 + random() * 25));
			image.g.push(Math.min(255, Math.round(x * 4 + random() * 255 * (x > 30 ? 1 : 0.1))));
			image.b.push(Math.min(255, Math.round(y * 5 + random() * 120)));
		}
	}
	return image;
}

type Kind = 'rgb' | 'grey' | 'cmyk' | 'ycck';

/** Full-resolution planes for each component of the JPEG colour space. */
function planesFor(image: Rgb, kind: Kind): number[][] {
	const n = image.width * image.height;
	const clamp = (v: number): number => Math.min(255, Math.max(0, Math.round(v)));
	const y: number[] = [], cb: number[] = [], cr: number[] = [];
	for (let i = 0; i < n; i++) {
		const { r: R, g: G, b: B } = { r: image.r[i], g: image.g[i], b: image.b[i] };
		y.push(clamp(0.299 * R + 0.587 * G + 0.114 * B));
		cb.push(clamp(-0.168736 * R - 0.331264 * G + 0.5 * B + 128));
		cr.push(clamp(0.5 * R - 0.418688 * G - 0.081312 * B + 128));
	}
	const black = image.r.map((r, i) => clamp(Math.abs(r - image.b[i]) / 2));
	if (kind === 'grey') return [y];
	if (kind === 'rgb') return [y, cb, cr];
	if (kind === 'ycck') return [y, cb, cr, black];
	return [image.r.map(v => 255 - v), image.g.map(v => 255 - v), image.b.map(v => 255 - v), black];
}

interface Comp {
	id: number;
	h: number;
	v: number;
	tq: number;
	dc: number;
	ac: number;
	/** Component dimensions in samples, and in 8x8 blocks (padded to whole MCUs). */
	width: number;
	height: number;
	blocksW: number;
	blocksH: number;
	/** Quantised coefficients, natural order, blocksW * blocksH * 64. */
	coefs: Int32Array;
}

let cosTable: number[][] | undefined;
function dct8(block: number[]): number[] {
	cosTable ??= Array.from({ length: 8 }, (_, u) => Array.from({ length: 8 }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / 16)));
	const out = new Array<number>(64);
	for (let v = 0; v < 8; v++) {
		for (let u = 0; u < 8; u++) {
			let sum = 0;
			for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) sum += block[y * 8 + x] * cosTable[u][x] * cosTable[v][y];
			out[v * 8 + u] = (sum * (u ? 1 : Math.SQRT1_2) * (v ? 1 : Math.SQRT1_2)) / 4;
		}
	}
	return out;
}

function buildComponents(image: Rgb, kind: Kind, sampling: [number, number][], quality: number): { comps: Comp[]; quant: number[][]; maxH: number; maxV: number } {
	const planes = planesFor(image, kind);
	const maxH = Math.max(...sampling.map(s => s[0]));
	const maxV = Math.max(...sampling.map(s => s[1]));
	const mcusX = Math.ceil(image.width / (8 * maxH));
	const mcusY = Math.ceil(image.height / (8 * maxV));
	const quant = [scaledTable(LUMA_Q, quality), scaledTable(CHROMA_Q, quality)];
	const comps = planes.map((plane, index): Comp => {
		const [h, v] = sampling[index];
		const fx = maxH / h, fy = maxV / v;
		const width = Math.ceil((image.width * h) / maxH), height = Math.ceil((image.height * v) / maxV);
		const blocksW = mcusX * h, blocksH = mcusY * v;
		const sample = (x: number, y: number): number => {
			// Box average over the fx x fy source samples, replicating the image edge.
			let sum = 0;
			for (let dy = 0; dy < fy; dy++) {
				for (let dx = 0; dx < fx; dx++) sum += plane[Math.min(image.height - 1, y * fy + dy) * image.width + Math.min(image.width - 1, x * fx + dx)];
			}
			return sum / (fx * fy);
		};
		const coefs = new Int32Array(blocksW * blocksH * 64);
		const luma = kind === 'grey' || index === 0 || (kind === 'cmyk' && index !== 1 && index !== 2) || index === 3;
		const tq = luma ? 0 : 1;
		for (let by = 0; by < blocksH; by++) {
			for (let bx = 0; bx < blocksW; bx++) {
				const block: number[] = [];
				for (let y = 0; y < 8; y++) {
					for (let x = 0; x < 8; x++) block.push(Math.round(sample(Math.min(width - 1, bx * 8 + x), Math.min(height - 1, by * 8 + y))) - 128);
				}
				const f = dct8(block);
				for (let i = 0; i < 64; i++) coefs[(by * blocksW + bx) * 64 + i] = Math.round(f[i] / quant[tq][i]);
			}
		}
		return { id: index + 1, h, v, tq, dc: tq, ac: tq, width, height, blocksW, blocksH, coefs };
	});
	return { comps, quant, maxH, maxV };
}

// ---------------------------------------------------------------- arithmetic entropy coder (jcarith.c)

class ArithEncoder {
	private c = 0;
	private a = 0x10000;
	private sc = 0;
	private zc = 0;
	private ct = 11;
	private buffer = -1;
	readonly dcStats: Uint8Array[] = [];
	readonly acStats: Uint8Array[] = [];
	readonly fixed = new Uint8Array(1);
	readonly lastDc: number[] = [];
	readonly dcContext: number[] = [];

	constructor(
		private readonly out: number[],
		private readonly dcL: number[],
		private readonly dcU: number[],
		private readonly acK: number[],
		components: number
	) {
		this.reset(components);
	}

	reset(components: number): void {
		this.c = 0;
		this.a = 0x10000;
		this.sc = 0;
		this.zc = 0;
		this.ct = 11;
		this.buffer = -1;
		this.dcStats.length = 0;
		this.acStats.length = 0;
		for (let i = 0; i < 16; i++) {
			this.dcStats.push(new Uint8Array(64));
			this.acStats.push(new Uint8Array(256));
		}
		this.fixed[0] = 113;
		for (let i = 0; i < components; i++) {
			this.lastDc[i] = 0;
			this.dcContext[i] = 0;
		}
	}

	private emit(byte: number): void {
		this.out.push(byte);
	}

	private flushZeros(): void {
		while (this.zc > 0) {
			this.emit(0);
			this.zc--;
		}
	}

	encode(stats: Uint8Array, index: number, val: number): void {
		const sv = stats[index];
		const [qe, nlBase, nm, sw] = STATES[sv & 0x7f];
		const nl = nlBase | (sw << 7);
		this.a -= qe;
		if (val !== sv >> 7) {
			if (this.a >= qe) {
				this.c += this.a;
				this.a = qe;
			}
			stats[index] = (sv & 0x80) ^ nl;
		} else {
			if (this.a >= 0x8000) return;
			if (this.a < qe) {
				this.c += this.a;
				this.a = qe;
			}
			stats[index] = (sv & 0x80) ^ nm;
		}
		do {
			this.a <<= 1;
			this.c <<= 1;
			if (--this.ct === 0) {
				const temp = this.c >> 19;
				if (temp > 0xff) {
					if (this.buffer >= 0) {
						this.flushZeros();
						this.emit(this.buffer + 1);
						if (this.buffer + 1 === 0xff) this.emit(0);
					}
					this.zc += this.sc;
					this.sc = 0;
					this.buffer = temp & 0xff;
				} else if (temp === 0xff) {
					this.sc++;
				} else {
					if (this.buffer === 0) this.zc++;
					else if (this.buffer >= 0) {
						this.flushZeros();
						this.emit(this.buffer);
					}
					if (this.sc) {
						this.flushZeros();
						do {
							this.emit(0xff);
							this.emit(0);
						} while (--this.sc);
					}
					this.buffer = temp & 0xff;
				}
				this.c &= 0x7ffff;
				this.ct += 8;
			}
		} while (this.a < 0x8000);
	}

	/** Section D.1.8: terminate the code stream (end of scan or before a restart marker). */
	finish(): void {
		const temp = (this.a - 1 + this.c) & 0xffff0000;
		this.c = temp < this.c ? temp + 0x8000 : temp;
		this.c <<= this.ct;
		if (this.c & 0xf8000000) {
			if (this.buffer >= 0) {
				this.flushZeros();
				this.emit(this.buffer + 1);
				if (this.buffer + 1 === 0xff) this.emit(0);
			}
			this.zc += this.sc;
			this.sc = 0;
		} else {
			if (this.buffer === 0) this.zc++;
			else if (this.buffer >= 0) {
				this.flushZeros();
				this.emit(this.buffer);
			}
			if (this.sc) {
				this.flushZeros();
				do {
					this.emit(0xff);
					this.emit(0);
				} while (--this.sc);
			}
		}
		if (this.c & 0x7fff800) {
			this.flushZeros();
			this.emit((this.c >> 19) & 0xff);
			if (((this.c >> 19) & 0xff) === 0xff) this.emit(0);
			if (this.c & 0x7f800) {
				this.emit((this.c >> 11) & 0xff);
				if (((this.c >> 11) & 0xff) === 0xff) this.emit(0);
			}
		}
	}

	/** Figure F.4 and following: DC difference of `m` (already point-transformed) for component `ci`. */
	dcFirst(ci: number, tbl: number, m: number): void {
		const stats = this.dcStats[tbl];
		let st = this.dcContext[ci];
		let v = m - this.lastDc[ci];
		if (v === 0) {
			this.encode(stats, st, 0);
			this.dcContext[ci] = 0;
			return;
		}
		this.lastDc[ci] = m;
		this.encode(stats, st, 1);
		if (v > 0) {
			this.encode(stats, st + 1, 0);
			st += 2;
			this.dcContext[ci] = 4;
		} else {
			v = -v;
			this.encode(stats, st + 1, 1);
			st += 3;
			this.dcContext[ci] = 8;
		}
		let mag = 0;
		if ((v -= 1)) {
			this.encode(stats, st, 1);
			mag = 1;
			let v2 = v;
			st = 20;
			while ((v2 >>= 1)) {
				this.encode(stats, st, 1);
				mag <<= 1;
				st += 1;
			}
		}
		this.encode(stats, st, 0);
		if (mag < (1 << this.dcL[tbl]) >> 1) this.dcContext[ci] = 0;
		else if (mag > (1 << this.dcU[tbl]) >> 1) this.dcContext[ci] += 8;
		st += 14;
		while ((mag >>= 1)) this.encode(stats, st, mag & v ? 1 : 0);
	}

	/** Spectral coefficients `ss..se` of one block, first pass, point transform `al`. */
	acFirst(block: Int32Array, off: number, tbl: number, ss: number, se: number, al: number): void {
		const stats = this.acStats[tbl];
		let ke = se;
		for (; ke > 0; ke--) {
			const v = block[off + NATURAL[ke]];
			if (Math.abs(v) >> al) break;
		}
		let k = ss;
		for (; k <= ke; k++) {
			let st = 3 * (k - 1);
			this.encode(stats, st, 0);
			let v: number;
			for (;;) {
				const raw = block[off + NATURAL[k]];
				v = Math.abs(raw) >> al;
				if (v) {
					this.encode(stats, st + 1, 1);
					this.encode(this.fixed, 0, raw < 0 ? 1 : 0);
					break;
				}
				this.encode(stats, st + 1, 0);
				st += 3;
				k++;
			}
			st += 2;
			let m = 0;
			if ((v -= 1)) {
				this.encode(stats, st, 1);
				m = 1;
				let v2 = v;
				if ((v2 >>= 1)) {
					this.encode(stats, st, 1);
					m <<= 1;
					st = k <= this.acK[tbl] ? 189 : 217;
					while ((v2 >>= 1)) {
						this.encode(stats, st, 1);
						m <<= 1;
						st += 1;
					}
				}
			}
			this.encode(stats, st, 0);
			st += 14;
			while ((m >>= 1)) this.encode(stats, st, m & v ? 1 : 0);
		}
		if (k <= se) this.encode(stats, 3 * (k - 1), 1);
	}

	acRefine(block: Int32Array, off: number, tbl: number, ss: number, se: number, ah: number, al: number): void {
		const stats = this.acStats[tbl];
		let ke = se;
		for (; ke > 0; ke--) if (Math.abs(block[off + NATURAL[ke]]) >> al) break;
		let kex = ke;
		for (; kex > 0; kex--) if (Math.abs(block[off + NATURAL[kex]]) >> ah) break;
		let k = ss;
		for (; k <= ke; k++) {
			let st = 3 * (k - 1);
			if (k > kex) this.encode(stats, st, 0);
			for (;;) {
				const raw = block[off + NATURAL[k]];
				const v = Math.abs(raw) >> al;
				if (v) {
					if (v >> 1) this.encode(stats, st + 2, v & 1);
					else {
						this.encode(stats, st + 1, 1);
						this.encode(this.fixed, 0, raw < 0 ? 1 : 0);
					}
					break;
				}
				this.encode(stats, st + 1, 0);
				st += 3;
				k++;
			}
		}
		if (k <= se) this.encode(stats, 3 * (k - 1), 1);
	}
}

// ---------------------------------------------------------------- scan layout

interface Scan {
	comps: number[];
	ss: number;
	se: number;
	ah: number;
	al: number;
}

/** libjpeg's jpeg_simple_progression for YCbCr or YCCK (`color`), or for a single component. */
function simpleProgression(n: number): Scan[] {
	if (n === 1) {
		return [
			{ comps: [0], ss: 0, se: 0, ah: 0, al: 1 },
			{ comps: [0], ss: 1, se: 5, ah: 0, al: 2 },
			{ comps: [0], ss: 6, se: 63, ah: 0, al: 2 },
			{ comps: [0], ss: 1, se: 63, ah: 2, al: 1 },
			{ comps: [0], ss: 0, se: 0, ah: 1, al: 0 },
			{ comps: [0], ss: 1, se: 63, ah: 1, al: 0 },
		];
	}
	const all = Array.from({ length: n }, (_, i) => i);
	const chroma = n >= 3 ? [1, 2] : [];
	const scans: Scan[] = [{ comps: all, ss: 0, se: 0, ah: 0, al: 1 }, { comps: [0], ss: 1, se: 5, ah: 0, al: 2 }];
	for (const c of chroma.slice().reverse()) scans.push({ comps: [c], ss: 1, se: 63, ah: 0, al: 1 });
	scans.push({ comps: [0], ss: 6, se: 63, ah: 0, al: 2 }, { comps: [0], ss: 1, se: 63, ah: 2, al: 1 }, { comps: all, ss: 0, se: 0, ah: 1, al: 0 });
	for (const c of chroma.slice().reverse()) scans.push({ comps: [c], ss: 1, se: 63, ah: 1, al: 0 });
	scans.push({ comps: [0], ss: 1, se: 63, ah: 1, al: 0 });
	for (let c = 3; c < n; c++) scans.push({ comps: [c], ss: 1, se: 63, ah: 0, al: 0 });
	return scans;
}

/** Spectral selection only, no successive approximation. */
function spectralProgression(n: number): Scan[] {
	const all = Array.from({ length: n }, (_, i) => i);
	const scans: Scan[] = [{ comps: all, ss: 0, se: 0, ah: 0, al: 0 }, { comps: [0], ss: 1, se: 5, ah: 0, al: 0 }, { comps: [0], ss: 6, se: 63, ah: 0, al: 0 }];
	for (let c = 1; c < n; c++) scans.push({ comps: [c], ss: 1, se: 63, ah: 0, al: 0 });
	return scans;
}

/** Block offsets (into `coefs`) of each MCU of a scan, in coding order. */
function scanMcus(scan: Scan, comps: Comp[], width: number, height: number, maxH: number, maxV: number): { comp: number; off: number }[][] {
	const mcus: { comp: number; off: number }[][] = [];
	if (scan.comps.length === 1) {
		const ci = scan.comps[0];
		const c = comps[ci];
		const cols = Math.ceil(c.width / 8), rows = Math.ceil(c.height / 8);
		for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) mcus.push([{ comp: ci, off: (y * c.blocksW + x) * 64 }]);
		return mcus;
	}
	const mcusX = Math.ceil(width / (8 * maxH)), mcusY = Math.ceil(height / (8 * maxV));
	for (let my = 0; my < mcusY; my++) {
		for (let mx = 0; mx < mcusX; mx++) {
			const blocks: { comp: number; off: number }[] = [];
			for (const ci of scan.comps) {
				const c = comps[ci];
				for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) blocks.push({ comp: ci, off: ((my * c.v + v) * c.blocksW + mx * c.h + h) * 64 });
			}
			mcus.push(blocks);
		}
	}
	return mcus;
}

// ---------------------------------------------------------------- file writer

export interface Variant {
	name: string;
	image: 'pattern' | 'noise';
	kind: Kind;
	sampling: [number, number][];
	mode: 'sequential' | 'progressive';
	/** Progressive script: libjpeg's simple progression or spectral selection only. */
	script?: 'simple' | 'spectral';
	restart: number;
	quality: number;
	/** Custom conditioning for DC tables 0 and 1 (L, U) and AC tables 0 and 1 (K). */
	dac?: { dc: [number, number][]; ac: number[] };
	/** Adobe APP14 transform byte; defaults to 0 for CMYK and 2 for YCCK. */
	adobe?: number;
	/** Write a JFIF header (only for greyscale and YCbCr). */
}

function u16(n: number): number[] {
	return [(n >> 8) & 0xff, n & 0xff];
}

function segment(marker: number, body: number[]): number[] {
	return [0xff, marker, ...u16(body.length + 2), ...body];
}

function header(variant: Variant, comps: Comp[], quant: number[][], width: number, height: number, arithmetic: boolean, progressive: boolean): number[] {
	const out: number[] = [0xff, 0xd8];
	if (variant.kind === 'cmyk' || variant.kind === 'ycck') {
		out.push(...segment(0xee, [...Buffer.from('Adobe'), 0, 100, 0, 0, 0, 0, variant.adobe ?? (variant.kind === 'ycck' ? 2 : 0)]));
	} else {
		out.push(...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]));
	}
	const used = new Set(comps.map(c => c.tq));
	for (const tq of [...used].sort()) out.push(...segment(0xdb, [tq, ...NATURAL.map(i => quant[tq][i])]));
	const sof = arithmetic ? (progressive ? 0xca : 0xc9) : 0xc0;
	out.push(...segment(sof, [8, ...u16(height), ...u16(width), comps.length, ...comps.flatMap(c => [c.id, (c.h << 4) | c.v, c.tq])]));
	if (arithmetic && variant.dac) {
		const body: number[] = [];
		variant.dac.dc.forEach(([l, u], i) => body.push(i, l | (u << 4)));
		variant.dac.ac.forEach((k, i) => body.push(0x10 + i, k));
		out.push(...segment(0xcc, body));
	}
	if (!arithmetic) {
		// Control Huffman tables: DC categories 0..11 and the 162 legal AC symbols all get fixed-length codes.
		const counts = (length: number, total: number): number[] => Array.from({ length: 16 }, (_, i) => (i === length - 1 ? total : 0));
		for (const id of [0, 1]) {
			out.push(...segment(0xc4, [id, ...counts(4, 12), ...Array.from({ length: 12 }, (_, i) => i)]));
			out.push(...segment(0xc4, [0x10 + id, ...counts(8, 162), ...acSymbols()]));
		}
	}
	if (variant.restart) out.push(...segment(0xdd, u16(variant.restart)));
	return out;
}

function acSymbols(): number[] {
	const symbols = [0x00, 0xf0];
	for (let r = 0; r < 16; r++) for (let s = 1; s <= 10; s++) symbols.push((r << 4) | s);
	return symbols;
}

function sosHeader(scan: Scan, comps: Comp[], progressive: boolean): number[] {
	return segment(0xda, [scan.comps.length, ...scan.comps.flatMap(ci => [comps[ci].id, (comps[ci].dc << 4) | comps[ci].ac]), progressive ? scan.ss : 0, progressive ? scan.se : 63, progressive ? (scan.ah << 4) | scan.al : 0]);
}

function encodeArithmetic(variant: Variant, comps: Comp[], quant: number[][], width: number, height: number, maxH: number, maxV: number): Uint8Array {
	const progressive = variant.mode === 'progressive';
	const scans: Scan[] = progressive
		? variant.script === 'spectral'
			? spectralProgression(comps.length)
			: simpleProgression(comps.length)
		: [{ comps: comps.map((_, i) => i), ss: 0, se: 63, ah: 0, al: 0 }];
	const dcL = new Array(16).fill(0), dcU = new Array(16).fill(1), acK = new Array(16).fill(5);
	variant.dac?.dc.forEach(([l, u], i) => {
		dcL[i] = l;
		dcU[i] = u;
	});
	variant.dac?.ac.forEach((k, i) => (acK[i] = k));
	const out = header(variant, comps, quant, width, height, true, progressive);
	for (const scan of scans) {
		out.push(...sosHeader(scan, comps, progressive));
		const enc = new ArithEncoder(out, dcL, dcU, acK, comps.length);
		const mcus = scanMcus(scan, comps, width, height, maxH, maxV);
		let restartIndex = 0;
		mcus.forEach((mcu, n) => {
			if (variant.restart && n > 0 && n % variant.restart === 0) {
				enc.finish();
				out.push(0xff, 0xd0 + (restartIndex++ & 7));
				enc.reset(comps.length);
			}
			for (const { comp, off } of mcu) {
				const c = comps[comp];
				if (!progressive) {
					enc.dcFirst(comp, c.dc, c.coefs[off]);
					enc.acFirst(c.coefs, off, c.ac, 1, 63, 0);
				} else if (scan.ss === 0) {
					if (scan.ah === 0) enc.dcFirst(comp, c.dc, c.coefs[off] >> scan.al);
					else enc.encode(enc.fixed, 0, (c.coefs[off] >> scan.al) & 1);
				} else if (scan.ah === 0) enc.acFirst(c.coefs, off, c.ac, scan.ss, scan.se, scan.al);
				else enc.acRefine(c.coefs, off, c.ac, scan.ss, scan.se, scan.ah, scan.al);
			}
		});
		enc.finish();
	}
	out.push(0xff, 0xd9);
	return Uint8Array.from(out);
}

/** The control file: sequential Huffman with fixed-length codes, same coefficients, same sampling, restart ignored. */
function encodeHuffmanControl(variant: Variant, comps: Comp[], quant: number[][], width: number, height: number, maxH: number, maxV: number): Uint8Array {
	const out = header({ ...variant, restart: 0 }, comps, quant, width, height, false, false);
	const scan: Scan = { comps: comps.map((_, i) => i), ss: 0, se: 63, ah: 0, al: 0 };
	out.push(...sosHeader(scan, comps, false));
	let acc = 0, bits = 0;
	const put = (value: number, length: number): void => {
		for (let i = length - 1; i >= 0; i--) {
			acc = (acc << 1) | ((value >> i) & 1);
			if (++bits === 8) {
				out.push(acc);
				if (acc === 0xff) out.push(0);
				acc = 0;
				bits = 0;
			}
		}
	};
	const category = (v: number): number => {
		let a = Math.abs(v), n = 0;
		while (a) {
			n++;
			a >>= 1;
		}
		return n;
	};
	const acIndex = new Map(acSymbols().map((s, i) => [s, i]));
	const extra = (v: number, n: number): void => put(v < 0 ? v + (1 << n) - 1 : v, n);
	const pred = comps.map(() => 0);
	for (const mcu of scanMcus(scan, comps, width, height, maxH, maxV)) {
		for (const { comp, off } of mcu) {
			const block = comps[comp].coefs;
			const diff = block[off] - pred[comp];
			pred[comp] = block[off];
			const n = category(diff);
			put(n, 4);
			if (n) extra(diff, n);
			let run = 0;
			for (let k = 1; k < 64; k++) {
				const v = block[off + NATURAL[k]];
				if (!v) {
					run++;
					continue;
				}
				while (run > 15) {
					put(acIndex.get(0xf0)!, 8);
					run -= 16;
				}
				const s = category(v);
				put(acIndex.get((run << 4) | s)!, 8);
				extra(v, s);
				run = 0;
			}
			if (run) put(0, 8);
		}
	}
	if (bits) put((1 << (8 - bits)) - 1, 8 - bits);
	out.push(0xff, 0xd9);
	return Uint8Array.from(out);
}

export function encodeVariant(variant: Variant): { arithmetic: Uint8Array; control: Uint8Array } {
	const image = variant.image === 'noise' ? noiseImage() : patternImage();
	const { comps, quant, maxH, maxV } = buildComponents(image, variant.kind, variant.sampling, variant.quality);
	return {
		arithmetic: encodeArithmetic(variant, comps, quant, image.width, image.height, maxH, maxV),
		control: encodeHuffmanControl(variant, comps, quant, image.width, image.height, maxH, maxV),
	};
}

const S444: [number, number][] = [[1, 1], [1, 1], [1, 1]];
const S420: [number, number][] = [[2, 2], [1, 1], [1, 1]];
const S422: [number, number][] = [[2, 1], [1, 1], [1, 1]];
const S440: [number, number][] = [[1, 2], [1, 1], [1, 1]];
const GREY: [number, number][] = [[1, 1]];
const CMYK: [number, number][] = [[1, 1], [1, 1], [1, 1], [1, 1]];
const YCCK420: [number, number][] = [[2, 2], [1, 1], [1, 1], [2, 2]];

const base = { image: 'pattern', mode: 'sequential', restart: 0, quality: 85 } as const;
const DAC = { dc: [[2, 5], [1, 3]] as [number, number][], ac: [2, 12] };
export const VARIANTS: Variant[] = [
	{ ...base, name: 'seq-444', kind: 'rgb', sampling: S444 },
	{ ...base, name: 'seq-420', kind: 'rgb', sampling: S420 },
	{ ...base, name: 'seq-422', kind: 'rgb', sampling: S422 },
	{ ...base, name: 'seq-440', kind: 'rgb', sampling: S440 },
	{ ...base, name: 'seq-grey', kind: 'grey', sampling: GREY },
	{ ...base, name: 'seq-cmyk', kind: 'cmyk', sampling: CMYK },
	{ ...base, name: 'seq-ycck-420', kind: 'ycck', sampling: YCCK420 },
	{ ...base, name: 'seq-444-dri1', kind: 'rgb', sampling: S444, restart: 1 },
	{ ...base, name: 'seq-420-dri2', kind: 'rgb', sampling: S420, restart: 2 },
	{ ...base, name: 'seq-grey-dri3', kind: 'grey', sampling: GREY, restart: 3 },
	{ ...base, name: 'seq-cmyk-dri2', kind: 'cmyk', sampling: CMYK, restart: 2 },
	{ ...base, name: 'seq-444-dac', kind: 'rgb', sampling: S444, dac: DAC },
	{ ...base, name: 'seq-444-dac-extreme', kind: 'rgb', sampling: S444, dac: { dc: [[0, 0], [15, 15]], ac: [1, 63] } },
	{ ...base, name: 'seq-noise-444', kind: 'rgb', sampling: S444, image: 'noise', quality: 100 },
	{ ...base, name: 'seq-noise-420-dri5', kind: 'rgb', sampling: S420, image: 'noise', quality: 95, restart: 5 },
	{ ...base, name: 'seq-noise-dac', kind: 'rgb', sampling: S444, image: 'noise', quality: 100, dac: DAC },
	{ ...base, name: 'prog-444', kind: 'rgb', sampling: S444, mode: 'progressive', script: 'simple' },
	{ ...base, name: 'prog-420', kind: 'rgb', sampling: S420, mode: 'progressive', script: 'simple' },
	{ ...base, name: 'prog-grey', kind: 'grey', sampling: GREY, mode: 'progressive', script: 'simple' },
	{ ...base, name: 'prog-cmyk', kind: 'cmyk', sampling: CMYK, mode: 'progressive', script: 'simple' },
	{ ...base, name: 'prog-ycck-420', kind: 'ycck', sampling: YCCK420, mode: 'progressive', script: 'simple' },
	{ ...base, name: 'prog-420-spectral', kind: 'rgb', sampling: S420, mode: 'progressive', script: 'spectral' },
	{ ...base, name: 'prog-420-dri2', kind: 'rgb', sampling: S420, mode: 'progressive', script: 'simple', restart: 2 },
	{ ...base, name: 'prog-444-dri1', kind: 'rgb', sampling: S444, mode: 'progressive', script: 'simple', restart: 1 },
	{ ...base, name: 'prog-444-dac', kind: 'rgb', sampling: S444, mode: 'progressive', script: 'simple', dac: DAC },
	{ ...base, name: 'prog-noise-444', kind: 'rgb', sampling: S444, mode: 'progressive', script: 'simple', image: 'noise', quality: 100 },
	{ ...base, name: 'prog-noise-420-dri5', kind: 'rgb', sampling: S420, mode: 'progressive', script: 'simple', image: 'noise', quality: 95, restart: 5 },
	{ ...base, name: 'prog-noise-dac', kind: 'rgb', sampling: S444, mode: 'progressive', script: 'simple', image: 'noise', quality: 100, dac: DAC },
];

if (import.meta.main) {
	const args = process.argv.slice(2);
	const directory = args[0];
	const controlAt = args.indexOf('--control');
	const control = controlAt >= 0 ? args[controlAt + 1] : undefined;
	if (!directory) throw new Error('usage: bun arith-jpeg-encoder.ts <dir> [--control <dir>]');
	mkdirSync(directory, { recursive: true });
	if (control) mkdirSync(control, { recursive: true });
	for (const variant of VARIANTS) {
		const { arithmetic, control: huffman } = encodeVariant(variant);
		writeFileSync(join(directory, `codec-jpeg-arith-${variant.name}.bin`), arithmetic);
		if (control) writeFileSync(join(control, `codec-jpeg-arith-${variant.name}.ctl`), huffman);
		// Four-component files are converted to RGB by colour management that the entropy decoder does not control, so
		// the tests compare them with this Huffman-coded copy of the same coefficients instead of a native image.
		if (variant.kind === 'cmyk' || variant.kind === 'ycck') writeFileSync(join(directory, `codec-jpeg-arith-${variant.name}-huffman.bin`), huffman);
	}
	console.log(`${VARIANTS.length} variants written`);
}
