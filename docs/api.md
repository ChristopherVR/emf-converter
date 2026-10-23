# API

All functions are named exports of `emf-converter`.

## MetafileInput

```ts
type MetafileInput = ArrayBuffer | ArrayBufferView | Blob;
```

Every conversion function accepts this. Typed arrays, `DataView`s and Node.js `Buffer`s are read from their viewed bytes only, so pass the `Buffer` itself rather than its `.buffer`. Gzip-compressed `.emz` and `.wmz` files are inflated automatically; this needs `DecompressionStream` (browsers and Node.js 18+), and the inflated size is capped at 256 MiB.

## convertMetafile

```ts
function convertMetafile(buffer: MetafileInput, options?: ConvertOptions): Promise<ConvertedImage | null>;
```

Converts an EMF or WMF file to PNG, JPEG, WebP or SVG bytes. It is the binary form of the `*DataUrl` functions: write `data` to a file, wrap it in a `Blob`, or send it over the network without the base64 round trip. The `null` cases are those of `convertMetafileToDataUrl` (raster) and `convertMetafileToSvg` (SVG).

`ConvertOptions` is `format` (`'png'` by default, `'jpeg'`, `'webp'` or `'svg'`) together with that format's options: `EmfConvertOptions`, `JpegConvertOptions`, `WebpConvertOptions` or `SvgConvertOptions`.

### ConvertedImage

| Field | Type | Description |
| --- | --- | --- |
| `format` | `'png' \| 'jpeg' \| 'webp' \| 'svg'` | The output format. |
| `mimeType` | `string` | `image/png`, `image/jpeg`, `image/webp` or `image/svg+xml`. |
| `data` | `Uint8Array` | The file bytes. |
| `width` | `number` | Pixel width, or the SVG's `width`. |
| `height` | `number` | Pixel height, or the SVG's `height`. |

## convertMetafileToDataUrl

```ts
function convertMetafileToDataUrl(buffer: MetafileInput, options?: EmfConvertOptions): Promise<string | null>;
```

Converts an EMF or WMF file to a PNG data URL. Returns `null` if the buffer is not a valid metafile, or, in plain Node.js, if the drawing contains text and neither `fonts` nor `@napi-rs/canvas` is available.

### EmfConvertOptions

| Option               | Type                                    | Default             | Description |
| -------------------- | --------------------------------------- | ------------------- | ----------- |
| `maxWidth`           | `number`                                |                     | Maximum output width in pixels. The aspect ratio is preserved. |
| `maxHeight`          | `number`                                |                     | Maximum output height in pixels. |
| `dpiScale`           | `number`                                | `1`                 | Resolution multiplier, clamped to `4`. |
| `wmfReferenceDpi`     | `number \| { x: number; y: number }`      | `96`                | Playback-device resolution for WMF physical map modes. Supply the original device DPI when known; values must be finite and positive. |
| `ansiCodePage`        | `number`                                | `1252`              | Playback-device ANSI code page (`GetACP()`) for ANSI/DEFAULT text in EMF and WMF ANSI text records, and WMF font face names. Explicit text charsets keep their own decoding. |
| `oemCodePage`         | `number`                                | `437`               | Playback-device OEM code page (`GetOEMCP()`) for OEM_CHARSET text in EMF and WMF ANSI text records. |
| `wmfAnsiCodePage`     | `number`                                | `ansiCodePage`      | WMF-only override of `ansiCodePage`. |
| `maxCanvasDimension` | `number`                                | `8192`              | Upper limit for output width and height in pixels. |
| `maxRecords`         | `number`                                | `200000` / `500000` | Records processed per stream before replay stops. EMF+ uses the higher default. |
| `gdiAntialias`       | `boolean`                               | `false`             | Smooth shape edges with canvas antialiasing instead of reproducing GDI/GDI+ rasterisation. |
| `fonts`              | `Array<ArrayBuffer \| ArrayBufferView>` |                     | TrueType (`.ttf`, `.ttc`) and raster (`.fon`, `.fnt`) font files used for GDI text rendering. |
| `fontSmoothing`      | `'cleartype' \| 'gray' \| 'mono'`       | `'cleartype'`       | Rendering used for fonts with `DEFAULT_QUALITY`, `DRAFT_QUALITY` or `PROOF_QUALITY`. |
| `fontFamilyMap`      | `Record<string, string>`                |                     | Used without `fonts`. Maps Windows face names (case-insensitive) to local font families, for example `{ calibri: 'Carlito' }`. |
| `signal`             | `AbortSignal`                           |                     | Cancels the conversion. On abort the promise rejects with `signal.reason` (an `AbortError` if there is none). `null` still means "not a valid metafile". |
| `timeoutMs`          | `number`                                |                     | Rejects with a `DOMException` named `TimeoutError` after this many milliseconds. |

`DEFAULT_DPI_SCALE` is exported as the default value of `dpiScale` (`1`).

For metafiles from a Windows device with other system code pages, supply the
device's known `GetACP()` value as `ansiCodePage` and its `GetOEMCP()` value as
`oemCodePage`. Supported ANSI values are `874`, `932`, `936`, `949`, `950`,
`1250`–`1258`, `54936` and `65001`; other values fall back to `1252`. Supported
OEM values are `437`, `737`, `775`, `850`, `852`, `855`, `858`, `860`–`863`,
`865`, `866`, `874`, `932`, `936`, `949` and `950`; other values fall back to `437`.
The converter does not infer these values from the file bytes or browser language.

## convertMetafileToJpegDataUrl

```ts
function convertMetafileToJpegDataUrl(buffer: MetafileInput, options?: JpegConvertOptions): Promise<string | null>;
```

Converts an EMF or WMF file to a JPEG data URL (`data:image/jpeg;base64,...`). The drawing is rendered exactly as for `convertMetafileToDataUrl`, with the same options and the same `null` cases, then encoded by the bundled baseline JPEG encoder, so the output does not depend on the canvas backend. JPEG has no transparency: the transparent background and translucent pixels are composited over `background`.

### JpegConvertOptions

Extends `EmfConvertOptions`.

| Option              | Type      | Default     | Description |
| ------------------- | --------- | ----------- | ----------- |
| `quality`           | `number`  | `0.92`      | Quality from `0` to `1`, as for `canvas.toDataURL('image/jpeg', quality)`. |
| `background`        | `string`  | `'#ffffff'` | Colour under transparent pixels, as `#rgb` or `#rrggbb`. Other values fall back to white. |
| `chromaSubsampling` | `boolean` | `false`     | `true` stores colour at half resolution (4:2:0) for a smaller file. The default keeps full-resolution colour (4:4:4), so coloured lines and text have no colour fringes. |

## convertMetafileToWebpDataUrl

```ts
function convertMetafileToWebpDataUrl(buffer: MetafileInput, options?: WebpConvertOptions): Promise<string | null>;
```

Converts an EMF or WMF file to a WebP data URL (`data:image/webp;base64,...`). The drawing is rendered exactly as for `convertMetafileToDataUrl`, with the same options, backends and `null` cases, then encoded by the bundled WebP encoder. Images larger than 16383 pixels on a side return `null`.

### WebpConvertOptions

Extends `EmfConvertOptions`.

| Option     | Type      | Default | Description |
| ---------- | --------- | ------- | ----------- |
| `lossless` | `boolean` | `true`  | `true` writes lossless WebP: exact pixels, and the transparent background kept exactly. `false` writes lossy WebP at `quality`; transparency is still kept. |
| `quality`  | `number`  | `0.8`   | Lossy quality from `0` to `1`. Ignored when `lossless` is `true`. The lossy encoder is simple: for line art and text it is usually much larger than lossless, so use it for smooth, photo-like content. |

## SVG functions

```ts
function convertMetafileToSvg(buffer: MetafileInput, options?: SvgConvertOptions): Promise<string | null>;
function convertMetafileToSvgDataUrl(buffer: MetafileInput, options?: SvgConvertOptions): Promise<string | null>;
function convertMetafileToSvgTree(buffer: MetafileInput, options?: SvgConvertOptions): Promise<SvgNode | null>;
```

| Function                      | Returns |
| ----------------------------- | ------- |
| `convertMetafileToSvg`        | Standalone SVG markup. |
| `convertMetafileToSvgDataUrl` | A `data:image/svg+xml;base64,...` URL. |
| `convertMetafileToSvgTree`    | An `SvgNode` tree for the helpers below. |

### SvgConvertOptions

Extends `EmfConvertOptions`.

| Option            | Type                    | Default               | Description |
| ----------------- | ----------------------- | --------------------- | ----------- |
| `gdiAntialias`    | `boolean`               | `true`                | `false` embeds the aliased GDI shape pixels as image patches instead of smooth vector edges. |
| `exactRasterOps`  | `boolean`               | `true`                | `false` skips the raster mirror and approximates destination-reading raster operations with SVG `mix-blend-mode`. |
| `imageResampling` | `'renderer' \| 'exact'` | `'renderer'`          | `'exact'` renders EMF+ `DrawImage` at device resolution with the GDI+ resampling kernel instead of letting the SVG renderer scale the image. |
| `includeSize`     | `boolean`               | `true`                | Emit `width` and `height` on the root `<svg>`. `viewBox` is always emitted. |
| `idPrefix`        | `string`                | `emf1-`, `emf2-`, ... | Prefix for generated element ids. Use a unique value per inlined SVG. |

## SvgNode helpers

```ts
interface SvgNode {
	tag: string;
	attrs: Record<string, string | number>;
	children?: SvgNode[];
	text?: string;
}

function svgTreeToString(node: SvgNode): string;
function svgTreeToDataUrl(node: SvgNode): string;
function svgTreeToReact<E>(node: SvgNode, createElement: CreateElement<E>, rootProps?: Record<string, unknown>): E;
function svgTreeToJsx(node: SvgNode, options?: SvgJsxOptions): string;

type CreateElement<E> = (type: string, props: Record<string, unknown> | null, ...children: unknown[]) => E;
```

| Function           | Description |
| ------------------ | ----------- |
| `svgTreeToString`  | SVG markup for a tree. |
| `svgTreeToDataUrl` | Base64 SVG data URL for a tree. |
| `svgTreeToReact`   | Elements built with `createElement` (for example `React.createElement`). `rootProps` are merged onto the root `<svg>`. |
| `svgTreeToJsx`     | Source code of a JSX or TSX component. |

### SvgJsxOptions

| Option          | Type      | Default      | Description |
| --------------- | --------- | ------------ | ----------- |
| `componentName` | `string`  | `'Metafile'` | Name of the generated component. |
| `typescript`    | `boolean` | `true`       | Emit TypeScript with `SVGProps<SVGSVGElement>` typing. |
| `spreadProps`   | `boolean` | `true`       | Spread the component props onto the root `<svg>` after the recorded attributes, so `width` and `height` can be overridden. |

## loadSystemFonts

```ts
function loadSystemFonts(options?: LoadSystemFontsOptions): Promise<Uint8Array[]>;
```

Reads installed `.ttf`, `.ttc`, `.fon` and `.fnt` files for use with the `fonts` option. Node.js only; in other environments it returns an empty array.

### LoadSystemFontsOptions

| Option     | Type                                      | Default | Description |
| ---------- | ----------------------------------------- | ------- | ----------- |
| `dirs`     | `string[]`                                | Platform font folders | Directories to scan. Missing directories are skipped. |
| `filter`   | `(path: string, name: string) => boolean` |         | Keep only files for which this returns `true`. `name` is the lower-case file name. |
| `maxDepth` | `number`                                  | `4`     | Subdirectory depth to scan. `0` scans only the listed directories. |

The default directories are:

- Windows: `%WINDIR%\Fonts` and `%LOCALAPPDATA%\Microsoft\Windows\Fonts`
- Linux: `/usr/share/fonts`, `/usr/local/share/fonts`, `~/.fonts`, `~/.local/share/fonts`
- macOS: `/Library/Fonts`, `/System/Library/Fonts`, `~/Library/Fonts`

## convertMetafileToPdf

```ts
function convertMetafileToPdf(buffer: MetafileInput, options?: PdfConvertOptions): Promise<Uint8Array | null>;
function svgTreeToPdf(tree: SvgNode, options?: PdfOptions): Promise<Uint8Array | null>;
```

Converts an EMF or WMF file to a one-page vector PDF 1.7, or returns `null` for an invalid or empty metafile. It uses the same replay as the SVG output. Paths, clipping, gradients, patterns, opacity, blend modes and images are kept as vectors or embedded (JPEG is embedded unchanged). `svgTreeToPdf` makes the same PDF from an existing `SvgNode` tree. The output does not include PDF/A or tagged PDF.

### PdfConvertOptions

Extends `SvgConvertOptions` and `PdfOptions`.

| Option       | Type                                             | Default     | Description |
| ------------ | ------------------------------------------------ | ----------- | ----------- |
| `pageSize`   | `'drawing' \| { width: number; height: number }` | `'drawing'` | `'drawing'` makes the page the drawing itself (1 pixel = 0.75 pt). `{ width, height }` in points makes a page of that size, with the drawing scaled to fit and centred. |
| `fonts`      | `Array<ArrayBuffer \| ArrayBufferView>`          |             | TrueType (`.ttf`, `.ttc`) files. Text in a matching font is embedded as a subset of that face, so it stays selectable and searchable. Other text uses the standard PDF fonts (Helvetica, Times, Courier), whose glyph shapes differ. |
| `compress`   | `boolean`                                        | `true`      | Deflate content streams and image data. |
| `title`      | `string`                                         |             | Document title in the PDF information dictionary. |
| `decodeImage`| `(bytes: Uint8Array, mime: string) => PdfDecodedImage \| null` (may be async) |  | Decodes an embedded image format that is neither JPEG nor handled by the bundled decoders (PNG, BMP, GIF, TIFF, WebP). Returns straight RGBA, or `null` to skip the image. |

## convertMetafileToImageData

```ts
function convertMetafileToImageData(buffer: MetafileInput, options?: EmfConvertOptions): Promise<RgbaImage | null>;
```

Renders the same drawing that the PNG output encodes and returns the pixels: `{ data: Uint8ClampedArray, width, height }`, straight (non-premultiplied) RGBA, row-major and top-down, like `ImageData`. Pass `data` to `putImageData`, or to any encoder (for example `sharp(data, { raw: { width, height, channels: 4 } })`).

## getMetafileInfo

```ts
function getMetafileInfo(buffer: MetafileInput, options?: MetafileInfoOptions): Promise<MetafileInfo | null>;
```

Reads the header and records without rendering, and returns `null` for an invalid metafile. The main use is finding which font files to pass as `fonts`: `fonts` lists the faces the file declares. The list is of declared fonts, so not every one is necessarily drawn with, and fonts inside nested WMFs are not collected. `width` and `height` are the PNG size at default options, so they ignore `maxWidth` and `dpiScale`.

### MetafileInfoOptions

| Option         | Type     | Default               | Description |
| -------------- | -------- | --------------------- | ----------- |
| `maxRecords`   | `number` | As for the converters | Record limit per stream, as for the converters. |
| `ansiCodePage` | `number` | `1252`                | ANSI code page for WMF face names, as `ansiCodePage` for the converters. |

### MetafileInfo

| Field                | Type                                     | Description |
| -------------------- | ---------------------------------------- | ----------- |
| `format`             | `'emf' \| 'emf+' \| 'emf+dual' \| 'wmf'` | `'emf+'` is EMF+ only (the GDI records are a stub); `'emf+dual'` has a GDI fallback. |
| `placeable`          | `boolean`                                | WMF only: the file has an Aldus placeable header. |
| `playsEmbeddedEmf`   | `boolean`                                | WMF only: the file carries its original EMF in `META_ESCAPE` comments, which the converter plays instead of the WMF records. |
| `bounds`             | `MetafileRect`                           | EMF: the header's device-pixel bounds (inclusive). WMF: the bounding box in logical units. |
| `frame`              | `MetafileRect \| null`                   | EMF: the picture frame in .01 mm. Placeable WMF: the bounding box in .01 mm. Otherwise `null`. |
| `unitsPerInch`       | `number`                                 | WMF only: logical units per inch from the placeable header (96 when absent). |
| `device`             | `{ width, height } \| null`              | EMF only: the reference device size in pixels. |
| `deviceMm`           | `{ width, height } \| null`              | EMF only: the reference device size in millimetres. |
| `dpi`                | `{ x, y }`                               | Reference device resolution (96 when unknown). |
| `width`, `height`    | `number`                                 | Pixel size `convertMetafileToDataUrl` produces at default options. |
| `recordCount`        | `number`                                 | Records read from the stream. |
| `emfPlusRecordCount` | `number`                                 | Records read from the EMF+ streams inside `EMR_COMMENT` records. |
| `recordTypes`        | `Record<string, number>`                 | Count by record name (`EMR_*`, `META_*`, `EMFPLUS_*`). |
| `fonts`              | `MetafileFont[]`                         | Declared font faces, each `{ name, gdi, emfPlus }`. `gdi` is set when a GDI font record names it, `emfPlus` when an EMF+ font object does. |
| `hasText`            | `boolean`                                | `true` when any text-drawing record is present. |
| `images`             | `{ count, mimeTypes }`                   | Embedded images, including DIBs, EMF+ image objects and nested metafiles. |
| `embeddedMetafiles`  | `number`                                 | Nested metafiles among `images`. |
| `description`        | `string \| null`                         | The EMF header's application and document names. |
| `truncated`          | `boolean`                                | `true` when the record limit was hit or the stream ends in a damaged record. |

## Supported records

### EMF

Shapes, paths, blits, clipping, transforms, `EMR_EXTTEXTOUTA/W`, `EMR_POLYTEXTOUTA/W`, `EMR_SMALLTEXTOUT` and text justification, plus:

- Logical palettes (`PALETTEINDEX`, `DIBPALETTEINDEX`, `PALETTERGB`, `DIB_PAL_COLORS`)
- `EMR_ALPHABLEND`, `EMR_TRANSPARENTBLT`, `EMR_MASKBLT`, `EMR_PLGBLT`, `EMR_SETDIBITSTODEVICE`
- `EMR_GRADIENTFILL` (rectangles and triangles)
- `EMR_FILLRGN`, `EMR_FRAMERGN`, `EMR_INVERTRGN`, `EMR_PAINTRGN`
- `EMR_EXTFLOODFILL`, `EMR_ANGLEARC`, `EMR_POLYDRAW`, `EMR_POLYDRAW16`
- `EMR_FLATTENPATH`, `EMR_WIDENPATH`, `EMR_ABORTPATH`

Color space, ICM, OpenGL, escape and font driver records are read and ignored, as on a Windows display.

### EMF+

All records in MS-EMFPLUS, with 32-bit, compressed 16-bit and relative point data, and all object types: solid, hatch, texture and gradient brushes; pens with caps, joins, dash styles, dash caps, compound lines and custom line caps; paths, regions, bitmap and metafile images, fonts, string formats and image attributes.

Bitmap images may be PNG, BMP, GIF, TIFF or JPEG. JPEG is decoded the way Windows decodes it, including arithmetic-coded and CMYK/YCCK files (also inside a TIFF) without a canvas backend; a 12-bit JPEG is refused as Windows refuses it, and nothing is drawn for it. ANSI text records use the LOGFONT charset, including Macintosh.

Where GDI+ behaves differently from the MS-EMFPLUS specification (relative points, `StrokeFillPath`, `SetTSGraphics`, `SetTSClip`), the converter follows GDI+.

### WMF

META_ANIMATEPALETTE, META_ARC, META_BITBLT, META_CHORD, META_CREATEBITMAP, META_CREATEBITMAPINDIRECT, META_CREATEBRUSH, META_CREATEBRUSHINDIRECT, META_CREATEFONTINDIRECT, META_CREATEPALETTE, META_CREATEPATTERNBRUSH, META_CREATEPENINDIRECT, META_CREATEREGION, META_DELETEOBJECT, META_DIBBITBLT, META_DIBCREATEPATTERNBRUSH, META_DIBSTRETCHBLT, META_ELLIPSE, META_EOF, META_ESCAPE, META_EXCLUDECLIPRECT, META_EXTFLOODFILL, META_EXTTEXTOUT, META_FILLREGION, META_FLOODFILL, META_FRAMEREGION, META_INTERSECTCLIPRECT, META_INVERTREGION, META_LINETO, META_MOVETO, META_OFFSETCLIPRGN, META_OFFSETVIEWPORTORG, META_OFFSETWINDOWORG, META_PAINTREGION, META_PATBLT, META_PIE, META_POLYGON, META_POLYLINE, META_POLYPOLYGON, META_REALIZEPALETTE, META_RECTANGLE, META_RESIZEPALETTE, META_RESTOREDC, META_ROUNDRECT, META_SAVEDC, META_SCALEVIEWPORTEXT, META_SCALEWINDOWEXT, META_SELECTCLIPREGION, META_SELECTOBJECT, META_SELECTPALETTE, META_SETBKCOLOR, META_SETBKMODE, META_SETDIBTODEV, META_SETLAYOUT, META_SETMAPMODE, META_SETMAPPERFLAGS, META_SETPALENTRIES, META_SETPIXEL, META_SETPOLYFILLMODE, META_SETRELABS, META_SETROP2, META_SETSTRETCHBLTMODE, META_SETTEXTALIGN, META_SETTEXTCHAREXTRA, META_SETTEXTCOLOR, META_SETTEXTJUSTIFICATION, META_SETVIEWPORTEXT, META_SETVIEWPORTORG, META_SETWINDOWEXT, META_SETWINDOWORG, META_STRETCHBLT, META_STRETCHDIB, META_TEXTOUT.

An EMF embedded in `MFCOMMENT` escape records is played instead of the WMF records, as Windows does. Where current Windows versions play a record differently from the MS-WMF specification (Win16 device bitmaps in META_BITBLT and META_STRETCHBLT, META_CREATEPATTERNBRUSH, banded META_SETDIBTODEV), the converter follows Windows.
