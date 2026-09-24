/**
 * Pixel parity against real Windows GDI / GDI+ output.
 *
 * Every fixture under `__fixtures__/gdi` pairs a metafile with a PNG of what
 * Windows itself painted for the same drawing calls (regenerate them with
 * `scripts/gdi-fixtures/generate.ps1` on Windows). Each case replays the
 * metafile at `dpiScale: 1` on the `@napi-rs/canvas` backend and bounds the
 * share of pixels whose largest channel differs by more than `tolerance`.
 */
import { describe, it, expect } from 'vitest';

import { compareFixture } from './__fixtures__/gdi-parity-harness';

interface ParityCase {
	name: string;
	ext: 'emf' | 'wmf';
	/** Largest per-channel difference that still counts as a match. */
	tolerance: number;
	/** Largest share of mismatching pixels allowed (0 = pixel-exact). */
	maxMismatch: number;
}

const exact = (name: string): ParityCase => ({ name, ext: 'emf', tolerance: 0, maxMismatch: 0 });

/**
 * A gradient case: `tolerance` allows for float colour-interpolation rounding
 * (Canvas gradients/patterns vs GDI+'s own fixed-point blend), and
 * `maxMismatch` is set from the ratio actually measured against the real
 * GDI+ fixture (see the module doc), with headroom so the test catches a
 * regression rather than sub-percent rendering noise.
 */
const close = (name: string, maxMismatch: number): ParityCase => ({
	name,
	ext: 'emf',
	tolerance: 8,
	maxMismatch,
});

const ROP3_CASES: ParityCase[] = [
	// All 256 ROP3 functions over striped D and banded S, per brush kind.
	exact('rop3-grid-solid'),
	exact('rop3-grid-hatch'),
	exact('rop3-grid-pattern-mono'),
	exact('rop3-grid-pattern-color'),
	exact('rop3-patblt-hatch'),
	exact('rop3-hatch-styles'),
	// StretchBlt / StretchDIBits: mirrors, source sub-rects, brush origin, stretch modes.
	exact('rop3-stretchblt'),
	exact('rop3-stretchdibits'),
	exact('rop3-stretch-sampling'),
];

/**
 * Linear-gradient WrapMode tiling (Tile/TileFlipX/TileFlipY/TileFlipXY) at a
 * horizontal angle, a 30-degree angle, an arbitrary shear+blend transform,
 * and preset (InterpolationColors) stops at 120 degrees. All are unrolled
 * into one hard-stopped `CanvasGradient` (see `tiledLinear` in
 * `emf-plus-brush-gradient.ts`), so they are exact up to float colour
 * rounding at period seams; measured mismatch tops out at 1.46% (the
 * preset-colours case, where GDI+'s own blend curve is coarsest).
 */
const LINEAR_TILE_CASES: ParityCase[] = [
	close('grad-linear-h-tile', 0.001),
	close('grad-linear-h-flipx', 0.001),
	close('grad-linear-h-flipy', 0.001),
	close('grad-linear-h-flipxy', 0.001),
	close('grad-linear-a30-tile', 0.001),
	close('grad-linear-a30-flipx', 0.001),
	close('grad-linear-a30-flipy', 0.001),
	close('grad-linear-a30-flipxy', 0.001),
	close('grad-linear-skew-blend-tile', 0.003),
	close('grad-linear-skew-blend-flipx', 0.001),
	close('grad-linear-skew-blend-flipy', 0.003),
	close('grad-linear-skew-blend-flipxy', 0.001),
	close('grad-linear-preset-a120-tile', 0.02),
	close('grad-linear-preset-a120-flipx', 0.02),
	close('grad-linear-preset-a120-flipy', 0.02),
	close('grad-linear-preset-a120-flipxy', 0.02),
];

/**
 * Path-gradient boundary-shaped rendering (not a radial approximation, see
 * `pathGradientColorAt`) for an elliptical boundary, an explicit
 * rectangle with a custom blend curve, and an off-centre triangle, each
 * across every WrapMode. `clamp` (no tiling) is closest to exact; the tile
 * modes carry a real, measured residual at the tile seam and at the
 * boundary edge itself (Canvas's supersampled pattern raster vs GDI+'s
 * unsampled per-pixel fill), honestly reflected in the wider tolerances here
 * and in the README's Limitations section.
 */
const PATH_TILE_CASES: ParityCase[] = [
	close('grad-path-ellipse-clamp', 0.008),
	close('grad-path-ellipse-tile', 0.05),
	close('grad-path-ellipse-flipx', 0.05),
	close('grad-path-ellipse-flipy', 0.05),
	close('grad-path-ellipse-flipxy', 0.05),
	close('grad-path-rect-blend-clamp', 0.02),
	close('grad-path-rect-blend-tile', 0.005),
	close('grad-path-rect-blend-flipx', 0.04),
	close('grad-path-rect-blend-flipy', 0.06),
	close('grad-path-rect-blend-flipxy', 0.08),
	close('grad-path-triangle-clamp', 0.008),
	close('grad-path-triangle-tile', 0.03),
	close('grad-path-triangle-flipx', 0.03),
	close('grad-path-triangle-flipy', 0.03),
	close('grad-path-triangle-flipxy', 0.03),
];

describe('GDI ground-truth parity', () => {
	describe('ROP3 raster operations', () => {
		it.each(ROP3_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
			const diff = await compareFixture(c.name, c.ext, c.tolerance);
			expect(diff).not.toBeNull();
			expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
		});
	});

	describe('linear gradient WrapMode tiling', () => {
		it.each(LINEAR_TILE_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
			const diff = await compareFixture(c.name, c.ext, c.tolerance);
			expect(diff).not.toBeNull();
			expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
		});
	});

	describe('path gradient boundary shape + WrapMode tiling', () => {
		it.each(PATH_TILE_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
			const diff = await compareFixture(c.name, c.ext, c.tolerance);
			expect(diff).not.toBeNull();
			expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
		});
	});
});
