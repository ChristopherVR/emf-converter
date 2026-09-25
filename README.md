# emf-converter

[![npm version](https://img.shields.io/npm/v/emf-converter.svg)](https://www.npmjs.com/package/emf-converter)
[![CI](https://github.com/ChristopherVR/emf-converter/actions/workflows/ci.yml/badge.svg)](https://github.com/ChristopherVR/emf-converter/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/emf-converter.svg)](LICENSE)

A zero-dependency TypeScript library that converts **EMF** (Enhanced Metafile) and **WMF** (Windows Metafile) binary buffers into **PNG data URLs** or **SVG** (markup, a base64 data URL, React elements, or a generated JSX/TSX component) by parsing their record streams and replaying the drawing commands.

Windows Metafiles store a sequence of GDI drawing commands and are commonly embedded inside Office documents (Word, PowerPoint) and Windows clipboard data. This converter reads the raw binary, interprets each record, and replays the drawing operations either onto a Canvas to produce a rasterised PNG, or onto an SVG recorder that keeps vectors, text, and gradients resolution-independent. It handles three formats:

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

No required dependencies. PNG output needs a Canvas API at runtime; SVG output needs none (it works anywhere JavaScript runs, and uses a canvas only when one is available, for exact destination-reading raster ops and text measurement):

- **Browser / Web Worker**: nothing else to install, `OffscreenCanvas` or `HTMLCanvasElement` is used automatically.
- **Node.js** (no DOM, no Worker): install the optional [`@napi-rs/canvas`](https://www.npmjs.com/package/@napi-rs/canvas) package as well:

  ```bash
  npm install @napi-rs/canvas
  ```

  It's a prebuilt, Skia-based native module (no `node-gyp` required). When it's not installed, PNG conversion in plain Node.js returns `null` instead of throwing; SVG conversion still works.

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

### SVG output

```typescript
import { convertMetafileToSvg, convertMetafileToSvgDataUrl } from 'emf-converter';

const markup = await convertMetafileToSvg(buffer);
// => '<svg xmlns="http://www.w3.org/2000/svg" width="..." height="..." viewBox="...">...</svg>'

const svgUrl = await convertMetafileToSvgDataUrl(buffer);
// => "data:image/svg+xml;base64,PHN2ZyB4bWxucz0i..."  (drop straight into <img src>)
```

SVG output needs **no canvas at all**, so it also works in plain Node.js without `@napi-rs/canvas`. Paths, text, gradients, clipping, and pattern brushes stay vectors; bitmaps are embedded as PNG/JPEG `<image>` elements (browser-native formats are embedded as-is, never re-encoded).

### Rendering in React (JSX / TSX)

`convertMetafileToSvgTree` returns a plain `SvgNode` tree. Turn it into live elements with any `createElement`-style factory (React, Preact, ...), so the SVG is part of your component tree and can be styled, sized, and given props like any other element:

```tsx
import { createElement, useEffect, useState, type ReactNode } from 'react';
import { convertMetafileToSvgTree, svgTreeToReact } from 'emf-converter';

export function Metafile({ buffer }: { buffer: ArrayBuffer }) {
	const [svg, setSvg] = useState<ReactNode>(null);
	useEffect(() => {
		let live = true;
		convertMetafileToSvgTree(buffer).then((tree) => {
			if (live && tree) {
				// Extra props land on the root <svg>: override size, add a class, aria, ...
				setSvg(svgTreeToReact(tree, createElement, { width: '100%', height: 'auto', role: 'img' }));
			}
		});
		return () => {
			live = false;
		};
	}, [buffer]);
	return svg;
}
```

Or generate a component at build time (the SVGR approach) and commit or import the `.tsx` file:

```typescript
import { writeFileSync } from 'node:fs';
import { convertMetafileToSvgTree, svgTreeToJsx } from 'emf-converter';

const tree = await convertMetafileToSvgTree(buffer, { idPrefix: 'logo-' });
writeFileSync('Logo.tsx', svgTreeToJsx(tree!, { componentName: 'Logo' }));
// export function Logo(props: SVGProps<SVGSVGElement>) { return (<svg ... {...props}> ... </svg>); }
```

Attribute names are converted to React's spelling (`stroke-width` → `strokeWidth`, `clip-path` → `clipPath`, `style` strings → style objects). Strings that come from the metafile (font names, text) are always emitted as escaped JavaScript string literals in generated source, never spliced into JSX raw. When several converted SVGs are inlined in the same page, give each its own `idPrefix` so their clip-path/gradient ids cannot collide (a unique prefix per conversion is the default).

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
| `gdiAntialias`       | `boolean`                  | `true`         | `false` rasterises GDI vector shapes without antialiasing on GDI's pixel grid, matching Windows output pixel for pixel (slower on shape-heavy files) |

```ts
const png = await convertMetafileToDataUrl(buffer, {
	dpiScale: 2,
	fontFamilyMap: { calibri: 'Carlito', 'ms shell dlg': 'Tahoma' },
});
```

### SVG functions

| Function | Returns |
| --- | --- |
| `convertMetafileToSvg(buffer, options?)` | `Promise<string \| null>`, standalone SVG markup |
| `convertMetafileToSvgDataUrl(buffer, options?)` | `Promise<string \| null>`, a `data:image/svg+xml;base64,...` URL |
| `convertMetafileToSvgTree(buffer, options?)` | `Promise<SvgNode \| null>`, the tree the helpers below consume |
| `svgTreeToString(tree)` / `svgTreeToDataUrl(tree)` | Markup / base64 data URL for an existing tree |
| `svgTreeToReact(tree, createElement, rootProps?)` | Live elements via `React.createElement` (or any compatible factory) |
| `svgTreeToJsx(tree, { componentName?, typescript?, spreadProps? })` | JSX/TSX component source code |

#### `SvgConvertOptions` (extends `EmfConvertOptions`)

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `exactRasterOps` | `boolean` | `true` | Evaluate destination-reading raster ops (exact ROP3 blits, exact bitwise ROP2) against a hidden raster mirror when a canvas backend exists, embedding only the pixels they change. `false` (or no canvas) uses SVG `mix-blend-mode` equivalents instead |
| `includeSize` | `boolean` | `true` | Emit `width`/`height` on the root `<svg>` (the `viewBox` is always emitted). `false` gives a fluid SVG that fills its container |
| `idPrefix` | `string` | `emf1-`, `emf2-`, ... | Prefix for generated element ids; keep it unique per inlined SVG |

`maxWidth`/`maxHeight`/`dpiScale`/`maxCanvasDimension` define the SVG's coordinate space (`viewBox`) and the resolution of any embedded raster content.

## How it works

A three-phase pipeline: **parse → replay → export**. The header parser extracts the drawing bounds, a Canvas is created and clamped to 8192×8192 (configurable via `maxCanvasDimension`), then records are scanned sequentially and dispatched to GDI, EMF+, or WMF handlers that drive the Canvas 2D context. Embedded bitmaps (DIB and GDI+ pixel formats) and recursively embedded metafiles are resolved asynchronously after the synchronous replay completes.

For SVG output the same handlers drive `SvgContext` (`svg-context.ts`), a recorder implementing the part of the Canvas 2D API the replay uses: paths are accumulated in device space exactly as Canvas does (arcs and ellipses as cubic Beziers, which affine maps carry exactly), fills become device-space `<path>`s, strokes are mapped back into their stroke-time user space so line widths and dashes scale like Canvas's, successive clips become a chain of `<clipPath>`s, gradients and pattern brushes become paint servers, text becomes `<text>`, and raster content becomes PNG `<image>`s encoded by a small dependency-free PNG encoder (`png-encoder.ts`). With no canvas implementation at all, bitmap scratch work runs on a pure-JavaScript raster (`software-raster.ts`), so SVG conversion works in plain Node.js without `@napi-rs/canvas`.

It supports 300+ EMF GDI record types, the EMF+ (GDI+) record set, and legacy WMF records, including state, transforms, objects, shapes, poly/path operations, text, bitmaps, gradients, raster operations, and clipping:

- **Clip regions with exact boolean combine modes**: `Intersect`, `Union`, `Xor`, `Exclude`, `Complement`, and `Replace` are exact for every clip, for `EMR_INTERSECTCLIPRECT` / `EMR_EXCLUDECLIPRECT` / `EMR_EXTSELECTCLIPRGN` (all `RGN_*` modes), path-bracket clips (`EMR_SELECTCLIPPATH`, combined with any region mode), the EMF+ `SetClipRect` / `SetClipPath` / `SetClipRegion` records (all `CombineMode` values, including nested region-node trees), and clip translation via `EMR_OFFSETCLIPRGN` / EMF+ `OffsetClip`. Simple cases keep their vector form: subtraction and symmetric difference are expressed through even-odd fill-rule clipping, which Canvas 2D cannot do with plain `clip()` stacking. Everything else (a clip that is already an intersection of several shapes, self-intersecting or curved operands) is evaluated exactly by scan-converting the operands at device pixel centres with their own fill rules (`emf-clip-scanline.ts`) and storing the result as disjoint pixel-aligned rectangles, which is how GDI itself stores regions.
- **Gradient brushes**: GDI+ linear gradients render as Canvas linear gradients with their full colour-stop list (preset blend colours and blend factors are expanded into stops, and the optional brush transform rotates or shears the gradient axis). `WrapMode` tiling (`Tile` / `TileFlipX` / `TileFlipY` / `TileFlipXY`) is supported for a linear gradient at any angle, by unrolling one period into a single hard-stopped gradient spanning the drawing surface. Path gradients render the true boundary-shaped falloff (per-vertex surround colours, blend curves, preset colours, focus scales, curved boundaries flattened at GDI+'s own 0.25 flatness), computed per device pixel for all five `WrapMode` values, with each device point folded analytically into the base tile (`emf-plus-exact-fill.ts`). Verified against real GDI+ fixtures under `src/__fixtures__/gdi/`: path gradients match within 0.15% of pixels in every wrap mode.
- **Raster operations (ROP3)**: `EMR_BITBLT`, `EMR_STRETCHBLT`, and `EMR_STRETCHDIBITS` (and `PatBlt`-style brush-only fills) evaluate all 256 ROP3 codes exactly, per pixel and per bit, against the real destination, brush, and (when present) source pixels, matching Windows GDI bit-for-bit rather than approximating with Canvas composite modes.
- **Raster operations (ROP2)**: every `SetROP2` mode is mapped. `R2_BLACK`, `R2_WHITE`, `R2_NOP`, `R2_COPYPEN`, `R2_NOTCOPYPEN`, and `R2_NOT` are emulated exactly via colour inversion and `difference` compositing. The bitwise AND/OR/XOR family (`R2_MASKPEN`, `R2_MERGEPEN`, `R2_XORPEN`, `R2_NOTXORPEN`, `R2_MASKPENNOT`, `R2_MERGEPENNOT`, `R2_MASKNOTPEN`, `R2_MERGENOTPEN`, `R2_NOTMASKPEN`, `R2_NOTMERGEPEN`) is evaluated exactly too, bit-for-bit against the true destination pixel, for a filled and/or stroked Rectangle, RoundRect, Ellipse, Arc/Chord/Pie, Polygon, Polyline, or PolyPolygon, whether drawn immediately or built up across an `EMR_BEGINPATH`/`EMR_ENDPATH` bracket: the shape's coverage is computed on/off per pixel (GDI does not antialias) within the shape's bounding box, combined with the exact pen/brush colour by the same truth-table evaluator the ROP3 blit path uses, and composited through the active clip region. A pattern (hatch, monochrome, or DIB) brush fill combines exactly with every `SetROP2` mode, bitwise ones included.
- **GDI world transforms**: `EMR_SETWORLDTRANSFORM` / `EMR_MODIFYWORLDTRANSFORM`'s full affine, including rotation and skew, is applied to Rectangle, RoundRect, Ellipse, Arc/Chord/Pie, Polygon, Polyline, PolyPolygon, path (`BeginPath`/`MoveTo`/`LineTo`/`Poly*To`/`EndPath`) drawing, bitmap blits (`EMR_BITBLT`/`EMR_STRETCHBLT`/`EMR_STRETCHDIBITS`, including the exact ROP3 path), and raster text (`EMR_EXTTEXTOUTW`). A rotated/skewed Ellipse (and Arc/Chord/Pie) is rendered from the mapped shape's exact semi-axes and rotation angle (the eigendecomposition of the linear part). RoundRect corners are exact elliptical arcs honouring unequal corner width and height, built as Beziers in logical space and mapped through the transform, so they rotate and skew exactly. Text under a skewed transform is sheared as well as rotated, matching GDI. Bitmap blits under a rotated or skewed transform are evaluated exactly (ROP3 truth table, brush pattern, source stretch-mode sampling) on a local raster whose axes are the exact transformed basis vectors, sampled at least once per device pixel, and then placed; real GDI does rotate a `BitBlt`/`TextOut` destination (`src/__fixtures__/gdi/rotate-bitblt-25deg`, `rotate-text-25deg`). This full-affine handling is also required for GDI+-exported EMF files even without rotation, since they record coordinates at 16× sub-pixel precision with a compensating world-transform scale.
- **GDI pattern-brush fills**: a hatch, monochrome (`EMR_CREATEMONOBRUSH`), or DIB (`EMR_CREATEDIBPATTERNBRUSHPT`) pattern brush selected for a Rectangle/RoundRect/Ellipse/Arc/Polygon/Polyline/PolyPolygon fill (or a bracketed path's `EMR_FILLPATH`/`EMR_STROKEANDFILLPATH`) paints the real tiled pattern, anchored to the brush origin (`EMR_SETBRUSHORGEX`), instead of a flat placeholder colour. This is filled per pixel (via the shape's already-built path and the same `sampleTile` sampler the exact ROP3 blit evaluator uses) rather than through a Canvas `CanvasPattern`: every canvas backend this package targets was measured to filter a `CanvasPattern` regardless of `imageSmoothingEnabled` (which only ever affects `drawImage`), smearing a hard-edged pattern tile's texels across several device pixels even at a 1:1 pattern transform. `EMR_CREATEDIBPATTERNBRUSHPT`/`EMR_CREATEMONOBRUSH` pattern brushes used as the *source* of a `BitBlt`/`StretchBlt`/`PatBlt` ROP3 blit were already exact before this (see Raster operations (ROP3) above); this closes the same brushes used for a vector shape fill.
- **GDI pixel grid**: thin (odd-width) pens paint the pixels their coordinates name, as GDI does, rather than two half-intensity rows straddling a pixel boundary. The `gdiAntialias: false` option goes further and rasterises every GDI vector fill and stroke without antialiasing on GDI's own pixel grid, matching Windows output to within 0.25% of pixels on the real-GDI shape fixtures, at a 3-4x cost on shape-heavy files.
- **EMF+ TextureFill brushes**: a TextureFill brush (brush type 2) paints its real image, tiled per `WrapMode` and placed by the brush and world transforms. Shape fills (FillRects, FillEllipse, FillPie, FillPolygon, FillPath) are computed one device pixel at a time and match a real GDI+ fixture pixel-exactly. Compressed (PNG/JPEG) embedded images, the common real-world case, are decoded by an async pre-decode pass (`emf-plus-texture-predecode.ts`) before the synchronous replay starts. EMF+ objects split across `EMFPLUS_OBJECT` continuation records, including ones spread over several `EMR_COMMENT` records, are reassembled by one routine shared by the replay and the pre-decode pass (`emf-plus-continuation.ts`), so a large split texture brush decodes like any other.
- **EMF+ Image objects and DrawImage**: `BitmapDataType` ([MS-EMFPLUS] 2.1.1.2: `Pixel = 0`, `Compressed = 1`) is read correctly for a standalone Image object. `DrawImage` / `DrawImagePoints` honour the source rectangle and the full destination parallelogram (so rotation and shear are kept), and resample the way GDI+ does for `InterpolationMode` Default / LowQuality / Bilinear / NearestNeighbor under `PixelOffsetMode` None or Half (`emf-plus-image-resample.ts`), matching a real GDI+ `DrawImage` fixture (`src/__fixtures__/gdi/image-draw-png`) within 8 levels per channel on every pixel.

## Limitations

- **Curved and diagonal GDI edges are antialiased by default**: GDI rasterises shape edges without antialiasing, while Canvas (and SVG renderers) smooth them, so by default about 1-3% of pixels differ on the rotated/curved real-GDI fixtures (`src/__fixtures__/gdi/rotate-*`, `skew-rect`, `pattern-fill-ellipse-color`, `rop2-bitwise-path-bracket`); axis-aligned shapes are exact or nearly so. With `gdiAntialias: false` the residual drops to occasional one-pixel stepping differences on steep lines and curves (at most 0.25%). See `src/gdi-parity.fixture.test.ts` for the per-fixture tolerances this is regression-tested against.
- **A rotated bitmap blit resamples once at placement**: the ROP3 combine itself is exact on the local raster, but painting that raster into a rotated position is a resample that cannot stay nearest-neighbour-exact at every output pixel; measured against real GDI output this is under 1% of pixels for a 25-degree rotated `BitBlt` (`src/__fixtures__/gdi/rotate-bitblt-25deg`).
- **Glyph rasterisation differs from GDI's font engine**: text placement, rotation, and shear match GDI, but glyphs are drawn by the host font engine, so rotated text still differs on about 2.4% of pixels (`src/__fixtures__/gdi/rotate-text-25deg`), mostly along glyph edges.
- **Preset-colour linear gradients differ slightly from GDI+**: linear gradients with `InterpolationColors` preset stops differ from GDI+ on about 1.5% of pixels, along the preset stops. GDI+ appears to blend preset colours through a coarse lookup table that never quite reaches a peak stop colour, while this library interpolates them exactly; without the table's exact size there is nothing exact to model. All other linear gradients, including every `WrapMode`, are exact up to float colour rounding at period seams. Path gradients match within 0.15% of pixels (single pixels right on a curved or diagonal boundary).
- **Texture and path-gradient brushes on strokes and text**: shape fills with these brushes are exact (see above), but strokes, pens, and text painted with a texture or path-gradient brush still go through a Canvas `CanvasPattern`, which every canvas backend filters, so their edges come out slightly soft. Texture brushes are sampled nearest-neighbour, so a texture scaled or rotated by its brush or world transform does not reproduce GDI+'s interpolated texture sampling.
- **`DrawImage` Bicubic/HighQuality modes and clipping**: GDI+ resampling is modelled for the Default, LowQuality, Bilinear, and NearestNeighbor interpolation modes; Bicubic and the HighQuality modes, and embedded metafile images, fall back to the canvas's own scaling. In PNG output, deferred image draws (decoded asynchronously after replay) are painted on top without the clip region that was active when they were recorded; SVG output keeps each image at its recorded z-order and clip.
- **SVG output**: SVG cannot read back what is already painted, so raster operations that depend on the destination (exact ROP3 blits, exact bitwise `SetROP2`) are evaluated against a hidden raster mirror when a canvas backend is available and embedded as image patches holding only the pixels they change; without a canvas backend (or with `exactRasterOps: false`) they fall back to `mix-blend-mode` equivalents (exact for the usual SRCAND/SRCPAINT/SRCINVERT mask idioms on black-and-white masks, approximate otherwise; ROP3 codes with no blend-mode equivalent are skipped). Embedded bitmaps are scaled by the SVG renderer's own image smoothing (they stay sharp when the SVG is scaled up) rather than baked at device resolution with GDI+'s resampler. Text is emitted as `<text>` and rendered with whatever fonts the viewer has, and rendering varies slightly between SVG renderers (measured in Chromium, SVG output matches the PNG output's parity on the real-GDI fixtures).
- **Safety limits**: output is clamped to 8192×8192 and replay stops after 200,000 records (EMF/WMF) or 500,000 (EMF+). All three are overridable via `maxCanvasDimension` / `maxRecords`.
- **Font rendering** uses the host Canvas font engine, so glyph metrics may differ from Windows GDI. Weight, italic, underline, and strike-out are honoured; supply `fontFamilyMap` to remap Windows face names to fonts available in your environment.

## License

[Apache-2.0](LICENSE), free for commercial and closed-source use, with an explicit patent grant.
