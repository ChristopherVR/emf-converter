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
 * @module emf-plus-brush-texture
 */

import { buildPattern, halfPixelDelta } from './emf-plus-brush-gradient';
import type { CanvasContext, EmfPlusTexture, TransformMatrix } from './emf-types';

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
