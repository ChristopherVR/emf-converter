/**
 * Minimal WebP lossy (VP8 key frame) encoder.
 *
 * Every macroblock is predicted as a whole 16 x 16 luma block (DC, vertical,
 * horizontal or TrueMotion) with the matching 8 x 8 chroma prediction, the
 * residual goes through the 4 x 4 DCT (with the Walsh-Hadamard transform for
 * the luma DC values), is quantised from a single quality-derived index, and
 * is entropy-coded with the boolean coder and the format's default token
 * probabilities. There is no 4 x 4 intra mode search, no rate-distortion
 * optimisation, no loop filter, no segments and no probability updates, so
 * files are larger than libwebp's at the same quality; every decoder reads
 * them like any other VP8 key frame.
 *
 * The format is RFC 6386 (VP8 Data Format and Decoding Guide). The transform
 * and prediction arithmetic follows it, with libwebp's edge conventions
 * (127 above the frame, 129 left of it).
 *
 * @module webp-vp8-encoder
 */

import { AC_Q_TABLE, COEFF_PROBS, COEFF_UPDATE_PROBS, DC_Q_TABLE } from './webp-vp8-tables';

/** Coefficient scan order: position in the token stream to raster index in the 4 x 4 block. */
const ZIGZAG = [0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15];
/** Token-probability band of each scan position (a 17th entry for the position after the last). */
const BANDS = [0, 1, 2, 3, 6, 4, 5, 6, 6, 6, 6, 6, 6, 6, 6, 7, 0];
const CAT3 = [173, 148, 140];
const CAT4 = [176, 155, 140, 135];
const CAT5 = [180, 157, 141, 134, 130];
const CAT6 = [254, 254, 243, 230, 196, 177, 153, 140, 133, 130, 129];

/** Prediction modes (internal numbering). */
const DC_PRED = 0;
const TM_PRED = 1;
const V_PRED = 2;
const H_PRED = 3;

/** Boolean entropy encoder (RFC 6386 section 7). */
class BoolEncoder {
	private out = new Uint8Array(1 << 12);
	private pos = 0;
	private range = 255;
	private bottom = 0;
	private bitCount = 24;

	private push(byte: number): void {
		if (this.pos === this.out.length) {
			const bigger = new Uint8Array(this.out.length * 2);
			bigger.set(this.out);
			this.out = bigger;
		}
		this.out[this.pos++] = byte;
	}

	private carry(): void {
		let p = this.pos - 1;
		while (p >= 0 && this.out[p] === 255) {
			this.out[p--] = 0;
		}
		if (p >= 0) {
			this.out[p]++;
		}
	}

	/** Codes `bit` where `prob` (1..255) is the probability, out of 256, that it is 0. */
	put(prob: number, bit: number): void {
		const split = 1 + (((this.range - 1) * prob) >> 8);
		if (bit) {
			this.bottom += split;
			this.range -= split;
		} else {
			this.range = split;
		}
		while (this.range < 128) {
			this.range <<= 1;
			if ((this.bottom & 0x80000000) !== 0) {
				this.carry();
			}
			this.bottom = (this.bottom << 1) >>> 0;
			if (--this.bitCount === 0) {
				this.push(this.bottom >>> 24);
				this.bottom &= 0xffffff;
				this.bitCount = 8;
			}
		}
	}

	/** Writes `n` raw bits, most significant first. */
	bits(value: number, n: number): void {
		for (let i = n - 1; i >= 0; i--) {
			this.put(128, (value >> i) & 1);
		}
	}

	/** Flushes the coder and returns the bytes. */
	finish(): Uint8Array {
		let c = this.bitCount;
		let v = this.bottom;
		if ((v & (1 << (32 - c))) !== 0 && c < 32) {
			this.carry();
		}
		v = (v << (c & 7)) >>> 0;
		c >>= 3;
		while (--c >= 0) {
			v = (v << 8) >>> 0;
		}
		for (let i = 0; i < 4; i++) {
			this.push(v >>> 24);
			v = (v << 8) >>> 0;
		}
		return this.out.subarray(0, this.pos);
	}
}

function clip8(v: number): number {
	return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Quantiser steps (DC, AC) of the three block kinds for one quantiser index. */
interface Quant {
	y1: [number, number];
	y2: [number, number];
	uv: [number, number];
}

function makeQuant(q: number): Quant {
	let y2ac = (AC_Q_TABLE[q] * 101581) >> 16;
	if (y2ac < 8) {
		y2ac = 8;
	}
	return {
		y1: [DC_Q_TABLE[q], AC_Q_TABLE[q]],
		y2: [DC_Q_TABLE[q] * 2, y2ac],
		uv: [DC_Q_TABLE[Math.min(q, 117)], AC_Q_TABLE[q]],
	};
}

/** Maps quality 0..1 to the 7-bit quantiser index (libwebp's curve: 1 is nearly lossless, 0 is coarsest). */
function qualityToIndex(quality: number): number {
	const linear = quality < 0.75 ? quality * (2 / 3) : 2 * quality - 1;
	return Math.min(127, Math.max(0, Math.floor(127 * (1 - Math.cbrt(linear)))));
}

const MUL1 = (a: number): number => Math.floor((a * 20091) / 65536) + a;
const MUL2 = (a: number): number => Math.floor((a * 35468) / 65536);

/** Forward 4 x 4 DCT of a residual block (raster in, raster out). */
function forwardDct(inp: Int32Array, out: Int32Array): void {
	const tmp = new Int32Array(16);
	for (let i = 0; i < 4; i++) {
		const d0 = inp[i * 4];
		const d1 = inp[i * 4 + 1];
		const d2 = inp[i * 4 + 2];
		const d3 = inp[i * 4 + 3];
		const a0 = d0 + d3;
		const a1 = d1 + d2;
		const a2 = d1 - d2;
		const a3 = d0 - d3;
		tmp[i * 4] = (a0 + a1) * 8;
		tmp[i * 4 + 1] = (a2 * 2217 + a3 * 5352 + 1812) >> 9;
		tmp[i * 4 + 2] = (a0 - a1) * 8;
		tmp[i * 4 + 3] = (a3 * 2217 - a2 * 5352 + 937) >> 9;
	}
	for (let i = 0; i < 4; i++) {
		const a0 = tmp[i] + tmp[12 + i];
		const a1 = tmp[4 + i] + tmp[8 + i];
		const a2 = tmp[4 + i] - tmp[8 + i];
		const a3 = tmp[i] - tmp[12 + i];
		out[i] = (a0 + a1 + 7) >> 4;
		out[4 + i] = ((a2 * 2217 + a3 * 5352 + 12000) >> 16) + (a3 !== 0 ? 1 : 0);
		out[8 + i] = (a0 - a1 + 7) >> 4;
		out[12 + i] = (a3 * 2217 - a2 * 5352 + 51000) >> 16;
	}
}

/** Inverse 4 x 4 DCT as the decoder does it: adds the result to `dst` (stride `stride`), clipped. */
function inverseDctAdd(coef: Int32Array, dst: Uint8Array, offset: number, stride: number): void {
	const tmp = new Int32Array(16);
	for (let i = 0; i < 4; i++) {
		const a = coef[i] + coef[8 + i];
		const b = coef[i] - coef[8 + i];
		const c = MUL2(coef[4 + i]) - MUL1(coef[12 + i]);
		const d = MUL1(coef[4 + i]) + MUL2(coef[12 + i]);
		tmp[i * 4] = a + d;
		tmp[i * 4 + 1] = b + c;
		tmp[i * 4 + 2] = b - c;
		tmp[i * 4 + 3] = a - d;
	}
	for (let i = 0; i < 4; i++) {
		const dc = tmp[i] + 4;
		const a = dc + tmp[8 + i];
		const b = dc - tmp[8 + i];
		const c = MUL2(tmp[4 + i]) - MUL1(tmp[12 + i]);
		const d = MUL1(tmp[4 + i]) + MUL2(tmp[12 + i]);
		const o = offset + i * stride;
		dst[o] = clip8(dst[o] + ((a + d) >> 3));
		dst[o + 1] = clip8(dst[o + 1] + ((b + c) >> 3));
		dst[o + 2] = clip8(dst[o + 2] + ((b - c) >> 3));
		dst[o + 3] = clip8(dst[o + 3] + ((a - d) >> 3));
	}
}

/** Forward Walsh-Hadamard transform of the 16 luma DC values (block raster order). */
function forwardWht(dc: Int32Array, out: Int32Array): void {
	const tmp = new Int32Array(16);
	for (let i = 0; i < 4; i++) {
		const a0 = dc[i * 4] + dc[i * 4 + 2];
		const a1 = dc[i * 4 + 1] + dc[i * 4 + 3];
		const a2 = dc[i * 4 + 1] - dc[i * 4 + 3];
		const a3 = dc[i * 4] - dc[i * 4 + 2];
		tmp[i * 4] = a0 + a1;
		tmp[i * 4 + 1] = a3 + a2;
		tmp[i * 4 + 2] = a3 - a2;
		tmp[i * 4 + 3] = a0 - a1;
	}
	for (let i = 0; i < 4; i++) {
		const a0 = tmp[i] + tmp[8 + i];
		const a1 = tmp[4 + i] + tmp[12 + i];
		const a2 = tmp[4 + i] - tmp[12 + i];
		const a3 = tmp[i] - tmp[8 + i];
		out[i] = (a0 + a1) >> 1;
		out[4 + i] = (a3 + a2) >> 1;
		out[8 + i] = (a3 - a2) >> 1;
		out[12 + i] = (a0 - a1) >> 1;
	}
}

/** Inverse Walsh-Hadamard transform: dequantised Y2 values to the 16 luma DC values. */
function inverseWht(inp: Int32Array, out: Int32Array): void {
	const tmp = new Int32Array(16);
	for (let i = 0; i < 4; i++) {
		const a0 = inp[i] + inp[12 + i];
		const a1 = inp[4 + i] + inp[8 + i];
		const a2 = inp[4 + i] - inp[8 + i];
		const a3 = inp[i] - inp[12 + i];
		tmp[i] = a0 + a1;
		tmp[8 + i] = a0 - a1;
		tmp[4 + i] = a3 + a2;
		tmp[12 + i] = a3 - a2;
	}
	for (let i = 0; i < 4; i++) {
		const dc = tmp[i * 4] + 3;
		const a0 = dc + tmp[i * 4 + 3];
		const a1 = tmp[i * 4 + 1] + tmp[i * 4 + 2];
		const a2 = tmp[i * 4 + 1] - tmp[i * 4 + 2];
		const a3 = dc - tmp[i * 4 + 3];
		out[i * 4] = (a0 + a1) >> 3;
		out[i * 4 + 1] = (a3 + a2) >> 3;
		out[i * 4 + 2] = (a0 - a1) >> 3;
		out[i * 4 + 3] = (a3 - a2) >> 3;
	}
}

/** Quantises one coefficient to a level (rounding slightly down, which saves bits for little loss). */
function quantise(c: number, step: number, round: number): number {
	const level = Math.min(2047, Math.floor(Math.abs(c) / step + round));
	return c < 0 ? -level : level;
}

/**
 * Builds the `size` x `size` prediction for the block at (x0, y0) of a
 * reconstructed plane, with the decoder's frame-edge conventions.
 */
function predict(
	plane: Uint8Array,
	stride: number,
	x0: number,
	y0: number,
	size: number,
	mode: number,
	out: Uint8Array,
): void {
	const hasTop = y0 > 0;
	const hasLeft = x0 > 0;
	const top = new Int32Array(size);
	const left = new Int32Array(size);
	for (let i = 0; i < size; i++) {
		top[i] = hasTop ? plane[(y0 - 1) * stride + x0 + i] : 127;
		left[i] = hasLeft ? plane[(y0 + i) * stride + x0 - 1] : 129;
	}
	const tl = hasTop ? (hasLeft ? plane[(y0 - 1) * stride + x0 - 1] : 129) : 127;
	if (mode === DC_PRED) {
		let sum = 0;
		let dc = 128;
		const shift = size === 16 ? 4 : 3;
		if (hasTop && hasLeft) {
			for (let i = 0; i < size; i++) {
				sum += top[i] + left[i];
			}
			dc = (sum + size) >> (shift + 1);
		} else if (hasTop || hasLeft) {
			const edge = hasTop ? top : left;
			for (let i = 0; i < size; i++) {
				sum += edge[i];
			}
			dc = (sum + (size >> 1)) >> shift;
		}
		out.fill(dc, 0, size * size);
		return;
	}
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			out[y * size + x] =
				mode === V_PRED ? top[x] : mode === H_PRED ? left[y] : clip8(left[y] + top[x] - tl);
		}
	}
}

/** Sum of squared differences between a source block and a prediction. */
function blockSse(src: Uint8Array, stride: number, x0: number, y0: number, size: number, pred: Uint8Array): number {
	let sse = 0;
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const d = src[(y0 + y) * stride + x0 + x] - pred[y * size + x];
			sse += d * d;
		}
	}
	return sse;
}

/** Per-macroblock coding decisions and quantised levels (raster order inside each 4 x 4 block). */
interface Macroblocks {
	ymode: Uint8Array;
	uvmode: Uint8Array;
	/** 400 levels per macroblock: Y2 (16), Y blocks (16 x 16), U (4 x 16), V (4 x 16). */
	levels: Int16Array;
	skip: Uint8Array;
}

const MB_LEVELS = 400;

/**
 * Transforms, quantises and reconstructs one component's 4 x 4 blocks.
 * Reconstruction (prediction plus dequantised residual) goes into `recon`,
 * and the levels into `levels` at `levelBase + 16 * block`.
 */
function codeBlocks(
	src: Uint8Array,
	recon: Uint8Array,
	stride: number,
	x0: number,
	y0: number,
	size: number,
	pred: Uint8Array,
	steps: [number, number],
	levels: Int16Array,
	levelBase: number,
	hasY2: boolean,
	y2dc: Int32Array,
): void {
	const perRow = size >> 2;
	const diff = new Int32Array(16);
	const coef = new Int32Array(16);
	const deq = new Int32Array(16);
	for (let by = 0; by < perRow; by++) {
		for (let bx = 0; bx < perRow; bx++) {
			const block = by * perRow + bx;
			for (let r = 0; r < 4; r++) {
				for (let c = 0; c < 4; c++) {
					diff[r * 4 + c] =
						src[(y0 + by * 4 + r) * stride + x0 + bx * 4 + c] - pred[(by * 4 + r) * size + bx * 4 + c];
				}
			}
			forwardDct(diff, coef);
			const base = levelBase + block * 16;
			if (hasY2) {
				y2dc[block] = coef[0];
				deq[0] = 0;
			} else {
				const l = quantise(coef[0], steps[0], 0.45);
				levels[base] = l;
				deq[0] = l * steps[0];
			}
			for (let i = 1; i < 16; i++) {
				const l = quantise(coef[i], steps[1], 0.4);
				levels[base + i] = l;
				deq[i] = l * steps[1];
			}
			// With a Y2 block the DC comes later; reconstruct after the WHT in the caller.
			if (!hasY2) {
				for (let r = 0; r < 4; r++) {
					for (let c = 0; c < 4; c++) {
						recon[(y0 + by * 4 + r) * stride + x0 + bx * 4 + c] = pred[(by * 4 + r) * size + bx * 4 + c];
					}
				}
				inverseDctAdd(deq, recon, (y0 + by * 4) * stride + x0 + bx * 4, stride);
			}
		}
	}
}

/** Reconstructs the 16 luma blocks of a macroblock from their levels and the dequantised Y2 DCs. */
function reconstructLuma(
	recon: Uint8Array,
	stride: number,
	x0: number,
	y0: number,
	pred: Uint8Array,
	levels: Int16Array,
	lumaBase: number,
	dcs: Int32Array,
	acStep: number,
): void {
	const deq = new Int32Array(16);
	for (let block = 0; block < 16; block++) {
		const bx = block & 3;
		const by = block >> 2;
		deq[0] = dcs[block];
		for (let i = 1; i < 16; i++) {
			deq[i] = levels[lumaBase + block * 16 + i] * acStep;
		}
		for (let r = 0; r < 4; r++) {
			for (let c = 0; c < 4; c++) {
				recon[(y0 + by * 4 + r) * stride + x0 + bx * 4 + c] = pred[(by * 4 + r) * 16 + bx * 4 + c];
			}
		}
		inverseDctAdd(deq, recon, (y0 + by * 4) * stride + x0 + bx * 4, stride);
	}
}

/** Quantises, dequantises and reconstructs the whole frame; returns the decisions and levels. */
function analyse(
	yPlane: Uint8Array,
	uPlane: Uint8Array,
	vPlane: Uint8Array,
	mbW: number,
	mbH: number,
	quant: Quant,
): Macroblocks {
	const yStride = mbW * 16;
	const cStride = mbW * 8;
	const mbs: Macroblocks = {
		ymode: new Uint8Array(mbW * mbH),
		uvmode: new Uint8Array(mbW * mbH),
		levels: new Int16Array(mbW * mbH * MB_LEVELS),
		skip: new Uint8Array(mbW * mbH),
	};
	const reconY = new Uint8Array(yPlane.length);
	const reconU = new Uint8Array(uPlane.length);
	const reconV = new Uint8Array(vPlane.length);
	const pred = new Uint8Array(256);
	const bestPred = new Uint8Array(256);
	const y2dc = new Int32Array(16);
	const y2coef = new Int32Array(16);
	const y2deq = new Int32Array(16);
	const dcs = new Int32Array(16);
	for (let mby = 0; mby < mbH; mby++) {
		for (let mbx = 0; mbx < mbW; mbx++) {
			const mb = mby * mbW + mbx;
			const base = mb * MB_LEVELS;
			// Luma: pick the prediction mode with the least squared error.
			const x0 = mbx * 16;
			const y0 = mby * 16;
			let bestMode = DC_PRED;
			let bestSse = Infinity;
			for (let mode = 0; mode < 4; mode++) {
				predict(reconY, yStride, x0, y0, 16, mode, pred);
				const sse = blockSse(yPlane, yStride, x0, y0, 16, pred);
				if (sse < bestSse) {
					bestSse = sse;
					bestMode = mode;
					bestPred.set(pred);
				}
			}
			mbs.ymode[mb] = bestMode;
			codeBlocks(yPlane, reconY, yStride, x0, y0, 16, bestPred, quant.y1, mbs.levels, base + 16, true, y2dc);
			forwardWht(y2dc, y2coef);
			for (let i = 0; i < 16; i++) {
				const l = quantise(y2coef[i], quant.y2[i === 0 ? 0 : 1], i === 0 ? 0.45 : 0.4);
				mbs.levels[base + i] = l;
				y2deq[i] = l * quant.y2[i === 0 ? 0 : 1];
			}
			inverseWht(y2deq, dcs);
			reconstructLuma(reconY, yStride, x0, y0, bestPred, mbs.levels, base + 16, dcs, quant.y1[1]);
			// Chroma: one mode for both planes, chosen on the summed error.
			const cx = mbx * 8;
			const cy = mby * 8;
			let bestUv = DC_PRED;
			let bestUvSse = Infinity;
			const predU = new Uint8Array(64);
			for (let mode = 0; mode < 4; mode++) {
				predict(reconU, cStride, cx, cy, 8, mode, predU);
				let sse = blockSse(uPlane, cStride, cx, cy, 8, predU);
				predict(reconV, cStride, cx, cy, 8, mode, predU);
				sse += blockSse(vPlane, cStride, cx, cy, 8, predU);
				if (sse < bestUvSse) {
					bestUvSse = sse;
					bestUv = mode;
				}
			}
			mbs.uvmode[mb] = bestUv;
			predict(reconU, cStride, cx, cy, 8, bestUv, predU);
			codeBlocks(uPlane, reconU, cStride, cx, cy, 8, predU, quant.uv, mbs.levels, base + 16 + 256, false, y2dc);
			predict(reconV, cStride, cx, cy, 8, bestUv, predU);
			codeBlocks(vPlane, reconV, cStride, cx, cy, 8, predU, quant.uv, mbs.levels, base + 16 + 256 + 64, false, y2dc);
			let any = false;
			for (let i = 0; i < MB_LEVELS && !any; i++) {
				any = mbs.levels[base + i] !== 0;
			}
			mbs.skip[mb] = any ? 0 : 1;
		}
	}
	return mbs;
}

/**
 * Writes one block's tokens (RFC 6386 section 13). `levels` are in raster
 * order at `base`; `first` is 1 for luma blocks whose DC lives in Y2.
 * Returns 1 when the block has any non-zero level (the context for neighbours).
 */
function putCoeffs(bw: BoolEncoder, type: number, ctx: number, levels: Int16Array, base: number, first: number): number {
	let last = -1;
	for (let n = 15; n >= first; n--) {
		if (levels[base + ZIGZAG[n]] !== 0) {
			last = n;
			break;
		}
	}
	const probOf = (band: number, c: number): number => ((type * 8 + band) * 3 + c) * 11;
	let p = probOf(BANDS[first], ctx);
	if (last < 0) {
		bw.put(COEFF_PROBS[p], 0);
		return 0;
	}
	bw.put(COEFF_PROBS[p], 1);
	let n = first;
	while (n < 16) {
		const c = levels[base + ZIGZAG[n++]];
		const sign = c < 0 ? 1 : 0;
		let v = sign ? -c : c;
		if (v === 0) {
			bw.put(COEFF_PROBS[p + 1], 0);
			p = probOf(BANDS[n], 0);
			continue;
		}
		bw.put(COEFF_PROBS[p + 1], 1);
		if (v === 1) {
			bw.put(COEFF_PROBS[p + 2], 0);
			p = probOf(BANDS[n], 1);
		} else {
			bw.put(COEFF_PROBS[p + 2], 1);
			if (v <= 4) {
				bw.put(COEFF_PROBS[p + 3], 0);
				if (v !== 2) {
					bw.put(COEFF_PROBS[p + 4], 1);
					bw.put(COEFF_PROBS[p + 5], v === 4 ? 1 : 0);
				} else {
					bw.put(COEFF_PROBS[p + 4], 0);
				}
			} else {
				bw.put(COEFF_PROBS[p + 3], 1);
				if (v <= 10) {
					bw.put(COEFF_PROBS[p + 6], 0);
					if (v <= 6) {
						bw.put(COEFF_PROBS[p + 7], 0);
						bw.put(159, v === 6 ? 1 : 0);
					} else {
						bw.put(COEFF_PROBS[p + 7], 1);
						bw.put(165, v >= 9 ? 1 : 0);
						bw.put(145, v & 1 ? 0 : 1);
					}
				} else {
					bw.put(COEFF_PROBS[p + 6], 1);
					let mask: number;
					let table: number[];
					if (v < 3 + (8 << 1)) {
						bw.put(COEFF_PROBS[p + 8], 0);
						bw.put(COEFF_PROBS[p + 9], 0);
						v -= 3 + (8 << 0);
						mask = 1 << 2;
						table = CAT3;
					} else if (v < 3 + (8 << 2)) {
						bw.put(COEFF_PROBS[p + 8], 0);
						bw.put(COEFF_PROBS[p + 9], 1);
						v -= 3 + (8 << 1);
						mask = 1 << 3;
						table = CAT4;
					} else if (v < 3 + (8 << 3)) {
						bw.put(COEFF_PROBS[p + 8], 1);
						bw.put(COEFF_PROBS[p + 10], 0);
						v -= 3 + (8 << 2);
						mask = 1 << 4;
						table = CAT5;
					} else {
						bw.put(COEFF_PROBS[p + 8], 1);
						bw.put(COEFF_PROBS[p + 10], 1);
						v -= 3 + (8 << 3);
						mask = 1 << 10;
						table = CAT6;
					}
					for (let t = 0; mask; t++, mask >>= 1) {
						bw.put(table[t], v & mask ? 1 : 0);
					}
				}
			}
			p = probOf(BANDS[n], 2);
		}
		bw.put(128, sign);
		if (n === 16) {
			return 1;
		}
		if (n <= last) {
			bw.put(COEFF_PROBS[p], 1);
		} else {
			bw.put(COEFF_PROBS[p], 0);
			return 1;
		}
	}
	return 1;
}

/** Writes the macroblock modes (first partition) and the coefficient tokens (second partition). */
function writeMacroblocks(
	first: BoolEncoder,
	tokens: BoolEncoder,
	mbs: Macroblocks,
	mbW: number,
	mbH: number,
	useSkip: boolean,
	skipProb: number,
): void {
	const topNz = new Uint8Array(mbW * 9); // 4 Y, 2 U, 2 V, 1 Y2 per macroblock column
	const leftNz = new Uint8Array(9);
	for (let mby = 0; mby < mbH; mby++) {
		leftNz.fill(0);
		for (let mbx = 0; mbx < mbW; mbx++) {
			const mb = mby * mbW + mbx;
			const ymode = mbs.ymode[mb];
			const uvmode = mbs.uvmode[mb];
			if (useSkip) {
				first.put(skipProb, mbs.skip[mb]);
			}
			// 16 x 16 luma mode (not B_PRED), then chroma mode.
			first.put(145, 1);
			if (ymode === TM_PRED || ymode === H_PRED) {
				first.put(156, 1);
				first.put(128, ymode === TM_PRED ? 1 : 0);
			} else {
				first.put(156, 0);
				first.put(163, ymode === V_PRED ? 1 : 0);
			}
			if (uvmode === DC_PRED) {
				first.put(142, 0);
			} else {
				first.put(142, 1);
				if (uvmode === V_PRED) {
					first.put(114, 0);
				} else {
					first.put(114, 1);
					first.put(183, uvmode === TM_PRED ? 1 : 0);
				}
			}
			const top = mbx * 9;
			if (useSkip && mbs.skip[mb]) {
				topNz.fill(0, top, top + 9);
				leftNz.fill(0);
				continue;
			}
			const base = mb * MB_LEVELS;
			// Y2
			const nzY2 = putCoeffs(tokens, 1, leftNz[8] + topNz[top + 8], mbs.levels, base, 0);
			leftNz[8] = nzY2;
			topNz[top + 8] = nzY2;
			// Y (DC is in Y2, so scanning starts at 1)
			for (let by = 0; by < 4; by++) {
				for (let bx = 0; bx < 4; bx++) {
					const nz = putCoeffs(tokens, 0, leftNz[by] + topNz[top + bx], mbs.levels, base + 16 + (by * 4 + bx) * 16, 1);
					leftNz[by] = nz;
					topNz[top + bx] = nz;
				}
			}
			// U then V
			for (let plane = 0; plane < 2; plane++) {
				const pBase = base + 16 + 256 + plane * 64;
				for (let by = 0; by < 2; by++) {
					for (let bx = 0; bx < 2; bx++) {
						const li = 4 + plane * 2 + by;
						const ti = top + 4 + plane * 2 + bx;
						const nz = putCoeffs(tokens, 2, leftNz[li] + topNz[ti], mbs.levels, pBase + (by * 2 + bx) * 16, 0);
						leftNz[li] = nz;
						topNz[ti] = nz;
					}
				}
			}
		}
	}
}

/**
 * Encodes straight RGBA pixels as a VP8 key frame (the payload of a `VP8 `
 * chunk). Alpha is ignored here (it goes in a separate ALPH chunk); pixels
 * that are fully transparent take their neighbour's colour so they cost
 * little.
 *
 * @param pixels   - `width * height * 4` bytes, straight RGBA.
 * @param width    - 1..16383.
 * @param height   - 1..16383.
 * @param quality  - 0..1.
 * @param hasAlpha - Whether any pixel is translucent (enables the transparent-colour fill).
 */
export function encodeVp8Frame(
	pixels: ArrayLike<number>,
	width: number,
	height: number,
	quality: number,
	hasAlpha: boolean,
): Uint8Array {
	const mbW = (width + 15) >> 4;
	const mbH = (height + 15) >> 4;
	const yStride = mbW * 16;
	const cStride = mbW * 8;
	// Padded RGB, replicating edge pixels into the partial macroblocks.
	const pw = mbW * 16;
	const ph = mbH * 16;
	const rgb = new Uint8Array(pw * ph * 3);
	let lastR = 255;
	let lastG = 255;
	let lastB = 255;
	for (let y = 0; y < ph; y++) {
		const sy = Math.min(y, height - 1);
		for (let x = 0; x < pw; x++) {
			const sx = Math.min(x, width - 1);
			const s = (sy * width + sx) * 4;
			let r = pixels[s];
			let g = pixels[s + 1];
			let b = pixels[s + 2];
			if (hasAlpha && pixels[s + 3] === 0) {
				r = lastR;
				g = lastG;
				b = lastB;
			} else {
				lastR = r;
				lastG = g;
				lastB = b;
			}
			const d = (y * pw + x) * 3;
			rgb[d] = r;
			rgb[d + 1] = g;
			rgb[d + 2] = b;
		}
	}
	const yPlane = new Uint8Array(pw * ph);
	const uPlane = new Uint8Array(cStride * mbH * 8);
	const vPlane = new Uint8Array(cStride * mbH * 8);
	for (let i = 0; i < pw * ph; i++) {
		yPlane[i] = (16839 * rgb[i * 3] + 33059 * rgb[i * 3 + 1] + 6420 * rgb[i * 3 + 2] + (16 << 16) + (1 << 15)) >> 16;
	}
	for (let y = 0; y < ph; y += 2) {
		for (let x = 0; x < pw; x += 2) {
			let sr = 0;
			let sg = 0;
			let sb = 0;
			for (let k = 0; k < 4; k++) {
				const i = ((y + (k >> 1)) * pw + x + (k & 1)) * 3;
				sr += rgb[i];
				sg += rgb[i + 1];
				sb += rgb[i + 2];
			}
			const o = (y >> 1) * cStride + (x >> 1);
			uPlane[o] = clip8((-9719 * sr - 19081 * sg + 28800 * sb + (128 << 18) + (1 << 17)) >> 18);
			vPlane[o] = clip8((28800 * sr - 24116 * sg - 4684 * sb + (128 << 18) + (1 << 17)) >> 18);
		}
	}
	const qIndex = qualityToIndex(quality);
	const mbs = analyse(yPlane, uPlane, vPlane, mbW, mbH, makeQuant(qIndex));
	let skipped = 0;
	for (let i = 0; i < mbs.skip.length; i++) {
		skipped += mbs.skip[i];
	}
	const total = mbs.skip.length;
	const skipProb = skipped === 0 ? 255 : Math.min(254, Math.max(1, Math.floor(((total - skipped) * 255) / total)));
	const useSkip = skipProb < 250;

	const first = new BoolEncoder();
	first.bits(0, 1); // colour space
	first.bits(0, 1); // clamping required
	first.bits(0, 1); // no segmentation
	first.bits(0, 1); // normal loop filter type (unused at level 0)
	first.bits(0, 6); // loop filter level 0: the decoder skips filtering
	first.bits(0, 3); // sharpness
	first.bits(0, 1); // no loop-filter deltas
	first.bits(0, 2); // one token partition
	first.bits(qIndex, 7);
	for (let i = 0; i < 5; i++) {
		first.bits(0, 1); // no quantiser deltas
	}
	first.bits(0, 1); // refresh_entropy_probs
	for (let i = 0; i < COEFF_UPDATE_PROBS.length; i++) {
		first.put(COEFF_UPDATE_PROBS[i], 0); // keep every default token probability
	}
	if (useSkip) {
		first.bits(1, 1);
		first.bits(skipProb, 8);
	} else {
		first.bits(0, 1);
	}
	const tokens = new BoolEncoder();
	writeMacroblocks(first, tokens, mbs, mbW, mbH, useSkip, skipProb);
	const part0 = first.finish();
	const part1 = tokens.finish();
	if (part0.length >= 1 << 19) {
		throw new RangeError('image too large for a single VP8 partition');
	}
	const out = new Uint8Array(10 + part0.length + part1.length);
	const tag = (1 << 4) | (part0.length << 5); // key frame, version 0, shown
	out[0] = tag & 0xff;
	out[1] = (tag >> 8) & 0xff;
	out[2] = (tag >> 16) & 0xff;
	out[3] = 0x9d;
	out[4] = 0x01;
	out[5] = 0x2a;
	out[6] = width & 0xff;
	out[7] = (width >> 8) & 0x3f;
	out[8] = height & 0xff;
	out[9] = (height >> 8) & 0x3f;
	out.set(part0, 10);
	out.set(part1, 10 + part0.length);
	return out;
}
