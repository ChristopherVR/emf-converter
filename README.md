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

### `convertEmfToDataUrl(buffer, maxWidth?, maxHeight?)` · `convertWmfToDataUrl(buffer, maxWidth?, maxHeight?)`

| Parameter   | Type                      | Description                       |
| ----------- | ------------------------- | --------------------------------- |
| `buffer`    | `ArrayBuffer`             | Raw EMF/WMF file bytes            |
| `maxWidth`  | `number` (optional)       | Maximum output width in pixels    |
| `maxHeight` | `number` (optional)       | Maximum output height in pixels   |
| **Returns** | `Promise<string \| null>` | PNG data URL or `null` on failure |

## How it works

A three-phase pipeline: **parse → replay → export**. The header parser extracts the drawing bounds, a Canvas is created and clamped to 4096×4096, then records are scanned sequentially and dispatched to GDI, EMF+, or WMF handlers that drive the Canvas 2D context. Embedded bitmaps (DIB and GDI+ pixel formats) and recursively embedded metafiles are resolved asynchronously after the synchronous replay completes.

It supports 300+ EMF GDI record types, the EMF+ (GDI+) record set, and legacy WMF records, including state, transforms, objects, shapes, poly/path operations, text, bitmaps, and clipping.

## Limitations

- **EMF+ region objects** are not parsed (no Canvas 2D equivalent for boolean region clipping).
- **Gradient brushes are simplified** — GDI+ linear/path gradients use the primary colour only.
- **No raster operations (ROP)** — `SetROP2` blend modes are not applied.
- **Limited clipping** — single rect/path clipping is supported; combined regions are not.
- **Safety limits** — output is clamped to 4096×4096; processing stops after 50,000 records (EMF/WMF) or 100,000 (EMF+).
- **Font rendering** uses the browser's font engine, so glyph metrics may differ from Windows GDI.

## License

[Apache-2.0](LICENSE) — free for commercial and closed-source use, with an explicit patent grant.
