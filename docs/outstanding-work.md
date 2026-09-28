# Outstanding work

Open items, grouped by area. [Limitations](./limitations.md) describes current behaviour for users. This page lists what is still to be done and what data each item needs.

Windows reference images come from `scripts/gdi-fixtures`. The **Windows fixtures** workflow (`.github/workflows/windows-fixtures.yml`) runs those scripts on a GitHub-hosted Windows runner and pushes the output to a `windows-fixtures/<run_id>` branch. See `scripts/gdi-fixtures/README.md`.

## EMF+ image effects

The 74 GDI+ effect fixtures (`plus-effect-*`) are in the parity test. `src/emf-plus-image-effects.fixture.test.ts` also checks the effect algorithms against the effected bitmaps that GDI+ records into each fixture.

- **Not exact yet:**
  - HSL hue rotation reproduces GDI+'s integer hue rounding only partly (up to 11 levels off).
  - Tint is within 2 levels.
  - Red-eye uses a simple rule. GDI+ detects pupils and repaints them with a texture.
  - The blur has a 0.22% residual along one edge of the rotated draw (`plus-effect-blur-r3-rotate30`).
- **Fitted to a single data point:**
  - tint's chroma scale;
  - sharpen's gain beyond radius 3;
  - the ColorCurve contrast, highlight and shadow control points (measured at ±50 only, scaled linearly for other intensities).
- **Re-run the effect fixtures.** The generator's metafile type constants were wrong, so the 74 cases were recorded as EmfPlusDual instead of EmfPlusOnly, and `plus-effect-blur-r3-dual` failed. The constants are fixed in `GdiFixtures.cs`. Re-run the `emfplus-effects` group to get EmfPlusOnly recordings and the dual case.
- **Red-eye parameter size:** the red-eye parameter size used by the generator is unverified.
- **Undecoded formats:** effects are skipped for JPEG, GIF and TIFF images when no canvas backend is available to decode them.
- **Source rectangle not in pixels:** the effect is applied to the whole image.
- **Deferred draws:** a `DrawImage` deferred until after replay is painted without its effect.

## GDI color adjustment and HALFTONE

- **`EMR_SETCOLORADJUSTMENT` formulas** are fitted to the Windows fixtures and still approximate:
  - Saturated reds pick up some blue, and saturated blues too much green.
  - Windows' ordered dither (32 levels per channel) is not reproduced; its threshold matrix is unknown.
- **The fitted parameters trade two fixtures against each other.** `emfrec-coloradjustment` went from 6.6% to 7.9% of pixels off by more than 24, in exchange for large gains on the newer `emfrec-halftone-*-ca` fixtures.
- **No fixtures yet:**
  - the log filter;
  - the illuminant (ignored);
  - gamma-only adjustment;
  - `StretchDIBits` under HALFTONE;
  - a stretch that enlarges one axis and reduces the other.
- **Enlargement pre-smoothing:** the rule that smooths isolated pixels before an enlargement was inferred from checkerboard fixtures. It is not a known algorithm, so test it on more inputs.

## EMF+ pens

- **Pen transforms that cannot be inverted** are ignored.
- **Anchor caps:** anchor caps other than `ArrowAnchor` have no Windows fixture.
- **Dash pattern under a uniform pen scale:** a uniform pen scale no longer scales the dash pattern. This was inferred from the (4, 1) case and no fixture checks it.

## GDI path geometry

- **RoundRect control points:** four GM_COMPATIBLE `RoundRect` control points in Wine's `test_roundrect` data (#33, #38, #102, #113) are one unit off. See `OFF_BY_ONE` in `src/gdi-path-wine.test.ts`.
- **Antialiased path brackets:** on the antialiased Canvas route, `Rectangle`, `Ellipse` and `RoundRect` inside path brackets still use the old point order. Only the exact GDI geometry was corrected.
- **Existing residuals with no ground truth yet:**
  - `WidenPath` inner join triangles;
  - wide round joins;
  - `LAYOUT_RTL` diagonals;
  - WMF `PS_INSIDEFRAME`.

  Wine's tests do not cover these. New Windows fixture cases are needed.

## Text

- **Unresolved differences:** glyph-edge differences and the `PolyTextOut` C1 control glyph difference have no fix yet.
- **Fonts in fixtures:** text fixtures generated on the Windows runner may differ from the original captures, because the runner's fonts can differ. Pin fonts before adding text cases to the workflow.

## Tooling

- **`scripts/gdi-fixtures/report.ts`** stops with an error on `wmf-embedded-emf.recovered.emf`, which has no reference PNG.
- **Regenerating existing groups:** running existing fixture groups on the Windows runner can change their PNGs, because the runner's OS, fonts and DPI can differ. Compare before replacing committed fixtures.
