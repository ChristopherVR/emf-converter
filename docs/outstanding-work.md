# Outstanding work

What is still open, and what would settle each item. Current behaviour for users is in [Limitations](./limitations.md). The measurements and everything already ruled out are in the [Parity log](./parity-log.md).

State on 30 October 2026: 899 of 910 report comparisons are pixel-exact (`bun scripts/gdi-fixtures/report.ts`), and none got worse in round 12.

## Text

- **GDI ClearType, default quality (Arial `u` and `W` at 12 px).** Two pixels each remain. To settle: truncate the glyph programs (appended glyphs, no `hdmx`) and find the first instruction at which native and the converter differ, as was done for Arial `o`.
- **GDI ClearType, natural quality.** A few small Tahoma curves (`e`, `@`, `$`, `s`) and Segoe UI 12 px `A`. These are the remaining 32 to 141 pixels on the `textx-*-cleartype` sheets.
- **Rotated GDI text.** At a few sizes and angles (a line of 9 to 14 px text, say) GDI hints a rotated glyph at a neighbouring whole-pixel size, and the choice is not a function of the exact size alone when that is within a fiftieth of a half pixel. To settle: capture the size and matrix GDI hands to the scaler for those angles.
- **GDI+ text.** About 14 pixels per glyph on Arial Bold 40 `W`, 7 on `4` and 3 on `k`, plus single pixels on Arial 16 `y` and `w`. The AntiAlias fractional underline bars have not been examined. Three DrawString cell-baseline captures lost exactness in the accepted DirectWrite trade. The ClearType sheets (`textx-plus-cleartype`, `gpx-rec-textcontrast-cleartype`) differ by single-sample stem and diagonal shifts at repeating glyph columns. To settle: trace the DWrite.dll diagonal-stem routine for those columns, and capture the rare second native ClearType image.
- **GDI+ AntiAlias rasteriser.** Collections of private fonts still use the old scan converter, because the native one loses two private diagonal-coverage controls.
- **Raster font mapper.** 61 of 980 large heights pick a different face size, and no cost formula fits them. To settle: the same sweep at 100% and 125% display scaling.
- **Playback stretch.** For stretches of a few percent, Segoe UI hints at a different integer x ppem, which is not modelled. Georgia, Trebuchet MS and Microsoft Sans Serif follow neither known stretch rule.

## EMF+ drawing

- **`DrawImage` points form and the other high-quality cases.** 19 of 124 float32 flips of the JPEG geometry and 36 horizontal sweep flips are still 1 to 3 float32 units off (plain Bilinear). High-quality draws of a cropped source, with wrap attributes, with a half-pixel offset or mirrored still use the fitted model, and the stretch span has not been given the visible-clip crop. To settle: the same stretch port with the source margin of `DpDriver::DrawImage`, checked against the crop, wrap and mirror captures.
- **Path gradients.** 113 edge pixels of 24 of the 120 tiled colour controls (ellipses on fractional bounds, up to 2 levels) still differ: the alpha of the texture filter is one off at the edge of the shape. To settle: a probe of edge texels with chosen alphas through a texture brush.

## Images and colour

- **Red-eye.** A direct call made after earlier calls in the same process differs. A stateless converter reproduces a fresh process, so this is not planned.

## Tooling

- Regenerating existing fixture groups on the Windows runner can change their PNGs, because the runner's OS, fonts and DPI differ. Compare before replacing committed fixtures; the `environment-*.json` manifests record the versions.
- Write new measurements in the [Parity log](./parity-log.md). Keep this page and [Limitations](./limitations.md) short.
