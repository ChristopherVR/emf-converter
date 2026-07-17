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

## Demo

Try it right in your browser — drop in an `.emf` or `.wmf` file and see the rendered PNG, conversion time, and output size:

**https://christophervr.github.io/emf-converter/**

## Install

```bash
npm install emf-converter
```

No dependencies. Requires a Canvas API at runtime — `OffscreenCanvas` (Web Workers) or `HTMLCanvasElement`.

## Quick start

```typescript
import { convertEmfToDataUrl, convertWmfToDataUrl } from 'emf-converter';

const emfBuffer: ArrayBuffer = /* loaded from file or network */;
const pngDataUrl = await convertEmfToDataUrl(emfBuffer);
// => "data:image/png;base64,iVBORw0KGgo..."

const wmfPng = await convertWmfToDataUrl(wmfBuffer);

// Optional: limit output dimensions (aspect ratio preserved)
const scaled = await convertEmfToDataUrl(emfBuffer, { maxWidth: 1024, maxHeight: 768 });
```

Both functions return `Promise<string | null>` — `null` if the buffer is invalid or no Canvas API is available.

## API

### `convertEmfToDataUrl(buffer, options?)` · `convertWmfToDataUrl(buffer, options?)`

| Parameter   | Type                          | Description                                          |
| ----------- | ----------------------------- | ---------------------------------------------------- |
| `buffer`    | `ArrayBuffer`                 | Raw EMF/WMF file bytes                               |
| `options`   | `EmfConvertOptions` (optional)| Output size, DPI scale, record limits, font mapping |
| **Returns** | `Promise<string \| null>`     | PNG data URL or `null` on failure                   |

#### `EmfConvertOptions`

| Field                | Type                       | Default        | Description                                                                 |
| -------------------- | -------------------------- | -------------- | --------------------------------------------------------------------------- |
| `maxWidth`           | `number`                   | —              | Maximum output width in pixels (aspect ratio preserved)                     |
| `maxHeight`          | `number`                   | —              | Maximum output height in pixels                                             |
| `dpiScale`           | `number`                   | `1`            | Resolution multiplier for sharper output; clamped to `4`                    |
| `maxCanvasDimension` | `number`                   | `8192`         | Hard cap on canvas width/height in pixels                                   |
| `maxRecords`         | `number`                   | `200000`/`500000` | Cap on records processed per stream before replay stops (EMF+ uses the higher default unless overridden) |
| `fontFamilyMap`      | `Record<string, string>`   | —              | Maps Windows face names (case-insensitive) to fonts available locally, e.g. `{ calibri: 'Carlito' }` |

```ts
const png = await convertEmfToDataUrl(buffer, {
	dpiScale: 2,
	fontFamilyMap: { calibri: 'Carlito', 'ms shell dlg': 'Tahoma' },
});
```

## How it works

A three-phase pipeline: **parse → replay → export**. The header parser extracts the drawing bounds, a Canvas is created and clamped to 8192×8192 (configurable via `maxCanvasDimension`), then records are scanned sequentially and dispatched to GDI, EMF+, or WMF handlers that drive the Canvas 2D context. Embedded bitmaps (DIB and GDI+ pixel formats) and recursively embedded metafiles are resolved asynchronously after the synchronous replay completes.

It supports 300+ EMF GDI record types, the EMF+ (GDI+) record set, and legacy WMF records, including state, transforms, objects, shapes, poly/path operations, text, bitmaps, gradients, raster operations, and clipping:

- **Clip regions with full boolean combine modes** — the converter tracks the active clip as a list of path shapes, so `Intersect`, `Union`, `Xor`, `Exclude`, `Complement`, and `Replace` combine modes work for `EMR_INTERSECTCLIPRECT` / `EMR_EXCLUDECLIPRECT` / `EMR_EXTSELECTCLIPRGN` (all `RGN_*` modes), the EMF+ `SetClipRect` / `SetClipPath` / `SetClipRegion` records (all `CombineMode` values, including nested region-node trees), and clip translation via `EMR_OFFSETCLIPRGN` / EMF+ `OffsetClip`. Subtraction and symmetric difference are expressed through even-odd fill-rule clipping, which Canvas 2D cannot do with plain `clip()` stacking.
- **Gradient brushes** — GDI+ linear gradients render as Canvas linear gradients with their full colour-stop list (preset blend colours and blend factors are expanded into stops, and the optional brush transform rotates the gradient axis). Path gradients render as radial gradients from the centre colour to the surrounding colour across the boundary radius.
- **Raster operations (ROP2)** — every `SetROP2` mode is mapped: `R2_BLACK`, `R2_WHITE`, `R2_NOP`, `R2_COPYPEN`, `R2_NOTCOPYPEN`, and `R2_NOT` are emulated exactly (via colour inversion and `difference` compositing); the remaining bitwise AND/OR/XOR-family modes are approximated with the nearest arithmetic composite (`difference` / `darken` / `lighten`), combined with pen-colour inversion for the NOT variants.
- **GDI world transforms** — the scale and translation set by `EMR_SETWORLDTRANSFORM` / `EMR_MODIFYWORLDTRANSFORM` are applied to all GDI drawing, which is required for GDI+-exported EMF files (they record coordinates at 16× sub-pixel precision with a compensating transform). EMF+ records support the full affine transform set.

## Limitations

- **Approximated edge cases in region ops** — all six combine modes are exact while the tracked clip is at most one composable shape (the overwhelmingly common case). When the clip is already an intersection of several shapes, or was set from a live path bracket (`EMR_SELECTCLIPPATH`), `Union` / `Xor` / `Complement` degrade to the nearest conservative approximation (a console log notes when this happens).
- **Bitwise ROP2 modes are arithmetic approximations** — Canvas compositing cannot reproduce true bitwise AND/OR/XOR against the destination, so those modes use `darken` / `lighten` / `difference` stand-ins; only the modes listed above as exact are pixel-faithful.
- **Gradient details** — gradient wrap/tile modes clamp instead of tiling, path gradients are radial approximations of the true boundary-shaped falloff, and texture (image) brushes fall back to solid black.
- **GDI rotation/skew** — rotation and shear components of the *GDI* world transform are ignored (EMF+ transforms are unaffected); plain-GDI metafiles using rotated world transforms are rare.
- **Safety limits** — output is clamped to 8192×8192 and replay stops after 200,000 records (EMF/WMF) or 500,000 (EMF+). All three are overridable via `maxCanvasDimension` / `maxRecords`.
- **Font rendering** uses the host Canvas font engine, so glyph metrics may differ from Windows GDI. Weight, italic, underline, and strike-out are honoured; supply `fontFamilyMap` to remap Windows face names to fonts available in your environment.

## License

[Apache-2.0](LICENSE) — free for commercial and closed-source use, with an explicit patent grant.
