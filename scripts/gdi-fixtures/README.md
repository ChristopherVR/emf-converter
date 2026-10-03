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
- `focus-contours` (standalone): 252 public PathGradientBrush controls with three triangles, two centres, six vertex orders and seven focus pairs. Collapsed horizontal focus edges follow the strip below the scanline. 212 controls are within one level; 40 retain 57 boundary/overlap pixels beyond one level, checked independently per capture.
- `text-origin-phases` (standalone): 2,304 DrawDriverString captures at every 1/64-pixel x origin, with three glyphs, four fonts and grayscale/ClearType hints. All 1,280 closed grayscale controls are exact; nearest-quarter grayscale placement is independently established. ClearType horizontal origins round to the nearest sixth pixel without rounding the translated outline back to 26.6; 384 additional RGB controls are exact. Remaining glyph geometry still differs.
- `text-origin-vertical-phases` (standalone): another 2,304 DrawDriverString captures at every 1/64-pixel y origin. Nearest-quarter grayscale placement closes all 1,280 selected grayscale controls and reduces differing channel samples from 85,006 to 22,624 across the full set without regressions. Another 384 ClearType controls pin integer vertical placement; glyph shape residuals remain open.
- `text-drawstring-placement` (standalone): 144 public DrawString pixel captures covering four fonts, three hints, default/typographic formats and integer/quarter-pixel layouts. 88 closed glyph/format controls match exactly. Font ascent is rounded before adding the layout position; grayscale horizontal origins snap to the nearest quarter pixel; remaining glyph and ClearType sampling differences remain open.
- `halftone-transitions` (standalone): 144 full-pixel captures of sharp two-colour steps and multicolour ramps, four source widths, 2x/3x enlargement, identity/log/gamma adjustments, and both StretchBlt and StretchDIBits. `halftone-transitions.json.gz` retains input/output BGRA bytes and a transition line. The captures expose both replicated pixels and filtered enlargement; the selection rule is unresolved.
- `text-c1`: eight record-playback captures comparing C1 controls in ExtTextOut/PolyTextOut, default/IGNORELANGUAGE options, and Arial/Courier New. PolyTextOut paints C1 .notdef glyphs without requiring IGNORELANGUAGE. Courier is exact; Arial retains three glyph-edge pixels.
- `pen-axis-scales`: eight native EMF/PNG sheets, with 216 solid geometric pen controls under unequal axis scales, both 4/8-unit widths and all caps/joins. Every rendered pixel is exact.
- `wide-pen-axis-probe` (standalone): 3,600 public WidenPath/GetPath controls at independent 0.5/0.75/1/2/4 axis scales, widths 2/4/8/16, all caps/joins, and horizontal/vertical/diagonal/joined paths. The ellipse nib, square extension, miter metric and logical-direction tie rule reproduce all 3,600 fills exactly. These controls do not establish dashed or rotated/sheared nib geometry.
- `playback-extents` (standalone): replays 88 cases into surfaces covering their original references and recorded device bounds. GDI uses public PlayEnhMetaFile; EMF+ uses explicit pixel source rectangles including the extra extent. The `.extent.png` captures preserve every original reference pixel and carry their device origins in `playback-extents.json`; the report prefers these references. Sixty full-area controls are exact. Thirteen other extent candidates failed original-overlap validation and remain open.
- `text-cleartype-coverage` (standalone): 1,664 ClearType DrawDriverString captures using the same fonts, characters, quarter-pixel origins and contrasts. All per-channel contrast mappings and 576 quarter-origin RGB controls are exact. Natural-width interpreter flags and truncating subpixel coverage are independently checked; other geometry/positioning residuals remain open.
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
- `arc-path-probe`: native `GetPath` of 900 Arc, Chord and Pie calls (`arc-paths.json`: box, radial points and `[x, y, type]` triples in FIX), the same calls under `AD_CLOCKWISE` (`arc-paths-cw.json`) 600 AngleArcs (`angle-arc-paths.json`) and 260 arcs on a 40,000 px circle (`arc-precise.json`: radials 8 million pixels out, single pieces of 0.3 to 85 degrees, arcs through every quadrant, nearly full turns and boundary-aligned ends, a quarter of them clockwise).
- `curve-dash-probe`: native `WidenPath` of 300 dashed wide pens (stock dash styles and user styles; round, square and flat caps) on Beziers and arcs (`curve-dash.json`).
- `curve-widen-probe`: native `WidenPath` of 320 wide curves (Bezier, Arc, Chord, Pie) under flat, square and round caps and round, bevel and miter joins (`curve-widen.json`).
- `image-codecs-extra`: odd-width bilevel TIFF captures with uncompressed, PackBits and CCITT Group 3/4 compression.
- `illuminant-tables`: large raw native samples, excluded from `all`. `halftone-dither-grey-samples.bin` contains 256 × 64 bytes, indexed by grey level then `(sourceY + 5) % 8`, `(sourceX + 5) % 8`; bytes are the nearest output index on the 32-level channel scale. `illuminant-colour-samples-N.bin` contains 32³ RGB triples, indexed by `(r * 32 + g) * 32 + b`, for inputs `floor(channel * 255 / 31)`, sampled at source cell offset (11,11). These captures are specific to the probe layout: using them as universal conversion tables fails independent chart comparisons.

These standalone probe modes must be invoked separately from comma-separated drawing groups: `path-probe`, `wide-path-probe`, `wide-outline-probe`, `miter-limit-probe`, `gradient-blend-probe`, `image-codecs`, `image-codecs-extra`, `image-codecs-advanced`, `image-effects`, `image-effect-sharpen`, `image-effect-large-blur`, `image-effect-expanded-blur`, `image-effect-narrow-blur`, `image-effect-hue`, `image-effect-tint`, `image-effect-tables`.
These standalone probe modes must be invoked separately from comma-separated drawing groups: `path-probe`, `wide-path-probe`, `wide-outline-probe`, `flat-pen-probe`, `arc-path-probe`, `curve-widen-probe`, `curve-dash-probe`, `miter-limit-probe`, `gradient-blend-probe`, `image-codecs`, `image-codecs-extra`, `image-codecs-advanced`, `image-effects`, `image-effect-sharpen`, `image-effect-large-blur`, `image-effect-expanded-blur`, `image-effect-hue`, `image-effect-tint`, `image-effect-tables`.

Every generator run also writes `environment-<groups>.json`. It records SHA-256 hashes of the generated references, installed system/user font files and native drawing libraries, plus Windows version, screen DPI and runner image. Compare manifests before accepting regenerated text fixtures; older captures have no recoverable environment manifest. Temporary image-effect tables keep their manifest in the requested temporary directory.

- `illuminant-cubes -TablesDir <dir>` (standalone): the colour Windows draws for every one of the 32^3 halftone palette colours under `IlluminantIndex` 1�5, 7 and 8 (`HalftoneColorProbe.cs`). `generate-illuminant-data.ts <dir>` turns them into `src/emf-gdi-illuminant-data.ts`; the same probe measured the colour-adjustment stage order and constants in `src/emf-gdi-color-adjust.ts` and the 66 x 65 dither in `src/emf-gdi-halftone-dither.ts`.
- `halftone-origin`: `emfrec-halftone-origin-{stretch,dib,plgblt,rotated}`, flat colours under a colour adjustment whose dither shows where the pattern starts (mirrored destinations, brush origins, mixed axes, bottom-up `StretchDIBits`, axis-aligned `PlgBlt`, rotated and skewed blits). Windows decides at the process's first HALFTONE blit whether rotated blits are adjusted, so the rotated case opens with an unrotated adjusted blit.
- `illuminant-cubes -TablesDir <dir>` (standalone): the colour Windows draws for every one of the 32^3 halftone palette colours under `IlluminantIndex` 1�5, 7 and 8 (`HalftoneColorProbe.cs`). `generate-illuminant-data.ts <dir>` turns them into `src/emf-gdi-illuminant-data.ts`; the same probe measured the colour-adjustment stage order and constants in `src/emf-gdi-color-adjust.ts` and the 66 x 65 dither in `src/emf-gdi-halftone-dither.ts`.
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
