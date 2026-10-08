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
 * - NearestNeighbor follows its own rules (see {@link resampleNearest}):
 *   the destination parallelogram is scan-converted from its 28.4 corners
 *   like a fill, and each row is walked with GDI+'s 16.16 fixed-point
 *   stepper, so the texel boundaries land where GDI+ puts them under any
 *   scale, rotation, shear or flip.
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
 *   also applies the fractional part of an axis-aligned destination origin's
 *   x mirrored: an x origin at `n + f` samples as if placed at `n + 1 - f`
 *   (confirmed at scales from 0.32 to 1.5 and offsets 0.1 to 2.3). A
 *   fractional y origin is used as given, rounded to 1/16 pixel; mirroring it
 *   too left errors of up to 96 levels against native draws. An axis-aligned
 *   draw that is scaled up (or unscaled) on both axes follows GDI+'s fixed-point
 *   phase arithmetic exactly for the tent and to 1% of values for the cubic,
 *   see {@link resampleHqAxisAligned}; a reduction keeps the float model
 *   above.
 *
 * - Rotated or sheared high-quality draws (a 3-point destination) are two
 *   draws, measured against native `DrawImage` output (`hq-rotated`): the source
 *   is first scaled, axis-aligned with the kernel above, to the whole number of
 *   device pixels the destination edges span (each length rounded up), into an
 *   8-bit premultiplied intermediate; that bitmap is then drawn with the plain
 *   Bicubic (`a = -0.5`, integer arithmetic) or Bilinear kernel at about unit
 *   scale. If either edge's rounded-up length is within one pixel of the source
 *   length the first step is skipped and the plain kernel samples the source.
 *   The destination parallelogram is filled by the aliased fill rule, and the
 *   intermediate's overhang fades out through the second kernel's transparent
 *   taps, which is what the earlier far-edge fade table approximated. Under
 *   PixelOffsetMode Half/HighQuality the second pass's grid moves by -0.5 device
 *   pixels and +0.5 intermediate texels. A quad whose edges are axis-aligned to
 *   within 5e-4 draws as an axis-aligned one. See {@link resampleRotatedTwoStage}.
 *
 * A texel outside the bitmap counts as transparent (GDI+'s default clamp
 * for `DrawImage`), so the kernel's overhang fades an edge out; a texel
 * inside the bitmap but outside the source rectangle is read as it is
 * (measured on sub-rectangle draws in every interpolation mode). With an
 * ImageAttributes WrapMode the overhang beyond the bitmap wraps (Tile,
 * TileFlip*) or reads the clamp colour (Clamp). Colours are blended
 * premultiplied, and a negative-lobe result is clamped. {@link resampleImage} implements all of this as a pure function
 * over RGBA pixels; callers composite its block at an integer device
 * offset, which every canvas backend copies unfiltered.
 *
 * @module emf-plus-image-resample
 */

import { hqCubicBinWeights, hqCubicCdf } from './emf-plus-hq-cubic-weights';
import { rasterizePlusFill, toPlusFix } from './emf-plus-raster';
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

/**
 * Largest off-diagonal to diagonal ratio of a high-quality draw's matrix that
 * GDI+ still draws as axis-aligned. Native draws of a 48-pixel quad whose far
 * corners are offset by up to 0.02 pixels (a ratio of 4.2e-4) are identical
 * to the axis-aligned draw, and by 0.03 pixels (6.3e-4) take the rotated
 * path, whatever the origin's fraction.
 */
const AXIS_ALIGNED_SHEAR = 5e-4;

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
	/** Non-premultiplied RGBA (premultiplied when `premultiplied` is set), `w * h * 4` bytes. */
	rgba: Uint8ClampedArray;
	premultiplied?: boolean;
}

/** Internal switches of {@link resampleImage} for the passes of a rotated high-quality draw. */
export interface ResampleOptions {
	/** The plain Bicubic pass of a rotated high-quality draw: integer arithmetic. */
	plainRotated?: boolean;
	/** Use `spec.toDevice` as given instead of snapping its origin to 1/16 pixel. */
	keepOrigin?: boolean;
	/** The source bytes are premultiplied. */
	premultSource?: boolean;
	/** Return premultiplied bytes (where the draw takes the phased high-quality path). */
	premultOut?: boolean;
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

/**
 * `HighQualityBicubic` fade table: sampled every 0.05 pixel from 0 to 1 (see {@link fadeAt}).
 */
const FAR_FADE = [1, 1, 0.985, 0.95, 0.91, 0.85, 0.8, 0.745, 0.69, 0.63, 0.56, 0.5, 0.43, 0.35, 0.28, 0.22, 0.16, 0.11, 0.065, 0.03, 0];

/**
 * How much of its edge alpha a rotated high-quality draw (under
 * PixelOffsetMode None) loses `d` device pixels inside the far (right or
 * bottom) edge of the source rectangle, as a share of the alpha the kernel
 * gives at the edge itself. Native alpha there is the kernel's alpha minus
 * this share of the edge alpha: zero at the edge, rejoining the kernel one
 * pixel in, whatever the angle or the scale (measured with an opaque image
 * against the same image inside a transparent border, over angles 0.4 to
 * 60 degrees and scales 2 to 6). The tent kernel loses it linearly
 * (`1 - d`); the cubic follows {@link FAR_FADE}. Pure.
 */
function fadeAt(d: number, bilinear: boolean): number {
	if (d >= 1) {
		return 0;
	}
	if (bilinear) {
		return 1 - Math.max(0, d);
	}
	const x = Math.max(0, d) * 20;
	const i = Math.floor(x);
	return FAR_FADE[i] + (FAR_FADE[i + 1] - FAR_FADE[i]) * (x - i);
}

/**
 * A device length rounded up to whole pixels as GDI+ does for a rotated
 * high-quality draw's intermediate bitmap. The length arrives as a float32
 * result, so an exact whole length can read a few float32 units high; the
 * native sizes show 12.0000029 rounding up (13) and 12.000001, 24.0000019
 * and 40.0000038 not, a relative tolerance between 1e-7 and 2.4e-7.
 */
function ceilExtent(len: number): number {
	return Math.ceil(len * (1 - 1.5e-7));
}

/**
 * Whether a source extent of `srcLen` texels spanning `deviceLen` device
 * pixels counts as "unscaled" for a rotated high-quality draw: its rounded-up
 * device length is within one pixel of the source length (so 20 texels at
 * scales from 0.905 to 1.05 are, 0.9 and 1.055 are not).
 */
function nearSourceExtent(deviceLen: number, srcLen: number): boolean {
	const d = ceilExtent(deviceLen) - srcLen;
	return d >= -1 && d <= 1;
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
 * the other does not). Axis-aligned Bicubic first converts source colours
 * to integer premultiplied bytes and truncates each convolution pass.
 * A texel outside `box` is transparent. Returns
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
	integerBicubic = false,
	premult = false,
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
			lr += premult ? wi * px[s] : integerBicubic ? wi * Math.round(alpha * px[s] / 255) : wa * px[s];
			lg += premult ? wi * px[s + 1] : integerBicubic ? wi * Math.round(alpha * px[s + 1] / 255) : wa * px[s + 1];
			lb += premult ? wi * px[s + 2] : integerBicubic ? wi * Math.round(alpha * px[s + 2] / 255) : wa * px[s + 2];
			la += wi * alpha;
		}
		if (integerBicubic) {
			lr = Math.trunc(lr);
			lg = Math.trunc(lg);
			lb = Math.trunc(lb);
			la = Math.trunc(la);
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
	options: ResampleOptions | boolean = {},
): ResampledBlock | null {
	const { plainRotated: plainRotatedPass = false, keepOrigin = false, premultSource = false, premultOut = false }: ResampleOptions =
		typeof options === 'boolean' ? { plainRotated: options } : options;
	if (spec.rightHalo && spec.rightHalo.length === height * 4) {
		// Append the halo column to the bitmap, then sample it as an ordinary one.
		const grown = new Uint8ClampedArray((width + 1) * height * 4);
		for (let y = 0; y < height; y++) {
			grown.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width + 1) * 4);
			grown.set(spec.rightHalo.subarray(y * 4, y * 4 + 4), (y * (width + 1) + width) * 4);
		}
		return resampleImage(grown, width + 1, height, { ...spec, rightHalo: undefined }, surface);
	}
	if (spec.kernel === 'nearest' && !spec.wrap) {
		return resampleNearest(rgba, width, height, spec, surface);
	}
	let m = keepOrigin ? spec.toDevice : snapToDeviceGrid(spec);
	let kernel = spec.kernel;
	const hq = kernel === 'hq-bilinear' || kernel === 'hq-bicubic';
	if (hq && (m[1] !== 0 || m[2] !== 0) && Math.abs(m[1]) <= AXIS_ALIGNED_SHEAR * Math.abs(m[0]) && Math.abs(m[2]) <= AXIS_ALIGNED_SHEAR * Math.abs(m[3])) {
		// A quad that is axis-aligned to within a hair draws as an axis-aligned one.
		m = [m[0], 0, 0, m[3], m[4], m[5]];
	}
	const axisAligned = m[1] === 0 && m[2] === 0;
	// Native DrawImage's axis-aligned Bicubic path uses integer colour
	// intermediates, and so does the plain Bicubic pass of a rotated
	// high-quality draw (`plainRotated`). A directly requested rotated or
	// sheared Bicubic draw keeps the float convolution: the independent
	// captures (modes 2 and 3) do not support the integer arithmetic there
	// at every scale.
	let plainRotated = plainRotatedPass;
	// Native unit-scale draws copy near-integral texels within this signed
	// 1/64 phase interval. The positive source-phase endpoint has additional
	// dispatch conditions, so keep it on the convolution path. Public captures
	// cover both axes, fractional destination origins, cropped sizes and alpha.
	const unitBicubicCopy = kernel === 'bicubic' && axisAligned && !spec.halfPixelOffset && m[0] === 1 && m[3] === 1 &&
		m[4] - Math.round(m[4]) > -1 / 64 && m[4] - Math.round(m[4]) <= 1 / 64 &&
		m[5] - Math.round(m[5]) > -1 / 64 && m[5] - Math.round(m[5]) <= 1 / 64;
	let farFade = false;
	let shiftX = 0;
	let shiftY = 0;
	if (hq && !axisAligned) {
		// A rotated or sheared high-quality draw (see the module doc).
		const extentU = Math.hypot(m[0], m[1]) * spec.srcW;
		const extentV = Math.hypot(m[2], m[3]) * spec.srcH;
		const near = nearSourceExtent(extentU, spec.srcW) || nearSourceExtent(extentV, spec.srcH);
		if (!spec.wrap) {
			return resampleRotatedTwoStage(rgba, width, height, spec, surface, m, kernel, near);
		} else if (near) {
			kernel = kernel === 'hq-bicubic' ? 'bicubic' : 'bilinear';
			plainRotated = true;
		} else {
			farFade = true;
			if (spec.halfPixelOffset) {
				const lu = Math.hypot(m[0], m[1]);
				const lv = Math.hypot(m[2], m[3]);
				shiftX = (0.5 * m[0]) / lu + (0.5 * m[2]) / lv;
				shiftY = (0.5 * m[1]) / lu + (0.5 * m[3]) / lv;
			}
		}
	}
	const integerBicubic = kernel === 'bicubic' && (axisAligned || plainRotated);
	if (hq && axisAligned && !spec.wrap && !premultSource) {
		const phased = resampleHqAxisAligned(rgba, width, height, spec, surface, m, premultOut);
		if (phased !== undefined) {
			return phased;
		}
	}
	if (hq && axisAligned) {
		// Mirror the fractional part of the destination origin's x (the device
		// position of the source rectangle's top-left corner). Only x is
		// mirrored: GDI+ places a fractional y origin as given (measured against
		// native draws at 24 origin/scale combinations, where mirroring y as well
		// leaves errors of up to 96 levels).
		const ox = m[0] * spec.srcX + m[4];
		m = [m[0], 0, 0, m[3], m[4] + mirroredOrigin(ox) - ox, m[5]];
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
	// High-quality native draws bypass filtering only for a complete unit
	// copy. An unscaled axis still uses the integrated kernel when the other
	// axis is scaled; independent noise/impulse and cropped alpha captures
	// distinguish this from copying each qualifying axis separately.
	const copy = copyU && copyV;
	const fu = axisFilter(kernel, scaleU, copy);
	const fv = axisFilter(kernel, scaleV, copy);
	const out = new Uint8ClampedArray(w * h * 4);
	// PixelOffsetMode Half/HighQuality: pixel (x, y) is the point
	// (x + 0.5, y + 0.5) and texel (i, j) is centred on (i + 0.5, j + 0.5).
	const o = spec.halfPixelOffset ? 0.5 : 0;
	const uMax = spec.srcX + spec.srcW;
	const vMax = spec.srcY + spec.srcH;
	const wu: number[] = [];
	const wv: number[] = [];
	const gradU = Math.hypot(inv[0], inv[2]);
	const gradV = Math.hypot(inv[1], inv[3]);
	const c = spec.clampArgb ?? 0;
	const edge: EdgeMode = {
		wrap: spec.wrap,
		clamp: [(c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff, (c >>> 24) & 0xff],
		mirrorX: spec.wrap === 'tile-flip-x' || spec.wrap === 'tile-flip-xy',
		mirrorY: spec.wrap === 'tile-flip-y' || spec.wrap === 'tile-flip-xy',
	};
	const bicubicDu = Math.round(inv[0] * FIX16);
	const bicubicDv = Math.round(inv[1] * FIX16);
	for (let j = 0; j < h; j++) {
		const py = by0 + j + o;
		let start = -1;
		let su = 0;
		let sv = 0;
		for (let i = 0; i < w; i++) {
			const px = bx0 + i + o;
			let u = inv[0] * (px - shiftX) + inv[2] * (py - shiftY) + inv[4];
			let v = inv[1] * (px - shiftX) + inv[3] * (py - shiftY) + inv[5];
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
			if (integerBicubic) {
				// The first covered pixel starts a nearest-16.16 row stepper.
				// Kernel phases truncate to 1/64; y is reinitialised each row.
				if (start < 0) {
					start = i;
					su = Math.round(u * FIX16);
					sv = Math.round(v * FIX16);
				}
				u = Math.floor((su + (i - start) * bicubicDu) / (FIX16 / 64)) / 64;
				v = Math.floor((sv + (i - start) * bicubicDv) / (FIX16 / 64)) / 64;
				if (unitBicubicCopy) {
					u = Math.round(u);
					v = Math.round(v);
				}
			}
			// Texel (i, j) is centred on (i, j) in source coordinates under every
			// PixelOffsetMode: under Half/HighQuality GDI+'s recorder already
			// shifts the source rectangle by -0.5 (it records (0, 0, w, h) as
			// (-0.5, -0.5, w, h)), so only the device sample point moves.
			const box = { x0: 0, y0: 0, x1: width, y1: height };
			const sampleAt = (cu: number, cv: number): [number, number, number, number] => {
				const iu0 = Math.ceil(cu - fu.radius);
				const iu1 = Math.floor(cu + fu.radius);
				const iv0 = Math.ceil(cv - fv.radius);
				const iv1 = Math.floor(cv + fv.radius);
				wu.length = 0;
				wv.length = 0;
				for (let t = iu0; t <= iu1; t++) {
					// Native Bicubic stores each kernel share in nearest 16.16,
					// after selecting its 1/64 source phase. Keeping polynomial
					// weights unquantised changes rare integer colour boundaries.
					wu.push(integerBicubic ? Math.round(fu.weight(t, cu) * 65536) / 65536 : fu.weight(t, cu));
				}
				for (let t = iv0; t <= iv1; t++) {
					wv.push(integerBicubic ? Math.round(fv.weight(t, cv) * 65536) / 65536 : fv.weight(t, cv));
				}
				return blendSeparable(rgba, width, box, iu0, wu, iv0, wv, kernel === 'bicubic', edge, integerBicubic, premultSource);
			};
			let [r, g, b, a] = sampleAt(u, v);
			if (farFade && !spec.wrap && a > 0) {
				const du = (uMax - u) / gradU;
				const dv = (vMax - v) / gradV;
				const k =
					1 -
					(du < 1 ? fadeAt(du, kernel === 'hq-bilinear') * (sampleAt(uMax, v)[3] / a) : 0) -
					(dv < 1 ? fadeAt(dv, kernel === 'hq-bilinear') * (sampleAt(u, vMax)[3] / a) : 0);
				if (k < 1) {
					const f = Math.max(0, k);
					r *= f;
					g *= f;
					b *= f;
					a *= f;
				}
			}
			if (a <= 0) {
				continue;
			}
			if (integerBicubic) {
				r = Math.trunc(r);
				g = Math.trunc(g);
				b = Math.trunc(b);
				a = Math.trunc(a);
				if (a <= 0) continue;
			} else if (premultSource) {
				// The plain pass of a rotated high-quality draw writes whole premultiplied bytes.
				r = Math.round(r);
				g = Math.round(g);
				b = Math.round(b);
				a = Math.round(a);
				if (a <= 0) continue;
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

/** Phases per texel of the high-quality weight tables. */
const HQ_PHASES = 128;

/**
 * The 16.16 step per destination pixel of an axis-aligned high-quality draw scaled by `scale`: the rounded
 * reciprocal. A reciprocal within about 0.004 below a half (1.37 is 47836.496) rounds either way in native
 * draws, and which way depends on the draw's height (47836 at heights 8 to 64, 47837 at 336): a float32
 * rounding of the matrix inverse that the width alone does not fix. The plain rounding is kept.
 */
function hqStep(scale: number): number {
	return Math.round(65536 / scale);
}

/** The tent's running integral at `u = j / 128` kernel units, over 65536 (`512 j - 2 j^2` on `|j| < 128`). */
function hqTentCdf(j: number): number {
	if (j <= -128) {
		return -32768;
	}
	if (j >= 128) {
		return 32768;
	}
	return j < 0 ? -(512 * -j - 2 * j * j) : 512 * j - 2 * j * j;
}

interface HqTaps {
	first: number;
	weights: number[];
}

/**
 * The taps of a reduced axis (scale below one) of a high-quality draw, from the native noise captures. Each
 * texel edge `e` (relative to the source origin) lands in destination space at `s' (e - P)`, where `s' = 65536 /
 * step` and `P = (k step + offset) / 65536` is the position of destination pixel `k`; that offset, in 1/128
 * destination pixel, is rounded down, and a texel's weight is the difference of the kernel's running integral at
 * its two edges' rounded offsets: the cubic's measured half-grid table ({@link hqCubicCdf}), the tent's exact
 * integral at whole grid points. All 9,012 noise values of the sweep from 0.9x to 0.25x match, except two tent
 * values at 0.4x where an offset falls exactly on the end of the kernel.
 *
 * `originBins` is the source origin in 1/128 texel (a whole number).
 */
function hqReductionTaps(cubic: boolean, scale: number, step: number, position: (k: number) => number, origin: number, from: number, to: number): HqTaps[] {
	const taps: HqTaps[] = [];
	const s = Math.fround(scale);
	const radius = (cubic ? 2 : 1) * (step / 65536) + 1;
	for (let k = from; k <= to; k++) {
		const p = position(k);
		const centre = origin + p / 65536;
		const first = Math.ceil(centre - radius);
		const last = Math.floor(centre + radius);
		const weights: number[] = [];
		let prev = Number.NaN;
		for (let t = first; t <= last + 1; t++) {
			// 128 u at texel edge t - 1/2, u = s (e - origin - P) in destination pixels.
			const q = 128 * s * (t - 0.5 - origin - p / 65536);
			const edge = Math.floor(q);
			const cdf = cubic ? hqCubicCdf(edge) : hqTentCdf(edge);
			if (t > first) {
				weights.push((cdf - prev) / 65536);
			}
			prev = cdf;
		}
		taps.push({ first, weights });
	}
	return taps;
}

/**
 * An axis-aligned HighQualityBilinear/HighQualityBicubic draw, as GDI+ computes
 * it (measured from native impulse and noise draws: `hq-axis`, `hq-axis-noise`,
 * `hq-arithmetic`, `hq-independent`, `hq-cubic-weights`, `hq-phases`):
 *
 * - Each axis steps through the source in 16.16 fixed point, `S = round(65536 /
 *   scale)` per destination pixel, from the first covered pixel; the position is
 *   `P = k S + offset`, where the offset is the distance from the destination
 *   edge to the first covered pixel (`1 - d` of the fraction `d` along x, `d` along
 *   y; `d` follows the unsnapped edge), zero for an integral edge.
 * - An upscaled axis (scale of one or more): the weights depend only on the
 *   phase `floor((P - 1) / 512)`, 1/128 of a texel: for the cubic, the measured
 *   integer table of {@link hqCubicBinWeights}; for the tent, the kernel's
 *   integral at `(phase + 1) / 128`.
 * - A reduced axis: see {@link hqReductionTaps}.
 * - A mirrored x axis (negative scale) steps backwards from the far end, `P =
 *   (covered pixels + d - k) S`, plus a few units that grow with the source width,
 *   through the same rules in the source's own direction.
 * - The horizontal pass runs first and is rounded to 8 bits (colours
 *   premultiplied, alpha limited to 255 and colours to alpha) before the
 *   vertical pass, which is rounded the same way.
 *
 * Returns `undefined` when the draw is not of this kind (a mirrored unit axis, a
 * complete unit copy, a half-pixel offset under a mirror): the caller keeps its
 * general path. A tap outside the bitmap is transparent, one inside it but
 * outside the source rectangle reads the bitmap.
 */
function resampleHqAxisAligned(
	rgba: Uint8ClampedArray,
	width: number,
	height: number,
	spec: DeferredImageResample,
	surface: { w: number; h: number },
	m: TransformMatrix,
	premultOut: boolean,
): ResampledBlock | null | undefined {
	const kernel = spec.kernel;
	const mirrorU = m[0] < 0;
	const scaleU = Math.abs(m[0]);
	const scaleV = m[3];
	if (!(scaleU > 0 && scaleV > 0) || spec.rightHalo) {
		return undefined;
	}
	const integral = (v: number): boolean => Math.abs(v - Math.round(v)) < 1e-9;
	if (scaleU === 1 && scaleV === 1 && !mirrorU && integral(m[4]) && integral(m[5])) {
		return undefined;
	}
	// A mirrored unit axis keeps the general path (open: a DrawImage rectangle with a negative width copies it
	// exactly, DrawImagePoints with reversed points filters it, and the converter cannot tell the two apart).
	if (mirrorU && scaleU === 1) {
		return undefined;
	}
	const shift = spec.halfPixelOffset ? 0.5 : 0;
	const edge0 = m[0] * spec.srcX + m[4] - shift;
	const edge1 = edge0 + m[0] * spec.srcW;
	// A mirrored draw snaps its left edge (the far end of the source rectangle) to the 1/16 grid, not the right one.
	const rawLeft = spec.toDevice[0] * (spec.srcX + spec.srcW) + spec.toDevice[4] - shift;
	const left = mirrorU ? Math.round(rawLeft * SUBPIXEL_GRID) / SUBPIXEL_GRID : Math.min(edge0, edge1);
	const top = m[3] * spec.srcY + m[5] - shift;
	const right = mirrorU ? left + scaleU * spec.srcW : Math.max(edge0, edge1);
	const bottom = top + m[3] * spec.srcH;
	const xFirst = Math.ceil(left - COVERAGE_NUDGE_X);
	const xLast = Math.ceil(right - COVERAGE_NUDGE_X) - 1;
	const yFirst = Math.ceil(top - COVERAGE_NUDGE_Y);
	const yLast = Math.ceil(bottom - COVERAGE_NUDGE_Y) - 1;
	const cx0 = Math.max(0, xFirst);
	const cy0 = Math.max(0, yFirst);
	const cx1 = Math.min(surface.w - 1, xLast);
	const cy1 = Math.min(surface.h - 1, yLast);
	if (cx1 < cx0 || cy1 < cy0) {
		return null;
	}
	const w = cx1 - cx0 + 1;
	const h = cy1 - cy0 + 1;
	if (w * h > MAX_RESAMPLE_PIXELS) {
		return null;
	}
	const cubic = kernel === 'hq-bicubic';
	const bin = cubic ? 0.5 : 1;
	const stepU = hqStep(scaleU);
	const stepV = hqStep(scaleV);
	const rawLeftEdge = mirrorU ? rawLeft : spec.toDevice[0] * spec.srcX + spec.toDevice[4] - shift;
	// The phase offset follows the unsnapped edge (a 3.4 origin steps from 0.6, not from the snapped 0.625).
	const dxRaw = xFirst - rawLeftEdge;
	const dx = dxRaw < 1e-5 ? 0 : dxRaw;
	const dy = Math.max(0, yFirst - top);
	if (mirrorU && (spec.halfPixelOffset || !integral(spec.srcX) || !integral(spec.srcW))) {
		return undefined;
	}
	// A mirrored draw reads the flipped source from its far end: pixel k sits at the flipped position
	// (source width - one texel) - (covered pixels - k) steps.
	const mirroredPixels = xLast - xFirst + 1 + dx;
	const offsetU = !mirrorU && dx > 1e-9 ? Math.round((1 - dx) * stepU) : 0;
	const offsetV = dy > 1e-9 ? Math.round(dy * stepV) : 0;
	const filterU = axisFilter(kernel, scaleU, false);
	const filterV = axisFilter(kernel, scaleV, false);
	interface Taps {
		first: number;
		weights: number[];
	}
	const tapsFor = (filter: ReturnType<typeof axisFilter>, step: number, offset: number, origin: number, from: number, to: number, scale: number, mirror = false): Taps[] => {
		const taps: Taps[] = [];
		// A mirrored draw steps backwards from the far end: pixel k sits at (covered pixels + fraction - k) steps.
		// The far end of the source is a few units off in native draws, growing with the source width (3 at 512 texels, 0 at 13)
		// and absent for a power-of-two step (a scale of 2, 0.5 or 4 computes exactly).
		const farBias = (step & (step - 1)) === 0 ? 0 : Math.round(spec.srcW / 170);
		const position = (k: number): number => (mirror ? Math.round((mirroredPixels - k) * step) + farBias : k * step + offset);
		// The measured integer table applies when the source origin is a whole number of phase bins.
		const originBins = origin * HQ_PHASES;
		const wholeBins = Math.abs(originBins - Math.round(originBins)) < 1e-6;
		if (scale < 1 && wholeBins) {
			return hqReductionTaps(cubic, scale, step, position, origin, from, to);
		}
		const tabulated = cubic && wholeBins;
		for (let k = from; k <= to; k++) {
			const phase = Math.floor((position(k) - 1) / (65536 / HQ_PHASES));
			if (tabulated) {
				const total = Math.round(originBins) + phase;
				const bins = hqCubicBinWeights(((total % HQ_PHASES) + HQ_PHASES) % HQ_PHASES);
				taps.push({
					first: Math.floor(total / HQ_PHASES) + bins.first,
					weights: bins.weights.map((w) => w / 65536),
				});
				continue;
			}
			const c = origin + (phase + bin) / HQ_PHASES;
			const first = Math.ceil(c - filter.radius);
			const last = Math.floor(c + filter.radius);
			const weights: number[] = [];
			for (let t = first; t <= last; t++) {
				weights.push(filter.weight(t, c));
			}
			taps.push({ first, weights });
		}
		return taps;
	};
	const colTaps = tapsFor(filterU, stepU, offsetU, spec.srcX, cx0 - xFirst, cx1 - xFirst, scaleU, mirrorU);
	const rowTaps = tapsFor(filterV, stepV, offsetV, spec.srcY, cy0 - yFirst, cy1 - yFirst, scaleV);
	// Source rows the vertical pass reads (rows outside the bitmap are transparent).
	let rowMin = Infinity;
	let rowMax = -Infinity;
	for (const t of rowTaps) {
		rowMin = Math.min(rowMin, t.first);
		rowMax = Math.max(rowMax, t.first + t.weights.length - 1);
	}
	rowMin = Math.max(0, rowMin);
	rowMax = Math.min(height - 1, rowMax);
	const rows = Math.max(0, rowMax - rowMin + 1);
	// Horizontal pass: premultiplied, rounded to 8 bits, limited to the alpha.
	const inter = new Uint8Array(rows * w * 4);
	for (let r = 0; r < rows; r++) {
		const srcRow = (rowMin + r) * width;
		for (let i = 0; i < w; i++) {
			const t = colTaps[i];
			let pr = 0;
			let pg = 0;
			let pb = 0;
			let pa = 0;
			for (let q = 0; q < t.weights.length; q++) {
				const tx = t.first + q;
				if (tx < 0 || tx >= width) {
					continue;
				}
				const o = (srcRow + tx) * 4;
				const a = rgba[o + 3];
				if (a === 0) {
					continue;
				}
				const wq = t.weights[q];
				pr += wq * Math.round((rgba[o] * a) / 255);
				pg += wq * Math.round((rgba[o + 1] * a) / 255);
				pb += wq * Math.round((rgba[o + 2] * a) / 255);
				pa += wq * a;
			}
			const alpha = Math.min(255, Math.max(0, Math.round(pa)));
			const d = (r * w + i) * 4;
			inter[d] = Math.min(alpha, Math.max(0, Math.round(pr)));
			inter[d + 1] = Math.min(alpha, Math.max(0, Math.round(pg)));
			inter[d + 2] = Math.min(alpha, Math.max(0, Math.round(pb)));
			inter[d + 3] = alpha;
		}
	}
	const out = new Uint8ClampedArray(w * h * 4);
	for (let j = 0; j < h; j++) {
		const t = rowTaps[j];
		for (let i = 0; i < w; i++) {
			let pr = 0;
			let pg = 0;
			let pb = 0;
			let pa = 0;
			for (let q = 0; q < t.weights.length; q++) {
				const ty = t.first + q - rowMin;
				if (ty < 0 || ty >= rows) {
					continue;
				}
				const o = (ty * w + i) * 4;
				const wq = t.weights[q];
				pr += wq * inter[o];
				pg += wq * inter[o + 1];
				pb += wq * inter[o + 2];
				pa += wq * inter[o + 3];
			}
			const alpha = Math.min(255, Math.max(0, Math.round(pa)));
			if (alpha === 0) {
				continue;
			}
			const d = (j * w + i) * 4;
			const k = premultOut ? 1 : 255 / alpha;
			out[d] = Math.min(alpha, Math.max(0, Math.round(pr))) * k;
			out[d + 1] = Math.min(alpha, Math.max(0, Math.round(pg))) * k;
			out[d + 2] = Math.min(alpha, Math.max(0, Math.round(pb))) * k;
			out[d + 3] = alpha;
		}
	}
	return { x: cx0, y: cy0, w, h, rgba: out, premultiplied: premultOut };
}

function resampleRotatedTwoStage(
	rgba: Uint8ClampedArray,
	width: number,
	height: number,
	spec: DeferredImageResample,
	surface: { w: number; h: number },
	m: TransformMatrix,
	kernel: ImageResampleKernel,
	near: boolean,
): ResampledBlock | null {
	// The pass the second kernel draws: the intermediate (or, when an edge is
	// within a pixel of the source length, the source itself) in a transparent
	// border wide enough for the plain kernels' taps, so the pixels the
	// destination polygon covers just outside the image's own edge read their fade.
	const pad = 2;
	let img: Uint8ClampedArray;
	let pw: number;
	let ph: number;
	// Device position of the image's texel (0, 0) and the device step of a texel along each axis.
	let a: number;
	let b: number;
	let c: number;
	let d: number;
	let ex: number;
	let ey: number;
	const half = spec.halfPixelOffset;
	if (near) {
		// Plain kernel straight from the source: texel (i, j) is source coordinate (i, j).
		pw = width + 2 * pad;
		ph = height + 2 * pad;
		img = new Uint8ClampedArray(pw * ph * 4);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const s = (y * width + x) * 4;
				const al = rgba[s + 3];
				const o = ((y + pad) * pw + x + pad) * 4;
				img[o] = Math.round((rgba[s] * al) / 255);
				img[o + 1] = Math.round((rgba[s + 1] * al) / 255);
				img[o + 2] = Math.round((rgba[s + 2] * al) / 255);
				img[o + 3] = al;
			}
		}
		[a, b, c, d] = m;
		ex = m[4] - (half ? 0.5 : 0);
		ey = m[5] - (half ? 0.5 : 0);
	} else {
		const W = ceilExtent(Math.hypot(m[0], m[1]) * spec.srcW);
		const H = ceilExtent(Math.hypot(m[2], m[3]) * spec.srcH);
		const kx = W / spec.srcW;
		const ky = H / spec.srcH;
		// Stage 1: the source rectangle scaled to W x H with the axis-aligned
		// high-quality kernel (the rectangle's own corner at the intermediate's
		// origin; a Half-mode rectangle arrives already shifted by the recorder).
		const pre = resampleImage(rgba, width, height, {
			srcX: spec.srcX, srcY: spec.srcY, srcW: spec.srcW, srcH: spec.srcH,
			toDevice: [kx, 0, 0, ky, -spec.srcX * kx, -spec.srcY * ky],
			kernel, halfPixelOffset: false,
		}, { w: W, h: H }, { premultOut: true });
		if (!pre) {
			return null;
		}
		if (!pre.premultiplied) {
			// A reduction takes the general path, which returns straight colours.
			for (let i = 0; i < pre.rgba.length; i += 4) {
				const al = pre.rgba[i + 3];
				pre.rgba[i] = Math.round((pre.rgba[i] * al) / 255);
				pre.rgba[i + 1] = Math.round((pre.rgba[i + 1] * al) / 255);
				pre.rgba[i + 2] = Math.round((pre.rgba[i + 2] * al) / 255);
			}
		}
		pw = W + 2 * pad;
		ph = H + 2 * pad;
		img = new Uint8ClampedArray(pw * ph * 4);
		for (let y = 0; y < pre.h; y++) {
			for (let x = 0; x < pre.w; x++) {
				const dx = x + pre.x;
				const dy = y + pre.y;
				if (dx < W && dy < H) {
					img.set(pre.rgba.subarray((y * pre.w + x) * 4, (y * pre.w + x) * 4 + 4), ((dy + pad) * pw + dx + pad) * 4);
				}
			}
		}
		a = m[0] / kx;
		b = m[1] / kx;
		c = m[2] / ky;
		d = m[3] / ky;
		// Stage 2: the plain Bicubic or Bilinear kernel at about unit scale. A
		// None-mode pixel is the point (x, y); a Half-mode pixel is the point at its
		// centre and the intermediate's texels sit half a texel further along each
		// of its own axes, which moves the sample grid by -0.5 device pixels and by
		// +0.5 intermediate texels (not device pixels: the intermediate is not
		// exactly one pixel per texel when the length is not whole).
		const ox = m[0] * spec.srcX + m[2] * spec.srcY + m[4];
		const oy = m[1] * spec.srcX + m[3] * spec.srcY + m[5];
		ex = half ? ox - 0.5 + 0.5 * (a + c) : ox;
		ey = half ? oy - 0.5 + 0.5 * (b + d) : oy;
	}
	const block = resampleImage(img, pw, ph, {
		srcX: 0, srcY: 0, srcW: pw, srcH: ph,
		toDevice: [a, b, c, d, ex - a * pad - c * pad, ey - b * pad - d * pad],
		kernel: kernel === 'hq-bicubic' ? 'bicubic' : 'bilinear', halfPixelOffset: false,
	}, surface, { plainRotated: true, keepOrigin: true, premultSource: true });
	if (!block) {
		return block;
	}
	// Coverage is the destination parallelogram scan-converted from its 28.4
	// corners by the aliased fill rule, as for NearestNeighbor.
	const corners = [
		[spec.srcX, spec.srcY],
		[spec.srcX + spec.srcW, spec.srcY],
		[spec.srcX + spec.srcW, spec.srcY + spec.srcH],
		[spec.srcX, spec.srcY + spec.srcH],
	].flatMap(([u, v]) => [toPlusFix(m[0] * u + m[2] * v + m[4]), toPlusFix(m[1] * u + m[3] * v + m[5])]);
	const coverage = rasterizePlusFill([corners], false, false, half, { x: block.x, y: block.y, w: block.w, h: block.h });
	for (let i = 0; i < block.w * block.h; i++) {
		if (!coverage[i]) {
			block.rgba.fill(0, i * 4, i * 4 + 4);
		}
	}
	return block;
}

/** One in 16.16 fixed point, the precision of GDI+'s nearest-neighbour stepper. */
const FIX16 = 65536;

/**
 * NearestNeighbor `DrawImage`/`DrawImagePoints` (without an ImageAttributes
 * WrapMode), as GDI+ paints it. Fitted on 270 random draws (scales, shears,
 * rotations, flips, source sub-rectangles with whole and fractional
 * corners, PixelOffsetMode None and Half), every one pixel-exact:
 *
 * - Coverage: the destination parallelogram, its corners converted to 28.4
 *   as a fill's vertices are (`toPlusFix`), is scan-converted by GDI+'s
 *   aliased fill rule (`rasterizePlusFill`); the corners are not otherwise
 *   snapped (snapping the origin to 1/16 moved texel boundaries by a pixel).
 * - Texels: along each device row GDI+ maps the first covered pixel's
 *   sample point (x, y; x + 0.5, y + 0.5 under Half) through the inverse
 *   transform, rounds that source point to 16.16 fixed point, and steps it
 *   by the inverse's x column, also rounded to 16.16, pixel by pixel; the
 *   texel is the stepped point rounded half up (`(u + 0.5) >> 16`). The
 *   rounded step is why a flipped axis rounds its halves the other way
 *   after the first pixel of a row.
 * - Reads: a texel column anywhere in the bitmap is read, also beyond the
 *   source rectangle's right edge (a sub-rectangle of 1..3 paints column 3
 *   where its last half texel rounds up), but only the rows the source
 *   rectangle spans (from `floor(srcY)` to `ceil(srcY + srcH)`); anything
 *   else is transparent, as is a column beyond the bitmap. Pure.
 */
export function resampleNearest(
	rgba: Uint8ClampedArray,
	width: number,
	height: number,
	spec: DeferredImageResample,
	surface: { w: number; h: number },
): ResampledBlock | null {
	const m = spec.toDevice;
	const inv = invert(m);
	if (!inv) {
		return null;
	}
	const { srcX, srcY, srcW, srcH } = spec;
	const corners = [
		[srcX, srcY],
		[srcX + srcW, srcY],
		[srcX + srcW, srcY + srcH],
		[srcX, srcY + srcH],
	].map(([u, v]) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]]);
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const [x, y] of corners) {
		x0 = Math.min(x0, x);
		y0 = Math.min(y0, y);
		x1 = Math.max(x1, x);
		y1 = Math.max(y1, y);
	}
	if (![x0, y0, x1, y1].every(Number.isFinite)) {
		return null;
	}
	const bx0 = Math.max(0, Math.floor(x0) - 1);
	const by0 = Math.max(0, Math.floor(y0) - 1);
	const bx1 = Math.min(surface.w, Math.ceil(x1) + 2);
	const by1 = Math.min(surface.h, Math.ceil(y1) + 2);
	const w = bx1 - bx0;
	const h = by1 - by0;
	if (!(w > 0 && h > 0) || w * h > MAX_RESAMPLE_PIXELS) {
		return null;
	}
	const box = { x: bx0, y: by0, w, h };
	const coverage = rasterizePlusFill([corners.flatMap(([x, y]) => [toPlusFix(x), toPlusFix(y)])], false, false, spec.halfPixelOffset, box);
	const rowLo = Math.max(0, Math.floor(srcY));
	const rowHi = Math.min(height, Math.ceil(srcY + srcH));
	const o = spec.halfPixelOffset ? 0.5 : 0;
	const du = Math.round(inv[0] * FIX16);
	const dv = Math.round(inv[1] * FIX16);
	const out = new Uint8ClampedArray(w * h * 4);
	for (let j = 0; j < h; j++) {
		const py = by0 + j + o;
		let start = -1;
		let su = 0;
		let sv = 0;
		for (let i = 0; i < w; i++) {
			if (!coverage[j * w + i]) {
				continue;
			}
			if (start < 0) {
				const px = bx0 + i + o;
				start = i;
				su = Math.round((inv[0] * px + inv[2] * py + inv[4]) * FIX16);
				sv = Math.round((inv[1] * px + inv[3] * py + inv[5]) * FIX16);
			}
			const k = i - start;
			const tu = Math.floor((su + k * du + FIX16 / 2) / FIX16);
			const tv = Math.floor((sv + k * dv + FIX16 / 2) / FIX16);
			if (tu < 0 || tu >= width || tv < rowLo || tv >= rowHi) {
				continue;
			}
			const s = (tv * width + tu) * 4;
			const d = (j * w + i) * 4;
			out[d] = rgba[s];
			out[d + 1] = rgba[s + 1];
			out[d + 2] = rgba[s + 2];
			out[d + 3] = rgba[s + 3];
		}
	}
	return { x: bx0, y: by0, w, h, rgba: out };
}
