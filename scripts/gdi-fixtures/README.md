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

## Case groups

`rop`, `gradient`, `text`, `pattern`, `rotation`, `rop2`, `image`,
`rotation-affine`, `text-extra`, `gdi-raster`, `emfplus-records`,
`gdiplus-extra`, `wmf-records`, `emf-records`, `halftone`, `emfplus-effects`
and `pen-transform`; `all` runs every one.

Additional diagnostic groups:

- `wide-path-probe`: 2,136 native `WidenPath` outlines at 1/16-pixel precision, widths 2–64, all cap/join styles and near reversals. `wide-path-fix.json` contains source FIX coordinates and native `[x,y,type]` triples. The round-cap/round-join cases have exact fill regressions.
- `flat-pen-probe`: 1,176 single flat-capped segments (21 pen widths in FIX, fractional and over 100 px included, 40 random and 16 axis/diagonal/slope directions each); `flat-pen-vectors.json` rows are `[width, dx, dy, vx, vy]` in FIX, `v` being half the start-side vertex difference.
- `wide-outline-probe`: 72 polyline/ellipse outlines, widths 2, 7, 10 and 32 and every cap/join style. All 36 ellipse outlines have exact vertex regressions, including duplicated inner triangles.
- `illuminant-charts`: nine EMF/PNG pairs for 256 grey, primary and mixed colours, with the input colours in `illuminant-chart-colours.json` (packed RGB).
- `halftone-dither`: 256 grey levels at three destination/brush origins.
- `wmf-insideframe-curves`: 100 ellipse, RoundRect, chord, pie and arc cases with 0.5–10 px inside-frame pens.
- `wmf-roundrect-corners`: wide-pen (3, 5 and 7 px) RoundRects with 25 corner sizes at the identity scale and at 0.96 (`wmf-roundrect-corners[-scaled]`).
- `arc-path-probe`: native `GetPath` of 900 Arc, Chord and Pie calls (`arc-paths.json`: box, radial points and `[x, y, type]` triples in FIX).
- `curve-widen-probe`: native `WidenPath` of 320 wide curves (Bezier, Arc, Chord, Pie) under flat, square and round caps and round, bevel and miter joins (`curve-widen.json`).
- `image-codecs-extra`: odd-width bilevel TIFF captures with uncompressed, PackBits and CCITT Group 3/4 compression.
- `illuminant-tables`: large raw native samples, excluded from `all`. `halftone-dither-grey-samples.bin` contains 256 × 64 bytes, indexed by grey level then `(sourceY + 5) % 8`, `(sourceX + 5) % 8`; bytes are the nearest output index on the 32-level channel scale. `illuminant-colour-samples-N.bin` contains 32³ RGB triples, indexed by `(r * 32 + g) * 32 + b`, for inputs `floor(channel * 255 / 31)`, sampled at source cell offset (11,11). These captures are specific to the probe layout: using them as universal conversion tables fails independent chart comparisons.

These standalone probe modes must be invoked separately from comma-separated drawing groups: `path-probe`, `wide-path-probe`, `wide-outline-probe`, `flat-pen-probe`, `arc-path-probe`, `curve-widen-probe`, `miter-limit-probe`, `gradient-blend-probe`, `image-codecs`, `image-codecs-extra`, `image-codecs-advanced`, `image-effects`, `image-effect-sharpen`, `image-effect-large-blur`, `image-effect-expanded-blur`, `image-effect-hue`, `image-effect-tint`, `image-effect-tables`.

Every generator run also writes `environment-<groups>.json`. It records SHA-256 hashes of the generated references, installed system/user font files and native drawing libraries, plus Windows version, screen DPI and runner image. Compare manifests before accepting regenerated text fixtures; older captures have no recoverable environment manifest. Temporary image-effect tables keep their manifest in the requested temporary directory.

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

`miter-limit-probe` measures 384 native miter/bevel transition thresholds: eight pen widths, six near-reversal angles, four rotations and two mirrored orientations. It captures float32 limits immediately below/above each threshold and the native outline vertex counts for those 768 decisions.

`image-effect-hue` captures all 361 integer hue angles plus 182 saturation/lightness combinations on 1,536 saturated colours and 1,024 seeded mixed colours with varying alpha. Source bytes, setting triples and gzip-compressed output cover 1,390,080 colour/setting pairs. The regression verifies RGB bounds and exact native alpha preservation, also covered by the recorded DrawImage fixtures.

`image-effect-tint` uses the committed hue source plus every grey level to capture 90 combinations of hue and signed amount (253,440 colour/setting pairs), including -180/+180 and values next to zero. The source bytes, setting pairs and compressed output are saved independently of the hue capture.

`image-codecs-advanced` requires Python and Pillow >= 10.2. It encodes odd-sized Deflate TIFF strips (both compression tags and a horizontal predictor), uncompressed/Deflate tiles, RGB/YCbCr JPEG strips and tiles, and standalone 4:4:4/4:2:2/4:2:0, progressive, RGB and greyscale JPEG. Windows GDI+ then decodes every encoded file into its PNG reference. `codec-advanced-encoder.json` records the Python, Pillow, libtiff and JPEG encoder versions; the normal environment manifest associates both encoded files and native references with their hashes.
