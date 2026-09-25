/**
 * Pixel parity against real Windows GDI / GDI+ output.
 *
 * Every fixture under `__fixtures__/gdi` pairs a metafile with a PNG of what
 * Windows itself painted for the same drawing calls (regenerate them with
 * `scripts/gdi-fixtures/generate.ps1` on Windows). Each case replays the
 * metafile at `dpiScale: 1` on the `@napi-rs/canvas` backend and bounds the
 * share of pixels whose largest channel differs by more than `tolerance`.
 * The harness aligns the two images by device coordinate (an EMF's canvas
 * starts at its header bounds, which a rotated shape can push above/left of
 * the device origin), so a residual is a real rendering difference, never
 * a registration offset.
 */
import { afterAll, beforeAll, describe, it, expect } from 'vitest';

import { compareFixture, renderFixture, windowsFonts } from './__fixtures__/gdi-parity-harness';
import { setSoftwareCanvasOnly } from './emf-canvas-helpers';
import type { EmfConvertOptions } from './index';

interface ParityCase {
	name: string;
	ext: 'emf' | 'wmf';
	/** Largest per-channel difference that still counts as a match. */
	tolerance: number;
	/** Largest share of mismatching pixels allowed (0 = pixel-exact). */
	maxMismatch: number;
	/** Converter options on top of `dpiScale: 1`. */
	options?: EmfConvertOptions;
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
 * across every WrapMode. Filled one device pixel at a time
 * (`pathGradientSampler`, `emf-plus-exact-fill.ts`): each pixel's integer
 * origin is folded into the boundary's tile per WrapMode (mirrored tiles
 * one device pixel off a mathematical mirror, as GDI+ mirrors its raster
 * texel-for-texel) instead of reading a supersampled, filtered
 * `CanvasPattern`, and a curved boundary is flattened at GDI+'s own 0.25
 * flatness. Measured mismatch: 0% for the rectangle in every mode, at most
 * 0.013% for the Clamp cases, and 0.10% to 0.14% for the tiled ellipse and
 * triangle (single pixels where the flattened boundary edge itself rounds
 * the other way), down from 0.4% to 6.5% with the pattern.
 */
const PATH_TILE_CASES: ParityCase[] = [
	close('grad-path-ellipse-clamp', 0.001),
	close('grad-path-ellipse-tile', 0.003),
	close('grad-path-ellipse-flipx', 0.003),
	close('grad-path-ellipse-flipy', 0.003),
	close('grad-path-ellipse-flipxy', 0.003),
	close('grad-path-rect-blend-clamp', 0.001),
	close('grad-path-rect-blend-tile', 0.001),
	close('grad-path-rect-blend-flipx', 0.001),
	close('grad-path-rect-blend-flipy', 0.001),
	close('grad-path-rect-blend-flipxy', 0.001),
	close('grad-path-triangle-clamp', 0.001),
	close('grad-path-triangle-tile', 0.003),
	close('grad-path-triangle-flipx', 0.003),
	close('grad-path-triangle-flipy', 0.003),
	close('grad-path-triangle-flipxy', 0.003),
];

/**
 * GDI DIB/monochrome pattern-brush FILLS (Rectangle/Ellipse/Polygon/
 * RoundRect), not blits: exercises `fillCurrentPathWithGdiPattern`
 * (`emf-gdi-shape-paint.ts`), which fills the shape's path exactly, one
 * device pixel at a time, sampled at GDI's own pixel centres, using the
 * same `sampleTile` sampler the exact ROP3 blit evaluator uses. The 1px pen
 * outline is aligned to GDI's pixel grid (`gdiStrokeAlign`), so the
 * axis-aligned cases are exact but for a handful of hairline corner pixels;
 * the ellipse's and polygon's curved/diagonal outline is still Canvas's
 * antialiased `stroke()` by default (see the `gdiAntialias: false` block
 * below for the non-antialiased mode). `maxMismatch` is set from the ratio
 * measured against real GDI fixtures (see
 * `src/__fixtures__/gdi/pattern-fill-*`), with headroom.
 */
const PATTERN_FILL_CASES: ParityCase[] = [
	close('pattern-fill-rect-mono', 0.005), // measured 0.02%
	close('pattern-fill-rect-color', 0.002), // measured 0.00%
	close('pattern-fill-ellipse-color', 0.04), // measured 3.08%
	close('pattern-fill-polygon-color', 0.035), // measured 2.52%
	close('pattern-fill-roundrect-mono', 0.01), // measured 0.62%
];

/**
 * GDI world-transform rotation/skew (`EMR_SETWORLDTRANSFORM`) applied to
 * plain-GDI vector drawing: Rectangle, Ellipse, Polygon, and RoundRect,
 * under a rotated or skewed (non-axis-aligned) transform. Exercises
 * `gmapPoint` (full-affine point mapping) and `gdiEllipseParams` (affine
 * ellipse decomposition via eigendecomposition) in `emf-gdi-coord.ts`, and
 * the rounded rectangle's logical-space Bezier corners mapped through the
 * full affine (`appendRoundRectPath`, `emf-gdi-draw-shapes.ts`).
 * `maxMismatch` is the Canvas-antialiasing-vs-GDI residual along the
 * rotated edges, where every boundary pixel is partly covered (the
 * `gdiAntialias: false` block below takes it to near zero); see
 * `src/__fixtures__/gdi/rotate-*` and `skew-rect`.
 * `rotate-rect-25deg` measured 9.79% before the harness aligned images by
 * device coordinate: the shape reaches above the device origin, so its EMF
 * bounds (and the replayed canvas) start at y = -7.
 */
const ROTATION_CASES: ParityCase[] = [
	close('rotate-rect-25deg', 0.02), // measured 1.32%
	close('rotate-ellipse-40deg', 0.025), // measured 1.91%
	close('rotate-polygon-15deg', 0.03), // measured 2.07%
	close('rotate-roundrect-30deg', 0.03), // measured 2.27%
	close('skew-rect', 0.025), // measured 1.73%
];

/**
 * Exact bitwise `SetROP2` combine (`emf-rop2-exact.ts`) for the AND/OR/XOR
 * family of modes (`R2_MASKPEN`, `R2_MERGEPEN`, `R2_XORPEN`, and their
 * `NOT*` variants), a single grid fixture covering all 16 `SetROP2` modes
 * as a filled + stroked Rectangle over a striped background. The bitwise
 * modes combine per pixel with binary (non-antialiased) coverage, the pen
 * border on GDI's pixel grid and the brush on the Rectangle's interior only
 * (GDI never combines a border pixel twice); the residual is in the modes
 * Canvas composites natively, whose fill edge stays antialiased by default.
 * See `src/__fixtures__/gdi/rop2-bitwise-grid`.
 */
const ROP2_EXACT_CASES: ParityCase[] = [
	close('rop2-bitwise-grid', 0.005), // measured 0.23%
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
	close('rop2-bitwise-path-bracket', 0.03), // measured 2.11%
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
	close('rotate-bitblt-25deg', 0.01), // measured 0.67%
	close('rotate-text-25deg', 0.035), // measured 2.39%
];

/**
 * The same GDI vector fixtures with `gdiAntialias: false`: every fill and
 * stroke rasterised one device pixel at a time, without antialiasing, on
 * GDI's own pixel grid (fills point-sampled at GDI's pixel centres with its
 * top-left rule, 1px strokes along pixel centres). What is left is
 * single-pixel stepping differences along steep lines and curves (GDI's
 * own line DDA picks a neighbouring pixel at some steps).
 */
const aliased = (name: string, maxMismatch: number): ParityCase => ({
	...close(name, maxMismatch),
	options: { gdiAntialias: false },
});

const ALIASED_CASES: ParityCase[] = [
	aliased('pattern-fill-rect-mono', 0.001), // measured 0.00%
	aliased('pattern-fill-rect-color', 0.001), // measured 0.00%
	aliased('pattern-fill-ellipse-color', 0.003), // measured 0.14%
	aliased('pattern-fill-polygon-color', 0.001), // measured 0.01%
	aliased('pattern-fill-roundrect-mono', 0.001), // measured 0.00%
	aliased('rotate-rect-25deg', 0.001), // measured 0.01%
	aliased('rotate-ellipse-40deg', 0.002), // measured 0.10%
	aliased('rotate-polygon-15deg', 0.001), // measured 0.03%
	aliased('rotate-roundrect-30deg', 0.002), // measured 0.10%
	aliased('skew-rect', 0.004), // measured 0.22%
	aliased('rop2-bitwise-grid', 0.001), // measured 0.00%
	aliased('rop2-bitwise-path-bracket', 0.003), // measured 0.18%
];

/**
 * EMF+ `DrawImage` of a standalone Image object recorded as a real,
 * PNG-backed `Bitmap` (`BitmapDataType` = Compressed per [MS-EMFPLUS]
 * 2.1.1.2; see `parseEmfPlusImageObject`, `emf-plus-object-complex.ts`),
 * drawn at a 2x and a non-integer scale. Resampled per device pixel the way
 * GDI+ does under its default InterpolationMode Bilinear and PixelOffsetMode
 * None (`emf-plus-image-resample.ts`) rather than by Canvas `drawImage`:
 * measured 0% mismatch (down from 17.8%). Not `exact()`: about 0.2% of the
 * pixels still differ by a few levels of blend rounding (well inside the
 * 8-level tolerance).
 */
const IMAGE_DRAW_CASES: ParityCase[] = [close('image-draw-png', 0.001)];

/**
 * An EMF+ TextureFill brush (`emf-plus-brush-parser.ts`) whose embedded
 * image is a real, PNG-backed `Bitmap`: .NET's EMF+ recorder always
 * serialises this as a compressed image (see the note in `GdiFixtures.cs`),
 * exercising the async pre-decode pass (`emf-plus-texture-predecode.ts`)
 * rather than the synchronous uncompressed-pixel-bitmap path the unit tests
 * already cover. Pixel-exact: the fill samples the texture per device pixel
 * (`textureSampler`, `emf-plus-exact-fill.ts`) and composites it unfiltered,
 * instead of painting through a `CanvasPattern` (which every tested canvas
 * backend filters even at an identity matrix, 25% mismatch here).
 */
const TEXTURE_FILL_CASES: ParityCase[] = [exact('texture-fill-compressed')];

/**
 * Text drawn by the GDI font engine (`EmfConvertOptions.fonts`, see
 * `gdi-font-engine.ts`) from the same Windows font files GDI used: the
 * `text-*` WMF fixtures and the `textx-*` sheets (category `text-extra` in
 * `GdiFixtures.cs`): five faces at 8..72 px in every LOGFONT quality, both
 * lfHeight signs, weights, italic, underline, strike-out, lfWidth, Dx /
 * ETO_PDY / ETO_OPAQUE / ETO_CLIPPED / ETO_GLYPH_INDEX, every TA_*
 * alignment and TA_UPDATECP, OPAQUE backgrounds, escapement, world
 * rotation, the same through WMF, and EMF+ DrawString per
 * TextRenderingHint. `maxMismatch` is the measured share (tolerance 8)
 * with headroom; the comments give the measurement.
 *
 * What is left, by category (details in the module docs):
 * - non-antialiased (mono) text: under 0.03% on every sheet, a handful of
 *   single pixels per line where GDI's grid-fitting of a diagonal stroke
 *   differs from this interpreter by 1/64 pixel;
 * - grayscale (ANTIALIASED_QUALITY): the same, plus GDI's
 *   luminance-dependent contrast for coloured text (`textx-color-aa`);
 * - ClearType (also DEFAULT/DRAFT/PROOF_QUALITY, which Windows renders as
 *   ClearType): 3..10%, GDI's "compatible width" ClearType grid-fitting is
 *   approximated;
 * - rotated text: glyphs at non-axis angles and GDI's rounded rotation
 *   matrix (0.3..1.5%);
 * - EMF+ AntiAlias / SingleBitPerPixel / ClearType hints: GDI+'s own
 *   rasterizer and layout, approximated;
 * - `Helv` and `MS Shell Dlg` at a cell height: GDI used the bitmap
 *   `MS Sans Serif` (.fon), which is not supported.
 */
const fontCase = (name: string, ext: 'emf' | 'wmf', maxMismatch: number): ParityCase => ({
	name,
	ext,
	tolerance: 8,
	maxMismatch,
});

const FONT_ENGINE_CASES: ParityCase[] = [
	fontCase('rotate-text-25deg', 'emf', 0.0182), // measured 1.460%
	fontCase('text-arial-hm13', 'wmf', 0.0006), // measured 0.029%
	fontCase('text-arial-hm20', 'wmf', 0.0004), // measured 0.007%
	fontCase('text-arial-hp18', 'wmf', 0), // measured 0.000%
	fontCase('text-couriernew-hm13', 'wmf', 0), // measured 0.000%
	fontCase('text-couriernew-hm20', 'wmf', 0), // measured 0.000%
	fontCase('text-couriernew-hp18', 'wmf', 0), // measured 0.000%
	fontCase('text-helv-hm13', 'wmf', 0.029), // measured 2.307%
	fontCase('text-helv-hm20', 'wmf', 0.12), // measured 9.571%
	fontCase('text-helv-hp18', 'wmf', 0.0635), // measured 5.078%
	fontCase('text-msshelldlg-hm13', 'wmf', 0.0009), // measured 0.057%
	fontCase('text-msshelldlg-hm20', 'wmf', 0), // measured 0.000%
	fontCase('text-msshelldlg-hp18', 'wmf', 0.051), // measured 4.071%
	fontCase('text-nosuchfacexyz-hm13', 'wmf', 0), // measured 0.000%
	fontCase('text-nosuchfacexyz-hm20', 'wmf', 0), // measured 0.000%
	fontCase('text-nosuchfacexyz-hp18', 'wmf', 0.0005), // measured 0.021%
	fontCase('text-timesnewroman-hm13', 'wmf', 0), // measured 0.000%
	fontCase('text-timesnewroman-hm20', 'wmf', 0), // measured 0.000%
	fontCase('text-timesnewroman-hp18', 'wmf', 0), // measured 0.000%
	fontCase('textx-align-mono', 'emf', 0), // measured 0.000%
	fontCase('textx-arial-aa', 'emf', 0.0015), // measured 0.122%
	fontCase('textx-arial-cell-mono', 'emf', 0.0005), // measured 0.019%
	fontCase('textx-arial-cleartype', 'emf', 0.1009), // measured 8.074%
	fontCase('textx-arial-ctnatural', 'emf', 0.21), // measured 16.501%
	fontCase('textx-arial-mono', 'emf', 0.0005), // measured 0.017%
	fontCase('textx-arial-q0-default', 'emf', 0.1009), // measured 8.074%
	fontCase('textx-arial-q1-draft', 'emf', 0.1009), // measured 8.074%
	fontCase('textx-arial-q2-proof', 'emf', 0.1009), // measured 8.074%
	fontCase('textx-arial-styles-aa', 'emf', 0.0009), // measured 0.059%
	fontCase('textx-arial-styles-mono', 'emf', 0.0006), // measured 0.027%
	fontCase('textx-color-aa', 'emf', 0.017), // measured 1.352%
	fontCase('textx-color-cleartype', 'emf', 0.036), // measured 2.850%
	fontCase('textx-color-mono', 'emf', 0.0003), // measured 0.005%
	fontCase('textx-couriernew-aa', 'emf', 0.0004), // measured 0.010%
	fontCase('textx-couriernew-cell-mono', 'emf', 0.0004), // measured 0.011%
	fontCase('textx-couriernew-mono', 'emf', 0.0004), // measured 0.010%
	fontCase('textx-couriernew-styles-mono', 'emf', 0.0004), // measured 0.012%
	fontCase('textx-escapement-aa', 'emf', 0.0034), // measured 0.270%
	fontCase('textx-escapement-mono', 'emf', 0.0034), // measured 0.270%
	fontCase('textx-eto-aa', 'emf', 0.0062), // measured 0.499%
	fontCase('textx-eto-mono', 'emf', 0.0054), // measured 0.435%
	fontCase('textx-opaque-aa', 'emf', 0.0003), // measured 0.001%
	fontCase('textx-opaque-mono', 'emf', 0.0003), // measured 0.004%
	fontCase('textx-plus-antialias', 'emf', 0.204), // measured 16.320%
	fontCase('textx-plus-antialiasgridfit', 'emf', 0.068), // measured 5.405%
	fontCase('textx-plus-cleartype', 'emf', 0.1827), // measured 14.615%
	fontCase('textx-plus-singlebit', 'emf', 0.12), // measured 9.420%
	fontCase('textx-plus-singlebitgridfit', 'emf', 0.0009), // measured 0.065%
	fontCase('textx-plus-systemdefault', 'emf', 0.0009), // measured 0.065%
	fontCase('textx-segoeui-aa', 'emf', 0.0006), // measured 0.031%
	fontCase('textx-segoeui-cell-mono', 'emf', 0.0012), // measured 0.086%
	fontCase('textx-segoeui-cleartype', 'emf', 0.073), // measured 5.832%
	fontCase('textx-segoeui-mono', 'emf', 0.0004), // measured 0.015%
	fontCase('textx-segoeui-styles-mono', 'emf', 0.0004), // measured 0.007%
	fontCase('textx-tahoma-aa', 'emf', 0.0012), // measured 0.092%
	fontCase('textx-tahoma-cell-mono', 'emf', 0.0005), // measured 0.019%
	fontCase('textx-tahoma-mono', 'emf', 0.0005), // measured 0.020%
	fontCase('textx-tahoma-styles-mono', 'emf', 0.0006), // measured 0.028%
	fontCase('textx-timesnewroman-aa', 'emf', 0.0012), // measured 0.092%
	fontCase('textx-timesnewroman-cell-mono', 'emf', 0.0005), // measured 0.019%
	fontCase('textx-timesnewroman-mono', 'emf', 0.0004), // measured 0.013%
	fontCase('textx-timesnewroman-styles-mono', 'emf', 0.0004), // measured 0.012%
	fontCase('textx-wmf-align-mono', 'wmf', 0), // measured 0.000%
	fontCase('textx-wmf-arial-aa', 'wmf', 0.0015), // measured 0.122%
	fontCase('textx-wmf-arial-mono', 'wmf', 0.0005), // measured 0.017%
	fontCase('textx-wmf-arial-styles-mono', 'wmf', 0.0006), // measured 0.027%
	fontCase('textx-wmf-couriernew-mono', 'wmf', 0.0004), // measured 0.010%
	fontCase('textx-wmf-escapement-mono', 'wmf', 0.0038), // measured 0.305%
	fontCase('textx-wmf-eto-mono', 'wmf', 0.0003), // measured 0.004%
	fontCase('textx-wmf-opaque-mono', 'wmf', 0.0003), // measured 0.004%
	fontCase('textx-wmf-segoeui-mono', 'wmf', 0.0004), // measured 0.015%
	fontCase('textx-wmf-tahoma-mono', 'wmf', 0.0005), // measured 0.020%
	fontCase('textx-wmf-timesnewroman-cell-mono', 'wmf', 0.0006), // measured 0.028%
	fontCase('textx-wmf-timesnewroman-mono', 'wmf', 0.0005), // measured 0.020%
	fontCase('textx-wmf-timesnewroman-styles-mono', 'wmf', 0.0004), // measured 0.012%
	fontCase('textx-world-aa', 'emf', 0.0043), // measured 0.346%
	fontCase('textx-world-mono', 'emf', 0.0035), // measured 0.282%
];

describe('GDI ground-truth parity', () => {
	describe('ROP3 raster operations', () => {
		it.each(ROP3_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
			const diff = await compareFixture(c.name, c.ext, c.tolerance, c.options);
			expect(diff).not.toBeNull();
			expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
		});
	});

	describe('linear gradient WrapMode tiling', () => {
		it.each(LINEAR_TILE_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
			const diff = await compareFixture(c.name, c.ext, c.tolerance, c.options);
			expect(diff).not.toBeNull();
			expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
		});
	});

	describe('path gradient boundary shape + WrapMode tiling', () => {
		it.each(PATH_TILE_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
			const diff = await compareFixture(c.name, c.ext, c.tolerance, c.options);
			expect(diff).not.toBeNull();
			expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
		});
	});

	describe('GDI pattern-brush fills (Rectangle/Ellipse/Polygon/RoundRect)', () => {
		it.each(PATTERN_FILL_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
			const diff = await compareFixture(c.name, c.ext, c.tolerance, c.options);
			expect(diff).not.toBeNull();
			expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
		});
	});

	describe('GDI world-transform rotation/skew', () => {
		it.each(ROTATION_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
			const diff = await compareFixture(c.name, c.ext, c.tolerance, c.options);
			expect(diff).not.toBeNull();
			expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
		});
	});

	describe('exact bitwise ROP2 modes', () => {
		it.each(ROP2_EXACT_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
			const diff = await compareFixture(c.name, c.ext, c.tolerance, c.options);
			expect(diff).not.toBeNull();
			expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
		});
	});

	describe('rotated world-transform bitmap blits and text placement', () => {
		it.each(ROTATION_AFFINE_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
			const diff = await compareFixture(c.name, c.ext, c.tolerance, c.options);
			expect(diff).not.toBeNull();
			expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
		});
	});

	describe('GDI vector shapes with gdiAntialias: false', () => {
		it.each(ALIASED_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
			const diff = await compareFixture(c.name, c.ext, c.tolerance, c.options);
			expect(diff).not.toBeNull();
			expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
		});
	});

	describe('EMF+ DrawImage of a real PNG-backed Bitmap', () => {
		it.each(IMAGE_DRAW_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
			const diff = await compareFixture(c.name, c.ext, c.tolerance, c.options);
			expect(diff).not.toBeNull();
			expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
		});
	});

	describe.skipIf(!windowsFonts())('GDI text via the font engine (Windows fonts)', () => {
		it.each(FONT_ENGINE_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
			const diff = await compareFixture(c.name, c.ext, c.tolerance, { fonts: windowsFonts()!, ...c.options });
			expect(diff).not.toBeNull();
			expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
		});
	});

	describe('EMF+ TextureFill brush with a compressed embedded image', () => {
		it.each(TEXTURE_FILL_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
			const diff = await compareFixture(c.name, c.ext, c.tolerance, c.options);
			expect(diff).not.toBeNull();
			expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
		});
	});
});

/**
 * The same cases rendered by the built-in pure-JavaScript rasteriser
 * (`software-raster.ts`), as in plain Node.js without `@napi-rs/canvas`.
 * Every bound above holds unchanged: the ROP3 cases and the texture fill
 * stay pixel-exact (raster-op evaluation is exact given exact operands),
 * and the anti-aliased cases differ from the `@napi-rs/canvas` output only
 * along edges, where this rasteriser's coverage is the exact covered area
 * (Skia's approximates it; see `software-raster-coverage.ts`). Measured
 * against GDI: rotate-ellipse-40deg 2.00% (napi 1.91%), rotate-bitblt-25deg
 * 0.81% (0.67%), rop2-bitwise-grid 0.28% (0.23%), pattern-fill-ellipse-color
 * 3.01% (3.08%), every other case equal to the napi figure. Text cannot be
 * rasterised without a font engine, so the text fixture yields no PNG.
 */
describe('GDI ground-truth parity through the pure-JavaScript rasteriser (no canvas backend)', () => {
	beforeAll(() => setSoftwareCanvasOnly(true));
	afterAll(() => setSoftwareCanvasOnly(false));

	const cases = [
		...ROP3_CASES,
		...LINEAR_TILE_CASES,
		...PATH_TILE_CASES,
		...PATTERN_FILL_CASES,
		...ROTATION_CASES,
		...ROP2_EXACT_CASES,
		...ROTATION_AFFINE_CASES.filter((c) => c.name !== 'rotate-text-25deg'),
		...ALIASED_CASES,
		...IMAGE_DRAW_CASES,
		...TEXTURE_FILL_CASES,
	];
	it.each(cases.map((c) => [`${c.name}${c.options ? ' (gdiAntialias: false)' : ''}`, c] as const))('%s', async (_name, c) => {
		const diff = await compareFixture(c.name, c.ext, c.tolerance, c.options);
		expect(diff).not.toBeNull();
		expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
	});

	it('returns no PNG for a metafile with text', async () => {
		expect(await renderFixture('rotate-text-25deg.emf')).toBeNull();
	});
});