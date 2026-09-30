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
  - The rotated blur's effected bitmap is now exact; playback still has a 0.22% residual along one draw edge (`plus-effect-blur-r3-rotate30`).
  - Blur and sharpen differ above radius 16, where native GDI+ uses a different algorithm. The native radius sweep covers 0.25–255, and dimension probes cover seven square, tall and narrow buffers. Through radius 16, colour impulses are exact and ramps are within one level; smaller-radius sharpen residuals are at most two levels.
- **Fitted to a single data point:**
  - tint's chroma scale;

Sharpen strength now uses the native rational amount curve, quantized to 1/64 with half-down rounding. It matches every integer amount 0–100 and 19 radii when tested independently of blur convolution.

- **JPEG chroma reconstruction:** the bundled fallback decoder differs from Windows by up to 19 levels on the ramp fixture. GIF and TIFF match native references exactly, including offset opaque/transparent animated GIF frames with global/local palettes and different background and transparency indices, LZW-compressed TIFF, multipage TIFF, and odd-width bilevel uncompressed/PackBits/CCITT Group 3/4 TIFF. Group 3 now honors explicit one-dimensional coding instead of guessing from the first run. Deflate/JPEG-compressed and tiled TIFF remain additional coverage targets.

## GDI color adjustment and HALFTONE

- **`EMR_SETCOLORADJUSTMENT` formulas** are fitted to the Windows fixtures and still approximate:
  - Saturated reds pick up some blue, and saturated blues too much green.
  - Windows' ordered dither (32 levels per channel) is not reproduced; its threshold matrix is unknown.
- **The fitted parameters trade two fixtures against each other.** `emfrec-coloradjustment` went from 6.6% to 7.9% of pixels off by more than 24, in exchange for large gains on the newer `emfrec-halftone-*-ca` fixtures.
- **Isolated controls:** native `color-adjustment-controls` captures now cover the log filter, uniform/per-channel gamma, all eight illuminants and `StretchDIBits` under HALFTONE. Gamma and log-filter StretchBlt fixtures match exactly, including reduction. The log curve matches all 256 native input levels for grey and RGB channels. Illuminants other than device-default/D65 remain ignored; their native references now expose the difference. Direct DIB enlargement skips StretchBlt's pre-smoothing; the unadjusted fixture retains 0.74% mismatches (at most two levels), and adjusted DIB/colour-band boundaries still need work.
- **Mixed-axis stretching:** eight native `halftone-mixed` cases now cover ramp/checker enlargement on one axis and reduction on the other, with and without colour adjustment. Interpolation and directional sharpening reduce the unadjusted mismatch from 22.3–47.1% to 3.5–23.6% at zero tolerance. Colour and edge differences remain; the horizontal ramp enlargement is within one level everywhere.
- **Enlargement pre-smoothing:** the rule that smooths isolated pixels before an enlargement was inferred from checkerboard fixtures. It is not a known algorithm, so test it on more inputs.

Native `illuminant-charts` now capture 256 greys, primaries and mixed colours for all nine illuminant settings. `halftone-dither` captures all 256 grey levels at three destination/brush origins. The larger `illuminant-tables` probe records raw grey-phase and colour-cube samples; those samples do not generalize to the smaller charts as lookup tables. A universal dither or illuminant transform remains unresolved.

## GDI path geometry

RoundRect controls now match native `GetPath` captures without exceptions. The compatible-mode cases also match at 1/16-pixel precision, including mirrored viewports and clockwise paths; `path-probe` regenerates both captures.
- Native `wide-path-probe` now covers 2,136 three-point paths with 2–64 px pens, all cap/join combinations and near reversals. All 128 round-cap/round-join fills match exactly in the regression test. Mixed cap/join styles still have half-pixel perpendicular and arc-end inclusion differences; near-reversal miter limits also need work.
- `wide-outline-probe` captures 72 polyline/ellipse outlines across four widths and every cap/join combination. All 36 ellipse outlines match every native vertex, including the duplicated inner triangles; `emfrec-path-widen-outline` now matches exactly (previously 1.184% mismatches).
- Native `wmf-insideframe-curves` now covers 100 ellipse/RoundRect/chord/pie/arc cases at 0.5–10 px. Fractional fitting and widening, plus scaling RoundRect corners onto the inset box, reduce closed-curve mismatches from 1.67–2.79% to 0.11–0.16%; arc retains 0.039%. Small boundary differences remain.

  Rectangular inside-frame native sweeps now cover 0.5–10 px widths. The narrow subpixel sweep is exact; wider half-pixel widths retain 0.39% mismatches.


## Text

- **Unresolved differences:** glyph-edge differences and the `PolyTextOut` C1 control glyph difference have no fix yet.
- **Fonts in fixtures:** text fixtures generated on the Windows runner may differ from the original captures, because the runner's fonts can differ. New captures include font hashes and native library versions. The original text captures lack that provenance; matching their font environment remains unresolved.

## Tooling

- **Regenerating existing groups:** running existing fixture groups on the Windows runner can change their PNGs, because the runner's OS, fonts and DPI can differ. Compare before replacing committed fixtures.

Every new generator run writes an `environment-<groups>.json` manifest associating reference hashes with Windows/native-library versions, screen DPI and installed font hashes. This makes subsequent environment changes detectable; it cannot recover the environment of earlier captures.
