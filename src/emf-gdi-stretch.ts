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
 * Smooth part of the enlargement kernel, sampled every 0.05 source pixels
 * from the centre outwards (zero beyond 1 pixel). Measured: fitted jointly to
 * native linear responses for 44 enlargement ratios.
 */
const ENLARGE_KERNEL = [
	0.7598, 0.7276, 0.6829, 0.6528, 0.6106, 0.5745, 0.5362, 0.4955, 0.4570, 0.4121, 0.3762,
	0.3233, 0.2741, 0.2260, 0.1822, 0.1412, 0.1021, 0.0685, 0.0382, 0.0138, 0,
];
/** Height of the unit box (|u| < 0.5) added to {@link ENLARGE_KERNEL}. */
const ENLARGE_BOX = 0.2429;
const ENLARGE_STEP = 0.05;

/** Unnormalised enlargement kernel weight at `u` source pixels from the centre. */
function enlargeKernel(u: number): number {
	const edge = u / ENLARGE_STEP;
	const i = Math.floor(edge);
	const smooth = i >= ENLARGE_KERNEL.length - 1 ? 0
		: ENLARGE_KERNEL[i] + (ENLARGE_KERNEL[i + 1] - ENLARGE_KERNEL[i]) * (edge - i);
	return smooth + ENLARGE_BOX * (Math.abs(u - 0.5) < 1e-9 ? 0.5 : u < 0.5 ? 1 : 0);
}

/**
 * Taps (source index, weight) for each of `dst` pixels when a mixed-axis
 * HALFTONE stretch enlarges an axis of `src` (already sharpened) samples by
 * anything but exactly 2x.
 *
 * Measured against native impulse and random-data responses, Windows first
 * resamples the samples to destination resolution by the area each
 * destination pixel covers of each source pixel, then smooths that row with a
 * symmetric destination-space FIR. Its taps are {@link enlargeKernel} (roughly
 * 0.25 * box(|u| < 0.5) + 0.75 * triangle(|u| < 1)) sampled at the tap's
 * distance `u = k / ratio` in source pixels and normalised to sum to 1;
 * indices beyond the row replicate its edge pixels. The model reproduces the
 * captured linear responses to within measurement noise for enlargements from
 * 2.1x to 40x.
 */
export function halftoneEnlargeTaps(src: number, dst: number): HalftoneTaps[] {
	const ratio = dst / src;
	const reach = Math.ceil((ENLARGE_KERNEL.length - 1) * ENLARGE_STEP * ratio);
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
		taps.push([...weights.entries()]);
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
 * HALFTONE stretch, with the same argument conventions as
 * {@link stretchGdi}. Reproduces Windows' halftone engine on 32bpp output
 * (`emfrec-halftone-*` fixtures):
 *
 * - Enlarging both axes (or keeping a size while enlarging the other), the
 *   source is first smoothed where it has exact two-by-two checkers
 *   ({@link halftoneDespeckle}) and then replicated, each destination pixel
 *   taking the source pixel under its centre ({@link halftoneNearest}).
 * - Reducing both axes, each destination pixel is the area average of its
 *   footprint in 16.16 fixed point ({@link halftoneAxis}), rounded half
 *   up, and the reduced image is then sharpened ({@link halftoneSharpen}),
 *   which is what turns `#F0D010` next to a darker stripe into `#F7DD03`.
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
	if (ditherAtSource) {
		// A vertically mirrored blit runs the pattern down the destination rows,
		// shifted by the extra rows the stretch adds (H - SH), so a source row j
		// sits at pattern row H - 1 - j.
		ditherPixels(rect, SW, SH, dither!, false, false, undefined,
			flipY ? Int32Array.from({ length: SH }, (_, j) => H - 1 - j) : undefined);
	}
	if (adjust && !adjustAfterSampling && (!dithered || ditherAtSource)) {
		adjust(rect);
	}
	const sampleW = nativeMixed ? Math.min(SW, W) : W;
	const sampleH = nativeMixed ? Math.min(SH, H) : H;
	const axis = nativeMixed ? (n: number, d: number, r: boolean) => halftoneReduceTaps(n, d, r)
		: (n: number, d: number, r: boolean) => halftoneAxis(0, n, d, r);
	const cols = axis(SW, sampleW, flipX);
	const rows = axis(SH, sampleH, flipY);
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
	for (let y = 0; y < sampleH; y++) {
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
	if (reducing) {
		halftoneSharpen(out as Int32Array, W, H);
	}
	if (nativeMixed) {
		const reduceHorizontal = W < SW;
		for (const horizontal of [reduceHorizontal, !reduceHorizontal]) {
			const source = out;
			out = new Int32Array(source.length);
			const at = (x: number, y: number, c: number) =>
				source[(Math.max(0, Math.min(sampleH - 1, y)) * sampleW + Math.max(0, Math.min(sampleW - 1, x))) * 3 + c];
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
