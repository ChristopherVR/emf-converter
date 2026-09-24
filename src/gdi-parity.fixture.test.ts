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

/**
 * GDI DIB/monochrome pattern-brush FILLS (Rectangle/Ellipse/Polygon/
 * RoundRect), not blits: exercises `fillCurrentPathWithGdiPattern`
 * (`emf-gdi-shape-paint.ts`), which fills the shape's path exactly, one
 * device pixel at a time, using the same `sampleTile` sampler the exact
 * ROP3 blit evaluator uses. Not `exact()`/tolerance-0 because a non-hatch
 * pattern-fill vector shape's own boundary (an ellipse's curve, a rotated
 * polygon's diagonal edge, a rounded rectangle's corner arc) is still drawn
 * by Canvas's own anti-aliased `fill()`/`stroke()`, which does not exactly
 * match GDI's non-antialiased edge rasterisation; the pattern itself is
 * pixel-exact in the interior. `maxMismatch` is set from the ratio measured
 * against real GDI fixtures (see `src/__fixtures__/gdi/pattern-fill-*`),
 * with headroom.
 */
const PATTERN_FILL_CASES: ParityCase[] = [
	close('pattern-fill-rect-mono', 0.06),
	close('pattern-fill-rect-color', 0.05),
	close('pattern-fill-ellipse-color', 0.05),
	close('pattern-fill-polygon-color', 0.05),
	close('pattern-fill-roundrect-mono', 0.06),
];

/**
 * GDI world-transform rotation/skew (`EMR_SETWORLDTRANSFORM`) applied to
 * plain-GDI vector drawing: Rectangle, Ellipse, Polygon, and RoundRect,
 * under a rotated or skewed (non-axis-aligned) transform. Exercises
 * `gmapPoint` (full-affine point mapping) and `gdiEllipseParams` (affine
 * ellipse decomposition via eigendecomposition) in `emf-gdi-coord.ts`.
 * `maxMismatch` reflects the same Canvas-anti-aliasing-vs-GDI residual as
 * the pattern-fill cases above, now compounded by the rotation itself
 * touching every boundary pixel (there are no axis-aligned edges left to
 * rasterise exactly); see `src/__fixtures__/gdi/rotate-*` and `skew-rect`.
 */
const ROTATION_CASES: ParityCase[] = [
	close('rotate-rect-25deg', 0.15),
	close('rotate-ellipse-40deg', 0.05),
	close('rotate-polygon-15deg', 0.05),
	close('rotate-roundrect-30deg', 0.06),
	close('skew-rect', 0.05),
];

/**
 * Exact bitwise `SetROP2` combine (`emf-rop2-exact.ts`) for the AND/OR/XOR
 * family of modes (`R2_MASKPEN`, `R2_MERGEPEN`, `R2_XORPEN`, and their
 * `NOT*` variants), a single grid fixture covering all 16 `SetROP2` modes
 * as a filled + stroked Rectangle over a striped background. Not
 * `exact()`/tolerance-0: each cell's 1px pen stroke is still Canvas's own
 * anti-aliased line, not GDI's non-antialiased one; the bitwise-combined
 * fill interior is pixel-exact. See `src/__fixtures__/gdi/rop2-bitwise-grid`.
 */
const ROP2_EXACT_CASES: ParityCase[] = [
	close('rop2-bitwise-grid', 0.15),
	/**
	 * Same 16 modes, but the shape is a `BeginPath`/`EndPath` bracket
	 * (`MoveToEx`/`LineTo`/`CloseFigure`) filled+stroked via
	 * `StrokeAndFillPath`, not an immediate `Rectangle`. Exercises the path
	 * recording in `emf-gdi-path-record.ts` that lets `EMR_FILLPATH`/
	 * `EMR_STROKEANDFILLPATH`/`EMR_STROKEPATH` replay a bracketed path onto
	 * the exact-ROP2 scratch canvas the same way an immediate shape already
	 * could; before that, a bracketed path never reached the exact bitwise
	 * combine and used the `darken`/`lighten`/`difference` approximation
	 * unconditionally (a documented residual, now closed).
	 */
	close('rop2-bitwise-path-bracket', 0.12),
];

/**
 * Rotated/skewed `EMR_SETWORLDTRANSFORM` applied to bitmap blits and raster
 * text placement (`emf-gdi-draw-bitmap.ts`'s `executeRotatedBlit`,
 * `emf-gdi-draw-text.ts`'s `handleExtTextOutW`). Real GDI DOES rotate both
 * under a rotated world transform (confirmed against these exact fixtures:
 * the reference PNG is painted by the identical GDI calls under the same
 * transform). Not `exact()`: a rotated raster necessarily resamples at
 * every output pixel (`rotate-bitblt-25deg`), and glyph rasterisation
 * already differs from GDI's own font engine even without rotation
 * (`rotate-text-25deg`).
 */
const ROTATION_AFFINE_CASES: ParityCase[] = [
	close('rotate-bitblt-25deg', 0.02),
	close('rotate-text-25deg', 0.05),
];

/**
 * EMF+ `DrawImage` of a standalone Image object recorded as a real,
 * PNG-backed `Bitmap` (`BitmapDataType` = Compressed per [MS-EMFPLUS]
 * 2.1.1.2; see `parseEmfPlusImageObject`, `emf-plus-object-complex.ts`).
 * `close()` rather than `exact()`: DrawImage resamples the source bitmap
 * (a 2x and a non-integer scale here), and the two DrawImage calls are
 * verified to land in the right place with the right content, not to be
 * byte-identical to GDI+'s own resampler.
 */
const IMAGE_DRAW_CASES: ParityCase[] = [close('image-draw-png', 0.22)];

/**
 * An EMF+ TextureFill brush (`emf-plus-brush-parser.ts`) whose embedded
 * image is a real, PNG-backed `Bitmap`: .NET's EMF+ recorder always
 * serialises this as a compressed image (see the note in `GdiFixtures.cs`),
 * exercising the async pre-decode pass (`emf-plus-texture-predecode.ts`)
 * rather than the synchronous uncompressed-pixel-bitmap path the unit tests
 * already cover. `close()`, not `exact()`: the tile is painted through a
 * Canvas `CanvasPattern`, which every tested canvas backend filters at tile
 * seams regardless of `imageSmoothingEnabled` (the same pre-existing,
 * separately-documented residual as the GDI pattern-brush-fill cases
 * above); a coarse (8px) test block keeps this measurement about the
 * decode-and-paint path working, not that residual.
 */
const TEXTURE_FILL_CASES: ParityCase[] = [close('texture-fill-compressed', 0.28)];

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

	describe('GDI pattern-brush fills (Rectangle/Ellipse/Polygon/RoundRect)', () => {
		it.each(PATTERN_FILL_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
			const diff = await compareFixture(c.name, c.ext, c.tolerance);
			expect(diff).not.toBeNull();
			expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
		});
	});

	describe('GDI world-transform rotation/skew', () => {
		it.each(ROTATION_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
			const diff = await compareFixture(c.name, c.ext, c.tolerance);
			expect(diff).not.toBeNull();
			expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
		});
	});

	describe('exact bitwise ROP2 modes', () => {
		it.each(ROP2_EXACT_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
			const diff = await compareFixture(c.name, c.ext, c.tolerance);
			expect(diff).not.toBeNull();
			expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
		});
	});

	describe('rotated world-transform bitmap blits and text placement', () => {
		it.each(ROTATION_AFFINE_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
			const diff = await compareFixture(c.name, c.ext, c.tolerance);
			expect(diff).not.toBeNull();
			expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
		});
	});

	describe('EMF+ DrawImage of a real PNG-backed Bitmap', () => {
		it.each(IMAGE_DRAW_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
			const diff = await compareFixture(c.name, c.ext, c.tolerance);
			expect(diff).not.toBeNull();
			expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
		});
	});

	describe('EMF+ TextureFill brush with a compressed embedded image', () => {
		it.each(TEXTURE_FILL_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
			const diff = await compareFixture(c.name, c.ext, c.tolerance);
			expect(diff).not.toBeNull();
			expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
		});
	});
});
