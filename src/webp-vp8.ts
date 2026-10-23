/**
 * WebP lossy (VP8 key frame) decoder, with libwebp's default output stage:
 * in-loop filter, then "fancy" bilinear chroma upsampling and its fixed-point
 * YUV to RGB conversion. The arithmetic follows libwebp (BSD-3-Clause, see
 * THIRD_PARTY_NOTICES) so results match its default decode bit for bit.
 * Every failure throws (callers turn that into `null`).
 */
import { AC_TABLE, COEFF_UPDATE_PROBS, DC_TABLE, DEFAULT_COEFF_PROBS, KF_BMODE_PROBS } from './webp-tables';

/** Decoded planes, cropped to the picture size (chroma is `ceil(size / 2)`). */
export interface Vp8Frame {
	width: number;
	height: number;
	y: Uint8Array;
	u: Uint8Array;
	v: Uint8Array;
	yStride: number;
	uvStride: number;
}

// Intra modes in libwebp's numbering (16x16 and chroma modes reuse the first four).
const B_DC = 0, B_TM = 1, B_VE = 2, B_HE = 3, B_RD = 4, B_VR = 5, B_LD = 6, B_VL = 7, B_HD = 8, B_HU = 9;

const BANDS = [0, 1, 2, 3, 6, 4, 5, 6, 6, 6, 6, 6, 6, 6, 6, 7, 0];
const ZIGZAG = [0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15];
const CAT3456 = [
	[173, 148, 140],
	[176, 155, 140, 135],
	[180, 157, 141, 134, 130],
	[254, 254, 243, 230, 196, 177, 153, 140, 133, 130, 129],
];

/** Work buffer layout of one macroblock plus its prediction border (libwebp's `yuv_b`). */
const BPS = 32;
const Y_OFF = BPS + 8;
const U_OFF = Y_OFF + BPS * 16 + BPS;
const V_OFF = U_OFF + 16;
const WORK_SIZE = BPS * 26;

/** Boolean entropy decoder of RFC 6386 section 7. */
class BoolDecoder {
	private value: number;
	private range = 255;
	private bitCount = 0;
	pos: number;
	constructor(private readonly buf: Uint8Array, start: number, readonly end: number) {
		this.pos = start;
		this.value = (this.next() << 8) | this.next();
	}
	private next(): number {
		return this.pos < this.end ? this.buf[this.pos++] : (this.pos++, 0);
	}
	/** True once more than a couple of bytes past the end were consumed. */
	get overrun(): boolean {
		return this.pos > this.end + 2;
	}
	bit(prob: number): number {
		const split = 1 + (((this.range - 1) * prob) >> 8);
		const big = split << 8;
		let r: number;
		if (this.value >= big) {
			r = 1;
			this.range -= split;
			this.value -= big;
		} else {
			r = 0;
			this.range = split;
		}
		while (this.range < 128) {
			this.value <<= 1;
			this.range <<= 1;
			if (++this.bitCount === 8) {
				this.bitCount = 0;
				this.value |= this.next();
			}
		}
		return r;
	}
	flag(): number {
		return this.bit(128);
	}
	literal(n: number): number {
		let v = 0;
		while (n-- > 0) v = (v << 1) | this.bit(128);
		return v;
	}
	signed(n: number): number {
		const v = this.literal(n);
		return this.flag() ? -v : v;
	}
}

const clip8 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);
const avg2 = (a: number, b: number): number => (a + b + 1) >> 1;
const avg3 = (a: number, b: number, c: number): number => (a + 2 * b + c + 2) >> 2;

const mul1 = (a: number): number => ((a * 20091) >> 16) + a;
const mul2 = (a: number): number => (a * 35468) >> 16;

/** Inverse 4x4 DCT of `c[o..o+15]`, added to the prediction in `buf` at `d`. */
function transformAdd(c: Int16Array, o: number, buf: Uint8Array, d: number): void {
	const t = new Int32Array(16);
	for (let i = 0; i < 4; i++) {
		const a = c[o + i] + c[o + 8 + i];
		const b = c[o + i] - c[o + 8 + i];
		const cc = mul2(c[o + 4 + i]) - mul1(c[o + 12 + i]);
		const dd = mul1(c[o + 4 + i]) + mul2(c[o + 12 + i]);
		t[i * 4] = a + dd;
		t[i * 4 + 1] = b + cc;
		t[i * 4 + 2] = b - cc;
		t[i * 4 + 3] = a - dd;
	}
	for (let i = 0; i < 4; i++) {
		const dc = t[i] + 4;
		const a = dc + t[8 + i];
		const b = dc - t[8 + i];
		const cc = mul2(t[4 + i]) - mul1(t[12 + i]);
		const dd = mul1(t[4 + i]) + mul2(t[12 + i]);
		const p = d + i * BPS;
		buf[p] = clip8(buf[p] + ((a + dd) >> 3));
		buf[p + 1] = clip8(buf[p + 1] + ((b + cc) >> 3));
		buf[p + 2] = clip8(buf[p + 2] + ((b - cc) >> 3));
		buf[p + 3] = clip8(buf[p + 3] + ((a - dd) >> 3));
	}
}

/** Inverse Walsh-Hadamard transform of the luma DC block into the DC slots of 16 blocks. */
function transformWht(inp: Int16Array, out: Int16Array): void {
	const t = new Int32Array(16);
	for (let i = 0; i < 4; i++) {
		const a0 = inp[i] + inp[12 + i];
		const a1 = inp[4 + i] + inp[8 + i];
		const a2 = inp[4 + i] - inp[8 + i];
		const a3 = inp[i] - inp[12 + i];
		t[i] = a0 + a1;
		t[8 + i] = a0 - a1;
		t[4 + i] = a3 + a2;
		t[12 + i] = a3 - a2;
	}
	for (let i = 0; i < 4; i++) {
		const dc = t[i * 4] + 3;
		const a0 = dc + t[3 + i * 4];
		const a1 = t[1 + i * 4] + t[2 + i * 4];
		const a2 = t[1 + i * 4] - t[2 + i * 4];
		const a3 = dc - t[3 + i * 4];
		out[i * 64] = (a0 + a1) >> 3;
		out[i * 64 + 16] = (a3 + a2) >> 3;
		out[i * 64 + 32] = (a0 - a1) >> 3;
		out[i * 64 + 48] = (a3 - a2) >> 3;
	}
}

/** Fills a size x size block with the DC value `v`. */
function fill(buf: Uint8Array, d: number, size: number, v: number): void {
	for (let j = 0; j < size; j++) buf.fill(v, d + j * BPS, d + j * BPS + size);
}

function trueMotion(buf: Uint8Array, d: number, size: number): void {
	const tl = buf[d - BPS - 1];
	for (let j = 0; j < size; j++) {
		const l = buf[d + j * BPS - 1] - tl;
		for (let i = 0; i < size; i++) buf[d + j * BPS + i] = clip8(buf[d - BPS + i] + l);
	}
}

/** 16x16 luma (`size` 16) or 8x8 chroma (`size` 8) prediction; `mode` 0..3 as DC/TM/V/H. */
function predictBlock(buf: Uint8Array, d: number, size: number, mode: number, hasTop: boolean, hasLeft: boolean): void {
	if (mode === B_DC) {
		const shift = size === 16 ? 3 : 2;
		let sum = 0;
		if (hasTop) for (let i = 0; i < size; i++) sum += buf[d - BPS + i];
		if (hasLeft) for (let i = 0; i < size; i++) sum += buf[d + i * BPS - 1];
		if (hasTop && hasLeft) fill(buf, d, size, (sum + size) >> (shift + 2));
		else if (hasTop || hasLeft) fill(buf, d, size, (sum + (size >> 1)) >> (shift + 1));
		else fill(buf, d, size, 0x80);
	} else if (mode === B_TM) {
		trueMotion(buf, d, size);
	} else if (mode === B_VE) {
		for (let j = 0; j < size; j++) buf.copyWithin(d + j * BPS, d - BPS, d - BPS + size);
	} else {
		for (let j = 0; j < size; j++) buf.fill(buf[d + j * BPS - 1], d + j * BPS, d + j * BPS + size);
	}
}

/** 4x4 luma sub-block prediction from the border around `d` (top-right included). */
function predict4(buf: Uint8Array, d: number, mode: number): void {
	const put = (x: number, y: number, v: number): void => { buf[d + x + y * BPS] = v; };
	const X = buf[d - BPS - 1];
	const A = buf[d - BPS], B = buf[d - BPS + 1], C = buf[d - BPS + 2], D = buf[d - BPS + 3];
	const E = buf[d - BPS + 4], F = buf[d - BPS + 5], G = buf[d - BPS + 6], H = buf[d - BPS + 7];
	const I = buf[d - 1], J = buf[d - 1 + BPS], K = buf[d - 1 + 2 * BPS], L = buf[d - 1 + 3 * BPS];
	switch (mode) {
		case B_DC: {
			const dc = (A + B + C + D + I + J + K + L + 4) >> 3;
			for (let j = 0; j < 4; j++) buf.fill(dc, d + j * BPS, d + j * BPS + 4);
			break;
		}
		case B_TM:
			trueMotion(buf, d, 4);
			break;
		case B_VE: {
			const v = [avg3(X, A, B), avg3(A, B, C), avg3(B, C, D), avg3(C, D, E)];
			for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) put(i, j, v[i]);
			break;
		}
		case B_HE: {
			const v = [avg3(X, I, J), avg3(I, J, K), avg3(J, K, L), avg3(K, L, L)];
			for (let j = 0; j < 4; j++) buf.fill(v[j], d + j * BPS, d + j * BPS + 4);
			break;
		}
		case B_RD:
			put(0, 3, avg3(J, K, L));
			put(1, 3, put2(0, 2, avg3(I, J, K)));
			put(2, 3, put2(1, 2, put2(0, 1, avg3(X, I, J))));
			put(3, 3, put2(2, 2, put2(1, 1, put2(0, 0, avg3(A, X, I)))));
			put(3, 2, put2(2, 1, put2(1, 0, avg3(B, A, X))));
			put(3, 1, put2(2, 0, avg3(C, B, A)));
			put(3, 0, avg3(D, C, B));
			break;
		case B_VR:
			put(0, 0, put2(1, 2, avg2(X, A)));
			put(1, 0, put2(2, 2, avg2(A, B)));
			put(2, 0, put2(3, 2, avg2(B, C)));
			put(3, 0, avg2(C, D));
			put(0, 3, avg3(K, J, I));
			put(0, 2, avg3(J, I, X));
			put(0, 1, put2(1, 3, avg3(I, X, A)));
			put(1, 1, put2(2, 3, avg3(X, A, B)));
			put(2, 1, put2(3, 3, avg3(A, B, C)));
			put(3, 1, avg3(B, C, D));
			break;
		case B_LD:
			put(0, 0, avg3(A, B, C));
			put(1, 0, put2(0, 1, avg3(B, C, D)));
			put(2, 0, put2(1, 1, put2(0, 2, avg3(C, D, E))));
			put(3, 0, put2(2, 1, put2(1, 2, put2(0, 3, avg3(D, E, F)))));
			put(3, 1, put2(2, 2, put2(1, 3, avg3(E, F, G))));
			put(3, 2, put2(2, 3, avg3(F, G, H)));
			put(3, 3, avg3(G, H, H));
			break;
		case B_VL:
			put(0, 0, avg2(A, B));
			put(1, 0, put2(0, 2, avg2(B, C)));
			put(2, 0, put2(1, 2, avg2(C, D)));
			put(3, 0, put2(2, 2, avg2(D, E)));
			put(0, 1, avg3(A, B, C));
			put(1, 1, put2(0, 3, avg3(B, C, D)));
			put(2, 1, put2(1, 3, avg3(C, D, E)));
			put(3, 1, put2(2, 3, avg3(D, E, F)));
			put(3, 2, avg3(E, F, G));
			put(3, 3, avg3(F, G, H));
			break;
		case B_HU:
			put(0, 0, avg2(I, J));
			put(2, 0, put2(0, 1, avg2(J, K)));
			put(2, 1, put2(0, 2, avg2(K, L)));
			put(1, 0, avg3(I, J, K));
			put(3, 0, put2(1, 1, avg3(J, K, L)));
			put(3, 1, put2(1, 2, avg3(K, L, L)));
			for (const [x, y] of [[3, 2], [2, 2], [0, 3], [1, 3], [2, 3], [3, 3]]) put(x, y, L);
			break;
		default: // B_HD
			put(0, 0, put2(2, 1, avg2(I, X)));
			put(0, 1, put2(2, 2, avg2(J, I)));
			put(0, 2, put2(2, 3, avg2(K, J)));
			put(0, 3, avg2(L, K));
			put(3, 0, avg3(A, B, C));
			put(2, 0, avg3(X, A, B));
			put(1, 0, put2(3, 1, avg3(I, X, A)));
			put(1, 1, put2(3, 2, avg3(J, I, X)));
			put(1, 2, put2(3, 3, avg3(K, J, I)));
			put(1, 3, avg3(L, K, J));
	}
	// Writes a value to a second pixel too and passes it through, so equal pixels read as one chain.
	function put2(x: number, y: number, v: number): number {
		buf[d + x + y * BPS] = v;
		return v;
	}
}

// ---- Loop filter (RFC 6386 section 15, libwebp arithmetic) ----

const sclip1 = (v: number): number => (v < -128 ? -128 : v > 127 ? 127 : v);
const sclip2 = (v: number): number => (v < -16 ? -16 : v > 15 ? 15 : v);

function doFilter2(b: Uint8Array, p: number, s: number): void {
	const p1 = b[p - 2 * s], p0 = b[p - s], q0 = b[p], q1 = b[p + s];
	const a = 3 * (q0 - p0) + sclip1(p1 - q1);
	const a1 = sclip2((a + 4) >> 3), a2 = sclip2((a + 3) >> 3);
	b[p - s] = clip8(p0 + a2);
	b[p] = clip8(q0 - a1);
}

function doFilter4(b: Uint8Array, p: number, s: number): void {
	const p1 = b[p - 2 * s], p0 = b[p - s], q0 = b[p], q1 = b[p + s];
	const a = 3 * (q0 - p0);
	const a1 = sclip2((a + 4) >> 3), a2 = sclip2((a + 3) >> 3);
	const a3 = (a1 + 1) >> 1;
	b[p - 2 * s] = clip8(p1 + a3);
	b[p - s] = clip8(p0 + a2);
	b[p] = clip8(q0 - a1);
	b[p + s] = clip8(q1 - a3);
}

function doFilter6(b: Uint8Array, p: number, s: number): void {
	const p2 = b[p - 3 * s], p1 = b[p - 2 * s], p0 = b[p - s];
	const q0 = b[p], q1 = b[p + s], q2 = b[p + 2 * s];
	const a = sclip1(3 * (q0 - p0) + sclip1(p1 - q1));
	const a1 = (27 * a + 63) >> 7, a2 = (18 * a + 63) >> 7, a3 = (9 * a + 63) >> 7;
	b[p - 3 * s] = clip8(p2 + a3);
	b[p - 2 * s] = clip8(p1 + a2);
	b[p - s] = clip8(p0 + a1);
	b[p] = clip8(q0 - a1);
	b[p + s] = clip8(q1 - a2);
	b[p + 2 * s] = clip8(q2 - a3);
}

/** Filters `size` positions along an edge: `h` steps across the edge, `v` along it. */
function filterEdge(b: Uint8Array, p: number, h: number, v: number, size: number, thresh: number, ithresh: number, hevThresh: number, wide: boolean): void {
	const t2 = 2 * thresh + 1;
	for (; size > 0; size--, p += v) {
		const p3 = b[p - 4 * h], p2 = b[p - 3 * h], p1 = b[p - 2 * h], p0 = b[p - h];
		const q0 = b[p], q1 = b[p + h], q2 = b[p + 2 * h], q3 = b[p + 3 * h];
		if (4 * Math.abs(p0 - q0) + Math.abs(p1 - q1) > t2) continue;
		if (Math.abs(p3 - p2) > ithresh || Math.abs(p2 - p1) > ithresh || Math.abs(p1 - p0) > ithresh ||
			Math.abs(q3 - q2) > ithresh || Math.abs(q2 - q1) > ithresh || Math.abs(q1 - q0) > ithresh) continue;
		if (Math.abs(p1 - p0) > hevThresh || Math.abs(q1 - q0) > hevThresh) doFilter2(b, p, h);
		else if (wide) doFilter6(b, p, h);
		else doFilter4(b, p, h);
	}
}

function simpleEdge(b: Uint8Array, p: number, h: number, v: number, thresh: number): void {
	const t2 = 2 * thresh + 1;
	for (let i = 0; i < 16; i++, p += v) {
		if (4 * Math.abs(b[p - h] - b[p]) + Math.abs(b[p - 2 * h] - b[p + h]) <= t2) doFilter2(b, p, h);
	}
}

/**
 * Decodes a `VP8 ` chunk payload (one key frame) to planar YUV 4:2:0.
 */
export function decodeVp8(data: Uint8Array): Vp8Frame {
	if (data.length < 10) throw new Error('VP8: truncated');
	const tag = data[0] | (data[1] << 8) | (data[2] << 16);
	if (tag & 1) throw new Error('VP8: not a key frame');
	if (((tag >> 1) & 7) > 3) throw new Error('VP8: unknown profile');
	if (!((tag >> 4) & 1)) throw new Error('VP8: frame not shown');
	const partLen = tag >>> 5;
	if (data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) throw new Error('VP8: bad start code');
	const width = (data[6] | (data[7] << 8)) & 0x3fff, height = (data[8] | (data[9] << 8)) & 0x3fff;
	if (!width || !height) throw new Error('VP8: empty frame');
	if (10 + partLen > data.length) throw new Error('VP8: bad partition size');
	const mbW = (width + 15) >> 4, mbH = (height + 15) >> 4;

	const br = new BoolDecoder(data, 10, 10 + partLen);
	br.flag(); // colour space
	br.flag(); // clamping type (the clamp is always applied, as libwebp does)

	// Segment header.
	const useSegment = br.flag();
	let updateMap = 0, absoluteDelta = 1;
	const segQuant = [0, 0, 0, 0], segFilter = [0, 0, 0, 0], segProbs = [255, 255, 255];
	if (useSegment) {
		updateMap = br.flag();
		if (br.flag()) {
			absoluteDelta = br.flag();
			for (let s = 0; s < 4; s++) segQuant[s] = br.flag() ? br.signed(7) : 0;
			for (let s = 0; s < 4; s++) segFilter[s] = br.flag() ? br.signed(6) : 0;
		}
		if (updateMap) for (let s = 0; s < 3; s++) segProbs[s] = br.flag() ? br.literal(8) : 255;
	}
	// Filter header.
	const simple = br.flag(), level = br.literal(6), sharpness = br.literal(3), useLfDelta = br.flag();
	const refDelta = [0, 0, 0, 0], modeDelta = [0, 0, 0, 0];
	if (useLfDelta && br.flag()) {
		for (let i = 0; i < 4; i++) if (br.flag()) refDelta[i] = br.signed(6);
		for (let i = 0; i < 4; i++) if (br.flag()) modeDelta[i] = br.signed(6);
	}
	const filterType = level === 0 ? 0 : simple ? 1 : 2;

	// Token partitions.
	const numParts = 1 << br.literal(2);
	let partStart = 10 + partLen;
	if (data.length - partStart < 3 * (numParts - 1)) throw new Error('VP8: truncated partitions');
	let sizePos = partStart;
	partStart += 3 * (numParts - 1);
	let left = data.length - partStart;
	const parts: BoolDecoder[] = [];
	for (let p = 0; p < numParts - 1; p++) {
		const size = Math.min(data[sizePos] | (data[sizePos + 1] << 8) | (data[sizePos + 2] << 16), left);
		sizePos += 3;
		parts.push(new BoolDecoder(data, partStart, partStart + size));
		partStart += size;
		left -= size;
	}
	parts.push(new BoolDecoder(data, partStart, data.length));
	if (partStart >= data.length) throw new Error('VP8: no token data');

	// Quantisers.
	const baseQ = br.literal(7);
	const dq = [0, 0, 0, 0, 0].map(() => (br.flag() ? br.signed(4) : 0));
	const clip = (v: number, max: number): number => (v < 0 ? 0 : v > max ? max : v);
	const quant: { y1: number[]; y2: number[]; uv: number[] }[] = [];
	for (let i = 0; i < 4; i++) {
		let q = baseQ;
		if (useSegment) q = absoluteDelta ? segQuant[i] : segQuant[i] + baseQ;
		else if (i > 0) { quant.push(quant[0]); continue; }
		quant.push({
			y1: [DC_TABLE[clip(q + dq[0], 127)], AC_TABLE[clip(q, 127)]],
			y2: [DC_TABLE[clip(q + dq[1], 127)] * 2, Math.max(8, (AC_TABLE[clip(q + dq[2], 127)] * 101581) >> 16)],
			uv: [DC_TABLE[clip(q + dq[3], 117)], AC_TABLE[clip(q + dq[4], 127)]],
		});
	}

	br.flag(); // refresh entropy probabilities (irrelevant for a single frame)
	const probs = new Uint8Array(DEFAULT_COEFF_PROBS.length);
	for (let i = 0; i < probs.length; i++) probs[i] = br.bit(COEFF_UPDATE_PROBS[i]) ? br.literal(8) : DEFAULT_COEFF_PROBS[i];
	const useSkip = br.flag();
	const skipProb = useSkip ? br.literal(8) : 0;
	if (br.overrun) throw new Error('VP8: truncated header');

	// Loop-filter strengths per segment and block type (index 1: sub-block prediction).
	const fLimit = new Uint8Array(8), fILevel = new Uint8Array(8), fHev = new Uint8Array(8);
	if (filterType > 0) {
		for (let s = 0; s < 4; s++) {
			let base = level;
			if (useSegment) base = segFilter[s] + (absoluteDelta ? 0 : level);
			for (let i4 = 0; i4 <= 1; i4++) {
				let lv = base;
				if (useLfDelta) lv += refDelta[0] + (i4 ? modeDelta[0] : 0);
				lv = lv < 0 ? 0 : lv > 63 ? 63 : lv;
				if (lv > 0) {
					let il = lv;
					if (sharpness > 0) {
						il >>= sharpness > 4 ? 2 : 1;
						if (il > 9 - sharpness) il = 9 - sharpness;
					}
					if (il < 1) il = 1;
					fILevel[s * 2 + i4] = il;
					fLimit[s * 2 + i4] = 2 * lv + il;
					fHev[s * 2 + i4] = lv >= 40 ? 2 : lv >= 15 ? 1 : 0;
				}
			}
		}
	}

	const yStride = mbW * 16, uvStride = mbW * 8;
	const yPlane = new Uint8Array(yStride * mbH * 16);
	const uPlane = new Uint8Array(uvStride * mbH * 8);
	const vPlane = new Uint8Array(uvStride * mbH * 8);
	const mbInner = new Uint8Array(mbW * mbH);
	const mbSeg = new Uint8Array(mbW * mbH);
	const mbI4 = new Uint8Array(mbW * mbH);

	// Prediction context: modes above (4 per macroblock) and to the left, non-zero flags.
	const topModes = new Uint8Array(mbW * 4);
	const leftModes = new Uint8Array(4);
	const topNz = new Uint8Array(mbW * 9); // 4 luma, 2 U, 2 V, 1 Y2 DC
	const leftNz = new Uint8Array(9);
	const topY = new Uint8Array(mbW * 16), topU = new Uint8Array(mbW * 8), topV = new Uint8Array(mbW * 8);
	const work = new Uint8Array(WORK_SIZE);
	const coeffs = new Int16Array(384);
	const dcBlock = new Int16Array(16);
	const modes4 = new Uint8Array(16);

	const largeValue = (t: BoolDecoder, p: number): number => {
		let v: number;
		if (!t.bit(probs[p + 3])) {
			v = !t.bit(probs[p + 4]) ? 2 : 3 + t.bit(probs[p + 5]);
		} else if (!t.bit(probs[p + 6])) {
			if (!t.bit(probs[p + 7])) v = 5 + t.bit(159);
			else { v = 7 + 2 * t.bit(165); v += t.bit(145); }
		} else {
			const bit1 = t.bit(probs[p + 8]);
			const bit0 = t.bit(probs[p + 9 + bit1]);
			const cat = 2 * bit1 + bit0;
			v = 0;
			for (const prob of CAT3456[cat]) v += v + t.bit(prob);
			v += 3 + (8 << cat);
		}
		return v;
	};
	/** Reads one block of tokens; returns the position after the last non-zero coefficient. */
	const getCoeffs = (t: BoolDecoder, type: number, ctx: number, dc: number, ac: number, first: number, out: Int16Array, off: number): number => {
		let n = first;
		let p = ((type * 8 + BANDS[n]) * 3 + ctx) * 11;
		for (; n < 16; n++) {
			if (!t.bit(probs[p])) return n;
			while (!t.bit(probs[p + 1])) {
				p = ((type * 8 + BANDS[++n]) * 3) * 11;
				if (n === 16) return 16;
			}
			const next = (type * 8 + BANDS[n + 1]) * 33;
			let v: number;
			if (!t.bit(probs[p + 2])) { v = 1; p = next + 11; } else { v = largeValue(t, p); p = next + 22; }
			if (t.flag()) v = -v;
			out[off + ZIGZAG[n]] = v * (n > 0 ? ac : dc);
		}
		return 16;
	};

	for (let mby = 0; mby < mbH; mby++) {
		const tokens = parts[mby & (numParts - 1)];
		leftNz.fill(0);
		leftModes.fill(B_DC);
		// Left border (129) and top-left sample for the first macroblock of the row.
		for (let j = 0; j < 16; j++) work[Y_OFF + j * BPS - 1] = 129;
		for (let j = 0; j < 8; j++) { work[U_OFF + j * BPS - 1] = 129; work[V_OFF + j * BPS - 1] = 129; }
		if (mby > 0) {
			work[Y_OFF - BPS - 1] = work[U_OFF - BPS - 1] = work[V_OFF - BPS - 1] = 129;
		} else {
			work.fill(127, Y_OFF - BPS - 1, Y_OFF - BPS + 20);
			work.fill(127, U_OFF - BPS - 1, U_OFF - BPS + 8);
			work.fill(127, V_OFF - BPS - 1, V_OFF - BPS + 8);
		}
		for (let mbx = 0; mbx < mbW; mbx++) {
			const mbIndex = mby * mbW + mbx;
			// ---- Macroblock header (first partition) ----
			let segment = 0;
			if (updateMap) segment = !br.bit(segProbs[0]) ? br.bit(segProbs[1]) : br.bit(segProbs[2]) + 2;
			const skip = useSkip ? br.bit(skipProb) : 0;
			const isI4 = !br.bit(145);
			let ymode = B_DC;
			if (!isI4) {
				ymode = br.bit(156) ? (br.bit(128) ? B_TM : B_HE) : (br.bit(163) ? B_VE : B_DC);
				topModes.fill(ymode, mbx * 4, mbx * 4 + 4);
				leftModes.fill(ymode);
			} else {
				for (let y = 0; y < 4; y++) {
					let m = leftModes[y];
					for (let x = 0; x < 4; x++) {
						const pr = (topModes[mbx * 4 + x] * 10 + m) * 9;
						m = !br.bit(KF_BMODE_PROBS[pr]) ? B_DC
							: !br.bit(KF_BMODE_PROBS[pr + 1]) ? B_TM
							: !br.bit(KF_BMODE_PROBS[pr + 2]) ? B_VE
							: !br.bit(KF_BMODE_PROBS[pr + 3])
								? (!br.bit(KF_BMODE_PROBS[pr + 4]) ? B_HE : !br.bit(KF_BMODE_PROBS[pr + 5]) ? B_RD : B_VR)
								: !br.bit(KF_BMODE_PROBS[pr + 6]) ? B_LD
								: !br.bit(KF_BMODE_PROBS[pr + 7]) ? B_VL
								: !br.bit(KF_BMODE_PROBS[pr + 8]) ? B_HD : B_HU;
						topModes[mbx * 4 + x] = m;
						modes4[y * 4 + x] = m;
					}
					leftModes[y] = m;
				}
			}
			const uvmode = !br.bit(142) ? B_DC : !br.bit(114) ? B_VE : br.bit(183) ? B_TM : B_HE;
			if (br.overrun) throw new Error('VP8: truncated');

			// ---- Residuals (token partition) ----
			coeffs.fill(0);
			let nonZero = 0;
			const tn = mbx * 9;
			if (!skip) {
				const q = quant[segment];
				let first = 0, type = 3;
				if (!isI4) {
					dcBlock.fill(0);
					const nz = getCoeffs(tokens, 1, topNz[tn + 8] + leftNz[8], q.y2[0], q.y2[1], 0, dcBlock, 0);
					topNz[tn + 8] = leftNz[8] = nz > 0 ? 1 : 0;
					transformWht(dcBlock, coeffs);
					first = 1;
					type = 0;
				}
				for (let y = 0; y < 4; y++) {
					for (let x = 0; x < 4; x++) {
						const off = (y * 4 + x) * 16;
						const nz = getCoeffs(tokens, type, topNz[tn + x] + leftNz[y], q.y1[0], q.y1[1], first, coeffs, off);
						topNz[tn + x] = leftNz[y] = nz > first ? 1 : 0;
						if (nz > 1 || coeffs[off] !== 0) nonZero = 1;
					}
				}
				for (let ch = 0; ch < 2; ch++) {
					for (let y = 0; y < 2; y++) {
						for (let x = 0; x < 2; x++) {
							const off = (16 + ch * 4 + y * 2 + x) * 16;
							const ti = tn + 4 + ch * 2 + x, li = 4 + ch * 2 + y;
							const nz = getCoeffs(tokens, 2, topNz[ti] + leftNz[li], q.uv[0], q.uv[1], 0, coeffs, off);
							topNz[ti] = leftNz[li] = nz > 0 ? 1 : 0;
							if (nz > 1 || coeffs[off] !== 0) nonZero = 1;
						}
					}
				}
			} else {
				topNz.fill(0, tn, tn + 8);
				leftNz.fill(0, 0, 8);
				if (!isI4) topNz[tn + 8] = leftNz[8] = 0;
			}
			if (tokens.overrun) throw new Error('VP8: truncated');
			// Inner edges are filtered unless the macroblock has no coefficients at all.
			mbInner[mbIndex] = nonZero ? 1 : 0;
			mbSeg[mbIndex] = segment;
			mbI4[mbIndex] = isI4 ? 1 : 0;

			// ---- Reconstruction ----
			if (mbx > 0) {
				for (let j = -1; j < 16; j++) work[Y_OFF + j * BPS - 1] = work[Y_OFF + j * BPS + 15];
				for (let j = -1; j < 8; j++) {
					work[U_OFF + j * BPS - 1] = work[U_OFF + j * BPS + 7];
					work[V_OFF + j * BPS - 1] = work[V_OFF + j * BPS + 7];
				}
			}
			if (mby > 0) {
				work.set(topY.subarray(mbx * 16, mbx * 16 + 16), Y_OFF - BPS);
				work.set(topU.subarray(mbx * 8, mbx * 8 + 8), U_OFF - BPS);
				work.set(topV.subarray(mbx * 8, mbx * 8 + 8), V_OFF - BPS);
			}
			const hasTop = mby > 0, hasLeft = mbx > 0;
			if (isI4) {
				const tr = Y_OFF - BPS + 16;
				if (mby > 0) {
					if (mbx >= mbW - 1) work.fill(topY[mbx * 16 + 15], tr, tr + 4);
					else work.set(topY.subarray(mbx * 16 + 16, mbx * 16 + 20), tr);
				}
				for (let k = 1; k <= 3; k++) work.copyWithin(tr + 4 * BPS * k, tr, tr + 4);
				for (let n = 0; n < 16; n++) {
					const d = Y_OFF + (n & 3) * 4 + (n >> 2) * 4 * BPS;
					predict4(work, d, modes4[n]);
					transformAdd(coeffs, n * 16, work, d);
				}
			} else {
				predictBlock(work, Y_OFF, 16, ymode, hasTop, hasLeft);
				for (let n = 0; n < 16; n++) transformAdd(coeffs, n * 16, work, Y_OFF + (n & 3) * 4 + (n >> 2) * 4 * BPS);
			}
			predictBlock(work, U_OFF, 8, uvmode, hasTop, hasLeft);
			predictBlock(work, V_OFF, 8, uvmode, hasTop, hasLeft);
			for (let n = 0; n < 4; n++) {
				const d = (n & 1) * 4 + (n >> 1) * 4 * BPS;
				transformAdd(coeffs, (16 + n) * 16, work, U_OFF + d);
				transformAdd(coeffs, (20 + n) * 16, work, V_OFF + d);
			}
			// Keep the unfiltered bottom rows for the next row's prediction, store the macroblock.
			topY.set(work.subarray(Y_OFF + 15 * BPS, Y_OFF + 15 * BPS + 16), mbx * 16);
			topU.set(work.subarray(U_OFF + 7 * BPS, U_OFF + 7 * BPS + 8), mbx * 8);
			topV.set(work.subarray(V_OFF + 7 * BPS, V_OFF + 7 * BPS + 8), mbx * 8);
			for (let j = 0; j < 16; j++) yPlane.set(work.subarray(Y_OFF + j * BPS, Y_OFF + j * BPS + 16), (mby * 16 + j) * yStride + mbx * 16);
			for (let j = 0; j < 8; j++) {
				uPlane.set(work.subarray(U_OFF + j * BPS, U_OFF + j * BPS + 8), (mby * 8 + j) * uvStride + mbx * 8);
				vPlane.set(work.subarray(V_OFF + j * BPS, V_OFF + j * BPS + 8), (mby * 8 + j) * uvStride + mbx * 8);
			}
		}
	}

	// ---- In-loop filter over the whole frame, macroblock by macroblock ----
	if (filterType > 0) {
		for (let mby = 0; mby < mbH; mby++) {
			for (let mbx = 0; mbx < mbW; mbx++) {
				const i = mby * mbW + mbx;
				const idx = mbSeg[i] * 2 + mbI4[i];
				const limit = fLimit[idx];
				if (limit === 0) continue;
				const il = fILevel[idx], hev = fHev[idx], inner = mbInner[i] !== 0 || mbI4[i] !== 0;
				const yp = mby * 16 * yStride + mbx * 16, uvp = mby * 8 * uvStride + mbx * 8;
				if (filterType === 1) {
					if (mbx > 0) simpleEdge(yPlane, yp, 1, yStride, limit + 4);
					if (inner) for (let k = 4; k < 16; k += 4) simpleEdge(yPlane, yp + k, 1, yStride, limit);
					if (mby > 0) simpleEdge(yPlane, yp, yStride, 1, limit + 4);
					if (inner) for (let k = 4; k < 16; k += 4) simpleEdge(yPlane, yp + k * yStride, yStride, 1, limit);
				} else {
					if (mbx > 0) {
						filterEdge(yPlane, yp, 1, yStride, 16, limit + 4, il, hev, true);
						filterEdge(uPlane, uvp, 1, uvStride, 8, limit + 4, il, hev, true);
						filterEdge(vPlane, uvp, 1, uvStride, 8, limit + 4, il, hev, true);
					}
					if (inner) {
						for (let k = 4; k < 16; k += 4) filterEdge(yPlane, yp + k, 1, yStride, 16, limit, il, hev, false);
						filterEdge(uPlane, uvp + 4, 1, uvStride, 8, limit, il, hev, false);
						filterEdge(vPlane, uvp + 4, 1, uvStride, 8, limit, il, hev, false);
					}
					if (mby > 0) {
						filterEdge(yPlane, yp, yStride, 1, 16, limit + 4, il, hev, true);
						filterEdge(uPlane, uvp, uvStride, 1, 8, limit + 4, il, hev, true);
						filterEdge(vPlane, uvp, uvStride, 1, 8, limit + 4, il, hev, true);
					}
					if (inner) {
						for (let k = 4; k < 16; k += 4) filterEdge(yPlane, yp + k * yStride, yStride, 1, 16, limit, il, hev, false);
						filterEdge(uPlane, uvp + 4 * uvStride, uvStride, 1, 8, limit, il, hev, false);
						filterEdge(vPlane, uvp + 4 * uvStride, uvStride, 1, 8, limit, il, hev, false);
					}
				}
			}
		}
	}
	return { width, height, y: yPlane, u: uPlane, v: vPlane, yStride, uvStride };
}

// ---- Output stage: fancy upsampling and YUV to RGB (libwebp yuv.h / upsampling.c) ----

const mulHi = (v: number, coeff: number): number => (v * coeff) >> 8;
const clip6 = (v: number): number => ((v & ~16383) === 0 ? v >> 6 : v < 0 ? 0 : 255);

/**
 * Converts decoded planes to straight RGBA using libwebp's default path
 * (bilinear "fancy" chroma upsampling). `alpha` is one byte per pixel or `null`.
 */
export function vp8ToRgba(f: Vp8Frame, alpha: Uint8Array | null): Uint8ClampedArray {
	const { width: w, height: h } = f;
	const out = new Uint8ClampedArray(w * h * 4);
	const uvW = (w + 1) >> 1;
	const cu = new Uint8Array(w), cv = new Uint8Array(w);
	for (let y = 0; y < h; y++) {
		// Nearest chroma row, and the next-nearest in the vertical direction (mirrored at the borders).
		const near = y >> 1;
		let far = (y & 1) ? near + 1 : near - 1;
		if (far < 0 || far >= (h + 1) >> 1) far = near;
		const nU = near * f.uvStride, fU = far * f.uvStride;
		for (let c = 0; c < 2; c++) {
			const plane = c === 0 ? f.u : f.v, dst = c === 0 ? cu : cv;
			dst[0] = (3 * plane[nU] + plane[fU] + 2) >> 2;
			for (let k = 1; k <= (w - 1) >> 1; k++) {
				const tl = plane[nU + k - 1], t = plane[nU + k], l = plane[fU + k - 1], u = plane[fU + k];
				const avg = tl + t + l + u + 8;
				const d12 = (avg + 2 * (t + l)) >> 3, d03 = (avg + 2 * (tl + u)) >> 3;
				dst[2 * k - 1] = (d12 + tl) >> 1;
				dst[2 * k] = (d03 + t) >> 1;
			}
			if (!(w & 1)) dst[w - 1] = (3 * plane[nU + uvW - 1] + plane[fU + uvW - 1] + 2) >> 2;
		}
		for (let x = 0; x < w; x++) {
			const Y = mulHi(f.y[y * f.yStride + x], 19077), U = cu[x], V = cv[x];
			const o = (y * w + x) * 4;
			out[o] = clip6(Y + mulHi(V, 26149) - 14234);
			out[o + 1] = clip6(Y - mulHi(U, 6419) - mulHi(V, 13320) + 8708);
			out[o + 2] = clip6(Y + mulHi(U, 33050) - 17685);
			out[o + 3] = alpha ? alpha[y * w + x] : 255;
		}
	}
	return out;
}
