# Limitations

Output is compared with images rendered by Windows. The exact per-fixture bounds are in `src/gdi-parity.fixture.test.ts`. Known differences:

## Color adjustment and image effects

- The `HALFTONE` stretch mode reproduces Windows' halftone engine for 32-bit output when both axes enlarge or reduce together. An enlargement smooths isolated pixels and then takes the nearest source pixel. A reduction averages each pixel's footprint and then sharpens. All seven plain uniform-axis fixtures (2x, 3x, 0.5x, 0.65x and 1.37x) match exactly. Mixed-axis stretching uses interpolation and directional sharpening; native ramp/checker fixtures retain 3.5–23.6% mismatches at zero tolerance, with colour and edge differences. The horizontal ramp enlargement is within one level everywhere.
- `EMR_SETCOLORADJUSTMENT` affects `HALFTONE` `StretchBlt` and `StretchDIBits` calls, as in GDI. Standalone gamma and log curves are applied after sampling and sharpening, matching the native StretchBlt fixtures exactly. The log curve is verified across all 256 grey and RGB input levels. Combined contrast/brightness and chroma adjustments still use a fitted CIE model. Windows' ordered colour dither is not reproduced. Illuminants other than device-default/D65 remain ignored; all eight now have native references. The direct DIB fixture retains 0.74% mismatches of at most two levels, and adjusted DIB/colour-band boundaries still differ.
- EMF+ image effects (`SerializableObject`) are applied to the image's pixels before it is drawn. MS-EMFPLUS does not specify the algorithms, so they were measured against the effected bitmaps GDI+ itself writes into its recordings (`src/emf-plus-image-effects.fixture.test.ts`). Color matrix, lookup table, brightness/contrast and color balance match the native fixtures exactly. Sharpen strength matches all integer amounts 0–100 independently of radius. Blur convolution matches the native ramp and colour-impulse dimension sweep within one level through radius 16, including narrow and tall images. GDI+ filters each row horizontally, then vertically filters the leading ceil(height / width) rows; the converter follows that rule. At radius 20 and above, native reduction factors are measured across 957 quarter radii. Reduction, two-axis filtering and enlargement bring the captured even-sized colour impulses within three levels and ramps within seven (eight levels for odd-sized impulses). Tiny partial blocks, large expanded edges and rounding still differ; sharpen inherits those differences. Color curves use complete native lookups for all eight adjustments and every legal intensity, matching all 256 levels. Levels also handles inverted and equal thresholds and the full midtone range; a sweep of 258,560 values retains one one-level rounding difference. Hue/saturation/lightness now uses native 255-index rotation and sextant reconstruction. All 554,496 saturated-colour/angle pairs and the recorded pure rotation fixtures match exactly. A broader 1,390,080-pair mixed-colour and saturation/lightness sweep retains at most one level of tone rounding. Tint is within two levels (three on 0.07% of pixels). Red-eye correction is an approximation: GDI+ detects pupils and repaints them with a texture, which is not reproduced (up to 17% of pixels differ on the fixtures).
- EmfPlusDual recordings add a processed bitmap fallback after the effect draw. EmfPlusOnly recordings carry the effect and original source without that fallback. Both types have been regenerated and tested: 74 cases each, plus an explicit Dual blur case. Only recordings expose the HSL and red-eye algorithm differences directly. Deferred PNG and SVG draws preserve their effects and cropped source mapping.
- An effect is applied to the draw's source rectangle only, reading one more column and row, as GDI+ does. A blur with `expandEdge` blurs transparency in at the edges but, as in GDI+, draws nothing beyond the source rectangle. MS-EMFPLUS requires pixel source units; malformed non-pixel records do not apply effects.
- GDI+ records a color curve effect under the lookup table's identifier, and its own playback then draws the image without the effect. The converter does the same.
- An effect is skipped when the image cannot be decoded to pixels. PNG, BMP, JPEG, GIF and TIFF have bundled decoders. Animated GIF and multipage TIFF initially draw their first frame/page, as GDI+ does. Native references verify offset GIF frames, background colours, transparency, local palettes, LZW-compressed and multipage TIFF, plus odd-width bilevel uncompressed, PackBits and CCITT Group 3/4 TIFF. Group 3 also handles reversed bit order and multiple strips. Deflate strips (both compression tags and horizontal prediction) and uncompressed/Deflate tiles also match native references exactly. RGB JPEG-compressed TIFF strips and tiles are within one level, and YCbCr JPEG TIFF within four. Pixel-centred JPEG chroma reconstruction brings the original ramp within two levels (mean 0.36 across RGBA); odd-sized 4:4:4/4:2:2/4:2:0 and progressive JPEG are within three, while RGB and greyscale JPEG are within one. JPEG IDCT and chroma rounding still differ. A canvas backend remains preferred when available. Other encoded formats may need a browser or `@napi-rs/canvas`.

## Pen transforms

EMF+ pen transforms (uniform, non-uniform and skewed) match GDI+ exactly on the 17 pen-transform fixtures. That includes dashes, which GDI+ lays out along the path in world space at the untransformed pen width. Native fixtures verify dashes under uniform and non-uniform scales, including antialiasing. GDI+ rejects singular pen transforms; the converter ignores such malformed transform data. Square, round, diamond and arrow anchor caps use their native shapes; the new centered-cap fixtures match every pixel with and without antialiasing.

## Text

- The Windows text fixtures have a few glyph edge differences and a `PolyTextOut` C1 control glyph difference, under 0.1% of pixels. Bounds are in `src/emf-text-records.fixture.test.ts`.
- ANSI text is decoded with the host's `TextDecoder` for common Windows code pages. Johab and OEM CP437 use bundled Windows mappings; other unsupported encodings fall back to Windows-1252.
- Vertical `ETO_PDY` advances are supported with or without the `fonts` option.
- Without `fonts`, SVG text measurements are estimates. Supply the matching fonts for exact justification.

## Wide pens and paths

- Flat-capped GDI pens 7 px and wider can differ by a few pixels at round joins.
- Dashed wide Bezier curves follow `WidenPath`, which Windows' direct drawing does not match exactly. The difference is at most 0.2% of pixels on the fixtures.
- `EMR_WIDENPATH` ellipse outlines now match native vertices for every cap/join combination in the 2–32 px sweep, including the duplicated inner triangles. The stroked-outline fixture matches exactly; mixed cap/join polyline and curve cases retain small residuals.
- EMF+ 1-pixel antialiased lines can differ by one antialiasing sample at their ends, and some closed widened outlines by one sample along an edge.
- Inset and compound pens on closed figures are approximate.

## GM_COMPATIBLE recordings

EMF files do not record the graphics mode. Windows plays back RoundRect, Arc, Chord, Pie and null-pen Ellipse records differently from how a GM_COMPATIBLE application drew them on screen. The converter follows Windows playback.

## EMF+

- Rotated `HighQualityBicubic` `DrawImage` edge pixels differ (0.14%).
- There are one-level differences at exact half-level `Blend` knots.
- A few pixels differ in a metafile nested in `DrawImage` under a scale transform.

## WMF

- Fractional `PS_INSIDEFRAME` rectangles match the 1.0–2.9 px width sweep exactly. Wider half-pixel widths retain a 0.39% residual. Curved shapes retain fractional fitting and widening; native 0.5–10 px sweeps show 0.11–0.16% differences on closed curves and 0.039% on arcs.
- Mirrored `LAYOUT_RTL` cosmetic and wide line fixtures match Windows exactly.
- Metric map modes default to a 96 dpi reference device. Set `wmfReferenceDpi` to a number or `{ x, y }` when the original physical-device resolution is known. Metafiles do not always record that information.
