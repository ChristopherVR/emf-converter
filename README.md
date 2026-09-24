# emf-converter

[![npm version](https://img.shields.io/npm/v/emf-converter.svg)](https://www.npmjs.com/package/emf-converter)
[![CI](https://github.com/ChristopherVR/emf-converter/actions/workflows/ci.yml/badge.svg)](https://github.com/ChristopherVR/emf-converter/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/emf-converter.svg)](LICENSE)

A zero-dependency TypeScript library that converts **EMF** (Enhanced Metafile) and **WMF** (Windows Metafile) binary buffers into **PNG data URLs** by parsing their record streams and replaying the drawing commands onto an HTML Canvas.

Windows Metafiles store a sequence of GDI drawing commands and are commonly embedded inside Office documents (Word, PowerPoint) and Windows clipboard data. This converter reads the raw binary, interprets each record, and replays the drawing operations onto a Canvas to produce a rasterised PNG. It handles three formats:

| Format   | Description                    | Coordinate system       |
| -------- | ------------------------------ | ----------------------- |
| **WMF**  | Windows Metafile (16-bit)      | Window/viewport mapping |
| **EMF**  | Enhanced Metafile (32-bit GDI) | Bounds-based scaling    |
| **EMF+** | GDI+ extension embedded in EMF | World transform matrix  |

<samp>**[▶️ Live demo](https://christophervr.github.io/emf-converter/)** · **[📦 npm](https://www.npmjs.com/package/emf-converter)**</samp>

---

## Breaking change: `convertEmfToDataUrl` / `convertWmfToDataUrl` removed

Versions before 3.0.0 exported two functions, `convertEmfToDataUrl(buffer, options?)` and `convertWmfToDataUrl(buffer, options?)`. They have been replaced by a single auto-detecting function:

```diff
-import { convertEmfToDataUrl, convertWmfToDataUrl } from 'emf-converter';
-const emfPng = await convertEmfToDataUrl(emfBuffer);
-const wmfPng = await convertWmfToDataUrl(wmfBuffer);
+import { convertMetafileToDataUrl } from 'emf-converter';
+const emfPng = await convertMetafileToDataUrl(emfBuffer);
+const wmfPng = await convertMetafileToDataUrl(wmfBuffer);
```

`convertMetafileToDataUrl` detects the format from the buffer itself, so the same call works for either. See "Quick start" below.

## Demo

Try it right in your browser: drop in an `.emf` or `.wmf` file and see the rendered PNG, conversion time, and output size:

**https://christophervr.github.io/emf-converter/**

## Install

```bash
npm install emf-converter
```

No required dependencies. Requires a Canvas API at runtime:

- **Browser / Web Worker**: nothing else to install, `OffscreenCanvas` or `HTMLCanvasElement` is used automatically.
- **Node.js** (no DOM, no Worker): install the optional [`@napi-rs/canvas`](https://www.npmjs.com/package/@napi-rs/canvas) package as well:

  ```bash
  npm install @napi-rs/canvas
  ```

  It's a prebuilt, Skia-based native module (no `node-gyp` required). When it's not installed, conversion in plain Node.js returns `null` instead of throwing.

## Quick start

```typescript
import { convertMetafileToDataUrl } from 'emf-converter';

const emfBuffer: ArrayBuffer = /* loaded from file or network */;
const pngDataUrl = await convertMetafileToDataUrl(emfBuffer);
// => "data:image/png;base64,iVBORw0KGgo..."

// Works the same for WMF, the format is auto-detected from the bytes.
const wmfPng = await convertMetafileToDataUrl(wmfBuffer);

// Optional: limit output dimensions (aspect ratio preserved)
const scaled = await convertMetafileToDataUrl(emfBuffer, { maxWidth: 1024, maxHeight: 768 });
```

Returns `Promise<string | null>`, `null` if the buffer is invalid or no Canvas API is available.

## API

### `convertMetafileToDataUrl(buffer, options?)`

| Parameter   | Type                          | Description                                          |
| ----------- | ----------------------------- | ---------------------------------------------------- |
| `buffer`    | `ArrayBuffer`                 | Raw EMF or WMF file bytes (format is auto-detected)  |
| `options`   | `EmfConvertOptions` (optional)| Output size, DPI scale, record limits, font mapping |
| **Returns** | `Promise<string \| null>`     | PNG data URL or `null` on failure                   |

#### `EmfConvertOptions`

| Field                | Type                       | Default        | Description                                                                 |
| -------------------- | -------------------------- | -------------- | --------------------------------------------------------------------------- |
| `maxWidth`           | `number`                   | None           | Maximum output width in pixels (aspect ratio preserved)                     |
| `maxHeight`          | `number`                   | None           | Maximum output height in pixels                                             |
| `dpiScale`           | `number`                   | `1`            | Resolution multiplier for sharper output; clamped to `4`                    |
| `maxCanvasDimension` | `number`                   | `8192`         | Hard cap on canvas width/height in pixels                                   |
| `maxRecords`         | `number`                   | `200000`/`500000` | Cap on records processed per stream before replay stops (EMF+ uses the higher default unless overridden) |
| `fontFamilyMap`      | `Record<string, string>`   | None           | Maps Windows face names (case-insensitive) to fonts available locally, e.g. `{ calibri: 'Carlito' }` |

```ts
const png = await convertMetafileToDataUrl(buffer, {
	dpiScale: 2,
	fontFamilyMap: { calibri: 'Carlito', 'ms shell dlg': 'Tahoma' },
});
```

## How it works

A three-phase pipeline: **parse → replay → export**. The header parser extracts the drawing bounds, a Canvas is created and clamped to 8192×8192 (configurable via `maxCanvasDimension`), then records are scanned sequentially and dispatched to GDI, EMF+, or WMF handlers that drive the Canvas 2D context. Embedded bitmaps (DIB and GDI+ pixel formats) and recursively embedded metafiles are resolved asynchronously after the synchronous replay completes.

It supports 300+ EMF GDI record types, the EMF+ (GDI+) record set, and legacy WMF records, including state, transforms, objects, shapes, poly/path operations, text, bitmaps, gradients, raster operations, and clipping:

- **Clip regions with full boolean combine modes**: the converter tracks the active clip as a list of path shapes, so `Intersect`, `Union`, `Xor`, `Exclude`, `Complement`, and `Replace` combine modes work for `EMR_INTERSECTCLIPRECT` / `EMR_EXCLUDECLIPRECT` / `EMR_EXTSELECTCLIPRGN` (all `RGN_*` modes), the EMF+ `SetClipRect` / `SetClipPath` / `SetClipRegion` records (all `CombineMode` values, including nested region-node trees), and clip translation via `EMR_OFFSETCLIPRGN` / EMF+ `OffsetClip`. Subtraction and symmetric difference are expressed through even-odd fill-rule clipping, which Canvas 2D cannot do with plain `clip()` stacking.
- **Gradient brushes**: GDI+ linear gradients render as Canvas linear gradients with their full colour-stop list (preset blend colours and blend factors are expanded into stops, and the optional brush transform rotates or shears the gradient axis). `WrapMode` tiling (`Tile` / `TileFlipX` / `TileFlipY` / `TileFlipXY`) is supported for a linear gradient at any angle, by unrolling one period into a single hard-stopped Canvas gradient spanning the drawing surface. Path gradients render the true boundary-shaped falloff (fanned into triangles from the centre point, with per-vertex surround colours, blend curves, preset colours, and focus scales), not a radial approximation, rasterised into a tiled `CanvasPattern` for all five `WrapMode` values. Verified against real GDI+ fixtures under `src/__fixtures__/gdi/`; see [Limitations](#limitations) for the residual, measured mismatch in flip-mode tiling.
- **Raster operations (ROP3)**: `EMR_BITBLT`, `EMR_STRETCHBLT`, and `EMR_STRETCHDIBITS` (and `PatBlt`-style brush-only fills) evaluate all 256 ROP3 codes exactly, per pixel and per bit, against the real destination, brush, and (when present) source pixels, matching Windows GDI bit-for-bit rather than approximating with Canvas composite modes.
- **Raster operations (ROP2)**: every `SetROP2` mode is mapped. `R2_BLACK`, `R2_WHITE`, `R2_NOP`, `R2_COPYPEN`, `R2_NOTCOPYPEN`, and `R2_NOT` are emulated exactly via colour inversion and `difference` compositing. The bitwise AND/OR/XOR family (`R2_MASKPEN`, `R2_MERGEPEN`, `R2_XORPEN`, `R2_NOTXORPEN`, `R2_MASKPENNOT`, `R2_MERGEPENNOT`, `R2_MASKNOTPEN`, `R2_MERGENOTPEN`, `R2_NOTMASKPEN`, `R2_NOTMERGEPEN`) is evaluated exactly too, bit-for-bit against the true destination pixel, for a filled and/or stroked Rectangle, RoundRect, Ellipse, Arc/Chord/Pie, Polygon, Polyline, or PolyPolygon drawn outside an `EMR_BEGINPATH`/`EMR_ENDPATH` bracket: the shape is drawn once onto an isolated scratch canvas to get its exact per-pixel coverage and raw paint colour (unaffected by anti-aliasing, since compositing onto a fully transparent destination cannot blend), then combined into the destination with the same truth-table evaluator the ROP3 blit path uses. See [Limitations](#limitations) for the one case (a path built across a `BeginPath`/`EndPath` bracket) this does not cover, and the measured anti-aliasing residual at a shape's own boundary.
- **GDI world transforms**: `EMR_SETWORLDTRANSFORM` / `EMR_MODIFYWORLDTRANSFORM`'s full affine, including rotation and skew, is applied to Rectangle, RoundRect, Ellipse, Arc/Chord/Pie, Polygon, Polyline, PolyPolygon, and path (`BeginPath`/`MoveTo`/`LineTo`/`Poly*To`/`EndPath`) drawing: an affine map always carries an ellipse to another ellipse, so a rotated/skewed Ellipse (and the corresponding Arc/Chord/Pie) is rendered by decomposing the mapped shape's exact semi-axes and rotation angle (via the eigendecomposition of the linear part), not by scaling the original radii independently. A rounded rectangle's straight edges rotate/skew correctly; its corner radius stays axis-aligned even then (see [Limitations](#limitations)). Bitmap blits and raster text placement still apply only the scale and translation components (see [Limitations](#limitations)); this is also required for GDI+-exported EMF files even without rotation, since they record coordinates at 16× sub-pixel precision with a compensating world-transform scale. EMF+ records already supported the full affine transform set.
- **GDI pattern-brush fills**: a hatch, monochrome (`EMR_CREATEMONOBRUSH`), or DIB (`EMR_CREATEDIBPATTERNBRUSHPT`) pattern brush selected for a Rectangle/RoundRect/Ellipse/Arc/Polygon/Polyline/PolyPolygon fill (or a bracketed path's `EMR_FILLPATH`/`EMR_STROKEANDFILLPATH`) paints the real tiled pattern, anchored to the brush origin (`EMR_SETBRUSHORGEX`), instead of a flat placeholder colour. This is filled per pixel (via the shape's already-built path and the same `sampleTile` sampler the exact ROP3 blit evaluator uses) rather than through a Canvas `CanvasPattern`: every canvas backend this package targets was measured to filter a `CanvasPattern` regardless of `imageSmoothingEnabled` (which only ever affects `drawImage`), smearing a hard-edged pattern tile's texels across several device pixels even at a 1:1 pattern transform. `EMR_CREATEDIBPATTERNBRUSHPT`/`EMR_CREATEMONOBRUSH` pattern brushes used as the *source* of a `BitBlt`/`StretchBlt`/`PatBlt` ROP3 blit were already exact before this (see Raster operations (ROP3) above); this closes the same brushes used for a vector shape fill.
- **EMF+ TextureFill brushes**: an EMF+ TextureFill brush (brush type 2, `EmfPlusTextureBrushData`) whose embedded image is an uncompressed pixel-format bitmap decodes and paints exactly, tiled per `WrapMode` and placed by the brush transform, the same way the gradient brushes' tiled `CanvasPattern` works. See [Limitations](#limitations) for the common real-world case (a compressed PNG/JPEG-encoded embedded image) this does not yet cover.

## Limitations

- **Approximated edge cases in region ops**: all six combine modes are exact while the tracked clip is at most one composable shape (the overwhelmingly common case). When the clip is already an intersection of several shapes, or was set from a live path bracket (`EMR_SELECTCLIPPATH`), `Union` / `Xor` / `Complement` degrade to the nearest conservative approximation (a console log notes when this happens).
- **Bitwise ROP2 inside a `BeginPath`/`EndPath` bracket is still an arithmetic approximation**: the exact per-pixel combine (see above) needs to replay the shape's own drawing calls on an isolated scratch canvas, which is only available for an immediate (non-bracketed) shape; a path accumulated across several `MoveTo`/`LineTo`/`Poly*To` records inside a bracket and filled/stroked via `EMR_FILLPATH`/`EMR_STROKEANDFILLPATH`/`EMR_STROKEPATH` still uses the `darken`/`lighten`/`difference` stand-ins for the bitwise AND/OR/XOR family.
- **A shape's own boundary is still Canvas-anti-aliased**: the exact bitwise-ROP2 and pattern-brush-fill techniques above are pixel-exact in a shape's interior, but GDI rasterises a shape's edge (and a rotated/skewed one especially) without anti-aliasing, while Canvas's `fill()`/`stroke()` always anti-aliases; measured against real GDI fixtures, this residual is under 4% of pixels for an axis-aligned pattern fill or ROP2 grid (`src/__fixtures__/gdi/pattern-fill-*`, `rop2-bitwise-grid`), and under 3% for a rotated Ellipse/Polygon/RoundRect or a skewed Rectangle, worse (up to 10%) for a rotated Rectangle specifically, whose four long diagonal edges each carry the residual (`src/__fixtures__/gdi/rotate-*`, `skew-rect`). See `src/gdi-parity.fixture.test.ts` for the exact, per-fixture tolerances this is regression-tested against.
- **A rounded rectangle's corner radius stays axis-aligned under GDI world-transform rotation/skew**: its straight edges rotate/skew exactly (mapped through the full affine), but `arcTo`, which the corner arcs are built from, assumes a locally right-angled corner that does not survive a skew, so a rotated/skewed RoundRect's corners are approximated with straight tangent lines instead of true rotated/sheared elliptical arcs.
- **GDI bitmap blits and raster text placement ignore world-transform rotation/skew**: `EMR_BITBLT`/`EMR_STRETCHBLT`/`EMR_STRETCHDIBITS`'s exact per-pixel ROP3 evaluator, and WMF `TextOut`/`ExtTextOut` placement, still apply only the scale and translation components of `EMR_SETWORLDTRANSFORM`/`EMR_MODIFYWORLDTRANSFORM`; rotating those is a materially larger change (the ROP3 evaluator assumes an axis-aligned destination rectangle it can `getImageData`/`putImageData` directly) than the vector-shape rotation support above. A rotated/skewed *EMF+* transform is unaffected: EMF+ records already supported the full affine transform set for drawing and DrawImage.
- **Bitwise ROP2/pattern-brush-fill combination is untested and approximated**: a pattern brush combined with a bitwise `SetROP2` mode on the same shape fill is not implemented as an exact combination; the fill uses the flat-colour ROP2 approximation instead of the exact pattern fill in that specific combination (rare in practice).
- **Gradient tiling has a small, measured residual, worst in flip modes**: linear-gradient tiling is pixel-exact except for float colour rounding at period seams (measured against real GDI+ output, worst case 1.46% of pixels differing by up to 11 levels on one channel, for `InterpolationColors` preset stops; a handful of individual seam pixels can differ by more where a hard colour step falls exactly on a device pixel boundary). Path-gradient tiling carries a larger residual in `TileFlipX/Y/XY` modes (measured 1.7-6.5% of pixels for the fixtures in `src/__fixtures__/gdi/grad-path-*`, worse for a boundary whose gradient centre is off-centre in its own bounding box, such as an explicit `CenterPoint`): the renderer supersamples a device-resolution raster tile and mirrors it geometrically, while GDI+ mirrors its own already-rasterised tile with a small, undocumented sub-pixel lag at the seam. `Clamp` mode (no tiling) is closest to exact, typically under 1.2% (edge anti-aliasing only). See `src/gdi-parity.fixture.test.ts` for the exact, per-fixture tolerances this is regression-tested against.
- **EMF+ TextureFill brushes fall back to solid black for a compressed embedded image**: this is the common real-world case. Measured against real GDI+ output, .NET's EMF+ recorder always serialises a `TextureBrush`'s embedded `Bitmap` as a compressed PNG blob, even for an in-memory bitmap built with no source file involved (its `BitmapDataType` field was even observed ambiguous between the two numeric values this format has used, with the embedded image's width/height/stride/pixel-format fields all zeroed for the compressed case). Decoding a compressed image needs an async image decode (`createImageBitmap` / `@napi-rs/canvas`'s `loadImage`), which the synchronous, per-record EMF+ brush-object parse this package uses cannot perform; only a genuinely uncompressed pixel-format embedded bitmap decodes (see above). A GDI (not EMF+) `EMR_CREATEDIBPATTERNBRUSHPT`/`EMR_CREATEMONOBRUSH` pattern brush is unaffected by this: those are always stored as raw pixels, and are supported per the pattern-brush-fill entry above.
- **Safety limits**: output is clamped to 8192×8192 and replay stops after 200,000 records (EMF/WMF) or 500,000 (EMF+). All three are overridable via `maxCanvasDimension` / `maxRecords`.
- **Font rendering** uses the host Canvas font engine, so glyph metrics may differ from Windows GDI. Weight, italic, underline, and strike-out are honoured; supply `fontFamilyMap` to remap Windows face names to fonts available in your environment.

## License

[Apache-2.0](LICENSE), free for commercial and closed-source use, with an explicit patent grant.
