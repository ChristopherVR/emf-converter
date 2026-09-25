/**
 * GDI+-matching resampling for EMF+ `DrawImage` / `DrawImagePoints`, for
 * every GDI+ `InterpolationMode` and `PixelOffsetMode`.
 *
 * Canvas `drawImage` scales a bitmap with its own filter, sampled at pixel
 * centres, which neither lands texel edges where GDI+ puts them nor uses
 * GDI+'s kernels. Each mode was reverse-engineered from real GDI+ output by
 * measuring its full weight matrix (the response of every destination pixel
 * to an impulse at every source texel, over many scales and destination
 * offsets) and confirmed against the `gpx-image-*` fixtures:
 *
 * - Geometry. Under `PixelOffsetMode` None/HighSpeed/Default, device pixel
 *   (x, y) IS the point (x, y) and source texel (i, j) sits at (i, j);
 *   under Half/HighQuality both grids move by half a pixel (pixel centres).
 *   A device pixel maps back through the image's source-to-device matrix to
 *   a source point, and is painted only when that point lies inside the
 *   source rectangle (half-open). Destination corners are first snapped to
 *   GDI+'s 1/16-pixel fixed-point grid.
 * - NearestNeighbor: the texel nearest the source point (halves round up).
 * - Bilinear (also Default and LowQuality): the 2x2 tent, point-sampled at
 *   every scale (no prefilter, so a strong reduction aliases, as in GDI+).
 * - Bicubic: the 4x4 cubic convolution kernel with `a = -0.5`
 *   (Catmull-Rom), point-sampled at every scale.
 * - HighQualityBilinear / HighQualityBicubic (and HighQuality): the source
 *   is treated as area texels (each a unit box), filtered by the tent or by
 *   the cubic kernel with `a = -1`, stretched by `1 / scale` when reducing
 *   (so a reduction is prefiltered over the whole footprint). A weight is
 *   therefore the kernel's integral over the texel's box. At exactly 1:1 on
 *   an integer offset GDI+ copies texels unfiltered. GDI+'s high-quality path
 *   also applies the fractional part of an axis-aligned destination origin
 *   mirrored: an origin at `n + f` samples as if placed at `n + 1 - f`
 *   (confirmed at scales from 0.32 to 1.5 and offsets 0.1 to 2.3).
 *
 * A texel outside the source rectangle counts as transparent (GDI+'s
 * default clamp for `DrawImage`), so the kernel's overhang fades an edge
 * out; with an ImageAttributes WrapMode the overhang reads the bitmap's own
 * neighbouring texels and, beyond the bitmap, wraps (Tile, TileFlip*) or
 * reads the clamp colour (Clamp). Colours are blended premultiplied, and a negative-lobe result is
 * clamped. {@link resampleImage} implements all of this as a pure function
 * over RGBA pixels; callers composite its block at an integer device
 * offset, which every canvas backend copies unfiltered.
 *
 * @module emf-plus-image-resample
 */

import type { DeferredImageResample, ImageResampleKernel, TransformMatrix } from './emf-types';

/** GDI+ InterpolationMode values (MS-EMFPLUS 2.1.1.16). */
const INTERPOLATION_KERNELS: Record<number, ImageResampleKernel> = {
	0: 'bilinear', // Default
	1: 'bilinear', // LowQuality
	2: 'hq-bicubic', // HighQuality
	3: 'bilinear', // Bilinear
	4: 'bicubic', // Bicubic
	5: 'nearest', // NearestNeighbor
	6: 'hq-bilinear', // HighQualityBilinear
	7: 'hq-bicubic', // HighQualityBicubic
};

/** GDI+ PixelOffsetMode values (MS-EMFPLUS 2.1.1.26) that sample at pixel centres. */
const HALF_PIXEL_OFFSET_MODES = new Set([2, 4]); // HighQuality, Half

/** Largest device area (in pixels) one resampled draw may cover. */
const MAX_RESAMPLE_PIXELS = 16 * 1024 * 1024;

/** The resampling kernel for a GDI+ `InterpolationMode` (unknown values resample bilinearly, like Default). */
export function resampleKernelFor(interpolationMode: number): ImageResampleKernel {
	return INTERPOLATION_KERNELS[interpolationMode] ?? 'bilinear';
}

/** True when a GDI+ `PixelOffsetMode` samples at pixel centres rather than integer coordinates. */
export function isHalfPixelOffset(pixelOffsetMode: number): boolean {
	return HALF_PIXEL_OFFSET_MODES.has(pixelOffsetMode);
}

/** Full affine inverse, or `null` for a singular matrix. */
function invert(m: TransformMatrix): TransformMatrix | null {
	const det = m[0] * m[3] - m[1] * m[2];
	if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
		return null;
	}
	const a = m[3] / det;
	const b = -m[1] / det;
	const c = -m[2] / det;
	const d = m[0] / det;
	return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

/**
 * Device-space nudge of the coverage sample point (see the top-left rule in
 * {@link resampleImage}): mostly rightward, so the rule is decided by x for
 * any edge that is not exactly horizontal.
 */
const COVERAGE_NUDGE_X = 1e-6;
const COVERAGE_NUDGE_Y = 1e-9;

/** GDI+ rasterises in 28.4 fixed point: device coordinates snap to 1/16 pixel. */
const SUBPIXEL_GRID = 16;

/**
 * `spec.toDevice` with the destination origin (the device position of the
 * source rectangle's top-left corner) snapped to GDI+'s 1/16-pixel grid, so
 * a destination recorded as 20.0000002 (float noise from the recorder)
 * starts on device row 20, as it does in GDI+, rather than just below it.
 * The scale is left exact: snapping the far corners too put a 64-texel
 * image drawn 25.6 pixels wide half a texel off by its right edge.
 */
function snapToDeviceGrid(spec: DeferredImageResample): TransformMatrix {
	const m = spec.toDevice;
	const map = (u: number, v: number): [number, number] => [
		Math.round((m[0] * u + m[2] * v + m[4]) * SUBPIXEL_GRID) / SUBPIXEL_GRID,
		Math.round((m[1] * u + m[3] * v + m[5]) * SUBPIXEL_GRID) / SUBPIXEL_GRID,
	];
	const [ox, oy] = map(spec.srcX, spec.srcY);
	const [a, b, c, d] = m;
	return [a, b, c, d, ox - a * spec.srcX - c * spec.srcY, oy - b * spec.srcX - d * spec.srcY];
}

/** A block of device pixels produced by {@link resampleImage}. */
export interface ResampledBlock {
	x: number;
	y: number;
	w: number;
	h: number;
	/** Non-premultiplied RGBA, `w * h * 4` bytes. */
	rgba: Uint8ClampedArray;
}

// ---------------------------------------------------------------------------
// Kernels
// ---------------------------------------------------------------------------

/** Cubic convolution kernel with parameter `a` (Keys), support [-2, 2]. */
export function cubicKernel(t: number, a: number): number {
	const x = Math.abs(t);
	if (x < 1) {
		return ((a + 2) * x - (a + 3)) * x * x + 1;
	}
	if (x < 2) {
		return a * (((x - 5) * x + 8) * x - 4);
	}
	return 0;
}

/** Antiderivative (from 0) of the unit tent `max(0, 1 - |t|)`; odd, saturating at +/-1/2. */
function tentIntegral(t: number): number {
	const x = Math.min(1, Math.abs(t));
	return Math.sign(t) * (x - (x * x) / 2);
}

/** Antiderivative (from 0) of {@link cubicKernel} with parameter `a`; odd, saturating at +/-1/2. */
function cubicIntegral(t: number, a: number): number {
	const x = Math.min(2, Math.abs(t));
	let v: number;
	if (x < 1) {
		v = ((a + 2) * x ** 4) / 4 - ((a + 3) * x ** 3) / 3 + x;
	} else {
		const p1 = (a + 2) / 4 - (a + 3) / 3 + 1;
		const p = (y: number): number => a * (y ** 4 / 4 - (5 * y ** 3) / 3 + 4 * y * y - 4 * y);
		v = p1 + p(x) - p(1);
	}
	return Math.sign(t) * v;
}

/** Cubic parameter GDI+ uses for `Bicubic` (point-sampled). */
const BICUBIC_A = -0.5;
/** Cubic parameter GDI+ uses for `HighQualityBicubic` (area-integrated). */
const HQ_BICUBIC_A = -1;

/**
 * One axis of a resampling filter: which texels a source coordinate `c`
 * (texel-centre space, texel i centred at i) draws from, and with what
 * weight. Pure.
 */
interface AxisFilter {
	/** Texels farther than this from `c` have zero weight. */
	radius: number;
	weight(i: number, c: number): number;
}

/**
 * The axis filter of `kernel` for an axis scaled by `scale` (device pixels
 * per source texel along it); `copy` is true on an unscaled axis at an
 * integer offset, which GDI+'s high-quality path copies unfiltered.
 */
export function axisFilter(kernel: ImageResampleKernel, scale: number, copy: boolean): AxisFilter {
	switch (kernel) {
		case 'bilinear':
			return { radius: 1, weight: (i, c) => Math.max(0, 1 - Math.abs(i - c)) };
		case 'bicubic':
			return { radius: 2, weight: (i, c) => cubicKernel(i - c, BICUBIC_A) };
		case 'hq-bilinear':
		case 'hq-bicubic': {
			if (copy) {
				return { radius: 0.5, weight: (i, c) => (Math.floor(c + 0.5) === i ? 1 : 0) };
			}
			const st = Math.min(1, Math.abs(scale));
			const hq = kernel === 'hq-bicubic';
			const support = hq ? 2 : 1;
			const F = hq ? (t: number) => cubicIntegral(t, HQ_BICUBIC_A) : tentIntegral;
			return {
				radius: support / st + 0.5,
				weight: (i, c) => F(st * (i + 0.5 - c)) - F(st * (i - 0.5 - c)),
			};
		}
		default:
			return { radius: 0.5, weight: (i, c) => (Math.floor(c + 0.5) === i ? 1 : 0) };
	}
}

/** Texel index range of the source rectangle (half-open). */
interface TexelBox {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/**
 * Blends the taps `wu` (texels `iu0`..) by `wv` (texels `iv0`..) of an
 * RGBA bitmap, separably in two passes as GDI+ runs it: the taps along the
 * first axis are blended per line and that intermediate premultiplied
 * texel is clamped (alpha to [0, 255], colour to [0, alpha]) before the
 * lines are blended along the second axis, so a negative lobe over a
 * transparent edge clamps per line, not only once at the end. GDI+'s
 * Bicubic runs the vertical pass first, its high-quality kernels the
 * horizontal pass first (each order matches its own fixtures exactly and
 * the other does not). A texel outside `box` is transparent. Returns
 * premultiplied `[r, g, b, a]` on a 0..255 scale, unclamped. Pure.
 */
function blendSeparable(
	rgba: Uint8ClampedArray,
	width: number,
	box: TexelBox,
	iu0: number,
	wu: readonly number[],
	iv0: number,
	wv: readonly number[],
	verticalFirst: boolean,
	edge: EdgeMode = { wrap: undefined, clamp: null },
): [number, number, number, number] {
	const [outer0, outerW, inner0, innerW] = verticalFirst ? [iu0, wu, iv0, wv] : [iv0, wv, iu0, wu];
	const [oMin, oMax, iMin, iMax] = verticalFirst ? [box.x0, box.x1, box.y0, box.y1] : [box.y0, box.y1, box.x0, box.x1];
	let r = 0;
	let g = 0;
	let b = 0;
	let a = 0;
	for (let k = 0; k < outerW.length; k++) {
		const wo = outerW[k];
		const to = outer0 + k;
		if (wo === 0) {
			continue;
		}
		const mo = wrapTap(to, oMin, oMax, verticalFirst ? edge.mirrorX : edge.mirrorY, edge);
		if (mo === OUTSIDE_TRANSPARENT) {
			continue;
		}
		let lr = 0;
		let lg = 0;
		let lb = 0;
		let la = 0;
		for (let q = 0; q < innerW.length; q++) {
			const wi = innerW[q];
			const ti = inner0 + q;
			if (wi === 0) {
				continue;
			}
			const mi = wrapTap(ti, iMin, iMax, verticalFirst ? edge.mirrorY : edge.mirrorX, edge);
			if (mi === OUTSIDE_TRANSPARENT) {
				continue;
			}
			let px: ArrayLike<number>;
			let s = 0;
			if (mi === OUTSIDE_CLAMP || mo === OUTSIDE_CLAMP) {
				px = edge.clamp ?? [0, 0, 0, 0];
			} else {
				px = rgba;
				s = (verticalFirst ? mi * width + mo : mo * width + mi) * 4;
			}
			const alpha = px[s + 3];
			const wa = (wi * alpha) / 255;
			lr += wa * px[s];
			lg += wa * px[s + 1];
			lb += wa * px[s + 2];
			la += wi * alpha;
		}
		la = Math.min(255, Math.max(0, la));
		r += wo * Math.min(la, Math.max(0, lr));
		g += wo * Math.min(la, Math.max(0, lg));
		b += wo * Math.min(la, Math.max(0, lb));
		a += wo * la;
	}
	return [r, g, b, a];
}

/** A tap outside the source rectangle that reads nothing (no ImageAttributes). */
const OUTSIDE_TRANSPARENT = -1;
/** A tap outside the source rectangle that reads the ImageAttributes clamp colour. */
const OUTSIDE_CLAMP = -2;

/** How taps outside the source rectangle read (see {@link DeferredImageResample.wrap}). */
interface EdgeMode {
	wrap: DeferredImageResample['wrap'];
	/** The clamp colour as straight RGBA, under WrapMode Clamp. */
	clamp: number[] | null;
	mirrorX?: boolean;
	mirrorY?: boolean;
}

/**
 * The texel index a tap `t` reads along one axis of the readable range
 * [`lo`, `hi`) (the source rectangle, or the whole bitmap under an
 * ImageAttributes WrapMode): itself inside, else wrapped within the range
 * (repeated, or mirrored texel for texel), or one of the OUTSIDE codes.
 * Pure.
 */
function wrapTap(t: number, lo: number, hi: number, mirror: boolean | undefined, edge: EdgeMode): number {
	if (t >= lo && t < hi) {
		return t;
	}
	if (!edge.wrap) {
		return OUTSIDE_TRANSPARENT;
	}
	if (edge.wrap === 'clamp') {
		return OUTSIDE_CLAMP;
	}
	const n = hi - lo;
	if (!mirror) {
		return lo + (((t - lo) % n) + n) % n;
	}
	const q = (((t - lo) % (2 * n)) + 2 * n) % (2 * n);
	return lo + (q < n ? q : 2 * n - 1 - q);
}

/**
 * GDI+'s high-quality path applies the fractional part of a destination
 * origin mirrored (`n + f` samples as if at `n + 1 - f`, see the module
 * doc). Pure.
 */
export function mirroredOrigin(o: number): number {
	const f = o - Math.floor(o);
	return f === 0 ? o : Math.floor(o) + 1 - f;
}

/**
 * Resamples the `spec.src` rectangle of a `width` x `height` RGBA bitmap
 * onto device pixels, the way GDI+ `DrawImage` does (see the module doc).
 * `surface` bounds the output block. Returns `null` when the mapping is
 * singular, the draw is entirely off the surface, or it is implausibly
 * large. Pure.
 */
export function resampleImage(
	rgba: Uint8ClampedArray,
	width: number,
	height: number,
	spec: DeferredImageResample,
	surface: { w: number; h: number },
): ResampledBlock | null {
	let m = snapToDeviceGrid(spec);
	const kernel = spec.kernel;
	const hq = kernel === 'hq-bilinear' || kernel === 'hq-bicubic';
	const axisAligned = m[1] === 0 && m[2] === 0;
	if (hq && axisAligned) {
		// Mirror the fractional part of the destination origin (the device
		// position of the source rectangle's top-left corner).
		const ox = m[0] * spec.srcX + m[4];
		const oy = m[3] * spec.srcY + m[5];
		m = [m[0], 0, 0, m[3], m[4] + mirroredOrigin(ox) - ox, m[5] + mirroredOrigin(oy) - oy];
	}
	const inv = invert(m);
	if (!inv) {
		return null;
	}
	const sx0 = Math.max(0, Math.floor(spec.srcX));
	const sy0 = Math.max(0, Math.floor(spec.srcY));
	const sx1 = Math.min(width, Math.ceil(spec.srcX + spec.srcW));
	const sy1 = Math.min(height, Math.ceil(spec.srcY + spec.srcH));
	if (sx1 <= sx0 || sy1 <= sy0) {
		return null;
	}
	// Device bounding box of the destination parallelogram.
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const [u, v] of [
		[spec.srcX, spec.srcY],
		[spec.srcX + spec.srcW, spec.srcY],
		[spec.srcX, spec.srcY + spec.srcH],
		[spec.srcX + spec.srcW, spec.srcY + spec.srcH],
	]) {
		const x = m[0] * u + m[2] * v + m[4];
		const y = m[1] * u + m[3] * v + m[5];
		x0 = Math.min(x0, x);
		y0 = Math.min(y0, y);
		x1 = Math.max(x1, x);
		y1 = Math.max(y1, y);
	}
	const bx0 = Math.max(0, Math.floor(x0) - 1);
	const by0 = Math.max(0, Math.floor(y0) - 1);
	const bx1 = Math.min(surface.w, Math.ceil(x1) + 1);
	const by1 = Math.min(surface.h, Math.ceil(y1) + 1);
	const w = bx1 - bx0;
	const h = by1 - by0;
	if (!(w > 0 && h > 0) || w * h > MAX_RESAMPLE_PIXELS) {
		return null;
	}
	// Device pixels per source texel along each source axis.
	const scaleU = Math.hypot(m[0], m[1]);
	const scaleV = Math.hypot(m[2], m[3]);
	const integral = (v: number): boolean => Math.abs(v - Math.round(v)) < 1e-9;
	const copyU = axisAligned && Math.abs(scaleU - 1) < 1e-9 && integral(m[4]);
	const copyV = axisAligned && Math.abs(scaleV - 1) < 1e-9 && integral(m[5]);
	const fu = axisFilter(kernel, scaleU, copyU);
	const fv = axisFilter(kernel, scaleV, copyV);
	const out = new Uint8ClampedArray(w * h * 4);
	// PixelOffsetMode Half/HighQuality: pixel (x, y) is the point
	// (x + 0.5, y + 0.5) and texel (i, j) is centred on (i + 0.5, j + 0.5).
	const o = spec.halfPixelOffset ? 0.5 : 0;
	const uMax = spec.srcX + spec.srcW;
	const vMax = spec.srcY + spec.srcH;
	const wu: number[] = [];
	const wv: number[] = [];
	const c = spec.clampArgb ?? 0;
	const edge: EdgeMode = {
		wrap: spec.wrap,
		clamp: [(c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff, (c >>> 24) & 0xff],
		mirrorX: spec.wrap === 'tile-flip-x' || spec.wrap === 'tile-flip-xy',
		mirrorY: spec.wrap === 'tile-flip-y' || spec.wrap === 'tile-flip-xy',
	};
	for (let j = 0; j < h; j++) {
		const py = by0 + j + o;
		for (let i = 0; i < w; i++) {
			const px = bx0 + i + o;
			const u = inv[0] * px + inv[2] * py + inv[4];
			const v = inv[1] * px + inv[3] * py + inv[5];
			// Coverage by the top-left rule, as GDI+ rasterises the destination
			// parallelogram: the sample is nudged right by a hair (and down by
			// far less), so a pixel exactly on a left or top edge is inside and
			// one exactly on a right or bottom edge is outside, whatever the
			// rotation (and float noise in the inverse cannot tip it).
			const cx = px + COVERAGE_NUDGE_X;
			const cy = py + COVERAGE_NUDGE_Y;
			const eu = inv[0] * cx + inv[2] * cy + inv[4];
			const ev = inv[1] * cx + inv[3] * cy + inv[5];
			if (eu < spec.srcX || ev < spec.srcY || eu >= uMax || ev >= vMax) {
				continue;
			}
			// Texel (i, j) is centred on (i, j) in source coordinates under every
			// PixelOffsetMode: under Half/HighQuality GDI+'s recorder already
			// shifts the source rectangle by -0.5 (it records (0, 0, w, h) as
			// (-0.5, -0.5, w, h)), so only the device sample point moves.
			const cu = u;
			const cv = v;
			const iu0 = Math.ceil(cu - fu.radius);
			const iu1 = Math.floor(cu + fu.radius);
			const iv0 = Math.ceil(cv - fv.radius);
			const iv1 = Math.floor(cv + fv.radius);
			wu.length = 0;
			wv.length = 0;
			for (let t = iu0; t <= iu1; t++) {
				wu.push(fu.weight(t, cu));
			}
			for (let t = iv0; t <= iv1; t++) {
				wv.push(fv.weight(t, cv));
			}
			const [r, g, b, a] = blendSeparable(
				rgba,
				width,
				spec.wrap ? { x0: 0, y0: 0, x1: width, y1: height } : { x0: sx0, y0: sy0, x1: sx1, y1: sy1 },
				iu0,
				wu,
				iv0,
				wv,
				kernel === 'bicubic',
				edge,
			);
			if (a <= 0) {
				continue;
			}
			const alpha = Math.min(255, a);
			const dst = (j * w + i) * 4;
			out[dst] = (Math.min(Math.max(0, r), alpha) * 255) / alpha;
			out[dst + 1] = (Math.min(Math.max(0, g), alpha) * 255) / alpha;
			out[dst + 2] = (Math.min(Math.max(0, b), alpha) * 255) / alpha;
			out[dst + 3] = alpha;
		}
	}
	return { x: bx0, y: by0, w, h, rgba: out };
}
