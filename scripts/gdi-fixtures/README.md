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

```powershell
powershell.exe -NoProfile -File scripts/gdi-fixtures/generate.ps1 image-effect-tables .scratch/tables
bun scripts/gdi-fixtures/generate-image-curves.ts .scratch/tables
```

`image-effects` generates the direct pixel-effect probes and color-balance
sweep. `emfplus-effects` records metafiles for playback parity.
`image-codecs` generates the native JPEG, GIF and TIFF decoder references, including offset animated GIF frames (opaque and transparent, with global/local palettes and different background/transparency indices), LZW-compressed TIFF and multipage TIFF. `CodecProbe.Extended()` regenerates only these additional cases. `halftone-mixed` captures mixed-axis ramp/checker stretches with and without colour adjustment without regenerating the original uniform-axis cases. `color-adjustment-controls` captures standalone gamma, the log filter (including all 256 channel levels), all eight illuminants and direct StretchDIBits under HALFTONE.
`path-probe` captures native `GetPath` coordinates for the RoundRect sequence.
