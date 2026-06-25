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
const scaled = await convertEmfToDataUrl(emfBuffer, 1024, 768);
```

Both functions return `Promise<string | null>` — `null` if the buffer is invalid or no Canvas API is available.

## API

### `convertEmfToDataUrl(buffer, maxWidth?, maxHeight?, options?)` · `convertWmfToDataUrl(buffer, maxWidth?, maxHeight?, options?)`

| Parameter   | Type                                  | Description                                          |
| ----------- | ------------------------------------- | ---------------------------------------------------- |
| `buffer`    | `ArrayBuffer`                         | Raw EMF/WMF file bytes                               |
| `maxWidth`  | `number` (optional)                   | Maximum output width in pixels                       |
| `maxHeight` | `number` (optional)                   | Maximum output height in pixels                      |
| `options`   | `EmfConvertOptions \| number` (opt.)  | Options object, or a numeric `dpiScale` (legacy)    |
| **Returns** | `Promise<string \| null>`             | PNG data URL or `null` on failure                   |

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
const png = await convertEmfToDataUrl(buffer, undefined, undefined, {
	dpiScale: 2,
	fontFamilyMap: { calibri: 'Carlito', 'ms shell dlg': 'Tahoma' },
});
```

## How it works

A three-phase pipeline: **parse → replay → export**. The header parser extracts the drawing bounds, a Canvas is created and clamped to 8192×8192 (configurable via `maxCanvasDimension`), then records are scanned sequentially and dispatched to GDI, EMF+, or WMF handlers that drive the Canvas 2D context. Embedded bitmaps (DIB and GDI+ pixel formats) and recursively embedded metafiles are resolved asynchronously after the synchronous replay completes.

It supports 300+ EMF GDI record types, the EMF+ (GDI+) record set, and legacy WMF records, including state, transforms, objects, shapes, poly/path operations, text, bitmaps, and clipping.

## Limitations

- **Region boolean ops are partial** — rectangle, path, and union-of-rectangles regions (multi-rect `RGNDATA`, EMF+ rect/path region trees) are clipped correctly, but `Xor` / `Exclude` / `Complement` region operations have no Canvas 2D equivalent and fall back to intersect-or-skip. `EMR_EXCLUDECLIPRECT` and `EMR_OFFSETCLIPRGN` are recognised but not applied (Canvas 2D cannot subtract from or translate an active clip).
- **Gradient brushes are simplified** — GDI+ linear/path gradient brushes render with their primary colour only (no interpolated colour stops yet).
- **Raster operations (ROP2) are partial** — `SetROP2` modes `R2_COPYPEN` (default) and `R2_NOP` are faithful; `R2_XORPEN`, `R2_MASKPEN`, `R2_MERGEPEN`, and `R2_NOT` are approximated via Canvas composite modes (`xor` / `multiply` / `lighten` / `difference`). The bitwise NOT/NAND/NOR-family modes have no Canvas equivalent and fall back to normal source-over drawing.
- **Safety limits** — output is clamped to 8192×8192 and replay stops after 200,000 records (EMF/WMF) or 500,000 (EMF+). All three are overridable via `maxCanvasDimension` / `maxRecords`.
- **Font rendering** uses the host Canvas font engine, so glyph metrics may differ from Windows GDI. Weight, italic, underline, and strike-out are honoured; supply `fontFamilyMap` to remap Windows face names to fonts available in your environment.

## License

[Apache-2.0](LICENSE) — free for commercial and closed-source use, with an explicit patent grant.
