# Outstanding work

What is still open, and what would settle each item. Current behaviour for users is in [Limitations](./limitations.md). The measurements and everything already ruled out are in the [Parity log](./parity-log.md).

On 18 November 2026, all 910 report comparisons match Windows RGB exactly and cover all painted pixels on both sides (`bun scripts/gdi-fixtures/report.ts`).

## Text

- **Rotated GDI text.** At a few sizes and angles (a line of 9 to 14 px text, say) GDI hints a rotated glyph at a neighbouring whole-pixel size, and the choice is not a function of the exact size alone when that is within a fiftieth of a half pixel. To settle: capture the size and matrix GDI hands to the scaler for those angles.
- **GDI+ AntiAlias rasteriser.** Collections of private fonts still use the old scan converter, because the native one loses two private diagonal-coverage controls.
- **Raster font mapper.** 61 of 980 large heights pick a different face size, and no cost formula fits them. To settle: the same sweep at 100% and 125% display scaling.
- **Playback stretch.** For stretches of a few percent, Segoe UI hints at a different integer x ppem, which is not modelled. Georgia, Trebuchet MS and Microsoft Sans Serif follow neither known stretch rule.

## EMF+ drawing

- **`DrawImage` points form and the other high-quality cases.** 19 of 124 float32 flips of the JPEG geometry and 36 horizontal sweep flips are still 1 to 3 float32 units off (plain Bilinear). Unit-height HighQualityBilinear rectangle crops match the native alpha and coverage sweep. Other crop, wrap, mirror, and half-pixel cases still differ. The stretch span still needs the visible-clip crop.
- **Path gradients.** The 120 colour and 240 alpha controls are exact. The independent fractional tile captures still have isolated colour and alpha differences of one level.

- **GDI+ single-bit glyphs.** Hinted with GDI's arithmetic, 1,658 of 1,680 native probe glyphs are exact. GDI+'s own arithmetic sits between GDI's and the previous one: 15 glyphs in that probe are exact only with the previous arithmetic, and no subset of GDI's projection, movement and ISECT rules gets both. Italic faces keep the previous arithmetic. To settle: read GDI+'s interpreter arithmetic.
- **Courier New DrawString advances.** Single-bit "HxH" is exact at 10 of 73 Courier New sizes: the second and third glyphs sit a pixel off. The other four faces are exact at 71 to 73 of 73.
- **DrawString paragraphs.** Center and far alignment work line by line for single-bit grid-fitted text with a top-aligned layout box. One centered Arial line still starts one pixel off, and Courier New has advance differences. The 24 px character-trimmed Arial case still differs inside the last line. Vertical alignment, overflow with horizontal alignment, and smoothed paragraph hints need native controls.
- **Large grayscale DrawString.** At em 76 and 80, AntiAlias and AntiAliasGridFit text lands 1 to 2 px lower than native, with slightly different glyphs.

## Images and colour

- **Red-eye.** A direct call made after earlier calls in the same process differs. A stateless converter reproduces a fresh process, so this is not planned.

## Tooling

- Regenerating existing fixture groups on the Windows runner can change their PNGs, because the runner's OS, fonts and DPI differ. Compare before replacing committed fixtures; the `environment-*.json` manifests record the versions.
- Write new measurements in the [Parity log](./parity-log.md). Keep this page and [Limitations](./limitations.md) short.
