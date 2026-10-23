# Usage

All conversion functions take the raw file bytes and detect EMF or WMF from the contents. The input can be an `ArrayBuffer`, a typed array or Node.js `Buffer` (only the bytes it views are read, so pass the `Buffer` itself), or a `Blob`. Gzip-compressed `.emz` and `.wmz` files are inflated automatically.

## PNG

```ts
import { convertMetafileToDataUrl } from 'emf-converter';

const png = await convertMetafileToDataUrl(buffer);
// "data:image/png;base64,iVBORw0KGgo..."

// Limit the output size. The aspect ratio is preserved.
const thumb = await convertMetafileToDataUrl(buffer, { maxWidth: 1024, maxHeight: 768 });

// Render at twice the resolution.
const hiDpi = await convertMetafileToDataUrl(buffer, { dpiScale: 2 });

// Use Canvas antialiasing instead of Windows GDI rasterisation.
const smooth = await convertMetafileToDataUrl(buffer, { gdiAntialias: true });
```

By default, PNG output reproduces the aliased edges that Windows GDI draws. EMF+ drawing follows the `SmoothingMode` recorded in the file. Set `gdiAntialias: true` to smooth all shape edges with the canvas instead.

## JPEG

```ts
import { convertMetafileToJpegDataUrl } from 'emf-converter';

const jpeg = await convertMetafileToJpegDataUrl(buffer);
// "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ..."

// Smaller file, on a light grey background instead of white.
const preview = await convertMetafileToJpegDataUrl(buffer, { quality: 0.7, background: '#f4f4f4', maxWidth: 800 });
```

JPEG output is the PNG rendering (same options, same backends) encoded by the bundled JPEG encoder, so the bytes are the same in the browser and in Node.js. JPEG has no transparency, so the metafile's transparent background is filled with `background` (white by default). Colour is kept at full resolution unless you set `chromaSubsampling: true`. Use PNG or SVG when you need transparency or exact pixels.

## WebP

```ts
import { convertMetafileToWebpDataUrl } from 'emf-converter';

const webp = await convertMetafileToWebpDataUrl(buffer);
// "data:image/webp;base64,UklGR..."

// Lossy WebP at quality 0-1 (default 0.8), with a size limit.
const small = await convertMetafileToWebpDataUrl(buffer, { lossless: false, quality: 0.8, maxWidth: 800 });
```

WebP output is the PNG rendering (same options, same backends) encoded by the bundled WebP encoder, so the bytes are the same in the browser and in Node.js. The default is lossless, which keeps the pixels and the transparent background exactly, and the file is usually smaller than the PNG. Lossy WebP is a simple encoder: for line art and text it is usually much larger than lossless, so use it only for smooth, photo-like content. Images larger than 16383 pixels on a side return `null`.

## SVG

```ts
import { convertMetafileToSvg, convertMetafileToSvgDataUrl } from 'emf-converter';

const markup = await convertMetafileToSvg(buffer);
// '<svg xmlns="http://www.w3.org/2000/svg" width="..." height="..." viewBox="...">...</svg>'

const svgUrl = await convertMetafileToSvgDataUrl(buffer);
// "data:image/svg+xml;base64,PHN2ZyB4bWxucz0i..."
```

Paths, text, gradients, clipping and pattern brushes are written as SVG elements. Bitmaps are embedded as `<image>` elements; PNG, JPEG, GIF and WebP data is embedded as-is without re-encoding. Two kinds of JPEG are not: arithmetic-coded and CMYK/YCCK files, which SVG renderers decode differently from Windows (or not at all), are decoded by the bundled decoder (which reproduces the Windows result) and embedded as pixels; a 12-bit JPEG is refused as Windows refuses it ("Unsupported JPEG data precision 12"), so nothing is drawn for it.

Raster operations that read the destination (the 256 ROP3 codes, bitwise ROP2 modes, and pattern brushes drawn through ROP2) are computed against a hidden raster copy of the drawing. The changed pixels are embedded as image patches. The resulting SVG is the same with or without a canvas backend.

## React

`convertMetafileToSvgTree` returns a plain `SvgNode` tree. `svgTreeToReact` turns it into elements with `React.createElement` or any compatible factory (Preact, for example):

```tsx
import { createElement, useEffect, useState, type ReactNode } from 'react';
import { convertMetafileToSvgTree, svgTreeToReact } from 'emf-converter';

export function Metafile({ buffer }: { buffer: ArrayBuffer }) {
	const [svg, setSvg] = useState<ReactNode>(null);
	useEffect(() => {
		let live = true;
		convertMetafileToSvgTree(buffer).then((tree) => {
			if (live && tree) {
				// Extra props are applied to the root <svg>.
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

## Generating a JSX/TSX component

`svgTreeToJsx` returns component source code, which can be written to a file at build time:

```ts
import { writeFileSync } from 'node:fs';
import { convertMetafileToSvgTree, svgTreeToJsx } from 'emf-converter';

const tree = await convertMetafileToSvgTree(buffer, { idPrefix: 'logo-' });
writeFileSync('Logo.tsx', svgTreeToJsx(tree!, { componentName: 'Logo' }));
// export function Logo(props: SVGProps<SVGSVGElement>) { return (<svg ... {...props}> ... </svg>); }
```

Attribute names are converted to React names (`stroke-width` becomes `strokeWidth`, `clip-path` becomes `clipPath`, and `style` strings become style objects). Strings from the metafile, such as font names and text, are emitted as escaped JavaScript string literals.

### Element ids

Converted SVGs use generated ids for clip paths and gradients. When more than one converted SVG is inlined in the same page, each needs a distinct `idPrefix`. By default every conversion gets a unique prefix (`emf1-`, `emf2-`, and so on).

## Exact text

Text rendering depends on the fonts used. Pass the font files a metafile uses in the `fonts` option to draw text the way Windows GDI does. TrueType (`.ttf`, `.ttc`) and Windows raster fonts (`.fon`, `.fnt`) are supported.

```ts
import { convertMetafileToDataUrl, loadSystemFonts } from 'emf-converter';

const fonts = await loadSystemFonts(); // Node.js only. Reuse the array across conversions.
const png = await convertMetafileToDataUrl(buffer, { fonts });
```

With `fonts`:

- Fonts are selected like the GDI font mapper does: face substitutes, pitch and family fallback, weight selection, cell and em height, and `lfWidth` stretching. Metrics, advances, underline and strike-out follow GDI.
- Glyphs are hinted with the font's TrueType instructions (including the Windows ClearType rules), scan-converted with dropout control (the font's own `SCANCTRL`/`SCANTYPE` under grayscale and ClearType), and placed on GDI's integer grid. GDI+ ClearType text in the system Courier New is drawn half a pixel wider than its outline, as GDI+ does. Dx arrays, `ETO_*` flags and `TA_*` alignment are applied.
- Non-antialiased, grayscale or ClearType rendering is chosen from the font quality. `fontSmoothing` sets what `DEFAULT_QUALITY` renders as. The Windows default is ClearType.
- Raster faces (MS Sans Serif, MS Serif, Courier, Small Fonts, System, Terminal, Fixedsys, Helv, Tms Rmn) are drawn from their bitmaps, stretched by up to 8 vertically and 5 horizontally as GDI does. The size chosen depends on the faces supplied: at 120 dpi and above Windows serves System and Fixedsys from `8514sys.fon` and `8514fix.fon`, so pass those along with `vgasys.fon` and `vgafix.fon` to get the sizes a larger-dpi session draws.
- Rotated text uses GDI's rounded font matrix. Text recorded in a compatible-mode metafile keeps the recorded Dx array, which is what Windows plays back, but is drawn without the slight horizontal stretch (about 1.0006) that Windows playback applies; a few Segoe UI heights grid-fit differently under that stretch, so those lines can differ from a Windows playback by a stem width (see [Limitations](./limitations.md#differences-by-design)). The stretch belongs to the playing device (the ratio of the recording and target device sizes, 1 on a matching device), which a converter cannot know, so it is not applied. EMF+ `DrawString` applies the text rendering hint, string format tracking and margins, and texture and gradient brushes.

Without `fonts`, text is drawn by the canvas font engine of the host. Use `fontFamilyMap` to map Windows face names to fonts that are available locally:

```ts
const png = await convertMetafileToDataUrl(buffer, { fontFamilyMap: { calibri: 'Carlito' } });
```

SVG output always keeps text as `<text>` elements. With `fonts`, the elements carry the per-glyph positions computed by the GDI text engine.

## PDF

```ts
import { convertMetafileToPdf, loadSystemFonts } from 'emf-converter';

const fonts = await loadSystemFonts(); // Node.js only
const pdf = await convertMetafileToPdf(buffer, { fonts, title: 'Drawing' });
// Uint8Array holding a PDF file, or null
```

The output is a one-page vector PDF 1.7. It uses the same replay as the SVG output, so paths, clipping, gradients, patterns, opacity, blend modes and images stay vector or embedded (JPEG is embedded unchanged). By default the page is the drawing itself, at 1 pixel = 0.75 pt. Pass `pageSize: { width, height }` (in points) to fit the drawing to a page of that size instead.

Text is real text. With `fonts`, the matching TrueType face is embedded as a subset, so the text is selectable and searchable. Without `fonts`, text uses the standard PDF fonts (Helvetica, Times or Courier), whose glyph shapes differ from the original font. The output does not include PDF/A or tagged PDF.

## Raw RGBA pixels

```ts
import { convertMetafileToImageData } from 'emf-converter';

const image = await convertMetafileToImageData(buffer);
// { data: Uint8ClampedArray, width, height }
```

This is the same rendering the PNG output encodes, without the encoding step. `data` is straight (non-premultiplied) RGBA, row-major and top-down. Pass it to `putImageData`, or to any encoder.

## Inspecting a file

`getMetafileInfo` reads the header and records without rendering, so you can see what a file contains before converting it:

```ts
import { getMetafileInfo } from 'emf-converter';

const info = await getMetafileInfo(buffer);
// info.format: 'emf' | 'emf+' | 'emf+dual' | 'wmf'
// info.width, info.height: the PNG size at default options
// info.fonts: [{ name: 'Segoe UI', gdi: true, emfPlus: false }, ...]
```

The main use is finding out which font files to pass as `fonts`. `info.fonts` lists the face names the file declares, so you know which fonts to supply for exact text. Not every declared font is necessarily drawn with. Fonts inside nested WMFs are not collected, and `width` and `height` ignore `maxWidth` and `dpiScale`. The other fields (record counts, `images`, `description`, `truncated`) are listed in the [API reference](./api.md#metafileinfo).

## Cancellation

Every conversion function accepts `signal` (an `AbortSignal`) and `timeoutMs`:

```ts
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 5000);
try {
	const png = await convertMetafileToDataUrl(buffer, { signal: controller.signal });
} finally {
	clearTimeout(timer);
}

// Or reject after a time limit, with a DOMException named TimeoutError.
const quick = await convertMetafileToDataUrl(buffer, { timeoutMs: 5000 });
```

When the signal aborts, the promise rejects with `signal.reason` (an `AbortError` when there is none). A `null` result still means the buffer is not a valid metafile. Conversion checks the signal at every record, so it stops within about one record's work. A single very large record, such as one giant blit, can overrun. With a `signal`, conversion yields to the event loop about every 16 ms.

## Command line

The package installs an `emf-converter` command, which `npx emf-converter` runs. It converts files to PNG, JPEG, WebP, SVG or PDF:

```sh
npx emf-converter drawing.emf                          # drawing.png, next to the input
npx emf-converter drawing.emf --width 1200 -o drawing.jpg
npx emf-converter "charts/*.wmf" -f svg -o out/        # wildcards are expanded by the CLI
cat drawing.emz | npx emf-converter - -f png > drawing.png
```

Run `emf-converter --help` for every option. Exit code 0 means all files converted, 1 means one or more failed (the rest are still converted), and 2 is a usage error. `--fonts system` (the default) loads the installed fonts, so text matches Windows.

## How it works

ANSI text records are decoded by the LOGFONT charset, with or without `fonts`: ANSI and default, Macintosh, Shift-JIS, Hangul, GB2312, Big5, the Windows Greek, Turkish, Vietnamese, Hebrew, Arabic, Baltic, Cyrillic, Thai and Central European pages, Johab, OEM and Symbol. ANSI and default text use the playback device's ANSI code page (`ansiCodePage`, Windows-1252 by default) and OEM text its OEM code page (`oemCodePage`, 437 by default), as Windows does. Code pages the host's `TextDecoder` does not provide fall back to Windows-1252.

## How it works

Conversion has three steps: parse, replay and export.

1. The header parser reads the drawing bounds. A placeable WMF is sized from the units-per-inch value in its header.
2. An output surface is created, limited by `maxCanvasDimension`, and the records are replayed in order by the GDI, EMF+ or WMF handlers.
3. PNG, JPEG and WebP output draw onto a canvas: `OffscreenCanvas`, `HTMLCanvasElement`, `@napi-rs/canvas`, or the built-in JavaScript rasteriser, and are then encoded by the bundled encoders. SVG output draws onto `SvgContext`, a recorder that implements the part of the Canvas 2D API used by the replay. Where a raster operation needs to read the destination, it is mirrored onto a hidden raster. PDF output uses the SVG recorder and serialises the result as a one-page PDF.

Per-fixture comparison bounds against Windows output are in `src/gdi-parity.fixture.test.ts`.

The full pipeline and the Windows-parity details are in [How it works](./how-it-works.md).
