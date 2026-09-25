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
 * A gradient/image case measured pixel-for-pixel: every channel within one
 * level (GDI+'s own fixed-point rounding) and no pixel beyond it.
 */
const levelExact = (name: string, options?: EmfConvertOptions): ParityCase => ({
	name,
	ext: 'emf',
	tolerance: 1,
	maxMismatch: 0,
	options,
});

/**
 * Linear-gradient WrapMode tiling (Tile/TileFlipX/TileFlipY/TileFlipXY) at a
 * horizontal angle, a 30-degree angle, an arbitrary shear+blend transform,
 * and preset (InterpolationColors) stops at 120 degrees. Painted per device
 * pixel with GDI+'s own interpolation table (`emf-plus-linear-ramp.ts`:
 * 16/64/256 knots rounded to 8 bits, 16.16 fixed-point ramp coordinates,
 * a doubled table for TileFlipX), so every pixel is within one level of
 * GDI+ (down from 1.46% of pixels beyond 8 levels on the preset-colours
 * case, which a plain gradient through the exact preset stops left, and a
 * seam pixel one period off on the sheared blend case). The one-level
 * residue is GDI+'s float rounding of exact-tie blend knots.
 */
const LINEAR_TILE_CASES: ParityCase[] = [
	levelExact('grad-linear-h-tile'),
	levelExact('grad-linear-h-flipx'),
	levelExact('grad-linear-h-flipy'),
	levelExact('grad-linear-h-flipxy'),
	levelExact('grad-linear-a30-tile'),
	levelExact('grad-linear-a30-flipx'),
	levelExact('grad-linear-a30-flipy'),
	levelExact('grad-linear-a30-flipxy'),
	levelExact('grad-linear-skew-blend-tile'),
	levelExact('grad-linear-skew-blend-flipx'),
	levelExact('grad-linear-skew-blend-flipy'),
	levelExact('grad-linear-skew-blend-flipxy'),
	levelExact('grad-linear-preset-a120-tile'),
	levelExact('grad-linear-preset-a120-flipx'),
	levelExact('grad-linear-preset-a120-flipy'),
	levelExact('grad-linear-preset-a120-flipxy'),
];

/**
 * GDI+'s linear-gradient interpolation table in the cases that decide its
 * size and shape (`emf-plus-linear-ramp.ts`): five preset colours on a
 * brush rectangle whose w + h picks a 16-, 64- and 256-interval table,
 * `SetSigmaBellShape` (hundreds of blend points), `SetBlendTriangularShape`
 * (three), `GammaCorrection` on a two-colour and a preset ramp,
 * translucent end colours, and `PixelOffsetMode` Half. All within one
 * level of GDI+ on every pixel. `gpx-lin-blend-ellipse` (four blend
 * factors, rotated, on an ellipse) is level-exact inside the shape; its
 * curved edge is Canvas antialiasing where GDI+'s default SmoothingMode
 * paints aliased pixels (see the `gdiAntialias: false` block below).
 */
const LINEAR_RAMP_CASES: ParityCase[] = [
	levelExact('gpx-lin-preset5-small'),
	levelExact('gpx-lin-preset5-large'),
	levelExact('gpx-lin-preset5-huge'),
	levelExact('gpx-lin-sigma'),
	levelExact('gpx-lin-triangular'),
	levelExact('gpx-lin-gamma'),
	levelExact('gpx-lin-gamma-preset'),
	levelExact('gpx-lin-alpha'),
	levelExact('gpx-lin-pixeloffset-half'),
	close('gpx-lin-blend-ellipse', 0.03), // measured 2.41% (antialiased edge only)
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
 * transform). The blit maps every device pixel of the FIX parallelogram
 * back to one source texel, as GDI does, instead of resampling a local
 * raster: measured 0.005% (one pixel whose centre maps exactly onto a
 * texel boundary), down from 0.67%. Glyph rasterisation already differs
 * from GDI's own font engine even without rotation (`rotate-text-25deg`).
 */
const ROTATION_AFFINE_CASES: ParityCase[] = [
	close('rotate-bitblt-25deg', 0.001), // measured 0.005%
	close('rotate-text-25deg', 0.035), // measured 2.39%
];

/**
 * The same GDI vector fixtures with `gdiAntialias: false`: every fill and
 * stroke goes through the GDI rasteriser (`gdi-raster.ts`): GDI's exact
 * 28.4 geometry (point mapping, ellipse and rounded-rectangle Beziers,
 * fixed-point Bezier flattening), its polygon fill rule and its one-pixel
 * line algorithm. Every one of them is pixel-exact at tolerance 0 (they
 * measured 0.01% to 0.22% with the previous per-pixel `isPointInPath`
 * sampling).
 */
const aliased = (name: string): ParityCase => ({
	...exact(name),
	options: { gdiAntialias: false },
});

const ALIASED_CASES: ParityCase[] = [
	aliased('pattern-fill-rect-mono'),
	aliased('pattern-fill-rect-color'),
	aliased('pattern-fill-ellipse-color'), // was 0.14%
	aliased('pattern-fill-polygon-color'), // was 0.01%
	aliased('pattern-fill-roundrect-mono'),
	aliased('rotate-rect-25deg'), // was 0.01%
	aliased('rotate-ellipse-40deg'), // was 0.10%
	aliased('rotate-polygon-15deg'), // was 0.03%
	aliased('rotate-roundrect-30deg'), // was 0.10%
	aliased('skew-rect'), // was 0.22%
	aliased('rop2-bitwise-grid'),
	aliased('rop2-bitwise-path-bracket'), // was 0.18%
];

/**
 * The `gdi-raster` fixtures (`scripts/gdi-fixtures/GdiFixtures.cs`,
 * `RasterCases`): cosmetic lines at every angle (integer and 28.4 end
 * points), polylines and Beziers, ellipses of every size 1..18 (pen, null
 * pen, rotated, skewed, mirrored), rounded rectangles, arcs/pies/chords in
 * both directions, ALTERNATE vs WINDING polygon fills, bracketed paths, XOR
 * double-combination, cosmetic and geometric pen styles, wide pens with
 * every cap and join, rotated/mirrored/stretched/skewed blits, and a
 * 800-shape benchmark drawing. Under `gdiAntialias: false`:
 *   - exact at tolerance 0: everything but the rows below;
 *   - `raster-arcs`, `raster-paths`: a partial arc's control and end points
 *     are one FIX (1/16 px) off GDI's at about one arc in three (GDI's own
 *     trigonometry is slightly less precise than ours), moving a few pixels;
 *   - `raster-wide-pens`, `raster-wide-joins`, `raster-dash-geometric`: GDI
 *     adjusts its pen nib per segment slope and places flat/square caps and
 *     miter/bevel joins by its own rounding, which `gdi-raster-widen.ts`
 *     approximates;
 *   - `raster-blit-rotated`: about one blit in seven maps a handful of edge
 *     texels one texel off GDI's (random-probe evidence: 255 of 300 random
 *     rotated/mirrored/stretched/skewed blits pixel-exact).
 */
const raster = (name: string, maxMismatch = 0): ParityCase => ({
	name,
	ext: 'emf',
	tolerance: 0,
	maxMismatch,
	options: { gdiAntialias: false },
});

const RASTER_CASES: ParityCase[] = [
	raster('raster-lines-star'),
	raster('raster-lines-fractional'),
	raster('raster-polylines-beziers'),
	raster('raster-ellipses-sizes'),
	raster('raster-ellipses-nullpen'),
	raster('raster-ellipses-rotated'),
	raster('raster-roundrects'),
	raster('raster-pies-chords'),
	raster('raster-polygon-fillmodes'),
	raster('raster-rop2-shapes'),
	raster('raster-dash-cosmetic'),
	raster('raster-bench-shapes'),
	raster('raster-arcs', 0.002), // measured 0.117%
	raster('raster-paths', 0.001), // measured 0.057%
	raster('raster-blit-rotated', 0.005), // measured 0.350%
	raster('raster-wide-pens', 0.006), // measured 0.420%
	raster('raster-wide-joins', 0.013), // measured 0.991%
	raster('raster-dash-geometric', 0.045), // measured 3.943%
];

/**
 * The same fixtures in the default antialiased mode (tolerance 8). The
 * residual is the deliberate one: Canvas's antialiased edge pixels, which
 * differ from GDI's binary coverage along every edge (hence the high share
 * on drawings made of many small shapes, like `raster-bench-shapes`).
 * Everything that is not an edge (GDI's device geometry and flattened
 * curves for dashed pens, dash lengths and phase, pen widths, caps, joins,
 * pixel-grid alignment) follows GDI; the pattern-brush, bitwise-ROP2 and
 * rotated-blit content is exact in both modes (`raster-rop2-shapes` 0%).
 */
const RASTER_AA_CASES: ParityCase[] = [
	close('raster-lines-star', 0.14), // measured 11.97%
	close('raster-lines-fractional', 0.11), // measured 9.77%
	close('raster-polylines-beziers', 0.06), // measured 4.83%
	close('raster-ellipses-sizes', 0.12), // measured 10.83%
	close('raster-ellipses-nullpen', 0.05), // measured 3.87%
	close('raster-ellipses-rotated', 0.045), // measured 3.59%
	close('raster-roundrects', 0.045), // measured 3.70%
	close('raster-arcs', 0.04), // measured 3.21%
	close('raster-pies-chords', 0.065), // measured 5.65%
	close('raster-polygon-fillmodes', 0.05), // measured 3.94%
	close('raster-paths', 0.075), // measured 6.63%
	close('raster-rop2-shapes', 0.001), // measured 0.00%
	close('raster-dash-cosmetic', 0.1), // measured 8.71%
	close('raster-dash-geometric', 0.09), // measured 7.80%
	close('raster-wide-pens', 0.075), // measured 6.36%
	close('raster-wide-joins', 0.06), // measured 4.87%
	close('raster-blit-rotated', 0.005), // measured 0.35%
	close('raster-bench-shapes', 0.17), // measured 15.87%
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

/**
 * EMF+ `DrawImage` resampled per device pixel with each GDI+
 * InterpolationMode's own kernel (`emf-plus-image-resample.ts`, measured
 * from GDI+'s full weight matrices): NearestNeighbor (halves round up),
 * point-sampled Bilinear (Default, LowQuality) and Catmull-Rom Bicubic,
 * and the area-integrated, reduction-prefiltered HighQualityBilinear/
 * HighQualityBicubic (High), up- and down-scaled and non-uniform, under
 * every PixelOffsetMode. Before, only Bilinear/NearestNeighbor under None
 * were modelled and Bicubic/HQ fell back to Canvas scaling (39% to 46% of
 * pixels off). Every pixel within 8 levels of GDI+ (the largest channel
 * difference seen is 7, on Bicubic's clamped negative lobes).
 */
const IMAGE_MODE_CASES: ParityCase[] = [
	...[
		'nearestneighbor',
		'bilinear',
		'default',
		'low',
		'bicubic',
		'highqualitybilinear',
		'highqualitybicubic',
		'high',
		'pom-half-bilinear',
		'pom-half-highqualitybicubic',
		'pom-half-nearestneighbor',
		'pom-highquality-bilinear',
		'pom-highquality-highqualitybicubic',
		'pom-highquality-nearestneighbor',
		'pom-highspeed-bilinear',
		'pom-highspeed-highqualitybicubic',
		'pom-highspeed-nearestneighbor',
		'rotated-bilinear',
	].map((m) => close(`gpx-image-${m}`, 0)),
	// A rotated HighQualityBicubic draw: exact inside, a few edge pixels
	// fade differently (GDI+'s rotated high-quality edge is not modelled).
	close('gpx-image-rotated-highqualitybicubic', 0.003), // measured 0.14%
];

/**
 * In-order `DrawImage`: images are decoded before replay
 * (`emf-plus-image-predecode.ts`) and painted at their own record, under
 * the clip active there (a rectangle, then a rectangle minus another) and
 * beneath shapes recorded after them. Previously the PNG output painted
 * them after replay, on top of everything and unclipped.
 */
const IMAGE_ORDER_CASES: ParityCase[] = [close('gpx-image-clip-zorder', 0)];

/**
 * `DrawImage` with an ImageAttributes WrapMode (TileFlipXY, Tile, Clamp
 * with a clamp colour), whole images and a source sub-rectangle, under
 * Bilinear and HighQualityBicubic: the kernel's overhang reads the
 * bitmap's own texels and, beyond the bitmap, wraps or reads the clamp
 * colour. ImageAttributes objects were not parsed at all before (their
 * ObjectType, 8, was swapped with Region's, 4), so every edge faded to
 * transparent (4.9% to 13.2% of pixels off).
 */
const IMAGE_ATTRIBUTE_CASES: ParityCase[] = ['flipxy', 'tile', 'clamp'].flatMap((w) => [
	close(`gpx-image-attr-${w}-bilinear`, 0),
	close(`gpx-image-attr-${w}-highqualitybicubic`, 0),
]);

/**
 * `SetClip(Region)` from a real GDI+ recording (a union and an exclusion
 * of rectangles): the Region object (ObjectType 4) is parsed and applied.
 */
const REGION_CLIP_CASES: ParityCase[] = [exact('gpx-clipregion')];

/**
 * An EMF+ `DrawImage` of an embedded metafile, replayed record by record
 * into the destination (`emf-plus-draw-image.ts`) instead of rasterised
 * and scaled: scaled 1.5x/1.33x, and under a clip with later shapes over
 * it. Nested shape edges land where GDI+ puts them (its playback scales
 * about pixel centres); the residual is antialiased edges against GDI+'s
 * aliased ones (the `gdiAntialias: false` block takes it under 0.1%).
 */
const NESTED_METAFILE_CASES: ParityCase[] = [
	close('gpx-metafile-scaled', 0.05), // measured 4.57%
	close('gpx-metafile-clip-zorder', 0.03), // measured 2.31%
];

/**
 * TextureBrush fills scaled up, rotated and scaled down by the brush
 * transform, for every WrapMode: sampled bilinearly per device pixel, as
 * GDI+ samples a texture brush whatever the InterpolationMode (the
 * NearestNeighbor and HighQualityBicubic cases paint the identical bitmap
 * in GDI+), including PixelOffsetMode Half (`writeTextureColor`,
 * `emf-plus-brush-texture.ts`). Before, nearest-texel sampling left
 * 85% to 92% of these pixels off.
 */
const TEXTURE_SAMPLING_CASES: ParityCase[] = [
	'tile',
	'flipx',
	'flipy',
	'flipxy',
	'clamp',
	'nearest-tile',
	'hqbicubic-flipxy',
	'pom-half-tile',
].map((w) => levelExact(`gpx-texture-${w}`));

/**
 * Pens and text painted with a texture, linear-gradient or path-gradient
 * brush: the stroke's or glyphs' coverage comes from Canvas and every
 * covered pixel's colour from the brush's own per-pixel sampler
 * (`paintBrushThroughMask`), where a pen used to paint its brush's flat
 * colour and text a filtered `CanvasPattern`. Pen strokes: exact but for
 * the curved stroke's antialiased edge (19% to 28% before); text: the
 * residual is glyph shapes and layout from the host font engine, the
 * colours inside the glyphs match. `gpx-pen-styles` checks the pen record's
 * optional data (dash pattern and offset, alignment, compound line, caps,
 * join, miter limit) is parsed in GDI+'s order so the brush after it is
 * found; compound lines and separate dash/line caps are not modelled.
 */
const PEN_TEXT_BRUSH_CASES: ParityCase[] = [
	close('gpx-pen-texture', 0.025), // measured 1.79%
	close('gpx-pen-lingrad', 0.025), // measured 1.84%
	close('gpx-pen-pathgrad', 0.02), // measured 1.40%
	close('gpx-pen-styles', 0.05), // measured 4.37%
	close('gpx-text-texture', 0.14), // measured 11.57% (glyph shapes)
	close('gpx-text-lingrad', 0.14), // measured 11.76% (glyph shapes)
	close('gpx-text-pathgrad', 0.09), // measured 6.85% (glyph shapes)
];

/**
 * GraphicsPath FillMode for FillPath and SetClip(path): Alternate (GDI+'s
 * default, recorded as PathPointFlags without 0x2000) fills even-odd, so
 * the star's centre and the overlap of two same-direction rectangles stay
 * empty; Winding fills them. Alternate used to fill nonzero (9.7% of
 * pixels off). The residual is antialiased edges (see below for aliased).
 */
const PATH_FILL_MODE_CASES: ParityCase[] = [
	close('gpx-fillpath-alternate', 0.035), // measured 2.52%
	close('gpx-fillpath-winding', 0.03), // measured 1.96%
	close('gpx-clippath-alternate', 0.035), // measured 2.53%
	close('gpx-clippath-winding', 0.03), // measured 1.96%
];

/**
 * The same EMF+ fixtures with `gdiAntialias: false`: EMF+ fills and
 * strokes recorded under GDI+'s default SmoothingMode (None) are
 * rasterised aliased on GDI+'s pixel grid (a pixel is painted when its
 * sample point, the integer device coordinate under PixelOffsetMode None,
 * is inside; curves flattened into GDI+'s 0.25-pixel polygon), and EMF+
 * clip regions become the pixel sets GDI+ holds. What is left is single
 * pixels along slanted and curved edges, where GDI+'s fixed-point edge
 * stepping rounds a crossing the other way.
 */
const plusAliased = (name: string, maxMismatch: number): ParityCase => ({
	...close(name, maxMismatch),
	options: { gdiAntialias: false },
});

const PLUS_ALIASED_CASES: ParityCase[] = [
	plusAliased('gpx-fillpath-alternate', 0.002), // measured 0.07%
	plusAliased('gpx-fillpath-winding', 0.002), // measured 0.04%
	plusAliased('gpx-clippath-alternate', 0.002), // measured 0.08%
	plusAliased('gpx-clippath-winding', 0.002), // measured 0.06%
	plusAliased('gpx-lin-blend-ellipse', 0.003), // measured 0.11%
	plusAliased('gpx-metafile-scaled', 0.002), // measured 0.10%
	plusAliased('gpx-metafile-clip-zorder', 0.002), // measured 0.05%
	plusAliased('gpx-pen-texture', 0.003), // measured 0.12%
	plusAliased('gpx-pen-lingrad', 0.003), // measured 0.12%
	plusAliased('gpx-pen-pathgrad', 0.003), // measured 0.14%
	plusAliased('gpx-image-clip-zorder', 0), // measured 0%
	plusAliased('gpx-texture-tile', 0), // measured 0%
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

	describe('GDI rasteriser (gdi-raster fixtures, gdiAntialias: false)', () => {
		it.each(RASTER_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
			const diff = await compareFixture(c.name, c.ext, c.tolerance, c.options);
			expect(diff).not.toBeNull();
			expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
		});
	});

	describe('GDI rasteriser fixtures, default antialiased mode', () => {
		it.each(RASTER_AA_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
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

	const groups: Array<[string, ParityCase[]]> = [
		['GDI+ linear-gradient interpolation table', LINEAR_RAMP_CASES],
		['EMF+ DrawImage InterpolationMode / PixelOffsetMode kernels', IMAGE_MODE_CASES],
		['EMF+ DrawImage painted in record order under its clip', IMAGE_ORDER_CASES],
		['EMF+ DrawImage with ImageAttributes WrapMode', IMAGE_ATTRIBUTE_CASES],
		['EMF+ SetClip(Region) from a real GDI+ recording', REGION_CLIP_CASES],
		['EMF+ DrawImage of an embedded metafile, replayed as vectors', NESTED_METAFILE_CASES],
		['EMF+ TextureBrush sampling and WrapMode', TEXTURE_SAMPLING_CASES],
		['EMF+ pens and text painted with texture/gradient brushes', PEN_TEXT_BRUSH_CASES],
		['EMF+ path FillMode for fills and clips', PATH_FILL_MODE_CASES],
		['EMF+ SmoothingMode None with gdiAntialias: false', PLUS_ALIASED_CASES],
	];
	for (const [title, cases] of groups) {
		describe(title, () => {
			it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
				const diff = await compareFixture(c.name, c.ext, c.tolerance, c.options);
				expect(diff).not.toBeNull();
				expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
			});
		});
	}
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