# Limitations

Output is compared with images rendered by Windows. The exact per-fixture bounds are in `src/gdi-parity.fixture.test.ts`. Known differences:

## Color adjustment and image effects

- The `HALFTONE` stretch mode reproduces Windows' halftone engine for 32-bit output. An enlargement smooths isolated pixels and then takes the nearest source pixel. A reduction averages each pixel's footprint and then sharpens. All seven plain `HALFTONE` fixtures (2x, 3x, 0.5x, 0.65x and 1.37x) match exactly. A stretch that enlarges one axis and reduces the other has not been compared with Windows output.
- `EMR_SETCOLORADJUSTMENT` is applied to the source of `HALFTONE` `StretchBlt` and `StretchDIBits` calls, as in GDI. Windows does not publish its adjustment formulas. The converter uses a model fitted to two Windows captures: contrast and brightness on CIE L*, colorfulness and red-green tint on u'v' chromaticity, with gamma as the source encoding, so a gamma on its own changes nothing. Windows also dithers the adjusted colors over 32 levels per channel, and that pattern is not reproduced. On the fixtures, 0% to 15.1% of pixels differ by more than 24. The log filter uses an unverified curve, and the illuminant is ignored.
- EMF+ image effects (`SerializableObject`) are applied to the image's pixels before it is drawn. MS-EMFPLUS does not specify the algorithms, so they were measured against the effected bitmaps GDI+ itself writes into its recordings (`src/emf-plus-image-effects.fixture.test.ts`). Color matrix, lookup table, brightness/contrast, color balance, levels and sharpen match GDI+ exactly. Blur matches to within one level (GDI+ blurs along rows only, plus a vertical blur of the top row, and the converter does the same). Color curves match exactly for exposure, density, midtone and black saturation, and to within one level on up to 2.3% of pixels for contrast, highlight, shadow and white saturation, whose control points were measured at intensity ±50 and are scaled for other values. Hue/saturation/lightness uses GDI+'s integer HSL, but GDI+'s hue rounding is only partly reproduced: lightness and saturation changes differ on under 1% of pixels, and a hue rotation is more than two levels off on 0.3% to 32% of pixels (up to 11 levels). Tint is within two levels (three on 0.07% of pixels). Red-eye correction is an approximation: GDI+ detects pupils and repaints them with a texture, which is not reproduced (up to 17% of pixels differ on the fixtures).
- GDI+ follows each effect draw with a plain draw of the bitmap it effected, so Windows' playback of such a recording depends on the effect only where that bitmap is translucent. Played back, all the image effect fixtures match Windows to within one level, except one edge of a rotated blurred draw (0.22% of pixels).
- An effect is applied to the draw's source rectangle only, reading one more column and row, as GDI+ does. A blur with `expandEdge` blurs transparency in at the edges but, as in GDI+, draws nothing beyond the source rectangle. When the source rectangle is not in pixels, the effect is applied to the whole image.
- GDI+ records a color curve effect under the lookup table's identifier, and its own playback then draws the image without the effect. The converter does the same.
- An effect is skipped when the image cannot be decoded to pixels. PNG and BMP always can be. JPEG, GIF, TIFF and similar formats need a canvas backend (a browser or `@napi-rs/canvas`).

## Pen transforms

EMF+ pen transforms (uniform, non-uniform and skewed) match GDI+ exactly on the 17 pen-transform fixtures. That includes dashes, which GDI+ lays out along the path in world space at the untransformed pen width. The fixtures include dashes only under a non-uniform scale. Dashes under a uniform scale follow the same rule but have not been checked. A pen transform that cannot be inverted is ignored. Of the anchor caps, only `ArrowAnchor` is drawn with its real shape. The others are drawn as their base cap.

## Text

- The Windows text fixtures have a few glyph edge differences and a `PolyTextOut` C1 control glyph difference, under 0.1% of pixels. Bounds are in `src/emf-text-records.fixture.test.ts`.
- ANSI text is decoded with the host's `TextDecoder` for common Windows code pages. Unsupported encodings, including Johab and OEM on standard runtimes, fall back to Windows-1252.
- Vertical `ETO_PDY` advances require the `fonts` option.
- Without `fonts`, SVG text measurements are estimates. Supply the matching fonts for exact justification.

## Wide pens and paths

- Flat-capped GDI pens 7 px and wider can differ by a few pixels at round joins.
- Dashed wide Bezier curves follow `WidenPath`, which Windows' direct drawing does not match exactly. The difference is at most 0.2% of pixels on the fixtures.
- `EMR_WIDENPATH` does not reproduce the extra inner join triangles that GDI's `WidenPath` emits. This is only visible when the widened outline is stroked.
- EMF+ 1-pixel antialiased lines can differ by one antialiasing sample at their ends, and some closed widened outlines by one sample along an edge.
- Inset and compound pens on closed figures are approximate.

## GM_COMPATIBLE recordings

EMF files do not record the graphics mode. Windows plays back RoundRect, Arc, Chord, Pie and null-pen Ellipse records differently from how a GM_COMPATIBLE application drew them on screen. The converter follows Windows playback.

## EMF+

- Rotated `HighQualityBicubic` `DrawImage` edge pixels differ (0.14%).
- There are one-level differences at exact half-level `Blend` knots.
- A few pixels differ in a metafile nested in `DrawImage` under a scale transform.

## WMF

- `PS_INSIDEFRAME` boxes can be one pixel short at non-integer scales.
- Right-to-left (`LAYOUT_RTL`) layouts differ by single pixels on mirrored diagonals.
- Metric map modes assume a 96 dpi reference device. Windows derives them from the physical display, so its own output varies between machines.
