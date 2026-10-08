/**
 * A JPEG decoder that reproduces libjpeg(-turbo)'s default 8-bit output bit
 * for bit: accurate integer IDCT (`jidctint`), "fancy" triangle chroma
 * upsampling and fixed-point YCbCr -> RGB. Windows decodes JPEG the same way,
 * and the native references match it exactly. Supports baseline, extended
 * sequential and progressive JPEG, Huffman or arithmetic coded, with one,
 * three or four (CMYK, YCCK; see `jpeg-cmyk.ts`) components.
 * `decodeJpegTurbo` returns `null` for anything else (12-bit, lossless,
 * hierarchical) so the caller can fall back.
 *
 * Origin: this follows the algorithms of the Independent JPEG Group's libjpeg (jidctint.c, jdhuff.c,
 * jdsample.c, jdcolor.c; see THIRD_PARTY_NOTICES), so that its output matches Windows exactly.
 */
import { cmykPlanesToRgba } from './jpeg-cmyk';
import { ArithDecoder, defaultArithConditioning, type ArithConditioning } from './jpeg-arith';

export interface TurboJpeg {
	width: number;
	height: number;
	/** RGBA, alpha 255. */
	data: Uint8Array;
}

interface Component {
	/** DC conditioning category, arithmetic coding only. */
	ctx: number;
	id: number;
	h: number;
	v: number;
	tq: number;
	blocksW: number;
	blocksH: number;
	coefs: Int16Array;
	pred: number;
	dc: number;
	ac: number;
}

interface Huffman {
	maxcode: Int32Array;
	valptr: Int32Array;
	mincode: Int32Array;
	values: Uint8Array;
}

const ZIGZAG = [
	0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43,
	36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

function buildHuffman(counts: Uint8Array, values: Uint8Array): Huffman {
	const maxcode = new Int32Array(18).fill(-1);
	const valptr = new Int32Array(17);
	const mincode = new Int32Array(17);
	let code = 0;
	let k = 0;
	for (let l = 1; l <= 16; l++) {
		valptr[l] = k;
		mincode[l] = code;
		code += counts[l - 1];
		k += counts[l - 1];
		maxcode[l] = counts[l - 1] ? code - 1 : -1;
		code <<= 1;
	}
	return { maxcode, valptr, mincode, values };
}

class BitReader {
	pos: number;
	private bits = 0;
	private count = 0;
	private marker = false;
	constructor(private readonly data: Uint8Array, start: number) {
		this.pos = start;
	}
	reset(): void {
		this.bits = 0;
		this.count = 0;
		this.marker = false;
	}
	bit(): number {
		if (this.count === 0) {
			let b = 0;
			if (!this.marker && this.pos < this.data.length) {
				b = this.data[this.pos++];
				if (b === 0xff) {
					let n = this.data[this.pos];
					while (n === 0xff) {
						this.pos++;
						n = this.data[this.pos];
					}
					if (n === 0) {
						this.pos++;
					} else {
						this.marker = true;
						this.pos--;
						b = 0;
					}
				}
			}
			this.bits = b;
			this.count = 8;
		}
		this.count--;
		return (this.bits >> this.count) & 1;
	}
	receive(n: number): number {
		let v = 0;
		while (n--) v = (v << 1) | this.bit();
		return v;
	}
	receiveExtend(n: number): number {
		if (n === 0) return 0;
		const v = this.receive(n);
		return v < 1 << (n - 1) ? v - (1 << n) + 1 : v;
	}
	decode(h: Huffman): number {
		let code = 0;
		for (let l = 1; l <= 16; l++) {
			code = (code << 1) | this.bit();
			if (h.maxcode[l] >= 0 && code <= h.maxcode[l] && code >= h.mincode[l]) return h.values[h.valptr[l] + code - h.mincode[l]];
		}
		throw new Error('Bad Huffman code');
	}
}

// libjpeg jidctint (accurate integer IDCT, 8-bit samples)
const CONST_BITS = 13;
const PASS1_BITS = 2;
const FIX_0_298631336 = 2446;
const FIX_0_390180644 = 3196;
const FIX_0_541196100 = 4433;
const FIX_0_765366865 = 6270;
const FIX_0_899976223 = 7373;
const FIX_1_175875602 = 9633;
const FIX_1_501321110 = 12299;
const FIX_1_847759065 = 15137;
const FIX_1_961570560 = 16069;
const FIX_2_053119869 = 16819;
const FIX_2_562915447 = 20995;
const FIX_3_072711026 = 25172;

function descale(x: number, n: number): number {
	return (x + (1 << (n - 1))) >> n;
}

/**
 * One 1-D pass over eight values, returning even/odd sums as in jidctint.
 * `v` holds the input vector; results go to `r` (eight entries, unscaled).
 */
function idct1d(v: number[], r: number[]): void {
	let z2 = v[2];
	let z3 = v[6];
	let z1 = (z2 + z3) * FIX_0_541196100;
	let tmp2 = z1 + z3 * -FIX_1_847759065;
	let tmp3 = z1 + z2 * FIX_0_765366865;
	let tmp0 = (v[0] + v[4]) << CONST_BITS;
	let tmp1 = (v[0] - v[4]) << CONST_BITS;
	const tmp10 = tmp0 + tmp3;
	const tmp13 = tmp0 - tmp3;
	const tmp11 = tmp1 + tmp2;
	const tmp12 = tmp1 - tmp2;
	tmp0 = v[7];
	tmp1 = v[5];
	tmp2 = v[3];
	tmp3 = v[1];
	z1 = tmp0 + tmp3;
	z2 = tmp1 + tmp2;
	z3 = tmp0 + tmp2;
	let z4 = tmp1 + tmp3;
	const z5 = (z3 + z4) * FIX_1_175875602;
	tmp0 *= FIX_0_298631336;
	tmp1 *= FIX_2_053119869;
	tmp2 *= FIX_3_072711026;
	tmp3 *= FIX_1_501321110;
	z1 *= -FIX_0_899976223;
	z2 *= -FIX_2_562915447;
	z3 *= -FIX_1_961570560;
	z4 *= -FIX_0_390180644;
	z3 += z5;
	z4 += z5;
	tmp0 += z1 + z3;
	tmp1 += z2 + z4;
	tmp2 += z2 + z3;
	tmp3 += z1 + z4;
	r[0] = tmp10 + tmp3;
	r[7] = tmp10 - tmp3;
	r[1] = tmp11 + tmp2;
	r[6] = tmp11 - tmp2;
	r[2] = tmp12 + tmp1;
	r[5] = tmp12 - tmp1;
	r[3] = tmp13 + tmp0;
	r[4] = tmp13 - tmp0;
}

const vec = new Array<number>(8).fill(0);
const res = new Array<number>(8).fill(0);

function idctBlock(coef: Int16Array, offset: number, quant: Int32Array, out: Uint8Array, outOffset: number, stride: number, ws: Int32Array): void {
	for (let col = 0; col < 8; col++) {
		let ac = 0;
		for (let r = 0; r < 8; r++) {
			vec[r] = coef[offset + r * 8 + col] * quant[r * 8 + col];
			if (r) ac |= vec[r];
		}
		if (!ac) {
			const dc = vec[0] << PASS1_BITS;
			for (let r = 0; r < 8; r++) ws[r * 8 + col] = dc;
			continue;
		}
		idct1d(vec, res);
		for (let r = 0; r < 8; r++) ws[r * 8 + col] = descale(res[r], CONST_BITS - PASS1_BITS);
	}
	for (let row = 0; row < 8; row++) {
		let ac = 0;
		for (let c = 0; c < 8; c++) {
			vec[c] = ws[row * 8 + c];
			if (c) ac |= vec[c];
		}
		const o = outOffset + row * stride;
		if (!ac) {
			const x = descale(vec[0], PASS1_BITS + 3) + 128;
			const dc = x < 0 ? 0 : x > 255 ? 255 : x;
			for (let c = 0; c < 8; c++) out[o + c] = dc;
			continue;
		}
		idct1d(vec, res);
		for (let c = 0; c < 8; c++) {
			const x = descale(res[c], CONST_BITS + PASS1_BITS + 3) + 128;
			out[o + c] = x < 0 ? 0 : x > 255 ? 255 : x;
		}
	}
}

/** Upsample one component plane (`cw` x `ch` real samples) to the full image size. */
function upsample(plane: Uint8Array, stride: number, cw: number, ch: number, hr: number, vr: number, width: number, height: number): Uint8Array {
	const out = new Uint8Array(width * height);
	const at = (x: number, y: number): number => plane[Math.min(ch - 1, Math.max(0, y)) * stride + x];
	if (hr === 1 && vr === 1) {
		for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out[y * width + x] = plane[y * stride + x];
		return out;
	}
	if (hr === 2 && vr === 1) {
		for (let y = 0; y < height; y++) {
			for (let i = 0; i < cw; i++) {
				const v = at(i, y);
				const a = i === 0 ? v : (3 * v + at(i - 1, y) + 1) >> 2;
				const b = i === cw - 1 ? v : (3 * v + at(i + 1, y) + 2) >> 2;
				if (2 * i < width) out[y * width + 2 * i] = a;
				if (2 * i + 1 < width) out[y * width + 2 * i + 1] = b;
			}
		}
		return out;
	}
	if (hr === 2 && vr === 2) {
		for (let y = 0; y < height; y++) {
			const iy = y >> 1;
			const ny = (y & 1) === 0 ? iy - 1 : iy + 1;
			const sum = (i: number): number => 3 * at(i, iy) + at(i, ny);
			for (let i = 0; i < cw; i++) {
				const t = sum(i);
				const a = i === 0 ? (t * 4 + 8) >> 4 : (3 * t + sum(i - 1) + 8) >> 4;
				const b = i === cw - 1 ? (t * 4 + 7) >> 4 : (3 * t + sum(i + 1) + 7) >> 4;
				if (2 * i < width) out[y * width + 2 * i] = a;
				if (2 * i + 1 < width) out[y * width + 2 * i + 1] = b;
			}
		}
		return out;
	}
	if (hr === 1 && vr === 2) {
		for (let y = 0; y < height; y++) {
			const iy = y >> 1;
			const upper = (y & 1) === 0;
			const ny = upper ? iy - 1 : iy + 1;
			const bias = upper ? 1 : 2;
			for (let x = 0; x < width; x++) out[y * width + x] = (3 * at(x, iy) + at(x, ny) + bias) >> 2;
		}
		return out;
	}
	// Other ratios replicate samples, as libjpeg's integral box upsampler does.
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) out[y * width + x] = plane[Math.min(ch - 1, Math.floor(y / vr)) * stride + Math.min(cw - 1, Math.floor(x / hr))];
	}
	return out;
}

/** Decode `bytes`, or return `null` when this decoder does not support the file. */
export function decodeJpegTurbo(bytes: Uint8Array, colorTransform?: boolean): TurboJpeg | null {
	try {
		return decodeInner(bytes, colorTransform);
	} catch {
		return null;
	}
}

/** Unconverted full-resolution component planes of a decoded JPEG. */
export interface JpegPlanes {
	width: number;
	height: number;
	planes: Uint8Array[];
	ids: number[];
	/** Adobe APP14 colour transform byte, when present. */
	adobe: number | undefined;
}

function decodeInner(data: Uint8Array, colorTransform?: boolean): TurboJpeg | null {
	const p = decodeJpegPlanes(data);
	return p ? convertPlanes(p, colorTransform) : null;
}

/** Decode entropy-coded data to unconverted component planes. */
export function decodeJpegPlanes(data: Uint8Array): JpegPlanes | null {
	if (data[0] !== 0xff || data[1] !== 0xd8) return null;
	const quant: Int32Array[] = [];
	const dcTables: Huffman[] = [];
	const acTables: Huffman[] = [];
	let comps: Component[] = [];
	let width = 0;
	let height = 0;
	let progressive = false;
	let arithmetic = false;
	const conditioning = defaultArithConditioning();
	let restart = 0;
	let adobe: number | undefined;
	let maxH = 1;
	let maxV = 1;
	let sawScan = false;
	let pos = 2;
	const ws = new Int32Array(64);
	while (pos < data.length) {
		if (data[pos] !== 0xff) {
			pos++;
			continue;
		}
		const marker = data[pos + 1];
		if (marker === 0xff) {
			pos++;
			continue;
		}
		pos += 2;
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0) continue;
		if (marker === 0xd9) break;
		const len = data[pos] * 256 + data[pos + 1];
		const seg = pos + 2;
		const end = pos + len;
		if (marker === 0xdb) {
			let p = seg;
			while (p < end) {
				const pq = data[p] >> 4;
				const tq = data[p] & 15;
				p++;
				const table = new Int32Array(64);
				for (let i = 0; i < 64; i++) {
					table[ZIGZAG[i]] = pq ? data[p] * 256 + data[p + 1] : data[p];
					p += pq ? 2 : 1;
				}
				quant[tq] = table;
			}
		} else if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc9 || marker === 0xca) {
			if (data[seg] !== 8) return null;
			progressive = marker === 0xc2 || marker === 0xca;
			arithmetic = marker >= 0xc9;
			height = data[seg + 1] * 256 + data[seg + 2];
			width = data[seg + 3] * 256 + data[seg + 4];
			const n = data[seg + 5];
			if ((n !== 1 && n !== 3 && n !== 4) || !width || !height) return null;
			comps = [];
			for (let i = 0; i < n; i++) {
				const h = data[seg + 7 + i * 3] >> 4;
				const v = data[seg + 7 + i * 3] & 15;
				if (!h || !v) return null;
				comps.push({ id: data[seg + 6 + i * 3], h, v, tq: data[seg + 8 + i * 3], blocksW: 0, blocksH: 0, coefs: new Int16Array(0), pred: 0, ctx: 0, dc: 0, ac: 0 });
			}
			maxH = Math.max(...comps.map(c => c.h));
			maxV = Math.max(...comps.map(c => c.v));
			const mcusX = Math.ceil(width / (8 * maxH));
			const mcusY = Math.ceil(height / (8 * maxV));
			for (const c of comps) {
				c.blocksW = mcusX * c.h;
				c.blocksH = mcusY * c.v;
				c.coefs = new Int16Array(c.blocksW * c.blocksH * 64);
			}
		} else if (marker === 0xc3 || (marker >= 0xc5 && marker <= 0xcf && marker !== 0xc8 && marker !== 0xcc && marker !== 0xc9 && marker !== 0xca)) {
			return null;
		} else if (marker === 0xcc) {
			for (let p = seg; p + 1 < end; p += 2) {
				const index = data[p] & 15;
				if (data[p] >> 4 === 0) {
					conditioning.dcL[index] = data[p + 1] & 15;
					conditioning.dcU[index] = data[p + 1] >> 4;
				} else {
					conditioning.acK[index] = data[p + 1];
				}
			}
		} else if (marker === 0xc4) {
			let p = seg;
			while (p < end) {
				const tc = data[p] >> 4;
				const th = data[p] & 15;
				p++;
				const counts = data.subarray(p, p + 16);
				p += 16;
				let total = 0;
				for (let i = 0; i < 16; i++) total += counts[i];
				const table = buildHuffman(counts, data.subarray(p, p + total));
				p += total;
				(tc ? acTables : dcTables)[th] = table;
			}
		} else if (marker === 0xdd) {
			restart = data[seg] * 256 + data[seg + 1];
		} else if (marker === 0xee) {
			if (len >= 14 && String.fromCharCode(...data.subarray(seg, seg + 5)) === 'Adobe') adobe = data[seg + 11];
		} else if (marker === 0xda) {
			if (!comps.length) return null;
			const ns = data[seg];
			const scanComps: Component[] = [];
			for (let i = 0; i < ns; i++) {
				const c = comps.find(x => x.id === data[seg + 1 + i * 2]);
				if (!c) return null;
				c.dc = data[seg + 2 + i * 2] >> 4;
				c.ac = data[seg + 2 + i * 2] & 15;
				scanComps.push(c);
			}
			const ss = data[seg + 1 + ns * 2];
			const se = data[seg + 2 + ns * 2];
			const ah = data[seg + 3 + ns * 2] >> 4;
			const al = data[seg + 3 + ns * 2] & 15;
			pos = decodeScan(data, end, scanComps, comps, width, height, maxH, maxV, progressive, restart, ss, se, ah, al, dcTables, acTables, arithmetic ? conditioning : null);
			sawScan = true;
			continue;
		}
		pos = end;
	}
	if (!sawScan || !comps.length) return null;
	const full = comps.map(c => {
		if (maxH % c.h || maxV % c.v) throw new Error('Unsupported sampling');
		const stride = c.blocksW * 8;
		const plane = new Uint8Array(stride * c.blocksH * 8);
		const q = quant[c.tq];
		if (!q) throw new Error('Missing quantisation table');
		for (let by = 0; by < c.blocksH; by++) {
			for (let bx = 0; bx < c.blocksW; bx++) idctBlock(c.coefs, (by * c.blocksW + bx) * 64, q, plane, by * 8 * stride + bx * 8, stride, ws);
		}
		const cw = Math.ceil((width * c.h) / maxH);
		const ch = Math.ceil((height * c.v) / maxV);
		return upsample(plane, stride, cw, ch, maxH / c.h, maxV / c.v, width, height);
	});
	return { width, height, planes: full, ids: comps.map(c => c.id), adobe };
}

function convertPlanes({ width, height, planes: full, ids, adobe }: JpegPlanes, colorTransform?: boolean): TurboJpeg | null {
	if (full.length === 4) {
		// libjpeg treats an Adobe transform of 0, or no marker, as CMYK and anything else as YCCK.
		return { width, height, data: cmykPlanesToRgba(full, width, height, adobe !== undefined && adobe !== 0) };
	}
	const out = new Uint8Array(width * height * 4);
	const transform = colorTransform ?? (adobe !== undefined ? adobe !== 0 : !ids.every((id, i) => id === [82, 71, 66][i]));
	if (full.length === 1) {
		for (let i = 0; i < width * height; i++) {
			out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = full[0][i];
			out[i * 4 + 3] = 255;
		}
	} else if (!transform) {
		for (let i = 0; i < width * height; i++) {
			out[i * 4] = full[0][i];
			out[i * 4 + 1] = full[1][i];
			out[i * 4 + 2] = full[2][i];
			out[i * 4 + 3] = 255;
		}
	} else {
		const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);
		const fix = (x: number): number => Math.floor(x * 65536 + 0.5);
		const half = 1 << 15;
		const crR = fix(1.402);
		const cbB = fix(1.772);
		const crG = -fix(0.71414);
		const cbG = -fix(0.34414);
		for (let i = 0; i < width * height; i++) {
			const y = full[0][i];
			const cb = full[1][i] - 128;
			const cr = full[2][i] - 128;
			out[i * 4] = clamp(y + ((crR * cr + half) >> 16));
			out[i * 4 + 1] = clamp(y + ((cbG * cb + half + crG * cr) >> 16));
			out[i * 4 + 2] = clamp(y + ((cbB * cb + half) >> 16));
			out[i * 4 + 3] = 255;
		}
	}
	return { width, height, data: out };
}

function decodeScan(
	data: Uint8Array,
	start: number,
	scan: Component[],
	all: Component[],
	width: number,
	height: number,
	maxH: number,
	maxV: number,
	progressive: boolean,
	restart: number,
	ss: number,
	se: number,
	ah: number,
	al: number,
	dcTables: Huffman[],
	acTables: Huffman[],
	arith: ArithConditioning | null
): number {
	const br = new BitReader(data, start);
	const ar = arith ? new ArithDecoder(data, start, arith, scan) : null;
	const reader = ar ?? br;
	let eobrun = 0;
	const single = scan.length === 1;
	const decodeBlock = (c: Component, off: number): void => {
		if (ar) {
			ar.block(c, off, progressive, ss, se, ah, al);
			return;
		}
		const coefs = c.coefs;
		if (!progressive) {
			const t = br.decode(dcTables[c.dc]);
			c.pred += t === 0 ? 0 : br.receiveExtend(t);
			coefs[off] = c.pred;
			let k = 1;
			while (k < 64) {
				const rs = br.decode(acTables[c.ac]);
				const s = rs & 15;
				const r = rs >> 4;
				if (s === 0) {
					if (r < 15) break;
					k += 16;
					continue;
				}
				k += r;
				if (k > 63) break;
				coefs[off + ZIGZAG[k]] = br.receiveExtend(s);
				k++;
			}
			return;
		}
		if (ss === 0) {
			if (ah === 0) {
				const t = br.decode(dcTables[c.dc]);
				c.pred += t === 0 ? 0 : br.receiveExtend(t);
				coefs[off] = c.pred * (1 << al);
			} else if (br.bit()) {
				coefs[off] |= 1 << al;
			}
			return;
		}
		if (ah === 0) {
			if (eobrun > 0) {
				eobrun--;
				return;
			}
			let k = ss;
			while (k <= se) {
				const rs = br.decode(acTables[c.ac]);
				const s = rs & 15;
				const r = rs >> 4;
				if (s === 0) {
					if (r < 15) {
						eobrun = br.receive(r) + (1 << r) - 1;
						break;
					}
					k += 16;
					continue;
				}
				k += r;
				if (k > 63) break;
				coefs[off + ZIGZAG[k]] = br.receiveExtend(s) * (1 << al);
				k++;
			}
			return;
		}
		// AC refinement
		const p1 = 1 << al;
		const m1 = -1 << al;
		let k = ss;
		if (eobrun <= 0) {
			for (; k <= se; k++) {
				const rs = br.decode(acTables[c.ac]);
				const s = rs & 15;
				let r = rs >> 4;
				let value = 0;
				if (s === 0) {
					if (r < 15) {
						eobrun = (1 << r) + br.receive(r);
						break;
					}
				} else {
					value = br.bit() ? p1 : m1;
				}
				for (; k <= se; k++) {
					const idx = off + ZIGZAG[k];
					if (coefs[idx] !== 0) {
						if (br.bit() && (coefs[idx] & p1) === 0) coefs[idx] += coefs[idx] >= 0 ? p1 : m1;
					} else {
						if (r === 0) {
							if (value) coefs[idx] = value;
							break;
						}
						r--;
					}
				}
			}
		}
		if (eobrun > 0) {
			for (; k <= se; k++) {
				const idx = off + ZIGZAG[k];
				if (coefs[idx] !== 0 && br.bit() && (coefs[idx] & p1) === 0) coefs[idx] += coefs[idx] >= 0 ? p1 : m1;
			}
			eobrun--;
		}
	};
	let total: number;
	let mcusX: number;
	if (single) {
		const c = scan[0];
		mcusX = Math.ceil(Math.ceil((width * c.h) / maxH) / 8);
		total = mcusX * Math.ceil(Math.ceil((height * c.v) / maxV) / 8);
	} else {
		mcusX = Math.ceil(width / (8 * maxH));
		total = mcusX * Math.ceil(height / (8 * maxV));
	}
	const nextMarker = (from: number): number => {
		let p = from;
		while (p + 1 < data.length && !(data[p] === 0xff && data[p + 1] !== 0 && data[p + 1] !== 0xff)) p++;
		return p;
	};
	let n = 0;
	while (n < total) {
		for (const c of all) c.pred = 0;
		eobrun = 0;
		reader.reset();
		const limit = restart ? Math.min(total, n + restart) : total;
		for (; n < limit; n++) {
			if (single) {
				const c = scan[0];
				decodeBlock(c, (Math.floor(n / mcusX) * c.blocksW + (n % mcusX)) * 64);
			} else {
				const mx = n % mcusX;
				const my = Math.floor(n / mcusX);
				for (const c of scan) {
					for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) decodeBlock(c, ((my * c.v + v) * c.blocksW + mx * c.h + h) * 64);
				}
			}
		}
		const p = nextMarker(reader.pos);
		if (n >= total) return p;
		if (data[p + 1] >= 0xd0 && data[p + 1] <= 0xd7) reader.pos = p + 2;
		else return p;
	}
	return nextMarker(reader.pos);
}
