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
