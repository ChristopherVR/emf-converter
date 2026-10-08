# GDI / GDI+ reference fixtures

`src/__fixtures__/gdi` holds metafiles paired with PNGs that Windows itself
painted. The pixel-parity tests (`src/__fixtures__/gdi-parity-harness.ts`)
replay each metafile through the converter and compare against the PNG.

| File | What it does |
| --- | --- |
| `GdiFixtures.cs` | The case groups. Each case records the drawing into `<name>.emf` / `.wmf` and writes `<name>.png`: either the same calls painted onto a 32bpp bitmap, or GDI+'s own playback of the recorded metafile. |
| `PenTransformProbe.cs` | Pen-transform (`Pen.Transform`) cases: `pen-<case>.emf`, `pen-<case>.png` (GDI+ playback) and `pen-<case>-direct.png` (drawn straight onto a bitmap). |
| `generate.ps1` | Compiles both files with `Add-Type` and runs the requested groups. |
| `report.ts` | Parity table for every fixture: `bun scripts/gdi-fixtures/report.ts` (not part of `bun run test`). |

The report supplies `windowsFonts()` when the complete fixture font set is available (override its directory with `GDI_FIXTURE_FONTS`). Set `GDI_FONTS=host` to inspect canvas text rendering instead. It identifies the font mode, reports exact RGB pixel counts as well as differences beyond eight levels, and includes the overlap's right/bottom edges. `size` lists rendered/reference dimensions; `outside` counts reference ink missing from the render and rendered ink with no captured reference. White margins are ignored in those counts. Exact common-area RGB does not certify matching bounds or independent alpha. `GDI_FILTER` selects fixture names, `GDI_REPORT` selects the output file, and `GDI_DUMP` saves the same renders used for comparison.

## Case groups

`rop`, `gradient`, `text`, `pattern`, `rotation`, `rop2`, `image`,
`rotation-affine`, `text-extra`, `gdi-raster`, `emfplus-records`,
`gdiplus-extra`, `wmf-records`, `emf-records`, `halftone`, `halftone-origin`, `emfplus-effects`
and `pen-transform`; `all` runs every one.

Additional diagnostic groups:

- `path-gradient-focus` (standalone): 21 rectangle, triangle and ellipse captures with independent horizontal/vertical focus scales, including collapsed and fully focused axes. All seven rectangle and ellipse controls and seven triangle controls are within one channel level of native playback. Both collapsed triangle controls are within one level.
- `roundrect-half-fix` (standalone): 432 public GetPath controls in both arc directions, six fractional scales, three pen widths and twelve independent boxes/corners. Clockwise controls improve from zero to 87/216 exact paths, with every remaining coordinate within one FIX; all 72 even-FIX controls and prior counter-clockwise exact controls remain exact. Tests exercise the EMR_ROUNDRECT handler directly.
- `redeye-independent` (standalone): 192 synthetic controls plus 72 held-out controls use independent sizes, pupil radii and colours. All 103 selected nonzero-darkness controls are exact, and all 264 captures have per-case pixel/channel/alpha ceilings. Two previously inexact split fields retain slightly larger centroid residuals; pure-red native outputs can depend on capture order. Only left/both/whole residuals are now 12/99/582 pixels.
- `vertical-focus-line` (standalone): 108 independently coloured controls at three vertical focus scales and every triangle order. Focus-line samples are all within one level; ten controls retain 13 off-line pixels beyond one level.
- `path-gradient-steps` (standalone): 72 whole rows through white-to-black rectangles (width 4 to 2,000, height 2 to 300) and 64 100x80 images of rectangles, triangles and ellipses over opaque/translucent colour pairs, a Blend curve, an InterpolationColors preset, an isotropic focus and world scales 2 and 0.5 or brush scale 2 (`path-gradient-steps.json.gz`, each row/image with its path, centre and colours). Native paints a path gradient as `ceil(2 * hypot(w, h))` nested copies of the boundary for the device-space bounds; `src/emf-plus-path-gradient-steps.fixture.test.ts` pins the exact counts.
- `path-gradient-vertices` (standalone): 320 triangle, quad, pentagon and random star-shaped polygon captures (3 to 6 vertices on a 1/16 grid, 64x64) whose surround colours differ per vertex: single-channel and RGB vertices over black and white centres, translucent vertices and centres, isotropic and anisotropic focus scales, world scales and rotations (quarter turns, 10, 25, 30, 45 and 90 degrees). Native Gouraud-shades fan triangles (centre, vertex i, vertex i + 1) with a whole-pixel scan converter; `src/emf-plus-path-gradient-vertices.fixture.test.ts` pins the exact counts.
- `path-gradient-rotated` (standalone): 70 uniform white-to-black path gradients (rectangle, triangle and a wide rectangle, centre off the middle, fractional translation) under world and brush transforms: rotations of 0 to 200 degrees, an anisotropic scale, shears and mixed matrices (`path-gradient-rotated.json.gz`). The step count is `ceil(|M(w, h)| + |M(w, -h)|)` for the untransformed bounds `w` x `h` and the matrix's linear part `M`; `src/emf-plus-path-gradient-rotated.fixture.test.ts` pins the counts.
- `path-gradient-focus-shapes` (standalone): 80 white-to-black path gradients with independent FocusScales on a rectangle, an off-centre rectangle, a diamond and a triangle (ten scale pairs each: 0.75/0.25, 0.25/0.75, 0.5/0, 0/0.5, 1/0.25, 0.25/1, 0.5/0.5, 0.9/0.1, 0.6/0.3, 0.2/0.8) and 40 random triangles and quads with random scales, sized so every step can be read from its level (`path-gradient-focus-shapes.json.gz`). The nested copies scale per axis by `f + (1 - f) (m + 1/2) / N`; `src/emf-plus-path-gradient-focus-shapes.fixture.test.ts` pins the counts.
- `path-gradient-ties` (standalone): 14 integer-sized rectangles (30 x 30 to 120 x 60) and 7 diamonds (half-diagonals 16 to 50) centred on a pixel, white to black, so that nested copies at simple fractions have an edge exactly on a pixel row, column or diagonal (`path-gradient-ties.json.gz`). Native decides those pixels by edge arithmetic that is not reproduced (they keep the half-way colour of the two steps, within a level of either); `src/emf-plus-path-gradient-ties.fixture.test.ts` pins the counts and the statistics a future rule has to match.
- `focus-contours` (standalone): 252 public PathGradientBrush controls with three triangles, two centres, six vertex orders and seven focus pairs. Collapsed horizontal focus edges follow the strip below the scanline. 212 controls are within one level; 40 retain 57 boundary/overlap pixels beyond one level, checked independently per capture.
- `text-origin-phases` (standalone): 2,304 DrawDriverString captures at every 1/64-pixel x origin, with three glyphs, four fonts and grayscale/ClearType hints. All 1,280 closed grayscale controls are exact; nearest-quarter grayscale placement is independently established. ClearType horizontal origins round to the nearest sixth pixel without rounding the translated outline back to 26.6; 384 additional RGB controls are exact. Remaining glyph geometry still differs.
- `text-origin-vertical-phases` (standalone): another 2,304 DrawDriverString captures at every 1/64-pixel y origin. Nearest-quarter grayscale placement closes all 1,280 selected grayscale controls and reduces differing channel samples from 85,006 to 22,624 across the full set without regressions. Another 384 ClearType controls pin integer vertical placement; glyph shape residuals remain open.
- `text-drawstring-placement` (standalone): 144 public DrawString pixel captures covering four fonts, three hints, default/typographic formats and integer/quarter-pixel layouts. 88 closed glyph/format controls match exactly. Font ascent is rounded before adding the layout position; grayscale horizontal origins snap to the nearest quarter pixel; remaining glyph and ClearType sampling differences remain open.
- `halftone-transitions` (standalone): 144 full-pixel captures of sharp two-colour steps and multicolour ramps, four source widths, 2x/3x enlargement, identity/log/gamma adjustments, and both StretchBlt and StretchDIBits. `halftone-transitions.json.gz` retains input/output BGRA bytes and a transition line. The captures expose both replicated pixels and filtered enlargement; the selection rule is unresolved.
- `text-c1`: eight record-playback captures comparing C1 controls in ExtTextOut/PolyTextOut, default/IGNORELANGUAGE options, and Arial/Courier New. PolyTextOut paints C1 .notdef glyphs without requiring IGNORELANGUAGE. Courier is exact; Arial retains three glyph-edge pixels.
- `pen-axis-scales`: eight native EMF/PNG sheets, with 216 solid geometric pen controls under unequal axis scales, both 4/8-unit widths and all caps/joins. Every rendered pixel is exact.
- `wide-pen-axis-probe` (standalone): 3,600 public WidenPath/GetPath controls at independent 0.5/0.75/1/2/4 axis scales, widths 2/4/8/16, all caps/joins, and horizontal/vertical/diagonal/joined paths. The ellipse nib, square extension, miter metric and logical-direction tie rule reproduce all 3,600 fills exactly. These controls do not establish dashed or rotated/sheared nib geometry.
- `dashed-pen-axis-probe` (standalone): 2,160 public WidenPath/GetPath controls of dashed geometric pens (stock styles and a user style) at independent 0.5/1/2/4 axis scales, widths 2/4/8, all caps, and horizontal/vertical/diagonal lines. Writes `dashed-pen-axis-scales.json.gz`.
- `general-matrix-pen-probe` (standalone): 576 public WidenPath/GetPath controls of solid, dashed and user-style geometric pens under eight rotated, sheared and mixed world transforms, widths 4/8, all caps, four line shapes. Writes `general-matrix-pen.json.gz`.
- `nib-matrix-pen-probe` (standalone): 352 public WidenPath/GetPath controls of a zero-length and a one-unit round-capped path, widths 1 to 32, under eleven world transforms: the native pen polygon (nib) itself. Writes `nib-matrix-pen.json.gz`.
- `rotated-pen-vector-probe` (standalone): 6,432 public WidenPath/GetPath controls of a flat-capped solid pen along 134 logical directions under six rotated and sheared world transforms, widths 4 to 24: the perpendicular (start-cap corners) native picks. Writes `rotated-pen-vectors.json.gz`.
- `playback-extents` (standalone): replays 94 cases into surfaces covering their original references and recorded device bounds. GDI uses public PlayEnhMetaFile; EMF+ uses explicit pixel source rectangles including the extra extent. The `.extent.png` captures preserve every original reference pixel and carry their device origins in `playback-extents.json`; the report prefers these references. Sixty-eight full-area controls are exact. Nine other candidates failed original-overlap validation: `playback-extents-open.json` lists them and their native `.wide.png` playback (evidence that the originals are clipped, not references).
- `text-cleartype-coverage` (standalone): 1,664 ClearType DrawDriverString captures using the same fonts, characters, quarter-pixel origins and contrasts. All per-channel contrast mappings and 576 quarter-origin RGB controls are exact. Natural-width interpreter flags and truncating subpixel coverage are independently checked; other geometry/positioning residuals remain open.
- `text-recorded-advance` (standalone, reads the committed `textx-arial-*` and `textx-segoeui-cell-mono` EMF/PNG pairs from the output directory): draws each `TxSizeSheet` layout directly with `TextOutW`, directly with the dx array recorded in the EMF, and through `PlayEnhMetaFile`, and writes the pixel counts plus per-glyph direct and recorded advances to `text-recorded-advance.json`. Every mode accepts `-OutDir <dir>` to write somewhere other than `src/__fixtures__/gdi`; regenerating `text-extra` there first is how the nine clipped text references were compared (the `*.regen.*` raster-face captures are the two that differ).
- `text-coverage` (standalone): 3,328 single-glyph DrawDriverString captures, with baseline positions supplied directly, at quarter-pixel x/y origins, both grayscale hints and contrasts 0/4. Arial 16/40, italic Times New Roman 22 and bold Segoe UI 12 cover 13 letters/digits. All native contrast mappings are exact; 2,400 fractional-origin glyph controls are exact. Fractional origins are preserved; diagonal and other glyph residuals remain open.

The generator disables process DPI virtualisation so device caps agree with enhanced-metafile headers. Pen playback explicitly names its source rectangle in pixels; implicit source bounds can scale the image on a display above 96 DPI.

- `wide-path-probe`: 2,136 native `WidenPath` outlines at 1/16-pixel precision, widths 2–64, all cap/join styles and near reversals. `wide-path-fix.json` contains source FIX coordinates and native `[x,y,type]` triples. The round-cap/round-join cases have exact fill regressions.
- `flat-pen-probe`: 1,176 single flat-capped segments (21 pen widths in FIX, fractional and over 100 px included, 40 random and 16 axis/diagonal/slope directions each); `flat-pen-vectors.json` rows are `[width, dx, dy, vx, vy]` in FIX, `v` being half the start-side vertex difference.
- `wide-outline-probe`: 72 polyline/ellipse outlines, widths 2, 7, 10 and 32 and every cap/join style. All 36 ellipse outlines have exact vertex regressions, including duplicated inner triangles.
- `illuminant-charts`: nine EMF/PNG pairs for 256 grey, primary and mixed colours, with the input colours in `illuminant-chart-colours.json` (packed RGB).
- `halftone-dither`: 256 grey levels at three destination/brush origins.
- `wmf-insideframe-curves`: 100 ellipse, RoundRect, chord, pie and arc cases with 0.5–10 px inside-frame pens.
- `emf-insideframe`: `PS_INSIDEFRAME` pens of 1 to 16 px on a Rectangle, Ellipse, RoundRect, Arc, Chord, Pie and (as control) Polygon, drawn into an EMF in GM_ADVANCED and straight onto a bitmap (`emf-insideframe-<shape>`), plus the shapes under a 1.37 world scale (`emf-insideframe-scaled`).
- `wmf-roundrect-corners`: wide-pen (3, 5 and 7 px) RoundRects with 25 corner sizes at the identity scale and at 0.96 (`wmf-roundrect-corners[-scaled]`).
- `emf-scaled-path-probe`: native `GetPath` in `GM_ADVANCED` of 2,400 Arc, Chord, Pie, Ellipse, RoundRect and Rectangle calls under a `PS_INSIDEFRAME` pen (2 to 13 logical units) at the fractional scales window 16 / viewport 11, 17, 22, 23 and 29, a quarter of them `AD_CLOCKWISE` (`emf-scaled-paths.json`, stored gzipped: box, radials, corner and `[x, y, type]` triples in FIX). `src/emf-scaled-paths.fixture.test.ts` holds the bounds.
- `wmf-scaled-path-probe`: native `GetPath` of 1,500 Chord, Pie, Arc, Ellipse and RoundRect calls under a `PS_INSIDEFRAME` geometric pen (width 30 to 109 logical units) at the 0.96 WMF scale (`wmf-scaled-paths.json`: box, radials, RoundRect corner and `[x, y, type]` triples in FIX). Odd device pen widths put the shape's edges on half a FIX and shear its points; `src/wmf-scaled-paths.fixture.test.ts` holds the bounds.
- `arc-path-probe`: native `GetPath` of 900 Arc, Chord and Pie calls (`arc-paths.json`: box, radial points and `[x, y, type]` triples in FIX), the same calls under `AD_CLOCKWISE` (`arc-paths-cw.json`) 600 AngleArcs (`angle-arc-paths.json`) and 260 arcs on a 40,000 px circle (`arc-precise.json`: radials 8 million pixels out, single pieces of 0.3 to 85 degrees, arcs through every quadrant, nearly full turns and boundary-aligned ends, a quarter of them clockwise).
- `curve-dash-probe`: native `WidenPath` of 300 dashed wide pens (stock dash styles and user styles; round, square and flat caps) on Beziers and arcs (`curve-dash.json`).
- `curve-widen-probe`: native `WidenPath` of 320 wide curves (Bezier, Arc, Chord, Pie) under flat, square and round caps and round, bevel and miter joins (`curve-widen.json`).
- `arc-cap-sweep-probe`: native `WidenPath` of 1,436 square-capped, round-joined arcs on a 100 px circle, sweeping the end angle in whole degrees (1 to 359) at widths 9 and 16 and start angles 0 and 37 (`arc-cap-sweep.json.gz`: the arc's `GetPath` triples and the widened outline, FIX). It isolates a curve end's square-cap extension, which is the end tangent cut down to whole pixels (`src/gdi-raster-arc-cap.fixture.test.ts`).
- `scaled-cap-sweep-probe`: native `WidenPath` of 2,506 square-capped arcs under world scales 2, 0.5, 0.75 and 1.5, a 30 degree rotation and 1/16 and 1/2 anisotropic map modes (358 per transform: the end angle every 2 degrees from two start angles), with the arc's device `GetPath` points, in `scaled-cap-sweep.json.gz`. `scaled-line-caps-probe` does the same for one straight segment per logical vector (323 vectors from -40 to 40 units, 15 transforms including GM_COMPATIBLE map modes), in `scaled-line-caps.json.gz`. `scaled-pen-widths-probe` captures the device width a geometric pen gets from a logical width (1 to 40) under ten world scales and four map modes, horizontal and vertical, in `scaled-pen-widths.json`.
- `chord-closing-probe`: native `WidenPath` of 5,841 chords (arcs of 330 to 359.5 degrees on a circle and on the ellipse of `curve-widen.json` sample 206, width 9, every cap and join, then the neighbourhood of that sample with the end radial moved by 6 pixels each way), in `chord-closing.json.gz` with each chord's own `GetPath` points. `src/gdi-raster-dash-neighbourhood.fixture.test.ts` holds the bounds.
- `dash-neighbourhood-probe`: native `WidenPath` of 2,484 dashed or solid wide pens around `curve-dash.json` samples 117 (a user-style Bezier, second control point moved 2 pixels each way, first dash 15 to 40 px) and 128 (a dotted arc, 49 end radials, widths 2 to 9, solid and the three stock dash styles), in `curve-dash-neighbourhood.json.gz`.
- `emf-roundrect-mode-probe`: the same RoundRect calls (null, one-pixel cosmetic, wide plain and wide geometric pens) recorded into metafile DCs under GM_COMPATIBLE and GM_ADVANCED, played back natively. Writes `emf-roundrect-mode-{compat,adv}-{null,cosmetic,wide}.emf/.png` (native `PlayEnhMetaFile`) and `.direct.png` (the calls drawn straight in that mode), `emf-roundrect-mode-boxes.json` (the recorded EMR_ROUNDRECT boxes and the other record types: no graphics-mode record exists, a compatible recording stores the right and bottom one pixel short) and `emf-roundrect-mode-paths.json.gz` (800 shapes, `GetPath` of the call in each mode and `GetPath` read when the recorded EndPath has played, in whole pixels), plus `emfrec-path-widen.playback.png`, the native playback of an existing metafile whose reference was drawn directly. `src/emf-roundrect-mode.fixture.test.ts` holds the bounds.
- `emf-roundrect-wide-probe`: native `GetPath` in GM_COMPATIBLE of 1,800 RoundRects at the identity scale (450 each under a null pen, a one-pixel cosmetic pen, a wide plain pen and a wide geometric pen, both arc directions), in `emf-roundrect-wide-paths.json.gz`.
- `chord-sweep-probe`: native `WidenPath` of 1,044 chords on short arcs (1 to 15 degrees in half-degree steps on a 100 px circle, widths 9 and 16, start angles 0 and 37, every cap and join), with the chord's own `GetPath` points, in `chord-sweep.json.gz`.
- `image-codecs-cmyk-lut -TablesDir <dir>` (standalone): makes GDI+ decode every `*.jpg` in a directory to a PNG (a file it refuses gets `.failed.txt`). `cmyk-lut-inputs.py <dir>` writes the flat-block CMYK JPEGs (the 17^4 ink grid plus random combinations) and `bun scripts/gdi-fixtures/generate-cmyk-lut.ts <dir>` fits `src/jpeg-cmyk-data.ts` to the pairs. `image-codecs-advanced` also writes the `codec-jpeg-cmyk-*` / `codec-jpeg-ycck-*` references, `codec-jpeg-arithmetic` and `codec-jpeg-12bit` (the latter two are libjpeg-turbo's `testimgari.jpg` and `monkey12.jpg`, committed as is), and `codec-jpeg-{12bit,arithmetic,cmyk-photo}-playback.emf/.png`: an EMF+ DrawImage whose embedded JPEG was swapped in, with GDI+'s playback (the 12-bit file draws nothing).
- `icm-cmyk-probe -TablesDir <dir>` and `icm-cmyk-srgb16 -TablesDir <dir>` (standalone): run Windows ICM (`mscms.dll`, RSWOP.icm to sRGB, best mode) on every `*.ink` file in the directory (raw C, M, Y, K bytes per sample). `icm-cmyk-probe` writes every intent/flag/polarity variant (only intent 0 or 2 with flags 3 and the CMYK quads in reversed byte order matches GDI+), `icm-cmyk-srgb16` the 16-bit and 8-bit best-mode results that `generate-cmyk-lut.ts` solves the bundled table from (`inputs`, probe, `fit`, `samples`; `curve` checks the closed-form input table against the profile on a machine that has it, and `CMYK_STEP=n bun ... fit` reports another node step without writing the module). `icm-cmyk-translate16 -TablesDir <dir>` (standalone) feeds every `*.cmyk16` file (little-endian 16-bit C, M, Y, K words) to `TranslateColors` and writes `*.rgb16t` (16-bit R, G, B words); it needs a 64-bit PowerShell because a `COLOR` record is 16 bytes there. `generate-cmyk-lut.ts samples` writes the committed captures `icm-cmyk-samples.bin` (8,000 inks with the 8-bit result), `icm-cmyk-samples16.bin` (the same inks with the 16-bit result) and `icm-cmyk-translate16.bin` (4,000 `TranslateColors` records: 2,000 inks entered as `257 v`, 2,000 random words), with the manifest `environment-icm-cmyk-translate16.json`.
- `image-codecs-arithmetic` (standalone, needs `bun`): `arith-jpeg-encoder.ts` writes 28 arithmetic-coded JPEG variants (sequential/progressive, restart intervals, DAC conditioning, 4:2:0/4:2:2/4:4:0, greyscale, CMYK, YCCK) as `codec-jpeg-arith-*.bin` plus Huffman copies of the four-component ones, and GDI+ decodes each to a PNG (a refused one would get `.failed.txt`; none is refused). `-PlaybackCase prog-420-dri2` also records an EMF+ DrawImage playback. Prove the encoder with `bun arith-jpeg-encoder.ts <dir> --control <ctl>` and `python arith-jpeg-verify.py <dir> <ctl>` (Pillow decodes each file to the same pixels as the Huffman control).
- `image-codecs-extra`: odd-width bilevel TIFF captures with uncompressed, PackBits and CCITT Group 3/4 compression.
- `illuminant-tables`: large raw native samples, excluded from `all`. `halftone-dither-grey-samples.bin` contains 256 × 64 bytes, indexed by grey level then `(sourceY + 5) % 8`, `(sourceX + 5) % 8`; bytes are the nearest output index on the 32-level channel scale. `illuminant-colour-samples-N.bin` contains 32³ RGB triples, indexed by `(r * 32 + g) * 32 + b`, for inputs `floor(channel * 255 / 31)`, sampled at source cell offset (11,11). These captures are specific to the probe layout: using them as universal conversion tables fails independent chart comparisons.

These standalone probe modes must be invoked separately from comma-separated drawing groups: `path-probe`, `wide-path-probe`, `wide-outline-probe`, `flat-pen-probe`, `arc-path-probe`, `wmf-scaled-path-probe`, `emf-scaled-path-probe`, `curve-widen-probe`, `curve-dash-probe`, `arc-cap-sweep-probe`, `miter-limit-probe`, `gradient-blend-probe`, `image-codecs`, `image-codecs-extra`, `image-codecs-advanced`, `image-codecs-cmyk-lut`, `image-codecs-arithmetic`, `image-effects`, `image-effect-sharpen`, `image-effect-large-blur`, `image-effect-expanded-blur`, `image-effect-narrow-blur`, `image-effect-hue`, `image-effect-tint`, `image-effect-tables`, `chord-sweep-probe`, `scaled-cap-sweep-probe`, `scaled-line-caps-probe`, `scaled-pen-widths-probe`, `emf-roundrect-wide-probe`, `emf-roundrect-mode-probe`, `chord-closing-probe`, `dash-neighbourhood-probe`, `text-recorded-advance`, `hq-rotated`, `hq-axis`, `hq-half-shift`.

Every generator run also writes `environment-<groups>.json`. It records SHA-256 hashes of the generated references, installed system/user font files and native drawing libraries, plus Windows version, screen DPI and runner image. Compare manifests before accepting regenerated text fixtures; older captures have no recoverable environment manifest. Temporary image-effect tables keep their manifest in the requested temporary directory.

- `illuminant-cubes -TablesDir <dir>` (standalone): the colour Windows draws for every one of the 32^3 halftone palette colours under `IlluminantIndex` 1-5, 7 and 8 (`HalftoneColorProbe.cs`). `generate-illuminant-data.ts <dir>` turns them into `src/emf-gdi-illuminant-data.ts`; the same probe measured the colour-adjustment stage order and constants in `src/emf-gdi-color-adjust.ts` and the 66 x 65 dither in `src/emf-gdi-halftone-dither.ts`.
- `halftone-origin`: `emfrec-halftone-origin-{stretch,dib,plgblt,rotated}`, flat colours under a colour adjustment whose dither shows where the pattern starts (mirrored destinations, brush origins, mixed axes, bottom-up `StretchDIBits`, axis-aligned `PlgBlt`, rotated and skewed blits). Windows decides at the process's first HALFTONE blit whether rotated blits are adjusted, so the rotated case opens with an unrotated adjusted blit.
- `halftone`: `emfrec-halftone-{ramp,checker}-{2x,0p5x,1p37x}[-ca]`, HALFTONE
  `StretchBlt` of a gray/RGB ramp and a checkerboard, each plain and under
  `SetColorAdjustment` (`-ca`).
- `emfplus-effects`: `plus-effect-<effect>-<variant>`, GDI+ 1.1 image effects
  (blur, sharpen, brightness/contrast, colour balance, colour curve, colour
  LUT, colour matrix, hue/saturation/lightness, levels, tint, red-eye). Each is
  recorded with `GdipDrawImageFX` into an EMF+ metafile
  (`EmfPlusSerializableObject` + `DrawImagePoints` with flag E) and `.png` is
  GDI+'s playback of it. The test images are a 256-level gray ramp, colour
  ramps and hue sweeps, step edges and checkerboards, and a partly
  transparent image. `plus-effect-none-identity` is the same layout with no
  effect.
  Every case also records `plus-only-effect-<effect>-<variant>`. Dual adds
  a processed bitmap fallback; Only tests the effect algorithm directly.
- `pen-transform`: `pen-*` (uniform scale, rotation, translation, nonuniform
  scale (4, 1) and skew `[1 0 1 1]`).

## Running on GitHub Actions (no Windows machine needed)

The **Windows fixtures** workflow (`.github/workflows/windows-fixtures.yml`)
runs `generate.ps1` on a `windows-latest` runner.

1. Actions > **Windows fixtures** > **Run workflow**, or from a terminal:

   ```sh
   gh workflow run windows-fixtures.yml -f groups=emfplus-effects,halftone,pen-transform
   ```

   `groups` takes the names above, comma separated (`all` regenerates
   everything). `push` (default on) controls the branch push.
2. The run uploads every new or changed fixture as the artifact
   `windows-fixtures-<run_id>` and commits them to the branch
   `windows-fixtures/<run_id>`. It never pushes to `main`. The run summary
   lists the files.
3. Bring the files into your checkout, either:

   ```sh
   # from the branch
   git fetch origin windows-fixtures/<run_id>
   git checkout origin/windows-fixtures/<run_id> -- src/__fixtures__/gdi
   # or only some of them
   git checkout origin/windows-fixtures/<run_id> -- 'src/__fixtures__/gdi/plus-effect-*'

   # or from the artifact
   gh run download <run_id> -n windows-fixtures-<run_id> -D src/__fixtures__/gdi
   ```

   Then review with `git status` / `bun scripts/gdi-fixtures/report.ts`, add
   tests that use the new fixtures, and commit. Delete the branch afterwards
   (`git push origin --delete windows-fixtures/<run_id>`).

Regenerating existing groups on the runner can change their PNGs (a
different Windows build, fonts or DPI than the machine that made them); the
workflow's "Describe the runner" step logs the OS, `gdiplus.dll` /
`gdi32.dll` versions and screen DPI. Only take the files you need.

## Running on Windows by hand

From the repository root, in Windows PowerShell 5.1 (not PowerShell 7:
`Add-Type` must compile against .NET Framework's `System.Drawing`):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/gdi-fixtures/generate.ps1 emfplus-effects,halftone
```

The files are written straight into `src/__fixtures__/gdi`.

Native lookup tables can be regenerated separately:

`gradient-blend-probe` captures 17 premultiplied knots for each of 4,352 three-point Blend ramps, covering eight positions, eight factors and 68 opaque/translucent endpoint pairs. The compressed JSON preserves the recorded float32 positions and factors; tests reconstruct them with `Math.fround`.

```powershell
powershell.exe -NoProfile -File scripts/gdi-fixtures/generate.ps1 image-effect-tables .scratch/tables
bun scripts/gdi-fixtures/generate-image-curves.ts .scratch/tables
```

`image-effects` generates the direct pixel-effect probes and color-balance
sweep. `emfplus-effects` records metafiles for playback parity.
`image-codecs` generates the native JPEG, GIF and TIFF decoder references, including offset animated GIF frames (opaque and transparent, with global/local palettes and different background/transparency indices), LZW-compressed TIFF and multipage TIFF. `CodecProbe.Extended()` regenerates only these additional cases. `halftone-mixed` captures mixed-axis ramp/checker stretches with and without colour adjustment without regenerating the original uniform-axis cases. `color-adjustment-controls` captures standalone gamma, the log filter (including all 256 channel levels), all eight illuminants and direct StretchDIBits under HALFTONE.
`path-probe` captures native `GetPath` coordinates for the RoundRect sequence at whole-pixel and 1/16-pixel precision. `image-effect-sharpen` captures the sharpen amount sweep (0–100), blur/sharpen at 19 radii from 0.25 through 255, and blur ramps/colour impulses across seven bitmap dimensions.

`image-effect-large-blur` captures ramps and colour impulses at 22 radii on nine bitmap dimensions, plus impulse rows at every quarter radius from 16 through 255 to identify native reduction transitions. It also captures ten two-dimensional noise images (odd sizes, some with random alpha, radii 20-200) from a seeded generator, which pins the per-axis reduction, filtering and enlargement arithmetic.

`image-effect-expanded-blur` records 504 Dual draws into one metafile, retaining the source pixels, effect and native baked bitmap for every draw. Twelve radii (1–255), fourteen rectangles and three source patterns cover interior regions, every edge, one-pixel gaps, fractional bounds and varying alpha. This tests the effect before drawing/compositing differences.

`image-effect-narrow-blur` records 150 Dual draws of 48 x 48 seeded noise (opaque and translucent) into `effect-blur-narrow.emf`: rectangles up to one reduced block wide at radii 40-255 (a lone reduced sample, with and without a short block) and rectangles reaching an image edge at radii 20-160. It pins how a single sample is continued and how the buffer ends behave (`NarrowBlurProbe.cs`).

`miter-limit-probe` measures 384 native miter/bevel transition thresholds: eight pen widths, six near-reversal angles, four rotations and two mirrored orientations. It captures float32 limits immediately below/above each threshold and the native outline vertex counts for those 768 decisions.

`image-effect-hue` captures all 361 integer hue angles plus 182 saturation/lightness combinations on 1,536 saturated colours and 1,024 seeded mixed colours with varying alpha. Source bytes, setting triples and gzip-compressed output cover 1,390,080 colour/setting pairs. The regression verifies RGB bounds and exact native alpha preservation, also covered by the recorded DrawImage fixtures.

`image-effect-tint` uses the committed hue source plus every grey level to capture 90 combinations of hue and signed amount (253,440 colour/setting pairs), including -180/+180 and values next to zero. The source bytes, setting pairs and compressed output are saved independently of the hue capture.

`image-codecs-advanced` requires Python and Pillow >= 10.2. It encodes odd-sized Deflate TIFF strips (both compression tags and a horizontal predictor), uncompressed/Deflate tiles, RGB/YCbCr JPEG strips and tiles, and standalone 4:4:4/4:2:2/4:2:0, progressive, RGB and greyscale JPEG. Windows GDI+ then decodes every encoded file into its PNG reference. `codec-advanced-encoder.json` records the Python, Pillow, libtiff and JPEG encoder versions; the normal environment manifest associates both encoded files and native references with their hashes.

`bezier-flatten` captures public `GraphicsPath.Flatten(null, 0.25f)` output for 64 seeded random cubic curves and one ellipse. All 1,556 vertices match the shared fixed-point flattener and parsed path-gradient boundaries exactly.

`wide-pen-axis-directions` captures 16,128 independent single segments and right-angle corners, seven unequal axis transforms, four widths, and round/square caps. Every filled outline is exact, including 272 controls that previously differed because elliptical pen-edge ties were resolved in device direction.

`roundrect-half-fix-translation` captures 576 public `GetPath` controls: both arc directions, two fractional scales, 48 corner heights and translations of 0/+1024/-1024 logical units. Every translated native path is exactly covariant. This rejects coordinate magnitude as the cause of the remaining half-FIX side-point ties; 228 replay paths are exact and the others retain individually pinned one-FIX coordinate bounds. No rounding heuristic is inferred from the corner-height transition.

`halftone-selection` captures 240 fixed-geometry controls across 20 source patterns, two scales, three colour adjustments and both public stretch APIs. Of these, 144 are RGB-exact; 96 filtered controls have independent pixel, channel and maximum-error ceilings. Arbitrary palettes and grayscale ramps contradict both geometry-only and distinct-7-bit-colour selection rules, which are deliberately excluded from production.

`bicubic-arithmetic` captures 144 public native DrawImage controls with impulses and opaque/translucent noise. Nearest-16.16 row stepping, truncated 1/64 phases, integer premultiplication and per-pass truncation close 140 controls exactly; the other four differ on six pixels by one channel level. `bicubic-independent` adds 128 held-out crop, mirror, rotation and shear controls. The 64 axis controls improve from 10,474 to 142 differing pixels, with no per-case regression; the transform controls retain their bounds. PNG playback of `gpx-image-bicubic` improves from 7,127 to six differing pixels, maximum one level. SVG playback remains a separate open item.

`text-diagonal-hinting` captures 432 public GetGlyphOutline controls using three small committed diagnostic fonts. Their optional fontTools generator is `build-diagonal-fonts.py`. Vector normalization matches 144/144; diagonal coordinate projection matches 102/144 and point movement 98/144, with remaining errors at most 1/64 pixel. A proposed arithmetic correction closes these diagnostic primitives but loses existing exact real-font controls, so it is excluded from production pending independent GDI+ mode captures.

`halftone-arrangement` preserves each source histogram while permuting its pixels across 50 controls. Spatial arrangement changes the native enlargement branch, ruling out palette/histogram-only selectors. Both public APIs produce identical outputs in every capture, and repeated generation is byte-identical. Twenty-four replay controls are exact; 26 filtered controls retain strict individual RGB ceilings.

`bun scripts/check-svg-image-parity.ts <output.html>` writes a Chromium verification page for seven exact-resampling image fixtures. Open it and inspect `window.svgImageParity`: SVG should match PNG RGB byte for byte. The native comparison retains each PNG renderer's residuals. This checks real browser image embedding and chained clipping; an SVG decoder that omits embedded images cannot establish image parity.

`text-diagonal-coverage` captures 1,728 public GDI+ DrawDriverString images using the existing private diagnostic fonts, four sizes and four rendering hints. Every case has independent pixel-count and absolute-channel-error ceilings, pinning 375 exact controls. Candidate primitive arithmetic closes additional diagnostic images but still loses prior exact Arial grayscale captures and worsens eleven formerly inexact diagnostic images; it is not shipped. Interpreter arithmetic remains open.

`halftone-kernel` captures 216 central impulse/step/ramp responses with twelve deduplicated full source buffers. Seventy-two nearest-branch central controls are exact. Ninety-six filtered 2x/3x central responses independently verify four-neighbour sharpening and match a bounded nearest-eighth, integrated-tent measurement model, including log/gamma adjustment. A fractional 2.37x impulse rejects generalising this model, with fourteen channel levels of error. Selection and the general kernel remain open; the measurement model is kept out of production.

`bicubic-phases` captures 384 independent full-phase public DrawImage controls on opaque/translucent noise. Nearest 16.16 kernel coefficients close every original 144 arithmetic control and all 16,000 PNG fixture pixels exactly. Phase captures improve from 347 to 376 exact, with no per-case count/sum/maximum regression against the committed renderer. Eight native unit-scale near-integer copy cases retain individually pinned residuals; their eligibility boundary remains open. Independent crop/mirror residuals fall from 142 to 132 pixels.

`text-signed-diagonal` regenerates 576 public GDI signed outlines and 2,304 GDI+ signed coverage images using four separate diagnostic fonts (optional fontTools builder: `build-signed-diagonal-fonts.py`). The two capture sets can also be selected with `text-signed-diagonal-hinting` and `text-signed-diagonal-coverage`. Native model assertions isolate half-up component projection, original-distance projection before scaling, and unit freedom/projection dot products. Every current runtime control retains individual bounds. The proposed primitive change closes all signed outlines and additional images, but still loses fifteen prior exact real-font controls and increases four formerly inexact signed image residuals, so production arithmetic remains unchanged.

### Copy dispatch, vector opcodes and fractional HALFTONE controls

`bicubic-copy` captures 936 near-integer unit-scale draws; the half-open copy interval preserves prior exact convolution controls. `hq-arithmetic` captures 288 high-quality controls and 192 independent cropped, mirrored and alpha controls, distinguishing complete unit copies from draws scaled in only one axis.
`hq-rotated` (standalone) captures rotated HighQualityBilinear/Bicubic `DrawImagePoints` of impulse, two-impulse, noise and alpha-noise sources at 10 to 60 degrees and 1.1x to 3x under PixelOffsetMode None and Half (`hq-rotated.json.gz`, 600 draws, each also made in two steps: pre-scale to the device length, then the plain kernel rotated, with `twoDiff3`/`twoDiff4` the differing bytes, and the None intermediate of the noise draws), plus `hq-rotated-fine.json.gz` (the sweep over source scale from 0.5x to 2.5x with every candidate intermediate size and both pixel offset modes, and the near-axis-aligned shear sweeps). `hq-axis` (standalone) captures axis-aligned high-quality upscales and reductions of 256 grey impulses of value 0 to 255 (`hq-axis.json.gz`, reading each destination phase's weight to better than 1/255) and of a long noise row (`hq-axis-noise.json.gz`, which pins the 1/128-texel phase arithmetic). `hq-half-shift` (standalone) searches destination translations of the None draw that reproduce a Half draw (`hq-half-shift.json`).

`text-opcode-hinting` and `text-opcode-coverage` use the six `opcode-*.ttf` diagnostic inputs (384 outlines and 3,072 images). `text-vector-stage-hinting` and `text-vector-stage-coverage` use seven `vector-stage-*.ttf` inputs (448 outlines and 2,560 images). The supplied SPVFS/SFVFS vector words are preserved by native GPV/GFV; the broader projection-rounding candidate still fails prior exact controls. The optional builders require Python fontTools; capture does not rebuild their checked-in inputs. Environment manifests hash every diagnostic font. `bun scripts/check-diagonal-opcode.ts` reproduces the real-font candidate rejection without changing production code.

`halftone-fractional-kernel` captures 1,536 response lines and `halftone-run-phase` captures 576 independent lines across source sizes, ratios, translations and both blit APIs. The test-only model uses discrete nearest-source runs and tent weights quantised to sixteenths. Runtime content selection remains unresolved.

Expanded playback now contains 92 controls, including four mixed-axis checker captures. Each capture runs in a fresh PowerShell process because prior metafile playback can alter subsequent native output. Eight older recordings explicitly request their recorded native frame and public per-record playback with the enumeration DC and handle table. All expanded captures must reproduce the original PNG overlap exactly; original PNGs are retained.

`path-gradient-colors` captures 120 contour/color/wrap cases and 240 independent alpha/focus/order controls. Premultiplied interpolation is confirmed for uniform surrounds with unequal center alpha; varying surrounds remain on the prior path because extending the candidate introduces regressions.

`halftone-run-2d` captures 432 central RGB crops, including 48 independently held-out cases. Native rounds the vertical pass to integers before horizontal filtering and final rounding. The measured model predicts every crop exactly, including log/gamma controls. Selection, edge/alpha behavior and run lengths outside 2�4 remain unresolved; this helper is test-only.
