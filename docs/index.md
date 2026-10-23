---
layout: home

hero:
  name: emf-converter
  text: EMF and WMF to PNG, JPEG, WebP, SVG or PDF
  tagline: A TypeScript library with no runtime dependencies. Runs in the browser, in Web Workers and in Node.js.
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: API reference
      link: /api
    - theme: alt
      text: GitHub
      link: https://github.com/ChristopherVR/emf-converter

features:
  - title: EMF, EMF+ and WMF
    details: Reads Enhanced Metafiles, including embedded EMF+ (GDI+) records, and 16-bit Windows Metafiles. The format is detected from the file contents.
  - title: PNG, JPEG and WebP output
    details: Shapes, raster operations, brushes and clipping follow Windows GDI and GDI+ rasterisation. Output is tested against images rendered by Windows. The PNG, JPEG and WebP encoders are bundled, so the bytes are the same on every platform. WebP is lossless by default.
  - title: SVG output
    details: Produces SVG markup, a data URL, a node tree for React or another createElement factory, or generated JSX/TSX component source.
  - title: PDF output
    details: A one-page vector PDF with real text. With the font files supplied, text is embedded as a selectable TrueType subset.
---

## Live demo

Select or drop an `.emf` or `.wmf` file. The file is converted in your browser and is not uploaded anywhere.

<ClientOnly>
  <LiveDemo />
</ClientOnly>

## Example

```ts
import {
	convertMetafileToDataUrl,
	convertMetafileToJpegDataUrl,
	convertMetafileToPdf,
	convertMetafileToSvg,
	convertMetafileToWebpDataUrl,
} from 'emf-converter';

const buffer: ArrayBuffer = await file.arrayBuffer();

const png = await convertMetafileToDataUrl(buffer); // "data:image/png;base64,..."
const jpeg = await convertMetafileToJpegDataUrl(buffer); // "data:image/jpeg;base64,..."
const webp = await convertMetafileToWebpDataUrl(buffer); // "data:image/webp;base64,..."
const svg = await convertMetafileToSvg(buffer); // "<svg ...>...</svg>"
const pdf = await convertMetafileToPdf(buffer); // Uint8Array of a PDF file
```

See [Getting started](./getting-started.md) for installation and [Usage](./usage.md) for more examples.
