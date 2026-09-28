# Limitations

Output is compared with images rendered by Windows. The exact per-fixture bounds are in `src/gdi-parity.fixture.test.ts`. Known differences:

## Color adjustment and image effects

- `EMR_SETCOLORADJUSTMENT` is read but not applied.
- The `HALFTONE` stretch mode is not bit-exact.
- EMF+ image effects (`SerializableObject`: blur, sharpen, color matrix and similar) are not applied. The image is drawn without the effect.

## Pen transforms

EMF+ pen transforms support uniform scaling with rotation and translation. Non-uniform scaling and skew are not supported.

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
