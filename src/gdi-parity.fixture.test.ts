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

import { readFileSync } from 'node:fs';

import { compareFixture, fixturePath, loadReference, renderFixture, windowsFonts } from './__fixtures__/gdi-parity-harness';
import { setSoftwareCanvasOnly } from './emf-canvas-helpers';
import { parseWmfHeader } from './emf-header-parser';
import type { EmfConvertOptions } from './index';
import { extractEmbeddedEmf } from './wmf-embedded-emf';

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
 * (three), `GammaCorrection` on a two-colour and a preset ramp (linear
 * light held in 10 bits), translucent end colours (their exact half-level
 * knots rounding down), and `PixelOffsetMode` Half: every pixel equal to
 * GDI+'s. `gpx-lin-blend-ellipse` (four blend factors, rotated, on an
 * aliased ellipse) is exact too. `gpx-lin-sigma` keeps a few pixels one
 * level off where a blend knot lands exactly on a half level.
 */
const LINEAR_RAMP_CASES: ParityCase[] = [
	exact('gpx-lin-preset5-small'),
	exact('gpx-lin-preset5-large'),
	exact('gpx-lin-preset5-huge'),
	levelExact('gpx-lin-sigma'), // measured 0.013% one level off (tolerance 0)
	exact('gpx-lin-triangular'),
	exact('gpx-lin-gamma'),
	exact('gpx-lin-gamma-preset'),
	exact('gpx-lin-alpha'),
	exact('gpx-lin-pixeloffset-half'),
	exact('gpx-lin-blend-ellipse'),
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
 * raster, breaking a pixel centre that falls exactly on a texel boundary
 * the way GDI does: pixel-exact (0.67% with the earlier local
 * resampling). Glyph rasterisation already differs
 * from GDI's own font engine even without rotation (`rotate-text-25deg`).
 */
const ROTATION_AFFINE_CASES: ParityCase[] = [
	close('rotate-bitblt-25deg', 0), // measured 0.00%
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
 * 800-shape benchmark drawing, plus wide flattened-ellipse pens on closed
 * figures, curves and dashes (`raster-wide-extra`). Every one is exact at
 * tolerance 0 under `gdiAntialias: false` (Windows measures each segment of
 * a dashed curve from its vector cut down to whole pixels, which is what
 * had put its dashes up to 2% away from ours).
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
	raster('raster-arcs'), // was 0.117%
	raster('raster-paths'), // was 0.057%
	raster('raster-blit-rotated'), // was 0.350%
	raster('raster-wide-pens'), // was 0.420%
	raster('raster-wide-joins'), // was 0.991%
	raster('raster-dash-geometric'), // was 3.943%
	raster('raster-wide-extra'), // exact; was 0.114% (65 pixels): dashes along curves
	// PS_INSIDEFRAME pens of 1 to 16 px on every box shape (EMF playback pulls the shape's box in by the pen width):
	// 16% to 35% of the pixels were off before; the Polygon is the control, which the pen leaves alone.
	raster('emf-insideframe-rect'),
	raster('emf-insideframe-ellipse'),
	raster('emf-insideframe-roundrect'),
	raster('emf-insideframe-arc'),
	raster('emf-insideframe-chord'),
	raster('emf-insideframe-pie'),
	raster('emf-insideframe-polygon'),
	// The same shapes under a 1.37 world scale: an odd pen width (in 1/16 pixel) puts the vertical edges on half a
	// 1/16 pixel, which the Ellipse and RoundRect paths model, the Arc, Chord and Pie paths do not.
	raster('emf-insideframe-scaled', 0.0006), // measured 0.047% (80 pixels), before 0.096% with the box alone
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
	close('raster-arcs', 0.04), // measured 3.27%
	close('raster-pies-chords', 0.065), // measured 5.65%
	close('raster-polygon-fillmodes', 0.05), // measured 3.94%
	close('raster-paths', 0.075), // measured 6.63%
	close('raster-rop2-shapes', 0.001), // measured 0.00%
	close('raster-dash-cosmetic', 0.1), // measured 8.71%
	close('raster-dash-geometric', 0.09), // measured 7.80%
	close('raster-wide-pens', 0.075), // measured 6.36%
	close('raster-wide-joins', 0.06), // measured 4.87%
	close('raster-blit-rotated', 0), // measured 0.00%
	close('raster-wide-extra', 0.07), // measured 5.53%
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
	fontCase('rotate-text-25deg', 'emf', 0.0025), // measured 0.197%
	fontCase('text-arial-hm13', 'wmf', 0.0006), // measured 0.029%
	fontCase('text-arial-hm20', 'wmf', 0.0004), // measured 0.007%
	fontCase('text-arial-hp18', 'wmf', 0), // measured 0.000%
	fontCase('text-couriernew-hm13', 'wmf', 0), // measured 0.000%
	fontCase('text-couriernew-hm20', 'wmf', 0), // measured 0.000%
	fontCase('text-couriernew-hp18', 'wmf', 0), // measured 0.000%
	fontCase('text-helv-hm13', 'wmf', 0), // measured 0.000%
	fontCase('text-helv-hm20', 'wmf', 0), // measured 0.000%
	fontCase('text-helv-hp18', 'wmf', 0), // measured 0.000%
	fontCase('text-msshelldlg-hm13', 'wmf', 0.0009), // measured 0.057%
	fontCase('text-msshelldlg-hm20', 'wmf', 0), // measured 0.000%
	fontCase('text-msshelldlg-hp18', 'wmf', 0), // measured 0.000%
	fontCase('text-nosuchfacexyz-hm13', 'wmf', 0), // measured 0.000%
	fontCase('text-nosuchfacexyz-hm20', 'wmf', 0), // measured 0.000%
	fontCase('text-nosuchfacexyz-hp18', 'wmf', 0.0006), // measured 0.021%
	fontCase('text-timesnewroman-hm13', 'wmf', 0), // measured 0.000%
	fontCase('text-timesnewroman-hm20', 'wmf', 0), // measured 0.000%
	fontCase('text-timesnewroman-hp18', 'wmf', 0), // measured 0.000%
	fontCase('textx-align-mono', 'emf', 0), // measured 0.000%
	fontCase('textx-arial-aa', 'emf', 0.0016), // measured 0.122%
	fontCase('textx-arial-cell-mono', 'emf', 0.0005), // measured 0.019%
	fontCase('textx-arial-cleartype', 'emf', 0.0646), // measured 5.163%
	fontCase('textx-arial-ctnatural', 'emf', 0.1856), // measured 14.847%
	fontCase('textx-arial-mono', 'emf', 0.0005), // measured 0.017%
	fontCase('textx-arial-q0-default', 'emf', 0.0646), // measured 5.163%
	fontCase('textx-arial-q1-draft', 'emf', 0.0646), // measured 5.163%
	fontCase('textx-arial-q2-proof', 'emf', 0.0646), // measured 5.163%
	fontCase('textx-arial-styles-aa', 'emf', 0.0009), // measured 0.059%
	fontCase('textx-arial-styles-mono', 'emf', 0.0006), // measured 0.027%
	fontCase('textx-color-aa', 'emf', 0.017), // measured 1.352%
	fontCase('textx-color-cleartype', 'emf', 0.0234), // measured 1.868%
	fontCase('textx-color-mono', 'emf', 0.0004), // measured 0.005%
	fontCase('textx-couriernew-aa', 'emf', 0.0004), // measured 0.010%
	fontCase('textx-couriernew-cell-mono', 'emf', 0.0005), // measured 0.011%
	fontCase('textx-couriernew-mono', 'emf', 0.0004), // measured 0.010%
	fontCase('textx-couriernew-styles-mono', 'emf', 0.0005), // measured 0.012%
	fontCase('textx-escapement-aa', 'emf', 0.0027), // measured 0.212%
	fontCase('textx-escapement-mono', 'emf', 0.0027), // measured 0.212%
	fontCase('textx-eto-aa', 'emf', 0.0063), // measured 0.499%
	fontCase('textx-eto-mono', 'emf', 0.0055), // measured 0.435%
	fontCase('textx-fon-courier', 'emf', 0), // measured 0.000%
	fontCase('textx-fon-courier-cell', 'wmf', 0), // measured 0.000%
	fontCase('textx-fon-courier-styles', 'wmf', 0.0044), // measured 0.350%
	fontCase('textx-fon-fixedsys', 'emf', 0.0208), // measured 1.664%
	fontCase('textx-fon-fixedsys-cell', 'wmf', 0), // measured 0.000%
	fontCase('textx-fon-helv', 'emf', 0), // measured 0.000%
	fontCase('textx-fon-helv-cell', 'wmf', 0), // measured 0.000%
	fontCase('textx-fon-mssansserif', 'emf', 0), // measured 0.000%
	fontCase('textx-fon-mssansserif-aa', 'emf', 0), // measured 0.000%
	fontCase('textx-fon-mssansserif-cell', 'wmf', 0), // measured 0.000%
	fontCase('textx-fon-mssansserif-styles', 'emf', 0.0005), // measured 0.018%
	fontCase('textx-fon-msserif', 'emf', 0), // measured 0.000%
	fontCase('textx-fon-msserif-cell', 'wmf', 0), // measured 0.000%
	fontCase('textx-fon-msshelldlg', 'emf', 0.0006), // measured 0.021%
	fontCase('textx-fon-msshelldlg-cell', 'wmf', 0.0005), // measured 0.013%
	fontCase('textx-fon-smallfonts', 'emf', 0.0046), // measured 0.368%
	fontCase('textx-fon-smallfonts-cell', 'wmf', 0.0048), // measured 0.382%
	fontCase('textx-fon-system', 'emf', 0), // measured 0.000%
	fontCase('textx-fon-system-cell', 'wmf', 0), // measured 0.000%
	fontCase('textx-fon-terminal', 'emf', 0.0208), // measured 1.661%
	fontCase('textx-fon-terminal-cell', 'wmf', 0), // measured 0.000%
	fontCase('textx-fon-tmsrmn', 'emf', 0), // measured 0.000%
	fontCase('textx-fon-tmsrmn-cell', 'wmf', 0), // measured 0.000%
	fontCase('textx-opaque-aa', 'emf', 0.0004), // measured 0.001%
	fontCase('textx-opaque-mono', 'emf', 0.0004), // measured 0.004%
	fontCase('textx-plus-antialias', 'emf', 0.0321), // nearest-quarter grayscale origins; remaining glyph hinting
	fontCase('textx-plus-antialiasgridfit', 'emf', 0.0255), // measured 2.547%; GDI+ hinting and shades
	fontCase('textx-plus-cleartype', 'emf', 0.1021), // measured 10.216%; decorations retained
	fontCase('textx-plus-singlebit', 'emf', 0.0245), // measured 1.960%
	fontCase('textx-plus-singlebitgridfit', 'emf', 0.0005), // measured 0.020%
	fontCase('textx-plus-systemdefault', 'emf', 0.0005), // measured 0.020%
	fontCase('textx-rotalign-esc', 'emf', 0.0064), // measured 0.511%
	fontCase('textx-rotalign-esc-small', 'emf', 0.0046), // measured 0.367%
	fontCase('textx-rotalign-world', 'emf', 0.0068), // measured 0.537%
	fontCase('textx-segoeui-aa', 'emf', 0.0007), // measured 0.031%
	fontCase('textx-segoeui-cell-mono', 'emf', 0.0012), // measured 0.086%
	fontCase('textx-segoeui-cleartype', 'emf', 0.0506), // measured 4.041%
	fontCase('textx-segoeui-mono', 'emf', 0.0005), // measured 0.015%
	fontCase('textx-segoeui-styles-mono', 'emf', 0.0004), // measured 0.007%
	fontCase('textx-tahoma-aa', 'emf', 0.0013), // measured 0.092%
	fontCase('textx-tahoma-cell-mono', 'emf', 0.0005), // measured 0.019%
	fontCase('textx-tahoma-mono', 'emf', 0.0005), // measured 0.020%
	fontCase('textx-tahoma-styles-mono', 'emf', 0.0006), // measured 0.028%
	fontCase('textx-timesnewroman-aa', 'emf', 0.0013), // measured 0.092%
	fontCase('textx-timesnewroman-cell-mono', 'emf', 0.0005), // measured 0.019%
	fontCase('textx-timesnewroman-mono', 'emf', 0.0005), // measured 0.013%
	fontCase('textx-timesnewroman-styles-mono', 'emf', 0.0005), // measured 0.012%
	fontCase('textx-wmf-align-mono', 'wmf', 0), // measured 0.000%
	fontCase('textx-wmf-arial-aa', 'wmf', 0.0016), // measured 0.122%
	fontCase('textx-wmf-arial-mono', 'wmf', 0.0005), // measured 0.017%
	fontCase('textx-wmf-arial-styles-mono', 'wmf', 0.0006), // measured 0.027%
	fontCase('textx-wmf-couriernew-mono', 'wmf', 0.0004), // measured 0.010%
	fontCase('textx-wmf-escapement-mono', 'wmf', 0.0031), // measured 0.247%
	fontCase('textx-wmf-eto-mono', 'wmf', 0.0004), // measured 0.004%
	fontCase('textx-wmf-opaque-mono', 'wmf', 0.0004), // measured 0.004%
	fontCase('textx-wmf-segoeui-mono', 'wmf', 0.0005), // measured 0.015%
	fontCase('textx-wmf-tahoma-mono', 'wmf', 0.0005), // measured 0.020%
	fontCase('textx-wmf-timesnewroman-cell-mono', 'wmf', 0.0006), // measured 0.028%
	fontCase('textx-wmf-timesnewroman-mono', 'wmf', 0.0005), // measured 0.020%
	fontCase('textx-wmf-timesnewroman-styles-mono', 'wmf', 0.0005), // measured 0.012%
	fontCase('textx-world-aa', 'emf', 0.0036), // measured 0.284%
	fontCase('textx-world-mono', 'emf', 0.0028), // measured 0.221%
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
 * pixels off). Every pixel remains within 8 levels of GDI+; the Bicubic
 * fixture is now pixel-exact after native integer sampling.
 */
const IMAGE_MODE_CASES: ParityCase[] = [
	...[
		'nearestneighbor',
		'bilinear',
		'default',
		'low',
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
	exact('gpx-image-bicubic'),
	// A rotated HighQualityBicubic draw: the far edges fade to zero at the
	// edge (see `fadeAt`); two edge pixels remain over 8 levels.
	close('gpx-image-rotated-highqualitybicubic', 0.00015), // measured 0.013% (0.142% before)
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
 * it. Nested shapes are rasterised aliased like GDI+'s; the residual is a
 * handful of pixels on the scaled ellipse's edge (4.57% and 2.31% before
 * EMF+ followed the recorded SmoothingMode).
 */
const NESTED_METAFILE_CASES: ParityCase[] = [
	exact('gpx-metafile-scaled'), // 0.065% before
	exact('gpx-metafile-clip-zorder'), // 0.039% before
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
 * brush: every covered pixel's colour comes from the brush's own per-pixel
 * sampler, where a pen used to paint its brush's flat colour and text a
 * filtered `CanvasPattern`. Pen strokes are GDI+'s widened outline
 * scan-converted by its own rules (`emf-plus-widen.ts`,
 * `emf-plus-raster.ts`), 19% to 28% off before; `gpx-pen-styles` (a
 * custom dash pattern with an offset on an Inset pen with round joins, a
 * round start and square end cap on a dashed line, and a compound line) is
 * exact. Text without the `fonts` option: the residual is glyph shapes and
 * layout from the host font engine (see the fonts group below).
 */
const PEN_TEXT_BRUSH_CASES: ParityCase[] = [
	close('gpx-pen-texture', 0.001), // measured 0.019%
	close('gpx-pen-lingrad', 0.001), // measured 0.019%
	close('gpx-pen-pathgrad', 0.002), // measured 0.070%
	exact('gpx-pen-styles'),
	close('gpx-text-texture', 0.14), // measured 10.84% (glyph shapes)
	close('gpx-text-lingrad', 0.14), // measured 10.98% (glyph shapes)
	close('gpx-text-pathgrad', 0.09), // measured 6.53% (glyph shapes)
];

/**
 * The brush-filled text with the `fonts` option: glyph coverage from the
 * GDI font engine (`gdiTextCoverage`), per channel for ClearType, and the
 * brush's colour per pixel. The residual is the engine's own grayscale and
 * ClearType fidelity (see the font engine group); single-bit text is exact.
 */
const TEXT_BRUSH_FONT_CASES: ParityCase[] = [
	close('gpx-text-texture', 0.025), // measured 1.977%
	close('gpx-text-lingrad', 0.025), // measured 1.996%
	close('gpx-text-pathgrad', 0.021), // measured 1.649%
	exact('gpx-text-texture-mono'),
	close('gpx-text-texture-cleartype', 0.04), // measured 3.093%
];

/**
 * GraphicsPath FillMode for FillPath and SetClip(path): Alternate (GDI+'s
 * default, recorded as PathPointFlags without 0x2000) fills even-odd, so
 * the star's centre and the overlap of two same-direction rectangles stay
 * empty; Winding fills them. Alternate used to fill nonzero (9.7% of
 * pixels off). The fills and the clip regions are GDI+'s own pixels.
 */
const PATH_FILL_MODE_CASES: ParityCase[] = [
	exact('gpx-fillpath-alternate'),
	exact('gpx-fillpath-winding'),
	exact('gpx-clippath-alternate'),
	exact('gpx-clippath-winding'),
];

/**
 * The same EMF+ fixtures with `gdiAntialias: false`, which for EMF+ is the
 * default: drawing follows the recorded SmoothingMode either way (only
 * `gdiAntialias: true` hands EMF+ edges to Canvas).
 */
const plusAliased = (name: string, maxMismatch: number): ParityCase => ({
	...close(name, maxMismatch),
	options: { gdiAntialias: false },
});

const PLUS_ALIASED_CASES: ParityCase[] = [
	plusAliased('gpx-fillpath-alternate', 0),
	plusAliased('gpx-fillpath-winding', 0),
	plusAliased('gpx-clippath-alternate', 0),
	plusAliased('gpx-clippath-winding', 0),
	plusAliased('gpx-lin-blend-ellipse', 0),
	{ ...exact('gpx-metafile-scaled'), options: { gdiAntialias: false } }, // 0.065% before
	{ ...exact('gpx-metafile-clip-zorder'), options: { gdiAntialias: false } }, // 0.039% before
	plusAliased('gpx-pen-texture', 0.001), // measured 0.019%
	plusAliased('gpx-pen-lingrad', 0.001), // measured 0.019%
	plusAliased('gpx-pen-pathgrad', 0.002), // measured 0.070%
	plusAliased('gpx-image-clip-zorder', 0), // measured 0%
	plusAliased('gpx-texture-tile', 0), // measured 0%
];

/**
 * One drawing (a filled ellipse, triangle and Bezier path, a 3.5-pixel pen
 * ellipse and two 1-pixel lines) under each GDI+ SmoothingMode. None and
 * HighSpeed are drawn aliased, AntiAlias and HighQuality with GDI+'s 8 x 4
 * antialiasing: fills and strokes are exact (the 1-pixel lines through
 * GDI+'s nominal-width line algorithm, `emf-plus-nominal-line.ts`, and the
 * curves through GDI+'s own Bezier flattener). `gdiAntialias: true` keeps Canvas
 * smoothing (the bounds below it guard that it still applies).
 */
const SMOOTHING_CASES: ParityCase[] = [
	close('gpx-smooth-none', 0), // measured 0% (6.26% before, 0.025% with the older nominal-line model)
	close('gpx-smooth-highspeed', 0), // measured 0%
	close('gpx-smooth-antialias', 0), // measured 0% (8.60% before, 0.457% with the older nominal-line model)
	close('gpx-smooth-highquality', 0), // measured 0%
	{ ...close('gpx-smooth-none', 0.07), options: { gdiAntialias: true } }, // measured 6.258%
	{ ...close('gpx-smooth-antialias', 0.07), options: { gdiAntialias: true } }, // measured 5.603%
];

/**
 * WMF records, each file played the way Windows' `PlayMetaFile` plays it
 * (`wmf-records` fixtures: the reference is PlayMetaFile of the very same
 * bytes onto a white DIB, under a placeable-aware player's
 * `MM_ANISOTROPIC` mapping). Shapes in `GM_COMPATIBLE` geometry at 96 dpi,
 * in twips and at a 0.96 scale; every map mode, window/viewport origin,
 * extent, offset and scale record, placeable bounds off zero and two
 * non-placeable files; IntersectClipRect/ExcludeClipRect/OffsetClipRgn/
 * SelectClipRgn with SaveDC/RestoreDC; FillRgn/PaintRgn/InvertRgn/FrameRgn;
 * DIB blits, StretchDIBits, SetDIBitsToDevice and PatBlt under many ROP3
 * codes and stretch modes; pattern and hatch brushes; palettes and
 * PALETTEINDEX colours; SetPixel and flood fills; the object table; escapes
 * and SetLayout; hand-assembled Win16 records Windows no longer plays; an
 * embedded EMF. Before this replay (the old canvas-only WMF path) these
 * measured 4.9% to 100% of pixels off. Now `wmf-shapes`, `wmf-shapes-twips`,
 * `wmf-pixels*` and the PS_INSIDEFRAME rectangle, ellipse and RoundRect
 * sweeps, including the inside-frame Chord, Pie and Arc, are pixel-exact;
 * the residuals are `wmf-shapes-scaled` (0.008%: 7 pixels of the
 * inside-frame row and the Pies at the 0.96 scale),
 * `wmf-nonplaceable-viewport` and `wmf-embedded-emf` (the EMF path's
 * own wide-pen residual).
 */
const wmf = (name: string, maxMismatch = 0): ParityCase => ({ name, ext: 'wmf', tolerance: 0, maxMismatch });

const WMF_RECORD_CASES: ParityCase[] = [
	wmf('wmf-shapes'), // measured 0%
	wmf('wmf-shapes-twips'), // measured 0%
	wmf('wmf-shapes-scaled', 0.0001), // measured 0.008% (7 pixels), before 0.014%, 0.017%, 0.027% and 0.158%
	wmf('wmf-roundrect-corners'), // 0%, before 500+ pixels: wide-pen and null-pen corners scale onto the drawn box
	wmf('wmf-roundrect-corners-scaled'), // 0%, before 813+ pixels
	wmf('wmf-insideframe-subpixel'),
	wmf('wmf-insideframe-fractional'), // 0%, before 0.385% at the 6.5/7.5 px pens
	wmf('wmf-insideframe-wide-subpixel'), // 0%, before 0.385%: the same half-width ties
	wmf('wmf-insideframe-curved-ellipse'), // 0%, before 0.109% (2.057% before the fractional fit)
	wmf('wmf-insideframe-curved-roundrect'), // 0%, before 0.145% (2.785% before the fractional fit)
	wmf('wmf-insideframe-curved-chord'), // 0%, before 0.006% (0.156% before the arc ends)
	wmf('wmf-insideframe-curved-pie'), // 0%, before 0.005% (0.142% before the arc ends)
	wmf('wmf-insideframe-curved-arc'), // 0%, before 0.006% (0.039% before the arc ends)
	wmf('wmf-map-anisotropic'),
	wmf('wmf-map-isotropic'),
	wmf('wmf-map-text'),
	wmf('wmf-map-metric'),
	wmf('wmf-nonplaceable'),
	wmf('wmf-nonplaceable-viewport', 0.0003), // measured 0.020%
	wmf('wmf-placeable-origin'),
	wmf('wmf-clip'),
	wmf('wmf-clip-twips'),
	wmf('wmf-clip-scaled'),
	wmf('wmf-regions'),
	wmf('wmf-regions-twips'),
	wmf('wmf-bitmaps'),
	wmf('wmf-bitmaps-twips'),
	wmf('wmf-patterns'),
	wmf('wmf-legacy'),
	wmf('wmf-palette'),
	wmf('wmf-pixels'), // measured 0%, before 0.007%
	wmf('wmf-pixels-twips'), // measured 0%, before 0.007%
	wmf('wmf-objects'),
	wmf('wmf-escapes'),
	wmf('wmf-layout-rtl'),
	wmf('wmf-layout-rtl-lines'),
	wmf('wmf-embedded-emf', 0.0006), // measured 0.058%
];

/**
 * SetTextCharacterExtra and SetTextJustification through the GDI font
 * engine: GDI's per-character extra and its DDA spread of the break extra.
 */
const WMF_TEXT_SPACING_CASES: ParityCase[] = [wmf('wmf-text-spacing', 0.0002)]; // measured 0.006%

/**
 * EMF+ records and objects the converter used to skip, against real GDI+
 * (`emfplus-records` fixtures; the hand-built record encodings no recorder
 * writes are checked against GDI+'s own playback of them). Measured before
 * these records were handled (tolerance 8): beziers 4.45%, curve 9.46%,
 * closed curve 30.39%, region fill 34.16%, relative points 21.18%,
 * containers 36.57% / 22.29%, save/restore 21.34%, compositing 15.96%,
 * hatch 54.20%, MultiFormat 23.25%, StrokeFillPath 30.16%, terminal-server
 * clip 45.75% / 63.25%, terminal-server graphics 31.27%, compressed shapes
 * 0.26% (the arcs). Aliased and antialiased (`-aa`) variants.
 */
const recordCase = (name: string, maxMismatch: number): ParityCase => ({ ...close(name, maxMismatch) });

const EMF_PLUS_RECORD_CASES: ParityCase[] = [
	recordCase('gpx-rec-beziers', 0.0005), // measured 0.019%
	recordCase('gpx-rec-beziers-aa', 0.0005), // measured 0.025%
	recordCase('gpx-rec-curve', 0),
	recordCase('gpx-rec-curve-aa', 0.0005), // measured 0.013%
	recordCase('gpx-rec-closedcurve', 0),
	recordCase('gpx-rec-closedcurve-aa', 0),
	recordCase('gpx-rec-compressed', 0),
	recordCase('gpx-rec-compressed-aa', 0),
	recordCase('gpx-rec-relative', 0),
	recordCase('gpx-rec-relative-image', 0),
	recordCase('gpx-rec-fillregion', 0),
	recordCase('gpx-rec-fillregion-aa', 0),
	recordCase('gpx-rec-container', 0),
	recordCase('gpx-rec-container-page', 0),
	recordCase('gpx-rec-save-restore', 0),
	recordCase('gpx-rec-compositing', 0),
	recordCase('gpx-rec-compositing-aa', 0),
	recordCase('gpx-rec-hatch', 0),
	recordCase('gpx-rec-hatch-origin', 0),
	recordCase('gpx-rec-hatch-rotated', 0),
	recordCase('gpx-rec-multiformat-start', 0),
	recordCase('gpx-rec-multiformat-ignored', 0),
	recordCase('gpx-rec-strokefillpath', 0),
	recordCase('gpx-rec-tsclip', 0),
	recordCase('gpx-rec-tsclip-state', 0),
	recordCase('gpx-rec-tsgraphics', 0),
	recordCase('gpx-rec-customcap', 0.0005), // measured 0.013%
	recordCase('gpx-rec-customcap-aa', 0.001), // measured 0.051%
];

/**
 * TextContrast on antialiased and ClearType text (Windows fonts): GDI+
 * lightens grayscale coverage a to 1 - (1 - a)^(1 / gamma) and blends
 * ClearType channels as value^gamma, gamma = 1 + contrast / 10. The
 * residual is the glyph shapes (as in the brush-filled text cases); per
 * row the mean signed error no longer drifts with the contrast (ClearType
 * 6.39% before, grayscale 6.64%).
 */
const TEXT_CONTRAST_CASES: ParityCase[] = [
	close('gpx-rec-textcontrast', 0.0287), // measured 2.865%; GDI+ hinting and shades
	close('gpx-rec-textcontrast-cleartype', 0.05), // measured 4.008%
];

/**
 * EMF records that had no handler before (`emf-records` fixtures, drawn
 * directly by GDI onto a 32bpp DIB, in the default Windows-exact mode):
 * palettes and PALETTEINDEX / DIBPALETTEINDEX / PALETTERGB colours and
 * DIB_PAL_COLORS bitmaps, AlphaBlend (every constant alpha and every
 * per-pixel alpha, premultiplied or not, stretched, mirrored),
 * TransparentBlt, MaskBlt, PlgBlt (mask included), banded SetDIBitsToDevice,
 * GradientFill rectangles and triangles, FillRgn / FrameRgn / InvertRgn /
 * PaintRgn, ExtFloodFill, AngleArc, PolyDraw / PolyDraw16,
 * PolyPolyline16 and Flatten / Widen / AbortPath. Every one is pixel-exact
 * but for the wide-pen widener's known residual (`gdi-raster-widen.ts`):
 * `emfrec-anglearc` (2 pixels of a 7 px flat-capped miter pen along the arc;
 * the AngleArc path itself matches GDI's `GetPath` point for point),
 * `emfrec-path-flatten` (the same pen on a flattened curve) and the
 * WidenPath outlines (16 pixels).
 */
const emfrec = (name: string, maxMismatch = 0): ParityCase => ({ name, ext: 'emf', tolerance: 0, maxMismatch });

const EMF_RECORD_CASES: ParityCase[] = [
	emfrec('emfrec-palette-index'),
	emfrec('emfrec-palette-dib'),
	emfrec('emfrec-alphablend'),
	emfrec('emfrec-alphablend-sweep'),
	emfrec('emfrec-transparentblt'),
	emfrec('emfrec-maskblt'),
	emfrec('emfrec-plgblt'),
	emfrec('emfrec-setdibits'),
	emfrec('emfrec-gradient-rect'),
	emfrec('emfrec-gradient-tri'),
	emfrec('emfrec-fillrgn'),
	emfrec('emfrec-fillrgn-scaled'),
	emfrec('emfrec-framergn'),
	emfrec('emfrec-invertrgn'),
	emfrec('emfrec-paintrgn'),
	emfrec('emfrec-floodfill'),
	emfrec('emfrec-polydraw16'),
	emfrec('emfrec-polydraw32'),
	emfrec('emfrec-polypolyline16'),
	emfrec('emfrec-path-abort'),
	emfrec('emfrec-anglearc', 0.0001), // measured 0.0046% (2 pixels), before 0.062%
	emfrec('emfrec-path-flatten', 0.0005), // measured 0.011%
	emfrec('emfrec-path-widen', 0.0004), // measured 0.034% (16 pixels), before 0.157%
	emfrec('emfrec-path-widen-outline'), // ellipse curve sides and duplicated inner triangles
];

/**
 * HALFTONE StretchBlt (`emf-gdi-stretch.ts`, `emf-gdi-color-adjust.ts`).
 * `emfrec-coloradjustment*`: a 20x16 bitmap enlarged 3x and reduced to
 * 13x11, without and with an EMR_SETCOLORADJUSTMENT (negative, gammas
 * 2.0 / 1.5 / 2.5, contrast 40, brightness -30, colorfulness 50, tint 20).
 * `emfrec-halftone-*`: a 64x32 grey/red/green/blue ramp and a 32x32
 * checkerboard (1-pixel black/white over 2-pixel red/blue) at 2x, 0.5x and
 * 1.37x, plain and under SetColorAdjustment (`-ca`: gamma 1.5, reference
 * black / white 400 / 9600, contrast 30, brightness -20, colorfulness 40,
 * tint 20).
 *
 * Without an adjustment every case is pixel-exact: nearest-pixel
 * enlargement after Windows' despeckle filter, 16.16 fixed-point area
 * averages rounded half up and then sharpened on reduction. Before (a
 * box filter both ways; mismatch at tolerance 0): checker 2x 46.868%,
 * 0.5x 27.527%, 1.37x 45.125%, ramp 0.5x 16.377%, 1.37x 35.353%,
 * coloradjustment-off 1.048%; ramp 2x was already exact.
 *
 * With an adjustment the colour stages and the 32-level ordered dither are
 * reproduced from native colour cubes (`emf-gdi-color-adjust.ts`,
 * `emf-gdi-halftone-dither.ts`): the illuminant controls are pixel-exact and
 * the combined adjustments differ by at most 3 levels (chroma rounding), up to
 * 18 on the mixed-axis ramps (their interpolation kernel is approximate).
 * The same cases were off by up to 224 levels (mismatch 8-24% at tolerance
 * 24) with the earlier fitted model.
 */
const halftone = (name: string, maxMismatch = 0): ParityCase => ({ name, ext: 'emf', tolerance: 0, maxMismatch });
const adjusted = (name: string, maxMismatch: number, tolerance = 0): ParityCase => ({ name, ext: 'emf', tolerance, maxMismatch });
const HALFTONE_CASES: ParityCase[] = [
	...['default', 'gamma', 'gamma-rgb', 'log', ...[1, 2, 3, 4, 5, 6, 7, 8].map(i => `illuminant-${i}`)].map(name => halftone(`emfrec-ca-control-${name}`)),
	halftone('emfrec-ca-control-dib-adjusted'), // 0% (0.549% before the two-pass reduction)
	halftone('emfrec-ca-control-dib'), // 0% (0.738% before the two-pass reduction)
	halftone('emfrec-coloradjustment-off'), // measured 0% (1.048% before)
	halftone('emfrec-coloradjustment'), // measured 0% (1.814% before the unrounded palette levels)
	// Flat colours under a colour adjustment, showing where the dither pattern starts: mirrored
	// and brush-origin StretchBlts (2x, 0.5x, mixed axes), bottom-up StretchDIBits, axis-aligned
	// PlgBlt (a HALFTONE stretch), and rotated / skewed blits (adjusted only after an unrotated
	// adjusted HALFTONE blit, dithered per destination pixel). All pixel-exact (1.6-8.8% and up
	// to 60 levels off before).
	halftone('emfrec-halftone-origin-stretch'),
	halftone('emfrec-halftone-origin-dib'),
	halftone('emfrec-halftone-origin-plgblt'),
	halftone('emfrec-halftone-origin-rotated'),
	halftone('emfrec-halftone-ramp-2x'),
	halftone('emfrec-halftone-ramp-0p5x'),
	halftone('emfrec-halftone-ramp-1p37x'),
	halftone('emfrec-halftone-checker-2x'),
	halftone('emfrec-halftone-checker-0p5x'),
	halftone('emfrec-halftone-checker-1p37x'),
	// Mixed-axis sampling now follows the measured interpolation and sharpening
	// directions. Keep explicit bounds for the remaining colour/edge differences.
	halftone('emfrec-halftone-ramp-2x-0p5y'), // 0% (3.522% before)
	halftone('emfrec-halftone-ramp-0p5x-2y'), // 0% (17.698% before)
	halftone('emfrec-halftone-checker-2x-0p5y'), // 0% (23.629% before)
	halftone('emfrec-halftone-checker-0p5x-2y'), // 0% (22.498% before)
	adjusted('emfrec-halftone-ramp-2x-0p5y-ca', 0.001), // 0.070%, max 4 (0.469% before the exact XYZ matrix)
	adjusted('emfrec-halftone-ramp-0p5x-2y-ca', 0.0015), // 0.111%, max 2 (0.585% before the dithered edge row)
	halftone('emfrec-halftone-checker-2x-0p5y-ca'), // 0% (0.549% before)
	halftone('emfrec-halftone-checker-0p5x-2y-ca'), // 0% (1.447% before)
	halftone('emfrec-halftone-ramp-2x-ca'), // 0% (0.614% before the exact XYZ matrix)
	halftone('emfrec-halftone-ramp-0p5x-ca'), // 0% (0.290% before)
	halftone('emfrec-halftone-ramp-1p37x-ca'), // 0% (0.469% before)
	halftone('emfrec-halftone-checker-2x-ca'), // 0% (6.037% before)
	halftone('emfrec-halftone-checker-0p5x-ca'), // 0% (1.183% before)
	halftone('emfrec-halftone-checker-1p37x-ca'), // 0% (5.737% before)
];

/**
 * EMF+ pens with their own transform (`Pen.Transform`,
 * `scripts/gdi-fixtures/PenTransformProbe.cs`), against GDI+'s playback of
 * the recorded metafile: uniform scale, rotation and translation (a
 * similarity folds into the width), a zero-width pen (one pixel under any
 * transform), an ArrowAnchor start cap, a (4, 1) scale and a [1 0 1 1]
 * skew widened in pen space, aliased and antialiased, and dashes laid out
 * along the path in world space. All pixel-exact; before, the dashed
 * (4, 1) cases were 0.742% (aliased) and 1.299% (antialiased) off (dashes
 * 4x too long) and the ArrowAnchor 0.103% (drawn as a triangle cap).
 */
const PEN_TRANSFORM_CASES: ParityCase[] = [
	'id',
	'custom-id',
	'translate',
	'rotate45',
	'scale3',
	'scale3-rotate45-translate',
	'zero-scale3',
	'scale4x1',
	'scale4x1-aa',
	'scale4x1-diagonal',
	'scale4x1-dash',
	'scale4x1-dash-aa',
	'zero-scale4x1',
	'skew',
	'skew-aa',
	'skew-horizontal',
	'skew-diagonal',
	'scale3-dash',
	'scale3-dash-aa',
	'anchor-squareanchor',
	'anchor-squareanchor-aa',
	'anchor-roundanchor',
	'anchor-roundanchor-aa',
	'anchor-diamondanchor',
	'anchor-diamondanchor-aa',
].map((c) => exact(`pen-${c}`));

/**
 * EMF+ image effects (`plus-effect-*`, GDI+ 1.1 `GdipDrawImageFX`
 * recorded EmfPlusDual (the generator asked for EmfPlusOnly with a wrong
 * EmfType value, since fixed) and played back by GDI+; see
 * `emf-plus-image-effects.ts`). GDI+ records each effect draw followed by
 * a plain draw of the bitmap it effected, so what Windows paints is the
 * effect draw overlaid by that bitmap: the effect's own pixels show only
 * where the bitmap is translucent (the half-transparent bar of the alpha
 * test image, an expanded blur's faded edges). There the converter now
 * matches: an expanded blur draws no halo beyond the source rectangle
 * (28.2% of pixels off before on blur-r10-expand), and a ColorCurve, which
 * GDI+ records under the ColorLookupTable GUID, is drawn without the
 * effect, as GDI+'s playback does. `emf-plus-image-effects.fixture.test.ts`
 * measures the effect algorithms themselves against the recorded bitmaps.
 * Comments give the share of pixels off at tolerance 0 before and now.
 */
const EMF_PLUS_EFFECT_CASES: ParityCase[] = [
	levelExact('plus-effect-blur-r3-dual'),
	exact('plus-effect-blur-r1'), // 0.102% before (0.051% beyond 8 levels)
	levelExact('plus-effect-blur-r10'), // 1.633% before (1.358% beyond 8 levels), 0.038% one level off now
	levelExact('plus-effect-blur-r10-expand'), // 28.235% before (17.602% beyond 8 levels), 0.051% one level off now
	levelExact('plus-effect-blur-r2p5'), // 0.561% before (0.395% beyond 8 levels), 0.013% one level off now
	levelExact('plus-effect-blur-r3'), // 0.682% before (0.446% beyond 8 levels), 0.013% one level off now
	levelExact('plus-effect-blur-r3-expand'), // 8.323% before (4.619% beyond 8 levels), 0.013% one level off now
	// Residual along one edge of the rotated draw, where the effect draw shows through the recorded bitmap's faded edge.
	{ name: 'plus-effect-blur-r3-rotate30', ext: 'emf', tolerance: 8, maxMismatch: 0.00012 }, // 2.555% before, 0.218% (0.010% since the blur's halo column is sampled)
	levelExact('plus-effect-blur-r3-scale2'), // 5.696% before (0.045% beyond 8 levels), 5.539% one level off now
	exact('plus-effect-blur-r4-subrect'),
	levelExact('plus-effect-blur-r4-subrect-expand'), // 4.884% before (2.448% beyond 8 levels), 0.023% one level off now
	exact('plus-effect-brightnesscontrast-b0-c100'),
	exact('plus-effect-brightnesscontrast-b0-c50'),
	exact('plus-effect-brightnesscontrast-b0-cn100'),
	exact('plus-effect-brightnesscontrast-b0-cn50'),
	levelExact('plus-effect-brightnesscontrast-b30-c40'), // 0.153% before, 0.153% one level off now
	exact('plus-effect-brightnesscontrast-b50-c0'),
	exact('plus-effect-brightnesscontrast-bn80-c0'),
	exact('plus-effect-colorbalance-cr0-mg0-yb80'), // 0.153% before
	exact('plus-effect-colorbalance-cr0-mgn40-yb0'),
	levelExact('plus-effect-colorbalance-cr100-mg100-yb100'), // 0.153% before (0.153% beyond 8 levels), 0.153% one level off now
	exact('plus-effect-colorbalance-cr60-mg0-yb0'), // 0.153% before (0.153% beyond 8 levels)
	exact('plus-effect-colorbalance-crn100-mg50-ybn20'), // 0.153% before (0.153% beyond 8 levels)
	exact('plus-effect-colorcurve-blacksat-60'),
	exact('plus-effect-colorcurve-contrast-50'),
	exact('plus-effect-colorcurve-contrast-50-blue'),
	exact('plus-effect-colorcurve-contrast-n50'),
	exact('plus-effect-colorcurve-density-64'),
	exact('plus-effect-colorcurve-density-n64'),
	exact('plus-effect-colorcurve-exposure-64'),
	exact('plus-effect-colorcurve-exposure-64-red'),
	exact('plus-effect-colorcurve-exposure-n64'),
	exact('plus-effect-colorcurve-highlight-50'),
	exact('plus-effect-colorcurve-highlight-n50'),
	exact('plus-effect-colorcurve-midtone-50'),
	exact('plus-effect-colorcurve-midtone-n50'),
	exact('plus-effect-colorcurve-midtone-n50-green'),
	exact('plus-effect-colorcurve-shadow-50'),
	exact('plus-effect-colorcurve-shadow-n50'),
	exact('plus-effect-colorcurve-whitesat-200'),
	exact('plus-effect-colorlut-alpha'),
	levelExact('plus-effect-colorlut-mixed'), // 0.153% before, 0.153% one level off now
	exact('plus-effect-colorlut-posterize'),
	exact('plus-effect-colormatrix-alpha-half'),
	exact('plus-effect-colormatrix-grayscale'),
	exact('plus-effect-colormatrix-invert'),
	levelExact('plus-effect-colormatrix-sepia'), // 0.153% before, 0.153% one level off now
	exact('plus-effect-colormatrix-swap-translate'),
	exact('plus-effect-hsl-h0-s0-l50'), // 0.153% before (0.153% beyond 8 levels)
	exact('plus-effect-hsl-h0-s0-ln50'), // 0.153% before (0.153% beyond 8 levels)
	exact('plus-effect-hsl-h0-s60-l0'), // 0.153% before
	exact('plus-effect-hsl-h0-sn100-l0'),
	exact('plus-effect-hsl-h180-s0-l0'), // 0.153% before
	levelExact('plus-effect-hsl-h30-sn30-l20'), // 0.153% before (0.153% beyond 8 levels), 0.153% one level off now
	exact('plus-effect-hsl-h90-s0-l0'), // 0.153% before
	exact('plus-effect-hsl-hn120-s0-l0'), // 0.153% before
	exact('plus-effect-levels-h100-m0-s20'),
	levelExact('plus-effect-levels-h100-m50-s0'), // 0.153% before, 0.153% one level off now
	exact('plus-effect-levels-h100-mn50-s0'), // 0.153% before
	exact('plus-effect-levels-h80-m0-s0'),
	levelExact('plus-effect-levels-h90-mn30-s10'), // 0.153% before, 0.153% one level off now
	exact('plus-effect-none-identity'),
	exact('plus-effect-redeye-both'),
	exact('plus-effect-redeye-left'),
	exact('plus-effect-redeye-whole'),
	exact('plus-effect-sharpen-r0p5-a100'), // 0.153% before (0.153% beyond 8 levels)
	exact('plus-effect-sharpen-r1-a50'), // 0.153% before (0.153% beyond 8 levels)
	exact('plus-effect-sharpen-r2-a0'), // 0.153% before (0.153% beyond 8 levels)
	exact('plus-effect-sharpen-r3-a100'), // 0.128% before (0.115% beyond 8 levels)
	levelExact('plus-effect-sharpen-r6-a30'), // 0.153% before (0.121% beyond 8 levels), 0.026% one level off now
	exact('plus-effect-tint-h0-a50'), // 0.153% before (0.153% beyond 8 levels)
	exact('plus-effect-tint-h120-a100'), // 0.153% before (0.153% beyond 8 levels)
	exact('plus-effect-tint-h180-a100'), // 0.153% before (0.153% beyond 8 levels)
	levelExact('plus-effect-tint-h60-an50'), // 0.153% before, 0.153% one level off now
	levelExact('plus-effect-tint-hn90-a30'), // quantized hue leaves 96 boundary pixels one level off
];

const EMF_PLUS_ONLY_EFFECT_CASES: ParityCase[] = EMF_PLUS_EFFECT_CASES
	.filter((c) => c.name !== 'plus-effect-blur-r3-dual')
	.map((c) => ({
		...c,
		name: c.name.replace('plus-effect-', 'plus-only-effect-'),
		// Only recordings expose the effect directly, without Dual's baked
		// fallback painting over it. These bounds measure the real algorithm.
		tolerance: c.name.includes('-hsl-') ? (c.name === 'plus-effect-hsl-h0-s60-l0' || c.name === 'plus-effect-hsl-h30-sn30-l20' ? 1 : 0)
			: c.name.includes('-tint-') ? 3 : c.name === 'plus-effect-sharpen-r3-a100' ? 2 : 1,
		maxMismatch: c.name.endsWith('-redeye-left') ? 0.00026
			: c.name.endsWith('-redeye-both') ? 0.0021
			: c.name.endsWith('-redeye-whole') ? 0.0070
			: c.name.includes('-hsl-') ? 0
			: c.name === 'plus-effect-sharpen-r3-a100' ? 0.00013 : c.maxMismatch,
	}));

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

	describe.skipIf(!windowsFonts())('EMF+ brush-filled text via the font engine (Windows fonts)', () => {
		it.each(TEXT_BRUSH_FONT_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
			const diff = await compareFixture(c.name, c.ext, c.tolerance, { fonts: windowsFonts()!, ...c.options });
			expect(diff).not.toBeNull();
			expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
		});
	});

	describe.skipIf(!windowsFonts())('EMF+ TextContrast via the font engine (Windows fonts)', () => {
		it.each(TEXT_CONTRAST_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
			const diff = await compareFixture(c.name, c.ext, c.tolerance, { fonts: windowsFonts()!, ...c.options });
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

	describe('WMF records played as PlayMetaFile plays them', () => {
		it.each(WMF_RECORD_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
			const diff = await compareFixture(c.name, c.ext, c.tolerance, c.options);
			expect(diff).not.toBeNull();
			expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
		});

		it('recovers the embedded EMF byte for byte as SetWinMetaFileBits does', () => {
			const wmfBytes = readFileSync(fixturePath('wmf-embedded-emf.wmf'));
			const view = new DataView(wmfBytes.buffer, wmfBytes.byteOffset, wmfBytes.byteLength);
			const embedded = extractEmbeddedEmf(view, parseWmfHeader(view)!.headerSize);
			expect(embedded).not.toBeNull();
			expect(Buffer.from(embedded!).equals(readFileSync(fixturePath('wmf-embedded-emf.recovered.emf')))).toBe(true);
		});
	});

	describe('EMF records added with the emf-records fixtures', () => {
		it.each(EMF_RECORD_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
			const diff = await compareFixture(c.name, c.ext, c.tolerance, c.options);
			expect(diff).not.toBeNull();
			expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
		});

		it('SetMapperFlags(ASPECT_FILTERING) changes nothing Windows paints', async () => {
			const on = await loadReference('emfrec-text-mapperflags');
			const off = await loadReference('emfrec-text-mapperflags-off');
			expect(Buffer.from(on.data).equals(Buffer.from(off.data))).toBe(true);
		});
	});

	describe.skipIf(!windowsFonts())('WMF text spacing via the font engine (Windows fonts)', () => {
		it.each(WMF_TEXT_SPACING_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
			const diff = await compareFixture(c.name, c.ext, c.tolerance, { fonts: windowsFonts()! });
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
		['EMF+ with gdiAntialias: false', PLUS_ALIASED_CASES],
		['EMF+ drawing under each SmoothingMode', SMOOTHING_CASES],
		['EMF+ records and objects (curves, regions, containers, hatches, compositing, terminal-server, MultiFormat)', EMF_PLUS_RECORD_CASES],
		['HALFTONE StretchBlt with and without EMR_SETCOLORADJUSTMENT', HALFTONE_CASES],
		['EMF+ pens with a pen transform', PEN_TRANSFORM_CASES],
		['EMF+ DrawImage with GDI+ image effects', EMF_PLUS_EFFECT_CASES],
		['EMF+ Only DrawImage with GDI+ image effects', EMF_PLUS_ONLY_EFFECT_CASES],
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
 * 0.00% (0.00%), rop2-bitwise-grid 0.28% (0.23%), pattern-fill-ellipse-color
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
		...WMF_RECORD_CASES,
		...EMF_PLUS_RECORD_CASES,
		...EMF_RECORD_CASES,
		...HALFTONE_CASES,
		...PEN_TRANSFORM_CASES,
		...EMF_PLUS_EFFECT_CASES,
		...EMF_PLUS_ONLY_EFFECT_CASES,
	];
	it.each(cases.map((c) => [`${c.name}${c.options ? ' (gdiAntialias: false)' : ''}`, c] as const))('%s', async (_name, c) => {
		const diff = await compareFixture(c.name, c.ext, c.tolerance, c.options);
		expect(diff).not.toBeNull();
		expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
	});

	it('returns no PNG for a metafile with text', async () => {
		expect(await renderFixture('rotate-text-25deg.emf')).toBeNull();
	});

	describe.skipIf(!windowsFonts())('with the font engine', () => {
		it.each(WMF_TEXT_SPACING_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
			const diff = await compareFixture(c.name, c.ext, c.tolerance, { fonts: windowsFonts()! });
			expect(diff).not.toBeNull();
			expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
		});
	});
});