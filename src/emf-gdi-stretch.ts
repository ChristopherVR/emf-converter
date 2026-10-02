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

/**
 * HALFTONE source taps along one axis of a mixed-axis stretch. Enlarging (or
 * 1:1) is {@link halftoneAxis}'s nearest pixel. Reducing, destination pixel
 * `i` covers the exact span `[i * src / dst, (i + 1) * src / dst)` and takes
 * every source pixel it overlaps with a 16.16 weight: the overlap share
 * rounded up, except for the first (lowest source index) tap, which takes
 * whatever remains so the weights sum to exactly 65536. The stretch carries
 * these fractions through its sharpening pass, so the split decides which side
 * of an integer boundary an exact result (a 3x reduction) lands on; measured
 * against native captures the first tap is the one that ends up the lightest.
 * Weights that are exact in 16.16 (a 16 -> 5 reduction) stay exact.
 */
export function halftoneReduceTaps(srcLen: number, dstLen: number, reverse: boolean): HalftoneTaps[] {
	if (dstLen >= srcLen) return halftoneAxis(0, srcLen, dstLen, reverse);
	const taps: HalftoneTaps[] = [];
	for (let i = 0; i < dstLen; i++) {
		// Spans in units of 1 / dstLen source pixels: pixel k covers [k * dstLen, (k + 1) * dstLen).
		const from = i * srcLen;
		const to = (i + 1) * srcLen;
		const run: HalftoneTaps = [];
		let rest = 0;
		for (let k = Math.floor(from / dstLen); k * dstLen < to; k++) {
			const overlap = Math.min(to, (k + 1) * dstLen) - Math.max(from, k * dstLen);
			if (overlap <= 0) continue;
			const w = Math.ceil((overlap * FIX) / srcLen);
			run.push([k, w]);
			if (run.length > 1) rest += w;
		}
		if (run.length > 1) run[0][1] = FIX - rest;
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

/** Largest overshoot (in levels) a sharpened channel may have before it counts as clipped. */
const SPECKLE_OVERSHOOT = 4;

/**
 * The smoothing Windows' halftone engine applies to the source before an
 * enlargement (measured on `emfrec-halftone-checker-*`): a pixel whose
 * 3-tap sharpening `v + (2v - a - b) / 4` overshoots 0..255 by more than
 * {@link SPECKLE_OVERSHOOT} levels in at least two channels both along the
 * row (a, b = left and right neighbours) and along the column (above and
 * below) is replaced by its horizontal blur `(a + 2v + b) / 4`, rounded.
 * Neighbours past the edge of `px` mirror the one on the other side. A
 * one-pixel black/white checkerboard becomes flat `#808080`; the corners of
 * a red/blue checkerboard of 2-pixel squares where red meets blue on both
 * axes become 3/4 red + 1/4 blue, while the blue ones (whose sharpening
 * stays in range) keep their colour; ramps, bands and ordinary edges do not
 * change. `px` is RGB triples, `w` x `h`, changed in place.
 *
 * An odd size leaves an unpaired last column / row. Where such a pixel
 * differs from the one before it, Windows blurs it across the edge instead
 * of along it, so a lone final pixel of a 2-pixel-block pattern gets 3/4 of
 * itself instead of the mirrored half; the despeckled pixel beside an
 * unpaired pixel that was itself left alone blurs with that pixel's smoothed
 * value (native 13/16 mixes, 7/8 beside both a last column and a last row).
 * This reproduces native 2-pixel-block and one-pixel-checker captures of odd
 * sizes; other patterns and a lone corner pixel that natively stays unchanged
 * remain approximate.
 */
export function halftoneDespeckle(px: Int32Array, w: number, h: number): void {
	const src = px.slice();
	const at = (x: number, y: number, c: number): number => src[(y * w + x) * 3 + c];
	const over = (v: number): boolean => v < -SPECKLE_OVERSHOOT * 4 || v > (255 + SPECKLE_OVERSHOOT) * 4;
	// An odd size leaves the last column / row unpaired.
	const loneX = w > 2 && w % 2 === 1 ? w - 1 : -1;
	const loneY = h > 2 && h % 2 === 1 ? h - 1 : -1;
	const mirror = (i: number, n: number, d: number): number => {
		const j = i + d;
		return j < 0 || j >= n ? i - d : j;
	};
	const vBlur = (x: number, y: number, c: number): number =>
		(at(x, mirror(y, h, -1), c) + 2 * at(x, y, c) + at(x, mirror(y, h, 1), c) + 2) >> 2;
	const hBlur = (x: number, y: number, c: number): number =>
		(at(mirror(x, w, -1), y, c) + 2 * at(x, y, c) + at(mirror(x, w, 1), y, c) + 2) >> 2;
	// What the neighbours of an unpaired last column / row see: the pixel
	// smoothed across the other axis (the corner repeats itself past the edge).
	const differs = (x0: number, y0: number, x1: number, y1: number): boolean =>
		at(x0, y0, 0) !== at(x1, y1, 0) || at(x0, y0, 1) !== at(x1, y1, 1) || at(x0, y0, 2) !== at(x1, y1, 2);
	// A last-column / last-row pixel is unpaired when it differs from the one before it.
	const loneColumn = (y: number): boolean => loneX > 0 && differs(loneX, y, loneX - 1, y);
	const loneRow = (x: number): boolean => loneY > 0 && differs(x, loneY, x, loneY - 1);
	const loneColumnValue = (y: number, c: number): number =>
		y === loneY && loneRow(loneX) ? (at(loneX, y - 1, c) + 3 * at(loneX, y, c) + 2) >> 2 : vBlur(loneX, y, c);
	const loneRowValue = (x: number, c: number): number =>
		x === loneX && loneColumn(loneY) ? (at(x - 1, loneY, c) + 3 * at(x, loneY, c) + 2) >> 2 : hBlur(x, loneY, c);
	const speckled = (x: number, y: number): boolean => {
		// The unpaired last column / row repeats itself past the edge here.
		const up = mirror(y, h, -1);
		const down = mirror(y, h, 1);
		const left = mirror(x, w, -1);
		const right = mirror(x, w, 1);
		let hClip = 0;
		let vClip = 0;
		let alternating = 0;
		for (let c = 0; c < 3; c++) {
			const v = at(x, y, c);
			const axial = Math.max(Math.abs(v - at(left, y, c)), Math.abs(v - at(right, y, c)),
				Math.abs(v - at(x, up, c)), Math.abs(v - at(x, down, c)));
			const diagonal = Math.min(Math.abs(v - at(left, up, c)), Math.abs(v - at(right, up, c)),
				Math.abs(v - at(left, down, c)), Math.abs(v - at(right, down, c)));
			if (diagonal < axial) alternating++;
			// 4 * (v + (2v - a - b) / 4), kept in integers.
			if (over(6 * v - at(left, y, c) - at(right, y, c))) {
				hClip++;
			}
			if (over(6 * v - at(x, up, c) - at(x, down, c))) {
				vClip++;
			}
		}
		return hClip >= 2 && vClip >= 2 && alternating >= 2;
	};
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			if (!speckled(x, y)) {
				continue;
			}
			const left = mirror(x, w, -1);
			const right = mirror(x, w, 1);
			const up = mirror(y, h, -1);
			const down = mirror(y, h, 1);
			// Beside an unpaired last column / row that is itself left alone,
			// the blur sees that pixel's smoothed value instead of its own.
			const lonelyColumn = x === loneX && loneColumn(y);
			const lonelyRow = y === loneY && loneRow(x);
			const nearLoneX = x === loneX - 1 && loneX > 0 && loneColumn(y) && !speckled(loneX, y);
			const nearLoneY = y === loneY - 1 && loneY > 0 && loneRow(x) && !speckled(x, loneY);
			// The corner repeats itself past the edge when the lone column /
			// row beside it was left alone, else it mirrors.
			const cornerRepeats = lonelyColumn && lonelyRow && (!speckled(x, y - 1) || !speckled(x - 1, y));
			for (let c = 0; c < 3; c++) {
				const v = at(x, y, c);
				let r: number;
				if (lonelyColumn && lonelyRow) {
					r = cornerRepeats ? (at(left, y, c) + 3 * v + 2) >> 2 : hBlur(x, y, c);
				} else {
					// The unpaired column is blurred across, the unpaired row along.
					let sum = lonelyColumn
						? at(x, up, c) + 2 * v + at(x, down, c)
						: at(left, y, c) + 2 * v + at(right, y, c);
					if (nearLoneX) sum += loneColumnValue(y, c) - at(loneX, y, c);
					if (nearLoneY) sum += loneRowValue(x, c) - at(x, loneY, c);
					r = (sum + 2) >> 2;
				}
				px[(y * w + x) * 3 + c] = r;
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
 * HALFTONE stretch, with the same argument conventions as
 * {@link stretchGdi}. Reproduces Windows' halftone engine on 32bpp output
 * (`emfrec-halftone-*` fixtures):
 *
 * - Enlarging both axes (or keeping a size while enlarging the other), the
 *   source is first smoothed where it has isolated overshooting pixels
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
 *   rounding half up. The reduction carries its 16.16 weights
 *   ({@link halftoneReduceTaps}) through the sharpening. Milder reductions pick
 *   the nearest source pixel. Native captures match exactly for most sizes;
 *   exact-tie patterns, single-row destinations and full colour adjustment
 *   retain residual differences (`halftone-mixed.fixture.test.ts`).
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
	const SW = Math.round(Math.abs(sw));
	const SH = Math.round(Math.abs(sh));
	const x0 = Math.round(Math.min(sx, sx + sw));
	const y0 = Math.round(Math.min(sy, sy + sh));
	const flipX = dw < 0 !== sw < 0;
	const flipY = dh < 0 !== sh < 0;
	const data = new Uint8ClampedArray(W * H * 4);
	if (W === 0 || H === 0 || SW === 0 || SH === 0) {
		return { width: W, height: H, data };
	}
	// The source rectangle as RGB triples (outside `src`: black).
	const rect = new Int32Array(SW * SH * 3);
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
	if ((enlarging || nearestMixed) && !directDib) {
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
