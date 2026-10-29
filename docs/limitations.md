# Limitations

The converter is tested by comparing its output pixel for pixel with what Windows itself paints for 910 test pictures. 885 of them match exactly (October 2026). The other 25 differ by a few pixels, listed below. The measurements behind each item are in [Parity notes](./parity-notes.md), and what is still being worked on is in [Outstanding work](./outstanding-work.md).

## Where output can still differ from Windows

- **GDI ClearType text.** A few curved glyphs, and two small Arial glyphs at default quality, are hinted differently: about 150 to 260 pixels on a full test page of text.
- **GDI grayscale and monochrome text.** Rotated text can differ at a few small sizes and angles, by up to about 30 pixels a glyph at 9 to 14 px.
- **EMF+ (GDI+) text.** Between 5 and 44 pixels per test page, depending on the text rendering hint. `DrawString` layout matches Windows for single-line, unrotated text under a uniform scale. Wrapping, trimming, complex-script shaping, and rotated or non-uniformly scaled alignment can place text differently.
- **EMF+ images and effects.** A rotated blur, and high-quality `DrawImage` sampling, can differ by one colour level in a few pixels.
- **EMF+ path gradients.** A few edge pixels of tiled gradients on ellipses with fractional bounds can differ by up to two colour levels.
- **CMYK JPEG.** Very rarely one colour level off (43 of 30,000,000 random colours).

## Differences by design

- **Fonts.** Text matches Windows only when the metafile's fonts are passed in the `fonts` option. Without them, text is drawn by the host's canvas font engine (see [Usage](./usage.md)). GDI+ text follows Windows' arithmetic for installed fonts. Windows renders a font loaded privately (for example through a private font collection) slightly differently.
- **Playback stretch.** When Windows plays back a compatible-mode recording, it stretches recorded text by the ratio stored in the recording (about 1.0006 in the test files). Rotated text and the Segoe UI heights that react to it follow that stretch. Stretches of a few percent are not modelled: Segoe UI can hint at a different integer x size, and Georgia, Trebuchet MS and Microsoft Sans Serif follow no known rule.
- **Lossy WebP.** The lossy encoder is simple, so prefer lossless WebP (the default) for drawings. Lossy suits smooth, photo-like content.
- **PDF text without `fonts`.** Text uses the standard PDF fonts, so glyph shapes differ from the original font.
- **12-bit JPEG.** Windows refuses to decode it and draws nothing, so the converter draws nothing too.
- **Windows' own variation.** On Windows, GDI+ glyph output for a small share of glyphs changes from one process to the next. The converter reproduces one fixed state.
