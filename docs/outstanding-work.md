# Outstanding work

Open items, grouped by area. [Limitations](./limitations.md) describes current behaviour for users. This page lists what is still to be done and what data each item needs.

Windows reference images come from `scripts/gdi-fixtures`. The **Windows fixtures** workflow (`.github/workflows/windows-fixtures.yml`) runs those scripts on a GitHub-hosted Windows runner and pushes the output to a `windows-fixtures/<run_id>` branch. See `scripts/gdi-fixtures/README.md`.

## EMF+ image effects

The 74 Dual effect fixtures (`plus-effect-*`) and 74 Only equivalents (`plus-only-effect-*`) are in the parity test. They have been regenerated on Windows with corrected metafile type constants. `src/emf-plus-image-effects.fixture.test.ts` also checks the effect algorithms against the effected bitmaps that GDI+ records into each fixture.

- **Not exact yet:**
  - HSL hue rotation reproduces GDI+'s integer hue rounding only partly (up to 11 levels off).
  - Tint is within 3 levels.
  - Levels has one one-level rounding difference in the 258,560-value native sweep.
  - Red-eye uses a simple rule. GDI+ detects pupils and repaints them with a texture.
  - The blur has a 0.22% residual along one edge of the rotated draw (`plus-effect-blur-r3-rotate30`).
- **Fitted to a single data point:**
  - tint's chroma scale;
  - sharpen's gain beyond radius 3;

- **JPEG chroma reconstruction:** the bundled fallback decoder differs from Windows by up to 19 levels on the ramp fixture. GIF and TIFF match native references exactly, including offset opaque/transparent animated GIF frames with global/local palettes and different background and transparency indices, LZW-compressed TIFF, and multipage TIFF. Further TIFF compression variants remain useful coverage.

## GDI color adjustment and HALFTONE

- **`EMR_SETCOLORADJUSTMENT` formulas** are fitted to the Windows fixtures and still approximate:
  - Saturated reds pick up some blue, and saturated blues too much green.
  - Windows' ordered dither (32 levels per channel) is not reproduced; its threshold matrix is unknown.
- **The fitted parameters trade two fixtures against each other.** `emfrec-coloradjustment` went from 6.6% to 7.9% of pixels off by more than 24, in exchange for large gains on the newer `emfrec-halftone-*-ca` fixtures.
- **No fixtures yet:**
  - the log filter;
  - the illuminant (ignored);
  - gamma-only adjustment;
  - `StretchDIBits` under HALFTONE.
- **Mixed-axis stretching:** eight native `halftone-mixed` cases now cover ramp/checker enlargement on one axis and reduction on the other, with and without colour adjustment. Interpolation and directional sharpening reduce the unadjusted mismatch from 22.3–47.1% to 3.5–23.6% at zero tolerance. Colour and edge differences remain; the horizontal ramp enlargement is within one level everywhere.
- **Enlargement pre-smoothing:** the rule that smooths isolated pixels before an enlargement was inferred from checkerboard fixtures. It is not a known algorithm, so test it on more inputs.

## GDI path geometry

- **RoundRect control points:** four GM_COMPATIBLE `RoundRect` control points in Wine's `test_roundrect` data (#33, #38, #102, #113) are one unit off. A fresh native `GetPath` capture confirms those four differences; `path-probe` regenerates it. See `OFF_BY_ONE` in `src/gdi-path-wine.test.ts`.
- **Existing residuals with no ground truth yet:**
  - `WidenPath` inner join triangles;
  - wide round joins;
  - WMF `PS_INSIDEFRAME` curved boxes.

  Rectangular inside-frame native sweeps now cover 0.5–10 px widths. The narrow subpixel sweep is exact; wider half-pixel widths retain 0.39% mismatches.

  Wine's tests do not cover these. New Windows fixture cases are needed.

## Text

- **Unresolved differences:** glyph-edge differences and the `PolyTextOut` C1 control glyph difference have no fix yet.
- **Fonts in fixtures:** text fixtures generated on the Windows runner may differ from the original captures, because the runner's fonts can differ. Pin fonts before adding text cases to the workflow.

## Tooling

- **Regenerating existing groups:** running existing fixture groups on the Windows runner can change their PNGs, because the runner's OS, fonts and DPI can differ. Compare before replacing committed fixtures.
