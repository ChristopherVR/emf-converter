# Usage

All conversion functions take the raw file bytes as an `ArrayBuffer` and detect EMF or WMF from the contents.

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

## SVG

```ts
import { convertMetafileToSvg, convertMetafileToSvgDataUrl } from 'emf-converter';

const markup = await convertMetafileToSvg(buffer);
// '<svg xmlns="http://www.w3.org/2000/svg" width="..." height="..." viewBox="...">...</svg>'

const svgUrl = await convertMetafileToSvgDataUrl(buffer);
// "data:image/svg+xml;base64,PHN2ZyB4bWxucz0i..."
```

Paths, text, gradients, clipping and pattern brushes are written as SVG elements. Bitmaps are embedded as `<image>` elements; PNG, JPEG, GIF and WebP data is embedded as-is without re-encoding.

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
- Glyphs are hinted with the font's TrueType instructions (including the Windows ClearType rules), scan-converted with dropout control, and placed on GDI's integer grid. Dx arrays, `ETO_*` flags and `TA_*` alignment are applied.
- Non-antialiased, grayscale or ClearType rendering is chosen from the font quality. `fontSmoothing` sets what `DEFAULT_QUALITY` renders as. The Windows default is ClearType.
- Raster faces (MS Sans Serif, MS Serif, Courier, Small Fonts, System, Terminal, Fixedsys, Helv, Tms Rmn) are drawn from their bitmaps.
- Rotated text uses GDI's rounded font matrix. EMF+ `DrawString` applies the text rendering hint, string format tracking and margins, and texture and gradient brushes.

Without `fonts`, text is drawn by the canvas font engine of the host. Use `fontFamilyMap` to map Windows face names to fonts that are available locally:

```ts
const png = await convertMetafileToDataUrl(buffer, { fontFamilyMap: { calibri: 'Carlito' } });
```

SVG output always keeps text as `<text>` elements. With `fonts`, the elements carry the per-glyph positions computed by the GDI text engine.

## How it works

Conversion has three steps: parse, replay and export.

1. The header parser reads the drawing bounds. A placeable WMF is sized from the units-per-inch value in its header.
2. An output surface is created, limited by `maxCanvasDimension`, and the records are replayed in order by the GDI, EMF+ or WMF handlers.
3. PNG output draws onto a canvas: `OffscreenCanvas`, `HTMLCanvasElement`, `@napi-rs/canvas`, or the built-in JavaScript rasteriser. SVG output draws onto `SvgContext`, a recorder that implements the part of the Canvas 2D API used by the replay. Where a raster operation needs to read the destination, it is mirrored onto a hidden raster.

Per-fixture comparison bounds against Windows output are in `src/gdi-parity.fixture.test.ts`.

The full pipeline and the Windows-parity details are in [How it works](./how-it-works.md).
