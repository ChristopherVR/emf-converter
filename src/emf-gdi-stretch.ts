/**
 * GDI-exact bitmap stretching for StretchBlt / StretchDIBits.
 *
 * Canvas `drawImage` resamples with its own rules, which differ from GDI's
 * on ties and on shrinking. GDI's non-HALFTONE stretch modes are all
 * nearest-neighbour on enlargement; on reduction COLORONCOLOR drops the
 * eliminated pixels, while BLACKONWHITE ANDs and WHITEONBLACK ORs them into
 * the surviving pixel. The sampling rules were matched against real Windows
 * GDI output (`scripts/gdi-fixtures`, case `rop3-stretch-sampling`).
 *
 * HALFTONE reproduces Windows' halftone engine on 32bpp output
 * ({@link stretchHalftone}).
 *
 * @module emf-gdi-stretch
 */

import { halftoneBranch } from './emf-gdi-halftone-branch';
import { ditherQuantize, ditherThreshold, type HalftoneDither } from './emf-gdi-halftone-dither';

/** GDI stretch modes (EMR_SETSTRETCHBLTMODE). */
export const BLACKONWHITE = 1;
export const WHITEONBLACK = 2;
export const COLORONCOLOR = 3;
export const HALFTONE = 4;

/** Plain pixel buffer (structurally an `ImageData`). */
export interface Pixels {
	width: number;
	height: number;
	data: Uint8ClampedArray;
}

/**
 * GDI's nearest source pixel for destination pixel `i`: the pixel under the
 * destination pixel's centre, computed in exact integer arithmetic so an
 * exact tie (a 2.5x stretch) always resolves upward, as GDI does.
 */
export function gdiNearest(i: number, srcLen: number, dstLen: number): number {
	const k = Math.floor(((2 * i + 1) * srcLen) / (2 * dstLen));
	return Math.max(0, Math.min(srcLen - 1, k));
}

/**
 * Source indices feeding each of `dstLen` destination pixels along one
 * axis, for a source run of `srcLen` pixels starting at `srcStart`.
 * `reverse` walks the source backwards (a mirrored blit). When enlarging
 * (or dropping pixels, COLORONCOLOR) each destination pixel reads its
 * {@link gdiNearest} source pixel; when reducing under BLACKONWHITE /
 * WHITEONBLACK, it also absorbs every source pixel eliminated since the
 * previous destination pixel's, i.e. the run `(c[i-1], c[i]]` (leftovers
 * after the last kept pixel are dropped, as GDI's DDA does).
 */
export function axisSamples(
	srcStart: number,
	srcLen: number,
	dstLen: number,
	reverse: boolean,
	combine: boolean,
): number[][] {
	const out: number[][] = [];
	const at = (k: number): number => (reverse ? srcStart + srcLen - 1 - k : srcStart + k);
	if (dstLen <= 0 || srcLen <= 0) {
		return out;
	}
	let prev = -1;
	for (let i = 0; i < dstLen; i++) {
		const c = gdiNearest(i, srcLen, dstLen);
		const run: number[] = [];
		const from = combine && dstLen < srcLen ? prev + 1 : c;
		for (let k = from; k <= c; k++) {
			run.push(at(k));
		}
		out.push(run);
		prev = c;
	}
	return out;
}

/**
 * Stretches the source rect (`sx`,`sy`,`sw`,`sh`, negative extents mirror)
 * of `src` onto a `dw` x `dh` destination (negative extents mirror), using
 * GDI's rules for `mode`. Pixels outside `src` read as black.
 */
export function stretchGdi(
	src: Pixels,
	sx: number,
	sy: number,
	sw: number,
	sh: number,
	dw: number,
	dh: number,
	mode: number,
): Pixels {
	const W = Math.max(0, Math.round(Math.abs(dw)));
	const H = Math.max(0, Math.round(Math.abs(dh)));
	const flipX = dw < 0 !== sw < 0;
	const flipY = dh < 0 !== sh < 0;
	const combine = mode === BLACKONWHITE || mode === WHITEONBLACK;
	const cols = axisSamples(Math.round(Math.min(sx, sx + sw)), Math.round(Math.abs(sw)), W, flipX, combine);
	const rows = axisSamples(Math.round(Math.min(sy, sy + sh)), Math.round(Math.abs(sh)), H, flipY, combine);
	const data = new Uint8ClampedArray(W * H * 4);
	const s = src.data;
	const read = (x: number, y: number): number => {
		if (x < 0 || y < 0 || x >= src.width || y >= src.height) {
			return 0;
		}
		const i = (y * src.width + x) * 4;
		return (s[i] << 16) | (s[i + 1] << 8) | s[i + 2];
	};
	for (let y = 0; y < H; y++) {
		const ys = rows[y] ?? [];
		for (let x = 0; x < W; x++) {
			const xs = cols[x] ?? [];
			let v = mode === BLACKONWHITE ? 0xffffff : 0;
			let first = true;
			for (const yy of ys) {
				for (const xx of xs) {
					const p = read(xx, yy);
					if (mode === BLACKONWHITE) {
						v &= p;
					} else if (mode === WHITEONBLACK) {
						v |= p;
					} else if (first) {
						v = p;
					}
					first = false;
				}
			}
			const o = (y * W + x) * 4;
			data[o] = (v >> 16) & 0xff;
			data[o + 1] = (v >> 8) & 0xff;
			data[o + 2] = v & 0xff;
			data[o + 3] = 255;
		}
	}
	return { width: W, height: H, data };
}

/** Fixed-point unit of the HALFTONE reduction weights (16.16). */
const FIX = 65536;

/**
 * HALFTONE source pixel for destination pixel `i` on an enlarging axis:
 * the pixel under the destination pixel's centre, `floor((i + 0.5) *
 * srcLen / dstLen)`, with an exact tie going to the lower index (a 64 ->
 * 88 enlargement maps pixel 5 to 3, not 4).
 */
export function halftoneNearest(i: number, srcLen: number, dstLen: number): number {
	const num = (2 * i + 1) * srcLen;
	const den = 2 * dstLen;
	let k = Math.floor(num / den);
	if (k * den === num) {
		k--;
	}
	return Math.max(0, Math.min(srcLen - 1, k));
}

/** One destination pixel's source taps along an axis: [source index, weight]. */
export type HalftoneTaps = Array<[number, number]>;

/**
 * HALFTONE source taps along one axis for a source run of `srcLen` pixels
 * from `start` onto `dstLen` destination pixels. `reverse` walks the source
 * backwards (a mirrored blit).
 *
 * Enlarging (or 1:1), each destination pixel takes its
 * {@link halftoneNearest} source pixel. Reducing, destination pixel `i`
 * covers `[i * step, (i + 1) * step)` in 16.16 fixed point, with
 * `step = ceil(srcLen * 65536 / dstLen)`, and takes every source pixel it
 * overlaps, weighted by the overlap. Rounding the step up (not down) is
 * what makes an exact-looking half-and-half pixel of a 16 -> 11 reduction
 * lean to the lower source row, as Windows' does.
 */
export function halftoneAxis(start: number, srcLen: number, dstLen: number, reverse: boolean): HalftoneTaps[] {
	const taps: HalftoneTaps[] = [];
	if (dstLen <= 0 || srcLen <= 0) {
		return taps;
	}
	const at = (k: number): number => start + k;
	if (dstLen >= srcLen) {
		for (let i = 0; i < dstLen; i++) {
			taps.push([[at(halftoneNearest(i, srcLen, dstLen)), 1]]);
		}
		if (reverse) taps.reverse();
		return taps;
	}
	const step = Math.ceil((srcLen * FIX) / dstLen);
	for (let i = 0; i < dstLen; i++) {
		const a = i * step;
		const b = (i + 1) * step;
		const run: HalftoneTaps = [];
		for (let k = Math.floor(a / FIX); k * FIX < b && k < srcLen; k++) {
			const overlap = Math.min(b, (k + 1) * FIX) - Math.max(a, k * FIX);
			if (overlap > 0) {
				run.push([at(k), overlap]);
			}
		}
		taps.push(run);
	}
	if (reverse) taps.reverse();
	return taps;
}

/** Bits of the reduction weights Windows keeps per source sub-pixel (8192 shares). */
const REDUCE_BITS = 13;

/**
 * HALFTONE source taps along one axis of a mixed-axis stretch. Enlarging (or
 * 1:1) is {@link halftoneAxis}'s nearest pixel. Reducing, destination pixel
 * `i` covers `src` sub-pixels (each a `1 / dst` of a source pixel) starting
 * at `i * src`, and the footprint is divided into 8192 shares: the cumulative
 * share at sub-pixel `j` of the footprint is `floor(j * 8192 / src)`, and a
 * source pixel's weight is the difference of the cumulative shares at its two
 * edges inside the footprint (a whole-ratio footprint therefore has
 * `floor(8192 / src)` or one more per sub-pixel, the extras falling where the
 * cumulative share steps over an integer). The weights are returned scaled by 8
 * to 16.16, so they sum to exactly 65536. The stretch carries these fractions
 * through its sharpening pass, so the split decides which side of an integer
 * boundary an exact result (a 3x reduction, an alternating 0/255 checker) lands
 * on. Reproduced exactly by native impulse and random-data captures of over
 * 100 source/destination size pairs (sources of up to 300 pixels).
 */
export function halftoneReduceTaps(srcLen: number, dstLen: number, reverse: boolean): HalftoneTaps[] {
	if (dstLen >= srcLen) return halftoneAxis(0, srcLen, dstLen, reverse);
	const shares = 2 ** REDUCE_BITS;
	const scale = FIX / shares;
	const taps: HalftoneTaps[] = [];
	for (let i = 0; i < dstLen; i++) {
		// Sub-pixels of 1 / dstLen source pixels: pixel k covers [k * dstLen, (k + 1) * dstLen).
		const from = i * srcLen;
		const to = (i + 1) * srcLen;
		const run: HalftoneTaps = [];
		for (let k = Math.floor(from / dstLen); k * dstLen < to; k++) {
			const lo = Math.max(from, k * dstLen) - from;
			const hi = Math.min(to, (k + 1) * dstLen) - from;
			if (hi <= lo) continue;
			run.push([k, (Math.floor((hi * shares) / srcLen) - Math.floor((lo * shares) / srcLen)) * scale]);
		}
		taps.push(run);
	}
	if (reverse) taps.reverse();
	return taps;
}

/**
 * Enlargement kernel, sampled every 1/96 source pixel from the centre out to
 * one pixel (zero beyond), scaled so the centre is 1000. Left of half a pixel
 * the table holds the values just inside |u| < 0.5 and the box edge is in
 * {@link ENLARGE_HALF}; right of it the values from just outside. The
 * generating formula of the native kernel is not known: these are the values
 * of the one piecewise-linear curve that, with {@link halftoneEnlargeTaps}'s
 * integerisation, reproduces the integer weight rows measured from native
 * captures of about 410 source/destination size pairs (about 98% of the
 * rows it was solved on; about 95% of the rows of sizes held out of the solve).
 * Far from the centre (beyond about 0.9 pixels) and for ratios just above a
 * whole number a few rows are a share or two off.
 */
const ENLARGE_INNER = [
	1000.0000, 992.4700, 984.9399, 977.4099, 969.8798, 962.3498, 954.8198, 947.2897, 939.7597, 932.2296, 924.6996, 917.1695,
	909.6395, 902.1095, 894.5665, 886.8087, 879.0450, 871.2813, 863.4349, 855.5885, 847.7421, 839.8269, 831.9046, 823.9120,
	815.9193, 807.9266, 799.8470, 791.7283, 783.6096, 775.4490, 767.3204, 758.9233, 750.5263, 742.4271, 734.0547, 725.6823,
	717.2320, 708.7675, 700.2393, 691.7111, 683.0734, 674.4357, 665.7105, 656.9854, 648.2603, 639.3747, 630.4873, 621.5157,
	612.5442,
];
const ENLARGE_OUTER = [
	375.1388, 364.2093, 353.2797, 342.4714, 331.7615, 321.1462, 310.6456, 300.2252, 289.9229, 279.7227, 269.6439, 259.6535,
	249.7825, 240.0362, 230.3856, 220.8799, 211.4594, 202.1844, 192.9996, 183.9679, 175.1064, 166.2864, 157.6436, 149.1447,
	140.7609, 132.5474, 124.4802, 116.5636, 108.7780, 101.1602, 93.7098, 86.4419, 79.3251, 72.4091, 65.6853, 59.1472,
	52.8120, 46.6978, 40.8001, 35.1449, 29.7494, 24.6096, 19.7977, 15.2801, 11.1442, 7.3916, 4.1415, 1.4039,
	0.0000,
];
/** Kernel value exactly half a pixel from the centre (the box edge). */
const ENLARGE_HALF = 500.0106;
const ENLARGE_KNOTS = 96;

/** Unnormalised enlargement kernel weight at `u` source pixels from the centre. */
function enlargeKernel(u: number): number {
	if (u >= 1) return 0;
	if (Math.abs(u - 0.5) < 1e-9) return ENLARGE_HALF;
	const table = u < 0.5 ? ENLARGE_INNER : ENLARGE_OUTER;
	const edge = u * ENLARGE_KNOTS - (u < 0.5 ? 0 : ENLARGE_KNOTS / 2);
	const i = Math.min(table.length - 2, Math.floor(edge + 1e-9));
	return table[i] + (table[i + 1] - table[i]) * (edge - i);
}

/**
 * Taps (source index, weight) for each of `dst` pixels when a mixed-axis
 * HALFTONE stretch enlarges an axis of `src` (already sharpened) samples by
 * anything but exactly 2x.
 *
 * Measured against native impulse and random-data responses, Windows first
 * resamples the samples to destination resolution by the area each
 * destination pixel covers of each source pixel, then smooths that row with a
 * symmetric destination-space FIR whose taps are {@link enlargeKernel} sampled
 * at the tap's distance `u = k / ratio` in source pixels (a tap is non-zero
 * for `|u| < 1`) and normalised to sum to 1; indices beyond the row replicate
 * its edge pixels. The weights of a destination pixel are then made integer
 * shares of 8192: the cumulative weight up to source pixel `j` is rounded up
 * and a pixel's weight is the difference of two cumulative shares (the last
 * is 8192), so a row always sums to exactly 8192.
 */
export function halftoneEnlargeTaps(src: number, dst: number): HalftoneTaps[] {
	const ratio = dst / src;
	const reach = Math.ceil(ratio) - 1;
	const fir: number[] = [];
	let total = 0;
	for (let k = 0; k <= reach; k++) {
		const w = enlargeKernel(k / ratio);
		fir.push(w);
		total += k === 0 ? w : 2 * w;
	}
	// The source pixels (and their share) under every destination pixel.
	const cover: HalftoneTaps[] = [];
	for (let x = 0; x < dst; x++) {
		const lo = x / ratio;
		const hi = (x + 1) / ratio;
		const run: HalftoneTaps = [];
		for (let j = Math.max(0, Math.floor(lo)); j < Math.min(src, hi); j++) {
			const overlap = Math.min(hi, j + 1) - Math.max(lo, j);
			if (overlap > 0) run.push([j, overlap * ratio]);
		}
		cover.push(run);
	}
	const taps: HalftoneTaps[] = [];
	for (let x = 0; x < dst; x++) {
		const weights = new Map<number, number>();
		for (let k = -reach; k <= reach; k++) {
			const w = fir[Math.abs(k)] / total;
			if (w === 0) continue;
			for (const [j, v] of cover[Math.max(0, Math.min(dst - 1, x + k))]) {
				weights.set(j, (weights.get(j) ?? 0) + w * v);
			}
		}
		const sorted = [...weights.entries()].sort((a, b) => a[0] - b[0]);
		let prev = 0;
		let cum = 0;
		const row: HalftoneTaps = [];
		for (let i = 0; i < sorted.length; i++) {
			cum += sorted[i][1] * 8192;
			const c = i === sorted.length - 1 ? 8192 : Math.ceil(cum - 1e-7);
			row.push([sorted[i][0], (c - prev) / 8192]);
			prev = c;
		}
		taps.push(row);
	}
	return taps;
}

/**
 * Quantises RGB triples to the 32-level halftone palette with the ordered
 * dither of {@link HalftoneDither}. `flipX` / `flipY` reverse the pattern's
 * direction along that axis (the rows of a vertically mirrored source).
 */
function ditherPixels(
	px: Int32Array | Float64Array,
	w: number,
	h: number,
	dither: HalftoneDither,
	flipX: boolean,
	flipY: boolean,
	phaseX?: ArrayLike<number>,
	phaseY?: ArrayLike<number>,
): void {
	for (let y = 0; y < h; y++) {
		const yy = phaseY ? phaseY[y] : flipY ? h - 1 - y : y;
		for (let x = 0; x < w; x++) {
			const xx = phaseX ? phaseX[x] : flipX ? w - 1 - x : x;
			const threshold = ditherThreshold(dither.startX, dither.startY, xx, yy);
			const o = (y * w + x) * 3;
			px[o] = ditherQuantize(px[o], threshold);
			px[o + 1] = ditherQuantize(px[o + 1], threshold);
			px[o + 2] = ditherQuantize(px[o + 2], threshold);
		}
	}
}

/**
 * The smoothing Windows' halftone engine applies to the source before an
 * enlargement. It looks for exact two-by-two checkers: a block whose
 * diagonal pixels are equal (`a == d`, `b == c`) while the two diagonals
 * differ, compared as whole RGB pixels. Windows treats the image as mirrored
 * across its edges, so a block on the border has a mirrored neighbour.
 * Blocks are visited in raster order of their top-left pixel, and every
 * source pixel is read from the unmodified image; only the pixel being
 * changed carries over earlier results.
 *
 * - A checker block with another checker block on both sides along a row or
 *   along a column (the middle of three) is flattened: its four pixels all
 *   become the rounded mean `(a + b + 1) >> 1` of the two colours, per
 *   channel. A one-pixel checkerboard therefore becomes flat `#808080`.
 * - Any other checker block pulls the pixels of its brighter diagonal pair
 *   toward their surroundings: the top-left / bottom-right pair, unless the
 *   other pair is strictly brighter, where brightness is `4R + 8G + B`
 *   (compared channel by channel, the same pair is used for all three
 *   channels). Each pixel `p` of that pair moves, per channel, to
 *   `(12p + t1 + t2 + t3 + t4 + 8) >> 4`. Looking from `p` towards its
 *   partner in the pair, `t1` and `t2` are the horizontal and vertical
 *   neighbours inside the block (the other pair's pixels) and `t3`, `t4` the
 *   pixels one step further along that row and column (mirrored at the
 *   image edge). A pixel in several blocks is updated once for each, in turn.
 *
 * This reproduces native captures of every 4x4 black/white pattern at
 * 4x4 and in the middle of a larger image, every pattern up to 5x3, and
 * random black/white, grey and palette-coloured images of up to 40 pixels
 * a side. `px` is RGB triples, `w` x `h`, changed in place.
 */
export function halftoneDespeckle(px: Int32Array, w: number, h: number): void {
	if (w < 2 || h < 2) {
		return;
	}
	const src = px.slice();
	// The index of the pixel at (x, y), the image mirrored across its edges.
	const index = (x: number, y: number): number => {
		const mx = x < 0 ? -x : x >= w ? 2 * (w - 1) - x : x;
		const my = y < 0 ? -y : y >= h ? 2 * (h - 1) - y : y;
		return (Math.max(0, Math.min(h - 1, my)) * w + Math.max(0, Math.min(w - 1, mx))) * 3;
	};
	const same = (i: number, j: number): boolean =>
		src[i] === src[j] && src[i + 1] === src[j + 1] && src[i + 2] === src[j + 2];
	// Checker flags for the blocks whose top-left pixel is (-1..w-1, -1..h-1).
	const stride = w + 1;
	const flags = new Uint8Array(stride * (h + 1));
	for (let y = -1; y < h; y++) {
		for (let x = -1; x < w; x++) {
			const a = index(x, y);
			const b = index(x + 1, y);
			const c = index(x, y + 1);
			const d = index(x + 1, y + 1);
			flags[(y + 1) * stride + x + 1] = same(a, d) && same(b, c) && !same(a, b) ? 1 : 0;
		}
	}
	const checker = (x: number, y: number): boolean => flags[(y + 1) * stride + x + 1] === 1;
	for (let y = 0; y < h - 1; y++) {
		for (let x = 0; x < w - 1; x++) {
			if (!checker(x, y)) {
				continue;
			}
			const ia = index(x, y);
			const ib = index(x + 1, y);
			// The members of the block, each with the direction of its partner pixel.
			const members: [number, number, number, number, boolean][] = [
				[x, y, 1, 1, true],
				[x + 1, y + 1, -1, -1, true],
				[x + 1, y, -1, 1, false],
				[x, y + 1, 1, -1, false],
			];
			if ((checker(x - 1, y) && checker(x + 1, y)) || (checker(x, y - 1) && checker(x, y + 1))) {
				for (const [mx, my] of members) {
					const o = (my * w + mx) * 3;
					for (let c = 0; c < 3; c++) {
						px[o + c] = (src[ia + c] + src[ib + c] + 1) >> 1;
					}
				}
				continue;
			}
			const brighter = 4 * (src[ia] - src[ib]) + 8 * (src[ia + 1] - src[ib + 1]) + (src[ia + 2] - src[ib + 2]);
			for (const [mx, my, sx, sy, isA] of members) {
				if (isA ? brighter < 0 : brighter >= 0) {
					continue;
				}
				const o = (my * w + mx) * 3;
				const t1 = index(mx + sx, my);
				const t2 = index(mx, my + sy);
				const t3 = index(mx + 2 * sx, my);
				const t4 = index(mx, my + 2 * sy);
				for (let c = 0; c < 3; c++) {
					px[o + c] = (12 * px[o + c] + src[t1 + c] + src[t2 + c] + src[t3 + c] + src[t4 + c] + 8) >> 4;
				}
			}
		}
	}
}

/**
 * The sharpening Windows' halftone engine applies after a reduction: each
 * channel becomes `v + floor((4v - l - r - u - d) / 8)` over its four
 * neighbours (an edge pixel standing in for a missing one), clamped to
 * 0..255. `px` is RGB triples, `w` x `h`, changed in place.
 */
export function halftoneSharpen(px: Int32Array, w: number, h: number): void {
	const src = px.slice();
	const at = (x: number, y: number, c: number): number =>
		src[(Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))) * 3 + c];
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			for (let c = 0; c < 3; c++) {
				const v = at(x, y, c);
				const sum = at(x - 1, y, c) + at(x + 1, y, c) + at(x, y - 1, c) + at(x, y + 1, c);
				const out = v + Math.floor((4 * v - sum) / 8);
				px[(y * w + x) * 3 + c] = out < 0 ? 0 : out > 255 ? 255 : out;
			}
		}
	}
}

/**
 * A mixed-axis stretch that squeezes a pair of rows (columns) into one while
 * enlarging the other axis despeckles the pair first: a pixel of a 2 x 2 block
 * whose diagonals are equal colours while the colours differ (a one-pixel
 * checkerboard) becomes the rounded mean of its pair (`(a + b + 1) >> 1`,
 * measured on native captures; Windows' despeckle, which on a pair of rows sees
 * the other row as both neighbours). Nothing else changes. `px` is RGB triples,
 * `w` x `h`, one of them 2; `rows` is true for two rows.
 */
function halftonePairDespeckle(px: Int32Array, w: number, h: number, rows: boolean): void {
	const n = rows ? w : h;
	const at = (k: number, side: number): number => ((rows ? side * w + k : k * w + side) * 3);
	const same = (i: number, j: number): boolean =>
		px[i] === px[j] && px[i + 1] === px[j + 1] && px[i + 2] === px[j + 2];
	const checker = (k: number): boolean => k >= 0 && k + 1 < n && same(at(k, 0), at(k + 1, 1))
		&& same(at(k, 1), at(k + 1, 0)) && !same(at(k, 0), at(k, 1));
	const mean: boolean[] = Array.from({ length: n }, (_, k) => checker(k - 1) || checker(k));
	for (let k = 0; k < n; k++) {
		if (!mean[k]) continue;
		const first = at(k, 0);
		const last = at(k, 1);
		for (let c = 0; c < 3; c++) px[first + c] = px[last + c] = (px[first + c] + px[last + c] + 1) >> 1;
	}
}

/**
 * Where such a pair is squeezed into one while the other axis at least doubles,
 * only the last row (column) of the pair survives (measured on native
 * captures) and is enlarged like any other single-row source. Returns it as RGB
 * triples; `px` is as for {@link halftonePairDespeckle}.
 */
function halftoneKeepLast(px: Int32Array, w: number, h: number, rows: boolean): Int32Array {
	const n = rows ? w : h;
	const out = new Int32Array(n * 3);
	for (let k = 0; k < n; k++) {
		const last = (rows ? w + k : k * w + 1) * 3;
		for (let c = 0; c < 3; c++) out[k * 3 + c] = px[last + c];
	}
	return out;
}

/**
 * HALFTONE reduction of both axes: the rows are reduced first with
 * {@link halftoneReduceTaps} and each result rounded half up to an integer,
 * the columns are then reduced from those and kept unrounded, and the
 * sharpening `floor(v + (4v - l - r - u - d) / 8)` (edge pixels standing in for
 * missing neighbours, clamped to 0..255) works on that unrounded image.
 * Reproduces native random-noise captures of 8 size pairs exactly (5,370
 * channels). `rect` is RGB triples, `sw` x `sh`; returns `dw` x `dh` triples.
 */
function halftoneReduceBoth(rect: Int32Array, sw: number, sh: number, dw: number, dh: number, flipX: boolean, flipY: boolean): Int32Array {
	const cols = halftoneReduceTaps(sw, dw, flipX);
	const rows = halftoneReduceTaps(sh, dh, flipY);
	const wide = new Int32Array(dw * sh * 3);
	for (let y = 0; y < sh; y++) {
		for (let x = 0; x < dw; x++) {
			let total = 0;
			for (const [, w] of cols[x]) total += w;
			for (let c = 0; c < 3; c++) {
				let sum = 0;
				for (const [xx, w] of cols[x]) sum += rect[(y * sw + xx) * 3 + c] * w;
				wide[(y * dw + x) * 3 + c] = Math.floor((2 * sum + total) / (2 * total));
			}
		}
	}
	const avg = new Float64Array(dw * dh * 3);
	for (let y = 0; y < dh; y++) {
		let total = 0;
		for (const [, w] of rows[y]) total += w;
		for (let x = 0; x < dw; x++) {
			for (let c = 0; c < 3; c++) {
				let sum = 0;
				for (const [yy, w] of rows[y]) sum += wide[(yy * dw + x) * 3 + c] * w;
				avg[(y * dw + x) * 3 + c] = sum / total;
			}
		}
	}
	const at = (x: number, y: number, c: number): number =>
		avg[(Math.max(0, Math.min(dh - 1, y)) * dw + Math.max(0, Math.min(dw - 1, x))) * 3 + c];
	const out = new Int32Array(dw * dh * 3);
	for (let y = 0; y < dh; y++) {
		for (let x = 0; x < dw; x++) {
			for (let c = 0; c < 3; c++) {
				const v = at(x, y, c);
				const sum = at(x - 1, y, c) + at(x + 1, y, c) + at(x, y - 1, c) + at(x, y + 1, c);
				out[(y * dw + x) * 3 + c] = Math.max(0, Math.min(255, Math.floor(v + (4 * v - sum) / 8)));
			}
		}
	}
	return out;
}

/**
 * Interpolation weights of the filtered enlargement by a whole factor of 2 to 5
 * (one row per destination phase: the weights of the source samples before,
 * at and after the destination pixel's source pixel, then their sum). Recovered
 * from native impulse and random-profile responses (every phase of every factor
 * reproduces thousands of samples exactly with a single rounding half up of
 * `sum(w * s) / sum`); factors above 5 use {@link halftoneEnlargeTaps}.
 */
const FILTER_WEIGHTS: Record<number, number[][]> = {
	2: [[4, 12, 0, 16], [0, 12, 4, 16]],
	3: [[6, 10, 0, 16], [1, 14, 1, 16], [0, 10, 6, 16]],
	4: [[6, 10, 0, 16], [3, 12, 1, 16], [1, 12, 3, 16], [0, 10, 6, 16]],
	5: [[13, 19, 0, 32], [6, 25, 1, 32], [3, 26, 3, 32], [1, 25, 6, 32], [0, 19, 13, 32]],
};

/**
 * Exact weights (shares of 8192, rows for the source samples before, at and after) of the
 * larger whole factors where {@link halftoneEnlargeTaps} misses a share or two. Each row is
 * the unique integer solution of thousands of native random-profile samples per phase
 * (the cumulative round-up shares the kernel table is integerised with); factors 6 to 8, 12 and 14
 * agree with the table exactly.
 */
const FILTER_TABLE_FACTORS: Record<number, number[][]> = {
	9: [[3627, 4565, 0], [2763, 5387, 42], [1976, 6063, 153], [1271, 6569, 352], [651, 6891, 650], [353, 6569, 1270], [154, 6063, 1975], [43, 5387, 2762], [0, 4566, 3626]],
	10: [[3675, 4517, 0], [2891, 5269, 32], [2170, 5903, 119], [1515, 6405, 272], [926, 6763, 503], [504, 6763, 925], [273, 6405, 1514], [120, 5903, 2169], [33, 5269, 2890], [0, 4518, 3674]],
	11: [[3712, 4480, 0], [2994, 5173, 25], [2327, 5771, 94], [1713, 6262, 217], [1154, 6637, 401], [654, 6885, 653], [402, 6637, 1153], [218, 6262, 1712], [95, 5771, 2326], [26, 5173, 2993], [0, 4481, 3711]],
	13: [[3771, 4421, 0], [3156, 5019, 17], [2578, 5551, 63], [2038, 6009, 145], [1536, 6388, 268], [1075, 6681, 436], [655, 6883, 654], [437, 6681, 1074], [269, 6388, 1535], [146, 6009, 2037], [64, 5551, 2577], [18, 5019, 3155], [0, 4422, 3770]],
	15: [[3815, 4377, 0], [3278, 4902, 12], [2768, 5380, 44], [2286, 5804, 102], [1834, 6169, 189], [1410, 6474, 308], [1017, 6712, 463], [655, 6881, 656], [464, 6712, 1016], [309, 6474, 1409], [190, 6169, 1833], [103, 5804, 2285], [45, 5380, 2767], [13, 4902, 3277], [0, 4378, 3814]],
	16: [[3832, 4360, 0], [3328, 4854, 10], [2847, 5307, 38], [2391, 5714, 87], [1960, 6070, 162], [1555, 6373, 264], [1176, 6620, 396], [825, 6807, 560], [561, 6807, 824], [397, 6620, 1175], [265, 6373, 1554], [163, 6070, 1959], [88, 5714, 2390], [39, 5307, 2846], [11, 4854, 3327], [0, 4361, 3831]],
};

/**
 * Taps (source index, integer share of 8192) of an enlarged axis in the larger-ratio engine:
 * an exact 2x keeps the 3:1 linear weights, the whole factors of {@link FILTER_TABLE_FACTORS} their
 * measured shares, anything else {@link halftoneEnlargeTaps}.
 */
function filterAxisTaps(src: number, dst: number): Array<Array<[number, number]>> {
	const factor = dst / src;
	const rows = factor === 2 ? FILTER_WEIGHTS[2].map(([a, b, c]) => [a * 512, b * 512, c * 512]) : FILTER_TABLE_FACTORS[factor];
	if (!rows) return halftoneEnlargeTaps(src, dst).map(row => row.map(([j, v]): [number, number] => [j, Math.round(v * 8192)]));
	return Array.from({ length: dst }, (_, i): Array<[number, number]> => {
		const k = Math.floor(i / factor);
		const [a, b, c] = rows[i % factor];
		return [[Math.max(0, k - 1), a], [k, b], [Math.min(src - 1, k + 1), c]];
	});
}

/**
 * Enlarging one axis while the other keeps its size: only the enlarged axis is sharpened (with
 * `v + floor((2v - l - r) / 4)`, clamped, its edge pixels standing in for missing neighbours) and
 * interpolated with {@link filterAxisTaps}, one rounding half up. Exact on native captures for
 * 2x, 3x, 5x, 7x, 10x and fractional ratios such as 1.5x and 2.5x; the table misses a share for
 * ratios just above 1 and 2.
 */
function halftoneFilterOneAxis(rgb: Int32Array, w: number, h: number, W: number, H: number): Int32Array {
	const horizontal = W > w;
	const n = horizontal ? w : h;
	const sharp = new Int32Array(rgb.length);
	const at = (x: number, y: number, c: number): number =>
		rgb[(Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))) * 3 + c];
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			for (let c = 0; c < 3; c++) {
				const v = at(x, y, c);
				const sum = horizontal ? at(x - 1, y, c) + at(x + 1, y, c) : at(x, y - 1, c) + at(x, y + 1, c);
				const out = v + Math.floor((2 * v - sum) / 4);
				sharp[(y * w + x) * 3 + c] = out < 0 ? 0 : out > 255 ? 255 : out;
			}
		}
	}
	const taps = filterAxisTaps(n, horizontal ? W : H);
	const out = new Int32Array(W * H * 3);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			for (let c = 0; c < 3; c++) {
				let sum = 0;
				if (horizontal) for (const [j, weight] of taps[x]) sum += weight * sharp[(y * w + j) * 3 + c];
				else for (const [j, weight] of taps[y]) sum += weight * sharp[(j * w + x) * 3 + c];
				out[(y * W + x) * 3 + c] = Math.floor((sum + 4096) / 8192);
			}
		}
	}
	return out;
}

/** Whether {@link halftoneFilterEnlarge} reproduces an enlargement from `w` x `h` to `W` x `H`. */
export function halftoneFilterSupported(w: number, h: number, W: number, H: number): boolean {
	if (w <= 0 || h <= 0 || W < w || H < h || (W === w && H === h)) return false;
	if (W === w || H === h) return true;
	const whole = (src: number, dst: number): boolean => dst % src === 0 && dst / src <= 5;
	if (whole(w, W) && whole(h, H)) return true;
	return W > 5 * w || H > 5 * h;
}

/**
 * Quantises the source of a filtered enlargement with the ordered dither of a
 * combined colour adjustment (see {@link ditherPixels}). The engine of the
 * whole-factor enlargements up to 5x, which extends the source by a replicated
 * row above, runs its pattern two rows further down than the engine of the
 * larger ratios and of the replicated branch (measured on native captures).
 */
function ditherFilteredSource(rect: Int32Array, SW: number, SH: number, W: number, H: number, dither: HalftoneDither, flipY: boolean): Int32Array {
	if (W > 5 * SW || H > 5 * SH) {
		// One further row below the source is dithered as well: the last row is sharpened against it.
		const further = new Int32Array((SH + 1) * SW * 3);
		further.set(rect);
		further.set(rect.subarray((SH - 1) * SW * 3), SH * SW * 3);
		ditherPixels(further, SW, SH + 1, dither, false, false, undefined,
			Int32Array.from({ length: SH + 1 }, (_, j) => (flipY ? H - 1 - j : j)));
		return further;
	}
	// The extension rows are the first and last row replicated, dithered like any other row.
	const extended = new Int32Array((SH + 2) * SW * 3);
	extended.set(rect.subarray(0, SW * 3), 0);
	extended.set(rect, SW * 3);
	extended.set(rect.subarray((SH - 1) * SW * 3), (SH + 1) * SW * 3);
	ditherPixels(extended, SW, SH + 2, { startX: dither.startX, startY: (dither.startY + (flipY ? 63 : 2)) % 65 }, false, false, undefined,
		Int32Array.from({ length: SH + 2 }, (_, e) => (flipY ? H - e : e - 1)));
	return extended;
}

/**
 * The filtered branch of a HALFTONE enlargement of both axes (what
 * {@link halftoneBranch} selects for sources with enough colours). The source
 * is sharpened ({@link halftoneSharpen}'s kernel), then each axis interpolates
 * the sharpened samples. Two engines were separated by native captures:
 *
 * - Both axes enlarged by whole factors of 2 to 5: vertical first, a rounded
 *   (half up) 8-bit intermediate, then horizontal; the weights are
 *   {@link FILTER_WEIGHTS}. Vertically the source is extended by a replicated
 *   row above and below *before* sharpening, so the outer destination rows
 *   interpolate between the sharpened edge row and that extension row
 *   sharpened against replicated neighbours; horizontally the edge column is
 *   simply replicated after sharpening.
 * - Either axis enlarged by more than 5x (also by a fraction): horizontal
 *   first, the sharpened source clamped at its edges with no extension row, the
 *   weights {@link halftoneEnlargeTaps} (13-bit shares of the older kernel
 *   table, except an exact 2x axis, which stays the 3:1 linear weights),
 *   the intermediate rounded half up. Exact for 6x to 8x and 12x; the table
 *   misses a few weights by a share for factors such as 9x and 10x and for
 *   ratios just above 5.
 *
 * - One axis enlarged while the other keeps its size: {@link halftoneFilterOneAxis}.
 *
 * Fractional ratios up to 5x on both axes (and the mixed enlarge/reduce stretches) are not
 * reproduced: their weights are dyadic like the whole factors' but follow a position rule not yet
 * found, so {@link halftoneFilterSupported} is false for them.
 *
 * Callers check {@link halftoneFilterSupported} first. Pixel-exact for every
 * native capture that took the filtered branch (`halftone-boundary`,
 * `halftone-selection`, `halftone-arrangement`, `halftone-filtered`).
 *
 * @param rgb RGB triples, `w` x `h`; unchanged.
 * @param extended For the whole-factor engine only: the source with its extension rows already
 *   present (`h + 2` rows, the first and last being the rows above and below), used instead of
 *   replicating the edge rows (they are dithered on their own under a combined adjustment).
 * @returns RGB triples, `W` x `H`.
 */
export function halftoneFilterEnlarge(rgb: Int32Array, w: number, h: number, W: number, H: number, extended?: Int32Array): Int32Array {
	if (W === w || H === h) return halftoneFilterOneAxis(rgb, w, h, W, H);
	const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);
	const general = W > 5 * w || H > 5 * h;
	const out = new Int32Array(W * H * 3);
	if (general) {
		const sharp = rgb.slice();
		if (extended) {
			// One further row below (the last source row replicated and dithered at the next pattern row).
			const at = (x: number, y: number, c: number): number =>
				extended[(Math.max(0, Math.min(h, y)) * w + Math.max(0, Math.min(w - 1, x))) * 3 + c];
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < w; x++) {
					for (let c = 0; c < 3; c++) {
						const v = at(x, y, c);
						const sum = at(x - 1, y, c) + at(x + 1, y, c) + at(x, y - 1, c) + at(x, y + 1, c);
						sharp[(y * w + x) * 3 + c] = clamp(v + Math.floor((4 * v - sum) / 8));
					}
				}
			}
		} else {
			halftoneSharpen(sharp, w, h);
		}
		const xt = filterAxisTaps(w, W);
		const yt = filterAxisTaps(h, H);
		const middle = new Int32Array(W * h * 3);
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < W; x++) {
				for (let c = 0; c < 3; c++) {
					let sum = 0;
					for (const [j, weight] of xt[x]) sum += weight * sharp[(y * w + j) * 3 + c];
					middle[(y * W + x) * 3 + c] = Math.floor((sum + 4096) / 8192);
				}
			}
		}
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				for (let c = 0; c < 3; c++) {
					let sum = 0;
					for (const [j, weight] of yt[y]) sum += weight * middle[(j * W + x) * 3 + c];
					out[(y * W + x) * 3 + c] = clamp(Math.floor((sum + 4096) / 8192));
				}
			}
		}
		return out;
	}
	const rows = h + 2;
	const sharp = new Int32Array(w * rows * 3);
	let padded = extended;
	if (!padded) {
		padded = new Int32Array(w * rows * 3);
		padded.set(rgb.subarray(0, w * 3), 0);
		padded.set(rgb, w * 3);
		padded.set(rgb.subarray((h - 1) * w * 3), (h + 1) * w * 3);
	}
	const source = padded;
	// Past the extension rows the neighbour is the row on the other side (a mirrored edge; identical
	// to repeating the extension row unless the extension rows were dithered separately).
	const at = (x: number, y: number, c: number): number =>
		source[((y < 0 ? 1 : y > rows - 1 ? rows - 2 : y) * w + Math.max(0, Math.min(w - 1, x))) * 3 + c];
	for (let y = 0; y < rows; y++) {
		for (let x = 0; x < w; x++) {
			for (let c = 0; c < 3; c++) {
				const v = at(x, y, c);
				const sum = at(x - 1, y, c) + at(x + 1, y, c) + at(x, y - 1, c) + at(x, y + 1, c);
				sharp[(y * w + x) * 3 + c] = clamp(v + Math.floor((4 * v - sum) / 8));
			}
		}
	}
	const sx = W / w;
	const sy = H / h;
	const middle = new Int32Array(w * 3);
	for (let y = 0; y < H; y++) {
		const near = Math.floor(y / sy) + 1;
		const [a, b, c, total] = FILTER_WEIGHTS[sy][y % sy];
		const before = (near - 1) * w * 3;
		const here = near * w * 3;
		const after = (near + 1) * w * 3;
		for (let i = 0; i < w * 3; i++) {
			middle[i] = Math.floor((a * sharp[before + i] + b * sharp[here + i] + c * sharp[after + i] + total / 2) / total);
		}
		for (let x = 0; x < W; x++) {
			const k = Math.floor(x / sx);
			const [a2, b2, c2, total2] = FILTER_WEIGHTS[sx][x % sx];
			const left = Math.max(0, k - 1);
			const right = Math.min(w - 1, k + 1);
			for (let c3 = 0; c3 < 3; c3++) {
				out[(y * W + x) * 3 + c3] = Math.floor((a2 * middle[left * 3 + c3] + b2 * middle[k * 3 + c3] + c2 * middle[right * 3 + c3] + total2 / 2) / total2);
			}
		}
	}
	return out;
}

/** The exact 2x case of {@link halftoneFilterEnlarge}. */
export function halftoneFilterDouble(rgb: Int32Array, w: number, h: number): Int32Array {
	return halftoneFilterEnlarge(rgb, w, h, w * 2, h * 2);
}

/**
 * HALFTONE stretch, with the same argument conventions as
 * {@link stretchGdi}. Reproduces Windows' halftone engine on 32bpp output
 * (`emfrec-halftone-*` fixtures):
 *
 * - Enlarging both axes (or keeping a size while enlarging the other), the
 *   source is first smoothed where it has exact two-by-two checkers
 *   ({@link halftoneDespeckle}) and then replicated, each destination pixel
 *   taking the source pixel under its centre ({@link halftoneNearest}).
 * - Reducing both axes follows {@link halftoneReduceBoth}: the rows are
 *   reduced with the 13-bit-share weights and rounded half up, the columns
 *   are reduced from those unrounded, and the sharpening
 *   ({@link halftoneSharpen}'s kernel, on the unrounded image) turns `#F0D010`
 *   next to a darker stripe into `#F7DD03`.
 * - Mixed-axis stretching with an enlarged axis and an axis reduced by at least 2x
 *   reduces first, then sharpens each axis separately (the reduced axis first),
 *   clamping/truncating after each pass. Only then does it enlarge: an exact
 *   2x is plain linear interpolation, any other ratio is {@link halftoneEnlargeTaps}
 *   (area resampling plus a destination-space smoothing FIR). Both end in
 *   rounding half up. The reduction carries its 13-bit-share weights
 *   ({@link halftoneReduceTaps}) through the sharpening. Milder reductions pick
 *   the nearest source pixel. Native captures match exactly for most sizes;
 *   a few exact-tie patterns and full colour adjustment retain residual
 *   differences (`halftone-mixed.fixture.test.ts`).
 *
 * Direct StretchDIBits skips the enlargement pre-filter. Isolated gamma/log
 * curves are applied after sampling/sharpening. Pixels outside `src` read as black.
 */
export function stretchHalftone(
	src: Pixels,
	sx: number,
	sy: number,
	sw: number,
	sh: number,
	dw: number,
	dh: number,
	adjust?: (rgb: Int32Array) => void,
	adjustAfterSampling = false,
	directDib = false,
	dither?: HalftoneDither,
	curves?: (rgb: Int32Array) => void,
): Pixels {
	const W = Math.max(0, Math.round(Math.abs(dw)));
	const H = Math.max(0, Math.round(Math.abs(dh)));
	let SW = Math.round(Math.abs(sw));
	let SH = Math.round(Math.abs(sh));
	const x0 = Math.round(Math.min(sx, sx + sw));
	const y0 = Math.round(Math.min(sy, sy + sh));
	const flipX = dw < 0 !== sw < 0;
	const flipY = dh < 0 !== sh < 0;
	const data = new Uint8ClampedArray(W * H * 4);
	if (W === 0 || H === 0 || SW === 0 || SH === 0) {
		return { width: W, height: H, data };
	}
	// The source rectangle as RGB triples (outside `src`: black).
	let rect: Int32Array = new Int32Array(SW * SH * 3);
	for (let y = 0; y < SH; y++) {
		const yy = y0 + y;
		for (let x = 0; x < SW; x++) {
			const xx = x0 + x;
			if (yy < 0 || yy >= src.height || xx < 0 || xx >= src.width) {
				continue;
			}
			const i = (yy * src.width + xx) * 4;
			const o = (y * SW + x) * 3;
			rect[o] = src.data[i];
			rect[o + 1] = src.data[i + 1];
			rect[o + 2] = src.data[i + 2];
		}
	}
	// A pair of rows (columns) squeezed into one while the other axis grows is
	// despeckled first, and keeps only its last row (column) when that axis at
	// least doubles (measured on native captures).
	const pairRows = SH === 2 && H === 1 && W > SW && (!adjust || adjustAfterSampling || !!dither);
	const pairColumns = SW === 2 && W === 1 && H > SH && (!adjust || adjustAfterSampling || !!dither);
	if (pairRows || pairColumns) {
		if (!directDib) halftonePairDespeckle(rect, SW, SH, pairRows);
		if (pairRows && W >= 2 * SW) {
			rect = halftoneKeepLast(rect, SW, SH, true);
			SH = 1;
		} else if (pairColumns && H >= 2 * SH) {
			rect = halftoneKeepLast(rect, SW, SH, false);
			SW = 1;
		}
	}
	const enlarging = W >= SW && H >= SH && (W > SW || H > SH);
	const reducing = W < SW && H < SH;
	const mixed = (W > SW && H < SH) || (W < SW && H > SH);
	const dithered = !!dither && !!adjust && !adjustAfterSampling;
	const nearestMixed = mixed && (!adjust || adjustAfterSampling || dithered)
		&& ((W < SW && W * 2 > SW) || (H < SH && H * 2 > SH));
	// Reduction by at least 2x on one axis and enlargement on the other follows the
	// native reduce, sharpen, enlarge sequence. Milder reductions pick single source
	// pixels instead. Full fitted colour adjustment also retains its previous
	// sampling path.
	const nativeMixed = mixed && (!adjust || adjustAfterSampling || dithered)
		&& ((W > SW && H * 2 <= SH) || (H > SH && W * 2 <= SW));
	// An enlargement of both axes by whole factors up to 5, or by more than 5x on either axis, whose
	// source takes the filtered branch (see halftoneBranch) is sharpened and interpolated instead of
	// replicated (see halftoneFilterEnlarge). A mirrored blit is the mirror image of the unmirrored
	// one; a combined colour adjustment dithers and maps the source first (see emf-gdi-halftone-dither).
	if (enlarging && halftoneFilterSupported(SW, SH, W, H) && (!adjust || adjustAfterSampling || (dithered && W !== SW && H !== SH))
		&& halftoneBranch(rect, SW, SH) === 'filter') {
		let extended: Int32Array | undefined;
		if (dithered) {
			extended = ditherFilteredSource(rect, SW, SH, W, H, dither!, flipY);
			adjust!(extended);
		}
		const filtered = halftoneFilterEnlarge(rect, SW, SH, W, H, extended);
		if (flipX || flipY) {
			const mirror = filtered.slice();
			for (let y = 0; y < H; y++) {
				for (let x = 0; x < W; x++) {
					const from = ((flipY ? H - 1 - y : y) * W + (flipX ? W - 1 - x : x)) * 3;
					filtered.set(mirror.subarray(from, from + 3), (y * W + x) * 3);
				}
			}
		}
		if (adjust && adjustAfterSampling) adjust(filtered);
		if (curves && dithered) curves(filtered);
		for (let i = 0, o = 0; i < W * H; i++, o += 3) {
			data[i * 4] = filtered[o];
			data[i * 4 + 1] = filtered[o + 1];
			data[i * 4 + 2] = filtered[o + 2];
			data[i * 4 + 3] = 255;
		}
		return { width: W, height: H, data };
	}
	if ((enlarging || nearestMixed) && !directDib && !pairRows && !pairColumns) {
		halftoneDespeckle(rect, SW, SH);
	}
	// A combined adjustment quantises the source to 32 levels with an ordered
	// dither first, then maps the quantised colour: at source resolution when
	// enlarging, at output resolution otherwise (see emf-gdi-halftone-dither).
	// A mixed-axis stretch dithers the source when the reduced axis has an even
	// number of source pixels and the enlarged axis grows by a whole factor;
	// otherwise Windows dithers the finished output.
	const reducedEven = W < SW ? SW % 2 === 0 && H % SH === 0 : SH % 2 === 0 && W % SW === 0;
	const ditherAtSource = dithered && ((W >= SW && H >= SH) || (nativeMixed && reducedEven));
	// Enlarging rows while reducing columns, Windows sharpens the last row against a
	// further row that is the last source row replicated and dithered like any other
	// (pattern row SH), not against the last row itself.
	const extendRow = ditherAtSource && nativeMixed && W < SW && H > SH && !flipY;
	if (extendRow) {
		const bigger = new Int32Array((SH + 1) * SW * 3);
		bigger.set(rect);
		bigger.copyWithin(SH * SW * 3, (SH - 1) * SW * 3, SH * SW * 3);
		rect = bigger;
	}
	if (ditherAtSource) {
		// A vertically mirrored blit runs the pattern down the destination rows,
		// shifted by the extra rows the stretch adds (H - SH), so a source row j
		// sits at pattern row H - 1 - j.
		ditherPixels(rect, SW, extendRow ? SH + 1 : SH, dither!, false, false, undefined,
			flipY ? Int32Array.from({ length: SH }, (_, j) => H - 1 - j) : undefined);
	}
	if (adjust && !adjustAfterSampling && (!dithered || ditherAtSource)) {
		adjust(rect);
	}
	const sampleW = nativeMixed ? Math.min(SW, W) : W;
	const sampleH = nativeMixed ? Math.min(SH, H) : H;
	const axis = nativeMixed ? (n: number, d: number, r: boolean) => halftoneReduceTaps(n, d, r)
		: (n: number, d: number, r: boolean) => halftoneAxis(0, n, d, r);
	// An enlarged axis of the native path keeps its source order here; the mirror reverses its weights below.
	const enlargeX = nativeMixed && W > SW;
	const enlargeY = nativeMixed && H > SH;
	const cols = axis(SW, sampleW, flipX && !enlargeX);
	const rows = axis(SH, sampleH, flipY && !enlargeY);
	// Mixed-axis reduction keeps fractions until the first sharpening pass.
	if (nearestMixed) {
		const nearest = (taps: HalftoneTaps[], src: number, dst: number, reverse: boolean) => {
			for (let i = 0; i < dst; i++) {
				const index = reverse ? dst - 1 - i : i;
				// Below 2x reduction, native sampling chooses the last source centre
				// before the footprint's right edge. Mirrors reverse destination taps.
				const k = dst < src ? Math.floor(((index + 1) * 2 * src - dst) / (2 * dst))
					: halftoneNearest(index, src, dst);
				taps[i] = [[Math.max(0, Math.min(src - 1, k)), 1]];
			}
		};
		nearest(cols, SW, W, flipX); nearest(rows, SH, H, flipY);
	} else if (mixed && !nativeMixed) {
		const linear = (taps: HalftoneTaps[], src: number, dst: number, reverse: boolean) => {
			if (dst <= src) return;
			for (let i = 0; i < dst; i++) {
				const position = Math.max(0, Math.min(src - 1, (i + 0.5) * src / dst - 0.5));
				const left = Math.floor(position), fraction = position - left;
				const at = (k: number) => reverse ? src - 1 - k : k;
				taps[i] = [[at(left), 1 - fraction], [at(Math.min(src - 1, left + 1)), fraction]];
			}
		};
		linear(cols, SW, W, flipX); linear(rows, SH, H, flipY);
	}
	let out: Int32Array | Float64Array = nativeMixed
		? new Float64Array(sampleW * sampleH * 3)
		: new Int32Array(W * H * 3);
	if (reducing) {
		out = halftoneReduceBoth(rect, SW, SH, W, H, flipX, flipY);
	}
	for (let y = 0; !reducing && y < sampleH; y++) {
		const ys = rows[y];
		for (let x = 0; x < sampleW; x++) {
			const xs = cols[x];
			let r = 0;
			let g = 0;
			let b = 0;
			let total = 0;
			for (const [yy, wy] of ys) {
				for (const [xx, wx] of xs) {
					const w = wx * wy;
					total += w;
					const i = (yy * SW + xx) * 3;
					r += rect[i] * w;
					g += rect[i + 1] * w;
					b += rect[i + 2] * w;
				}
			}
			const o = (y * sampleW + x) * 3;
			const round = (value: number) => nativeMixed ? value / total
				: mixed ? Math.ceil(value / total - 0.5) : Math.floor((2 * value + total) / (2 * total));
			out[o] = round(r);
			out[o + 1] = round(g);
			out[o + 2] = round(b);
		}
	}
	if (nativeMixed) {
		const reduceHorizontal = W < SW;
		// The extension row reduced like the others (see `extendRow`); sharpened along x below.
		let extension: Float64Array | Int32Array | undefined;
		if (extendRow) {
			const reduced = new Float64Array(sampleW * 3);
			for (let x = 0; x < sampleW; x++) {
				let total = 0;
				const sums = [0, 0, 0];
				for (const [xx, wx] of cols[x]) {
					total += wx;
					for (let c = 0; c < 3; c++) sums[c] += rect[(SH * SW + xx) * 3 + c] * wx;
				}
				for (let c = 0; c < 3; c++) reduced[x * 3 + c] = sums[c] / total;
			}
			extension = reduced;
		}
		for (const horizontal of [reduceHorizontal, !reduceHorizontal]) {
			const source = out;
			out = new Int32Array(source.length);
			const ext = extension;
			const at = (x: number, y: number, c: number) =>
				y >= sampleH && ext
					? ext[Math.max(0, Math.min(sampleW - 1, x)) * 3 + c]
					: source[(Math.max(0, Math.min(sampleH - 1, y)) * sampleW + Math.max(0, Math.min(sampleW - 1, x))) * 3 + c];
			if (horizontal && ext) {
				const next = new Int32Array(sampleW * 3);
				for (let x = 0; x < sampleW; x++) {
					for (let c = 0; c < 3; c++) {
						const v = ext[x * 3 + c];
						const sum = at(x - 1, sampleH, c) + at(x + 1, sampleH, c);
						next[x * 3 + c] = Math.max(0, Math.min(255, Math.floor(v + (2 * v - sum) / 4)));
					}
				}
				extension = next;
			}
			for (let y = 0; y < sampleH; y++) {
				for (let x = 0; x < sampleW; x++) {
					for (let c = 0; c < 3; c++) {
						const v = at(x, y, c);
						const sum = horizontal ? at(x - 1, y, c) + at(x + 1, y, c) : at(x, y - 1, c) + at(x, y + 1, c);
						out[(y * sampleW + x) * 3 + c] = Math.max(0, Math.min(255, Math.floor(v + (2 * v - sum) / 4)));
					}
				}
			}
		}
		const source = out;
		out = new Int32Array(W * H * 3);
			const axisTaps = (src: number, dst: number): HalftoneTaps[] => {
				if (src === dst) return Array.from({ length: dst }, (_, i): HalftoneTaps => [[i, 1]]);
				// An exact 2x enlargement is plain linear interpolation.
				if (dst === 2 * src) {
					return Array.from({ length: dst }, (_, i): HalftoneTaps => {
						const pos = Math.max(0, Math.min(src - 1, (i + 0.5) * src / dst - 0.5));
						const i0 = Math.floor(pos);
						return [[i0, 1 - (pos - i0)], [Math.min(src - 1, i0 + 1), pos - i0]];
					});
				}
				return halftoneEnlargeTaps(src, dst);
			};
		const xt = axisTaps(sampleW, W), yt = axisTaps(sampleH, H);
		if (enlargeX && flipX) xt.reverse();
		if (enlargeY && flipY) yt.reverse();
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				for (let c = 0; c < 3; c++) {
					let v = 0;
					for (const [yy, wy] of yt[y]) for (const [xx, wx] of xt[x]) v += source[(yy * sampleW + xx) * 3 + c] * wy * wx;
					out[(y * W + x) * 3 + c] = Math.max(0, Math.min(255, Math.floor(v + 0.5 + 1e-7)));
				}
			}
		}
	}
	if (mixed && !nativeMixed && !nearestMixed) {
		const source = out.slice();
		const at = (x: number, y: number, c: number) =>
			source[(Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, x))) * 3 + c];
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				for (let c = 0; c < 3; c++) {
					const v = at(x, y, c);
					const sum = W < SW ? at(x - 1, y, c) + at(x + 1, y, c) : at(x, y - 1, c) + at(x, y + 1, c);
					out[(y * W + x) * 3 + c] = Math.max(0, Math.min(255, v + Math.floor((2 * v - sum) / 4)));
				}
			}
		}
	}
	if (dithered && !ditherAtSource) {
		// A mixed-axis stretch below 2x reduction picks single source pixels; the
		// dither pattern then follows the source pixel on the enlarged axis (and
		// on a reduced x axis), the destination pixel otherwise.
		const phase = (n: number, src: number, dst: number, selectSource: boolean): Int32Array =>
			Int32Array.from({ length: n }, (_, i) => dst > src
				? Math.max(0, Math.ceil(((2 * i + 1) * src) / (2 * dst)) - 1)
				: selectSource ? Math.max(0, Math.min(src - 1, Math.floor(((i + 1) * 2 * src - dst) / (2 * dst)))) : i);
		// Mirrored: the pattern follows the flipped source pixels along x, and
		// runs on down the destination rows along y, shifted by the rows the
		// enlargement adds. Destination-pixel phases do not change.
		const sourcePhase = nearestMixed && W * H > SW * SH;
		let phaseX = sourcePhase ? phase(W, SW, W, true) : undefined;
		let phaseY = sourcePhase ? phase(H, SH, H, false) : undefined;
		if (phaseX && flipX) phaseX = phaseX.slice().reverse();
		if (phaseY && flipY && H > SH) phaseY = phaseY.slice().reverse().map(v => H - 1 - v);
		ditherPixels(out as Int32Array, W, H, dither!, false, false, phaseX, phaseY);
		adjust!(out as Int32Array);
	}
	if (adjust && adjustAfterSampling) adjust(out as Int32Array);
	if (curves && dithered) curves(out as Int32Array);
	for (let i = 0, o = 0; i < W * H; i++, o += 3) {
		data[i * 4] = out[o];
		data[i * 4 + 1] = out[o + 1];
		data[i * 4 + 2] = out[o + 2];
		data[i * 4 + 3] = 255;
	}
	return { width: W, height: H, data };
}
