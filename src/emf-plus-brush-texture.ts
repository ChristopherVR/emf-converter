/**
 * Renders a parsed EMF+ TextureFill brush ({@link EmfPlusTexture}) to a
 * Canvas 2D `CanvasPattern`, the way GDI+ paints a texture brush: the
 * embedded bitmap IS the tile (no synthetic rasterisation needed, unlike a
 * gradient brush), repeated per `WrapMode` and placed by the brush
 * transform.
 *
 * Reuses the same tile-building machinery as the gradient brushes
 * (`emf-plus-brush-gradient.ts`): {@link buildPattern} rasterises a mirrored
 * (for TileFlipX/Y/XY) or plain (Tile/Clamp) tile from a `colorAt` sampler
 * and installs it as a `CanvasPattern` with the full brush-to-device matrix.
 * Here `colorAt` is nearest-neighbour lookup into the decoded bitmap instead
 * of a computed gradient function, and the tile is built at the bitmap's own
 * resolution (one texel per source pixel) rather than supersampled, since
 * the source is already a raster, not a continuous function.
 *
 * That pattern is only the FALLBACK paint now: every tested canvas backend
 * filters a `CanvasPattern` even at an identity matrix, so a real fill goes
 * through the exact per-device-pixel path in `emf-plus-exact-fill.ts`, which
 * samples the texture with {@link textureTexelAt} below. The pattern remains
 * for contexts that cannot take that path (no clip/`drawImage`, a surface
 * too large to expand, or `resolveBrushPaint` callers such as text).
 *
 * @module emf-plus-brush-texture
 */

import { buildPattern, halfPixelDelta } from './emf-plus-brush-gradient';
import { down32 } from './float32-down';
import type { CanvasContext, EmfPlusGradientWrapMode, EmfPlusTexture, TransformMatrix } from './emf-types';

/**
 * Wraps texel index `i` into `[0, n)` along one axis of a GDI+ WrapMode:
 * plain repetition, or (when `mirror`) repetition with every odd period
 * reflected. Pure.
 */
export function wrapTexel(i: number, n: number, mirror: boolean): number {
	if (!mirror) {
		return ((i % n) + n) % n;
	}
	const p = ((i % (2 * n)) + 2 * n) % (2 * n);
	return p < n ? p : 2 * n - 1 - p;
}

/**
 * The texel a texture brush paints at device pixel (`dx`, `dy`), given
 * `inv`, the device-to-texture matrix (inverse of world-to-device x brush
 * transform): the nearest texel to the pixel's integer origin (GDI+'s
 * PixelOffsetMode None convention), wrapped per `wrap`. Returns the texel's
 * RGBA byte offset into a `width` x `height` bitmap, or `-1` where a Clamp
 * brush paints nothing. Pure.
 */
export function textureTexelAt(
	inv: TransformMatrix,
	width: number,
	height: number,
	wrap: EmfPlusGradientWrapMode,
	dx: number,
	dy: number,
): number {
	// The epsilon keeps an exact texel boundary from flooring down through
	// float noise in the inverse matrix.
	const u = Math.floor(inv[0] * dx + inv[2] * dy + inv[4] + 1e-9);
	const v = Math.floor(inv[1] * dx + inv[3] * dy + inv[5] + 1e-9);
	if (wrap === 'clamp') {
		return u < 0 || v < 0 || u >= width || v >= height ? -1 : (v * width + u) * 4;
	}
	const tx = wrapTexel(u, width, wrap === 'tile-flip-x' || wrap === 'tile-flip-xy');
	const ty = wrapTexel(v, height, wrap === 'tile-flip-y' || wrap === 'tile-flip-xy');
	return (ty * width + tx) * 4;
}

/**
 * Writes the colour a texture brush paints at device pixel (`dx`, `dy`)
 * into `out` at `o` (straight RGBA; left untouched where it paints
 * nothing), the way GDI+ samples a texture brush: BILINEARLY, whatever the
 * Graphics `InterpolationMode` (every mode was measured to produce the
 * identical fill, `src/__fixtures__/gdi/gpx-texture-*`), point-sampled at
 * every scale (a reduced texture is not prefiltered). Under
 * `PixelOffsetMode` None the pixel is the point (`dx`, `dy`) and texel (i,
 * j) sits at (i, j); under Half/HighQuality (`halfPixel`) both move by half
 * a pixel. The four neighbouring texels wrap per the `WrapMode` (TileFlipX/
 * Y mirror alternate tiles texel for texel), and under Clamp a neighbour
 * outside the bitmap is transparent, so the last half texel along each
 * edge fades out. The bilinear fractions use 11 bits, source colours and
 * filtered results round to premultiplied bytes, and the straight output
 * preserves those bytes when the canvas premultiplies it. `inv` is the device-to-texture
 * matrix. Pure apart from writing `out`.
 */
export function writeTextureColor(
	inv: TransformMatrix,
	width: number,
	height: number,
	rgba: Uint8ClampedArray,
	wrap: EmfPlusGradientWrapMode,
	halfPixel: boolean,
	dx: number,
	dy: number,
	out: Uint8ClampedArray,
	o: number,
): void {
	const off = halfPixel ? 0.5 : 0;
	const px = dx + off;
	const py = dy + off;
	const cu = inv[0] * px + inv[2] * py + inv[4] - off;
	const cv = inv[1] * px + inv[3] * py + inv[5] - off;
	writeTextureColorAt(cu, cv, width, height, rgba, wrap, out, o);
}

/**
 * {@link writeTextureColor} for a known texel-space position (`cu`, `cv`) of the pixel: the position the
 * four-texel filter is centred on. The shared core of the exact and the stepped path.
 */
export function writeTextureColorAt(
	cu: number,
	cv: number,
	width: number,
	height: number,
	rgba: Uint8ClampedArray,
	wrap: EmfPlusGradientWrapMode,
	out: Uint8ClampedArray,
	o: number,
): void {
	// The epsilon keeps an exact texel position from flooring down through
	// float noise in the inverse matrix.
	const iu = Math.floor(cu + 1e-9);
	const iv = Math.floor(cv + 1e-9);
	// Native TextureBrush uses 11-bit bilinear fractions, including under
	// reductions and shears (texture-sampling.json.gz).
	const fu = Math.round(Math.max(0, cu - iu) * 2048) / 2048;
	const fv = Math.round(Math.max(0, cv - iv) * 2048) / 2048;
	const clamp = wrap === 'clamp';
	const mirrorX = wrap === 'tile-flip-x' || wrap === 'tile-flip-xy';
	const mirrorY = wrap === 'tile-flip-y' || wrap === 'tile-flip-xy';
	let r = 0;
	let g = 0;
	let b = 0;
	let a = 0;
	for (let k = 0; k < 4; k++) {
		const tu = iu + (k & 1);
		const tv = iv + (k >> 1);
		const w = ((k & 1) ? fu : 1 - fu) * ((k >> 1) ? fv : 1 - fv);
		if (w <= 0) {
			continue;
		}
		let x: number;
		let y: number;
		if (clamp) {
			if (tu < 0 || tv < 0 || tu >= width || tv >= height) {
				continue;
			}
			x = tu;
			y = tv;
		} else {
			x = wrapTexel(tu, width, mirrorX);
			y = wrapTexel(tv, height, mirrorY);
		}
		const s = (y * width + x) * 4;
		const alpha = rgba[s + 3];
		// Premultiplication belongs to the source bitmap, before filtering.
		r += w * Math.round(rgba[s] * alpha / 255);
		g += w * Math.round(rgba[s + 1] * alpha / 255);
		b += w * Math.round(rgba[s + 2] * alpha / 255);
		a += w * alpha;
	}
	a = Math.round(a);
	if (a <= 0) {
		return;
	}
	// Round the filtered premultiplied bytes before unpremultiplying. The
	// nearest straight value preserves those bytes when the canvas consumes
	// this buffer; copying native ARGB extraction's truncated reciprocal here
	// would lose a level when the canvas premultiplies it again.
	out[o] = Math.round(Math.round(r) * 255 / a);
	out[o + 1] = Math.round(Math.round(g) * 255 / a);
	out[o + 2] = Math.round(Math.round(b) * 255 / a);
	out[o + 3] = a;
}

/**
 * The device-to-texture matrix as GDI+ forms it: every operation is a float32 one rounded toward minus infinity
 * (checked against 4,000 native `Matrix.Invert` results, shears included, with no exception). `halfPixel`
 * (`PixelOffsetMode` Half) is folded into the matrix before it is inverted: the point is moved half a pixel and the texel
 * grid back, `m` becomes `T(0.5) m T(-0.5)`, whose translation is `m`'s plus half the sum of each column of the
 * linear part, less one half (the three orders of those float32 operations tried agree on the 7,820 flips of the two
 * Half sweeps of `texture-coordinate.json.gz`, which the same offset applied to the inverse's translation misses 678 of).
 */
export function invertTextureMatrix(m: TransformMatrix, halfPixel: boolean = false): TransformMatrix | null {
	const [a, b, c, d, e, f] = [m[0], m[1], m[2], m[3], m[4], m[5]].map(Math.fround);
	const ex = halfPixel ? down32(down32(down32(down32(0.5 * a) + down32(0.5 * c)) + e) - 0.5) : e;
	const fy = halfPixel ? down32(down32(down32(down32(0.5 * b) + down32(0.5 * d)) + f) - 0.5) : f;
	const det = down32(down32(a * d) - down32(b * c));
	if (!Number.isFinite(det) || det === 0) {
		return null;
	}
	const r = down32(1 / det);
	return [
		down32(d * r),
		down32(-b * r),
		down32(-c * r),
		down32(a * r),
		down32(down32(down32(c * fy) - down32(d * ex)) * r),
		down32(down32(down32(b * ex) - down32(a * fy)) * r),
	];
}

/**
 * Writes the brush colour of every pixel of a `w` x `h` rectangle at (`x0`, `y0`) into `out`, stepping the
 * texel-space position across each span the way GDI+ does (see {@link textureRowPositions}). A span is a row of the
 * rectangle, or, given `coverage` (one byte per pixel of the rectangle), each run of covered pixels of a row; pixels
 * outside every span are left untouched. Rows are independent.
 */
export function writeTextureRect(
	inv: TransformMatrix,
	width: number,
	height: number,
	rgba: Uint8ClampedArray,
	wrap: EmfPlusGradientWrapMode,
	x0: number,
	y0: number,
	w: number,
	h: number,
	out: Uint8ClampedArray,
	coverage?: Uint8ClampedArray,
): void {
	const us = new Float64Array(w);
	const vs = new Float64Array(w);
	for (let j = 0; j < h; j++) {
		// GDI+ hands the brush one span per run of covered pixels, and forms the row's positions from the span's own ends.
		let i = 0;
		while (i < w) {
			let end = w;
			if (coverage) {
				while (i < w && coverage[j * w + i] === 0) {
					i++;
				}
				if (i >= w) {
					break;
				}
				end = i;
				while (end < w && coverage[j * w + end] !== 0) {
					end++;
				}
			}
			const n = end - i;
			const u = us.subarray(i, end);
			const v = vs.subarray(i, end);
			textureRowPositions(inv, x0 + i, y0 + j, u, v, n);
			for (let k = 0; k < n; k++) {
				writeTextureColorAt(u[k], v[k], width, height, rgba, wrap, out, (j * w + i + k) * 4);
			}
			i = end;
		}
	}
}

/**
 * The texel-space positions GDI+ filters at along one span of device row `y`, from pixel `x0` for `us.length` pixels
 * (`DpOutputBilinearSpan::OutputSpan`, read from gdiplus.dll). Native does not step by the matrix's x entry: it
 * transforms the span's two end pixels, `x0` and `x0 + n`, through the float32 inverse matrix `inv` (see
 * {@link invertTextureMatrix}), divides the difference by the span's pixel count `n`, and adds that step to the start
 * position once per pixel; every operation is a float32 one rounded toward minus infinity. That reproduces every one of
 * the 6,238 flips of the native bisection captures (`texture-bisect-*.json.gz`; the bare matrix step reproduced 1,759 of
 * 2,379 of them), where the start, the step and the loss per addition all depend on the span's own pixel range.
 * (`PixelOffsetMode` Half is part of the matrix, see {@link invertTextureMatrix}.)
 */
export function textureRowPositions(
	inv: TransformMatrix,
	x0: number,
	y: number,
	us: Float64Array,
	vs: Float64Array,
	count: number = us.length,
): void {
	if (count <= 0) {
		return;
	}
	const [a, b, c, d, e, f] = inv;
	const at = (x: number): [number, number] => [
		down32(down32(down32(a * x) + down32(c * y)) + e),
		down32(down32(down32(b * x) + down32(d * y)) + f),
	];
	const [us0, vs0] = at(x0);
	const [us1, vs1] = at(x0 + count);
	const su = down32(down32(us1 - us0) / count);
	const sv = down32(down32(vs1 - vs0) / count);
	let u = us0;
	let v = vs0;
	for (let i = 0; i < count; i++) {
		us[i] = u;
		vs[i] = v;
		u = down32(u + su);
		v = down32(v + sv);
	}
}

const IDENTITY: TransformMatrix = [1, 0, 0, 1, 0, 0];

/** Packs a texel's RGBA bytes into `0xAARRGGBB`-ordered ARGB (matching `buildPattern`'s `colorAt`). */
function packArgb(rgba: Uint8ClampedArray, i: number): number {
	return ((rgba[i + 3] << 24) | (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]) >>> 0;
}

/**
 * Builds a `CanvasPattern` from a decoded EMF+ texture brush. `device` is the
 * world-to-device matrix the fill runs under (see `plusWorldMatrix`).
 * Returns `null` when the context lacks pattern support or the tile is
 * degenerate, in which case the caller falls back to the brush's flat
 * average colour.
 */
export function createBrushTexture(
	ctx: CanvasContext,
	texture: EmfPlusTexture,
	device: TransformMatrix = IDENTITY,
): CanvasPattern | null {
	const { width, height, rgba } = texture;
	if (width <= 0 || height <= 0) {
		return null;
	}
	try {
		const brush = texture.transform ?? IDENTITY;
		const colorAt = (bx: number, by: number): number | null => {
			const ix = Math.floor(bx);
			const iy = Math.floor(by);
			if (ix < 0 || iy < 0 || ix >= width || iy >= height) {
				return null;
			}
			return packArgb(rgba, (iy * width + ix) * 4);
		};
		return buildPattern(
			ctx,
			{ x: 0, y: 0, w: width, h: height },
			width,
			height,
			texture.wrapMode,
			brush,
			halfPixelDelta(device),
			{ phaseX: 0, lagX: 0, lagY: 0 },
			colorAt,
		);
	} catch {
		return null;
	}
}
