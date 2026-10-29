# Outstanding work

What is still open, and what would settle each item. Current behaviour for users is in [Limitations](./limitations.md). The measurements and everything already ruled out are in the [Parity log](./parity-log.md).

State on 23 October 2026: 885 of 910 report comparisons are pixel-exact (`bun scripts/gdi-fixtures/report.ts`), and none got worse in round 11.

## Text

- **GDI ClearType, default quality (Arial 12 and 13 px `a`, `e`, `s`, `o`).** The first stem MIRP of each program pairs an outer and an inner contour, and native takes no shift for that pair. To settle: test the "no pairing across contours" rule against the compatible-width captures.
- **GDI ClearType, natural quality.** A few small Tahoma curves (`e`, `@`, `$`, `s`) and Segoe UI 12 px `A`. These are the remaining 32 to 141 pixels on the `textx-*-cleartype` sheets.
- **Overlapping grayscale glyphs.** Where two GDI grayscale glyph bitmaps overlap, native is neither the larger level, the sum, nor the union of the 4x4 samples. These are the last 1 to 10 pixels of `textx-*-aa` and `textx-eto-aa`. To settle: a probe of two overlapping glyphs with controlled coverage levels.
- **Rotated GDI text.** Three rotated curved glyphs (5 pixels on `textx-escapement-*`) have a rotation matrix one 16.16 unit off. To settle: capture the point-size and resolution fields GDI puts in the font context.
- **GDI+ text.** About 14 pixels per glyph on Arial Bold 40 `W`, 7 on `4` and 3 on `k`, plus single pixels on Arial 16 `y` and `w`. `textx-plus-singlebit` (30 pixels) and the AntiAlias fractional underline bars have not been examined. Three DrawString cell-baseline captures lost exactness in the accepted DirectWrite trade.
- **GDI+ AntiAlias rasteriser.** It still uses the old scan converter. The native one gains private-font controls but loses two diagonal-coverage controls.
- **Raster font mapper.** 61 of 980 large heights pick a different face size, and no cost formula fits them. To settle: the same sweep at 100% and 125% display scaling.
- **Playback stretch.** For stretches of a few percent, Segoe UI hints at a different integer x ppem, which is not modelled. Georgia, Trebuchet MS and Microsoft Sans Serif follow neither known stretch rule.

## EMF+ drawing

- **Inset round-dash pens.** 32 antialiased and 5 aliased pixels on `gpx-pen-inset-dashround-*`. These come from the widener running in double precision where native uses single. To settle: a bit-exact float32 version of the join and line widening, checked against the 672 `dash-widen` outlines.
- **High-quality `DrawImage`.** `gpx-image-highqualitybilinear` (1 pixel) and `gpx-image-rotated-highqualitybicubic` (5). The native `DpOutputBicubicImageSpan` and `DpOutputSpanStretch` have not been read yet.
- **`DrawImage` points form.** 19 of 124 float32 flips of the JPEG geometry and 36 horizontal sweep flips are still 1 to 3 float32 units off. The rect form and draws with wrap attributes still use the fitted model.
- **Rotated blur.** 6 pixels each on `plus-effect-blur-r3-rotate30` and `plus-only-effect-blur-r3-rotate30`. These are on the rotated draw path, not in the effect.
- **Path gradients.** 24 of the 120 tiled colour controls (ellipses on fractional bounds, up to 2 levels) differ in the texture stage. A star fill is 2 pixels off because the sampler is given the bounding box, not each row's span.

## Images and colour

- **CMYK JPEG.** 43 of 30,000,000 random inks are one level off, mostly at colour-table nodes outside the gamut.
- **Red-eye.** A direct call made after earlier calls in the same process differs. A stateless converter reproduces a fresh process, so this is not planned.

## Tooling

- Regenerating existing fixture groups on the Windows runner can change their PNGs, because the runner's OS, fonts and DPI differ. Compare before replacing committed fixtures; the `environment-*.json` manifests record the versions.
- Write new measurements in the [Parity log](./parity-log.md). Keep this page and [Limitations](./limitations.md) short.
