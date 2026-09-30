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
	const at = (k: number): number => (reverse ? start + srcLen - 1 - k : start + k);
	if (dstLen >= srcLen) {
		for (let i = 0; i < dstLen; i++) {
			taps.push([[at(halftoneNearest(i, srcLen, dstLen)), 1]]);
		}
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
	return taps;
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
 */
export function halftoneDespeckle(px: Int32Array, w: number, h: number): void {
	const src = px.slice();
	const at = (x: number, y: number, c: number): number => src[(y * w + x) * 3 + c];
	const over = (v: number): boolean => v < -SPECKLE_OVERSHOOT * 4 || v > (255 + SPECKLE_OVERSHOOT) * 4;
	for (let y = 0; y < h; y++) {
		const up = y > 0 ? y - 1 : Math.min(h - 1, y + 1);
		const down = y < h - 1 ? y + 1 : Math.max(0, y - 1);
		for (let x = 0; x < w; x++) {
			const left = x > 0 ? x - 1 : Math.min(w - 1, x + 1);
			const right = x < w - 1 ? x + 1 : Math.max(0, x - 1);
			let hClip = 0;
			let vClip = 0;
			for (let c = 0; c < 3; c++) {
				const v = at(x, y, c);
				// 4 * (v + (2v - a - b) / 4), kept in integers.
				if (over(6 * v - at(left, y, c) - at(right, y, c))) {
					hClip++;
				}
				if (over(6 * v - at(x, up, c) - at(x, down, c))) {
					vClip++;
				}
			}
			if (hClip < 2 || vClip < 2) {
				continue;
			}
			for (let c = 0; c < 3; c++) {
				px[(y * w + x) * 3 + c] = (at(left, y, c) + 2 * at(x, y, c) + at(right, y, c) + 2) >> 2;
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
 * - Mixed-axis stretching uses linear interpolation on the enlarging axis,
 *   area averages on the reducing axis and sharpening along that axis only.
 *   The native ramp/checker captures still retain colour and edge differences;
 *   this branch is approximate (bounds in the parity tests).
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
	if (enlarging && !directDib) {
		halftoneDespeckle(rect, SW, SH);
	}
	if (adjust && !adjustAfterSampling) {
		adjust(rect);
	}
	const cols = halftoneAxis(0, SW, W, flipX);
	const rows = halftoneAxis(0, SH, H, flipY);
	if (mixed) {
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
	const out = new Int32Array(W * H * 3);
	for (let y = 0; y < H; y++) {
		const ys = rows[y];
		for (let x = 0; x < W; x++) {
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
			const o = (y * W + x) * 3;
			// Uniform-axis averages round half up; mixed-axis averages round ties down.
			out[o] = mixed ? Math.ceil(r / total - 0.5) : Math.floor((2 * r + total) / (2 * total));
			out[o + 1] = mixed ? Math.ceil(g / total - 0.5) : Math.floor((2 * g + total) / (2 * total));
			out[o + 2] = mixed ? Math.ceil(b / total - 0.5) : Math.floor((2 * b + total) / (2 * total));
		}
	}
	if (reducing) {
		halftoneSharpen(out, W, H);
	}
	if (mixed) {
		const source = out.slice();
		const at = (x: number, y: number, c: number) =>
			source[(Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, x))) * 3 + c];
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				for (let c = 0; c < 3; c++) {
					const v = at(x, y, c);
					const sum = W < SW
						? at(x - 1, y, c) + at(x + 1, y, c)
						: at(x, y - 1, c) + at(x, y + 1, c);
					out[(y * W + x) * 3 + c] = Math.max(0, Math.min(255, v + Math.floor((2 * v - sum) / 4)));
				}
			}
		}
	}
	if (adjust && adjustAfterSampling) adjust(out);
	for (let i = 0, o = 0; i < W * H; i++, o += 3) {
		data[i * 4] = out[o];
		data[i * 4 + 1] = out[o + 1];
		data[i * 4 + 2] = out[o + 2];
		data[i * 4 + 3] = 255;
	}
	return { width: W, height: H, data };
}
