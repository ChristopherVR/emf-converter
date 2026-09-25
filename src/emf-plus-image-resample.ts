/**
 * GDI+-matching resampling for EMF+ `DrawImage` / `DrawImagePoints`.
 *
 * Canvas `drawImage` scales a bitmap with its own filter (bilinear or
 * better, sampled at pixel centres), which lands texel edges half a device
 * pixel away from where GDI+ puts them: measured against a real GDI+ 2x and
 * 1.67x `DrawImage` (`image-draw-png`), about 18% of the image's pixels came
 * out different. GDI+'s default rendering state is `InterpolationMode`
 * Bilinear with `PixelOffsetMode` None, under which device pixel (x, y) IS
 * the point (x, y) (not its centre) and source texel (i, j) sits at (i, j):
 * device pixel (x, y) maps back through the image's source-to-device matrix
 * to a source point (u, v), is painted when (u, v) lies inside the source
 * rectangle (half-open), and takes the bilinear blend of the four texels
 * around (u, v), where a texel outside the source rectangle counts as
 * transparent (so the last half texel along the right and bottom edges
 * fades out). The destination corners are first snapped to GDI+'s
 * 1/16-pixel fixed-point grid. Modelled this way, the real GDI+ fixture is
 * reproduced to within 8 levels per channel on every pixel.
 *
 * {@link resampleImage} implements that (and NearestNeighbor, and the
 * `PixelOffsetMode` Half/HighQuality variant that moves both grids by half a
 * pixel) as a pure function over RGBA pixels; `processDeferredImages`
 * (`emf-converter.ts`) composites its result at an integer device offset.
 * The high-quality (prefiltered) and bicubic modes are not modelled and keep
 * Canvas's own `drawImage` scaling.
 *
 * @module emf-plus-image-resample
 */

import type { DeferredImageResample, TransformMatrix } from './emf-types';

/** GDI+ InterpolationMode values (MS-EMFPLUS 2.1.1.16) this module resamples itself. */
const INTERPOLATION_NEAREST = 5;
const BILINEAR_MODES = new Set([0, 1, 3]); // Default, LowQuality, Bilinear

/** GDI+ PixelOffsetMode values (MS-EMFPLUS 2.1.1.26) that sample at pixel centres. */
const HALF_PIXEL_OFFSET_MODES = new Set([2, 4]); // HighQuality, Half

/** Largest device area (in pixels) one resampled draw may cover. */
const MAX_RESAMPLE_PIXELS = 16 * 1024 * 1024;

/**
 * The resampling kernel for a GDI+ `InterpolationMode`, or `null` for a mode
 * this module does not model (bicubic and the prefiltered high-quality
 * modes), which keeps Canvas's own `drawImage` scaling.
 */
export function resampleKernelFor(interpolationMode: number): 'nearest' | 'bilinear' | null {
	if (interpolationMode === INTERPOLATION_NEAREST) {
		return 'nearest';
	}
	return BILINEAR_MODES.has(interpolationMode) ? 'bilinear' : null;
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

/** GDI+ rasterises in 28.4 fixed point: device coordinates snap to 1/16 pixel. */
const SUBPIXEL_GRID = 16;

/**
 * `spec.toDevice` with the destination parallelogram's three defining
 * corners snapped to GDI+'s 1/16-pixel grid, so a destination recorded as
 * 20.0000002 (float noise from the recorder) starts on device row 20, as it
 * does in GDI+, rather than just below it.
 */
function snapToDeviceGrid(spec: DeferredImageResample): TransformMatrix {
	const m = spec.toDevice;
	const map = (u: number, v: number): [number, number] => [
		Math.round((m[0] * u + m[2] * v + m[4]) * SUBPIXEL_GRID) / SUBPIXEL_GRID,
		Math.round((m[1] * u + m[3] * v + m[5]) * SUBPIXEL_GRID) / SUBPIXEL_GRID,
	];
	const [ox, oy] = map(spec.srcX, spec.srcY);
	const [ax, ay] = map(spec.srcX + spec.srcW, spec.srcY);
	const [bx, by] = map(spec.srcX, spec.srcY + spec.srcH);
	const a = (ax - ox) / spec.srcW;
	const b = (ay - oy) / spec.srcW;
	const c = (bx - ox) / spec.srcH;
	const d = (by - oy) / spec.srcH;
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
	const m = snapToDeviceGrid(spec);
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
	const out = new Uint8ClampedArray(w * h * 4);
	// PixelOffsetMode Half/HighQuality: pixel (x, y) is the point
	// (x + 0.5, y + 0.5) and texel (i, j) is centred on (i + 0.5, j + 0.5).
	const o = spec.halfPixelOffset ? 0.5 : 0;
	const uMax = spec.srcX + spec.srcW;
	const vMax = spec.srcY + spec.srcH;
	for (let j = 0; j < h; j++) {
		const py = by0 + j + o;
		for (let i = 0; i < w; i++) {
			const px = bx0 + i + o;
			const u = inv[0] * px + inv[2] * py + inv[4];
			const v = inv[1] * px + inv[3] * py + inv[5];
			if (u < spec.srcX || v < spec.srcY || u >= uMax || v >= vMax) {
				continue;
			}
			const dst = (j * w + i) * 4;
			if (spec.kernel === 'nearest') {
				const ti = Math.min(sx1 - 1, Math.max(sx0, Math.floor(u)));
				const tj = Math.min(sy1 - 1, Math.max(sy0, Math.floor(v)));
				const s = (tj * width + ti) * 4;
				out[dst] = rgba[s];
				out[dst + 1] = rgba[s + 1];
				out[dst + 2] = rgba[s + 2];
				out[dst + 3] = rgba[s + 3];
				continue;
			}
			const fu = u - o;
			const fv = v - o;
			const iu = Math.floor(fu);
			const iv = Math.floor(fv);
			const ax = fu - iu;
			const ay = fv - iv;
			// A neighbour outside the source rectangle is transparent (GDI+'s
			// default WrapModeClamp for DrawImage), so the last half texel
			// along an edge fades out rather than repeating the edge texel.
			const in0x = iu >= sx0 && iu < sx1;
			const in1x = iu + 1 >= sx0 && iu + 1 < sx1;
			const in0y = iv >= sy0 && iv < sy1;
			const in1y = iv + 1 >= sy0 && iv + 1 < sy1;
			const c0 = Math.min(sx1 - 1, Math.max(sx0, iu));
			const c1 = Math.min(sx1 - 1, Math.max(sx0, iu + 1));
			const r0 = Math.min(sy1 - 1, Math.max(sy0, iv));
			const r1 = Math.min(sy1 - 1, Math.max(sy0, iv + 1));
			const s00 = (r0 * width + c0) * 4;
			const s10 = (r0 * width + c1) * 4;
			const s01 = (r1 * width + c0) * 4;
			const s11 = (r1 * width + c1) * 4;
			// Blend in premultiplied space so a transparent texel does not
			// bleed its (meaningless) colour into an opaque neighbour.
			const w00 = in0x && in0y ? (1 - ax) * (1 - ay) * rgba[s00 + 3] : 0;
			const w10 = in1x && in0y ? ax * (1 - ay) * rgba[s10 + 3] : 0;
			const w01 = in0x && in1y ? (1 - ax) * ay * rgba[s01 + 3] : 0;
			const w11 = in1x && in1y ? ax * ay * rgba[s11 + 3] : 0;
			const alpha = w00 + w10 + w01 + w11;
			if (alpha <= 0) {
				continue;
			}
			for (let c = 0; c < 3; c++) {
				out[dst + c] =
					(w00 * rgba[s00 + c] + w10 * rgba[s10 + c] + w01 * rgba[s01 + c] + w11 * rgba[s11 + c]) / alpha;
			}
			out[dst + 3] = alpha;
		}
	}
	return { x: bx0, y: by0, w, h, rgba: out };
}
