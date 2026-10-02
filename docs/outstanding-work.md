# Outstanding work

Open items, grouped by area. [Limitations](./limitations.md) describes current behaviour for users. This page lists what is still to be done and what data each item needs.

Windows reference images come from `scripts/gdi-fixtures`. The **Windows fixtures** workflow (`.github/workflows/windows-fixtures.yml`) runs those scripts on a GitHub-hosted Windows runner and pushes the output to a `windows-fixtures/<run_id>` branch. See `scripts/gdi-fixtures/README.md`.

## EMF+ image effects

The 74 Dual effect fixtures (`plus-effect-*`) and 74 Only equivalents (`plus-only-effect-*`) are in the parity test. They have been regenerated on Windows with corrected metafile type constants. `src/emf-plus-image-effects.fixture.test.ts` also checks the effect algorithms against the effected bitmaps that GDI+ records into each fixture.

- **Not exact yet:**
  - HSL hue quantization now matches all 554,496 saturated-colour/angle pairs exactly. The broader 1,390,080-pair hue/saturation/lightness sweep retains at most one level on mixed colours and controls. All recorded pure rotation fixtures now match exactly; tone rounding remains.
  - Tint's native 256-index palette and signed hue wrapping now match the broader probe; the 253,440-pair sweep retains at most three levels for positive amounts and five for negative amounts.
  - Red-eye uses a simple rule. GDI+ detects pupils and repaints them with a texture.
  - The rotated blur's effected bitmap is now exact; playback still has a 0.22% residual along one draw edge (`plus-effect-blur-r3-rotate30`).
  - Large blur reproduces the native per-axis algorithm (reduce each row by the factor measured at all 957 quarter radii, filter, enlarge, then the same for columns, with products kept to 1/256 of a level). Against native noise, photo-like, rectangle, block and one-dimensional images 99.5-100% of pixels are exact (the rest one or two levels off); colour impulses and the 957-radius sweep are exact or within two levels, ramps within two. Through radius 16, colour impulses are exact and ramps are within one level; sharpen at radii 32-255 is exact. Unresolved: roughly 0.3% of pixels one level off at rounding boundaries, and images two or three pixels wide whose last pixel native leaves unfiltered.
  - Expanded blur uses native reduction (a cropped source rectangle reduces from its own corner with transparent samples around it) and the source rectangle's crop/vertical-row rules. The 504-draw native capture covers fourteen rectangles, twelve radii and opaque/translucent patterns. Integer bounds retain at most two levels at radius 20 and above, fractional bounds and radii below 20 one level; about 93% of pixels at radius 20 and above and 99.9% below are exact. Small cropped regions at large radii still differ by a level on about a tenth of their pixels.
- **Still fitted:** Tint's chroma scale. It is now checked across 90 hue/amount combinations, but its colour conversion and rounding remain approximate.

Sharpen strength now uses the native rational amount curve, quantized to 1/64 with half-down rounding. It matches every integer amount 0–100 and 19 radii when tested independently of blur convolution.

- **JPEG rounding:** pixel-centred chroma reconstruction reduces the original native ramp's maximum error from 19 levels to two (mean 0.36). Odd-sized 4:4:4/4:2:2/4:2:0 and progressive JPEG are within three levels; RGB/greyscale JPEG are within one. GIF and lossless TIFF references remain exact, including offset/palette GIFs, LZW/multipage/bilevel TIFF, Deflate strips (both tags and horizontal prediction) and uncompressed/Deflate tiles. RGB JPEG TIFF strips and tiles are within one level; YCbCr JPEG TIFF is within four. The TIFF coverage target is now captured; JPEG IDCT/chroma rounding differences remain.

## EMF+ gradients

Nothing outstanding: `buildLinearRampTable` reproduces all 4,352 native three-point Blend ramps (opaque and translucent) exactly; GDI+ forms each knot in float32 arithmetic that truncates toward zero.

## GDI color adjustment and HALFTONE

- **Colour adjustment** is reproduced from native colour cubes: curve stages (gamma, reference black/white, contrast, brightness, log, negative) are exact, illuminants 1-5, 7 and 8 use native cubes, and colorfulness/tint scale and turn u'v' chroma exactly. Windows' 66x65 ordered dither over 32 levels per channel is reproduced. Remaining: about a fifth of colorfulness/tint channels are one level off (an intermediate rounding step is unidentified), and the dither origin is measured only for unmirrored blits (a vertically mirrored enlargement and rotated or skewed destinations are not reproduced).
- **Mixed-axis stretching:** 82 of the 96 native size/pattern combinations are byte-exact. Remaining: exact-tie patterns (alternating 0/255 checker at `17x13->8x26`, `17x13->6x35`; `16x12->43x4` pattern 2), single-row destinations such as `3x2->6x1`, and the odd-size edge rules below.
- **Enlargement pre-smoothing (despeckle):** inferred from checkerboard and 2-pixel-block fixtures, not a known algorithm. Odd-size edges are fitted for those two pattern families only; shifted blocks, 3-pixel blocks, black/white 2-pixel blocks and the left/top edges of odd sizes still differ, and random binary images mismatch heavily even at even sizes.

## GDI path geometry

RoundRect controls now match native `GetPath` captures without exceptions. The compatible-mode cases also match at 1/16-pixel precision, including mirrored viewports and clockwise paths; `path-probe` regenerates both captures.
- Native `wide-path-probe` now covers 2,136 three-point paths with 2–64 px pens, all cap/join combinations and near reversals. All 128 round-cap/round-join fills match exactly in the regression test. Miter limit tests now follow native whole-pixel rounding of the fixed-point left-side vector (and its negation for the right side); 766 of 768 decisions around 384 measured thresholds match. The two retained decisions share a 7 px perpendicular error. All 228 square/flat-cap miter fills at 2/5 px now match exactly, including near reversals. Selecting cap/join arc vertices from the unrounded pen boundary point also fixes missed/extra endpoints. These changes reduce differing fills from 86 to 68, without changing any formerly exact fill in the capture. Sweeping the direction of a single flat-capped segment under every integer pen width from 7 to 100 px (1.1 million native directions) showed that the half-pixel rounding of the flattened-pen perpendicular depends on which pen edge the segment normal crosses; a per-edge bias table (`FLAT_SECTOR_BIAS`) reduces the 68 to 2, with 11 of 76,800 held-out directions still differing. A value landing exactly on a rounding boundary rounds down for one orientation and up for the mirror, which the table encodes as a bias of -1/64.
- `wide-outline-probe` captures 72 polyline/ellipse outlines across four widths and every cap/join combination. All 36 ellipse outlines match every native vertex, including the duplicated inner triangles; `emfrec-path-widen-outline` now matches exactly (previously 1.184% mismatches).
- Native `wmf-insideframe-curves` now covers 100 ellipse/RoundRect/chord/pie/arc cases at 0.5–10 px. Fractional fitting and widening, plus scaling RoundRect corners onto the inset box, reduce closed-curve mismatches from 1.67–2.79% to 0.11–0.16%; arc retains 0.039%. Small boundary differences remain.

  Rectangular inside-frame native sweeps now cover 0.5–10 px widths. The narrow subpixel sweep is exact; wider half-pixel widths retain 0.39% mismatches.


## Text

- **Unresolved differences:** glyph-edge differences and the `PolyTextOut` C1 control glyph difference have no fix yet.
- **Fonts in fixtures:** text fixtures generated on the Windows runner may differ from the original captures, because the runner's fonts can differ. New captures include font hashes and native library versions. The original text captures lack that provenance; matching their font environment remains unresolved.

## Tooling

- **Regenerating existing groups:** running existing fixture groups on the Windows runner can change their PNGs, because the runner's OS, fonts and DPI can differ. Compare before replacing committed fixtures.

Every new generator run writes an `environment-<groups>.json` manifest associating reference hashes with Windows/native-library versions, screen DPI and installed font hashes. This makes subsequent environment changes detectable; it cannot recover the environment of earlier captures.
