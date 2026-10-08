# API

All functions are named exports of `emf-converter`.

## convertMetafileToDataUrl

```ts
function convertMetafileToDataUrl(buffer: ArrayBuffer, options?: EmfConvertOptions): Promise<string | null>;
```

Converts an EMF or WMF file to a PNG data URL. Returns `null` if the buffer is not a valid metafile, or, in plain Node.js, if the drawing contains text and neither `fonts` nor `@napi-rs/canvas` is available.

### EmfConvertOptions

| Option               | Type                                    | Default             | Description |
| -------------------- | --------------------------------------- | ------------------- | ----------- |
| `maxWidth`           | `number`                                |                     | Maximum output width in pixels. The aspect ratio is preserved. |
| `maxHeight`          | `number`                                |                     | Maximum output height in pixels. |
| `dpiScale`           | `number`                                | `1`                 | Resolution multiplier, clamped to `4`. |
| `wmfReferenceDpi`     | `number \| { x: number; y: number }`      | `96`                | Playback-device resolution for WMF physical map modes. Supply the original device DPI when known; values must be finite and positive. |
| `maxCanvasDimension` | `number`                                | `8192`              | Upper limit for output width and height in pixels. |
| `maxRecords`         | `number`                                | `200000` / `500000` | Records processed per stream before replay stops. EMF+ uses the higher default. |
| `gdiAntialias`       | `boolean`                               | `false`             | Smooth shape edges with canvas antialiasing instead of reproducing GDI/GDI+ rasterisation. |
| `fonts`              | `Array<ArrayBuffer \| ArrayBufferView>` |                     | TrueType (`.ttf`, `.ttc`) and raster (`.fon`, `.fnt`) font files used for GDI text rendering. |
| `fontSmoothing`      | `'cleartype' \| 'gray' \| 'mono'`       | `'cleartype'`       | Rendering used for fonts with `DEFAULT_QUALITY`, `DRAFT_QUALITY` or `PROOF_QUALITY`. |
| `fontFamilyMap`      | `Record<string, string>`                |                     | Used without `fonts`. Maps Windows face names (case-insensitive) to local font families, for example `{ calibri: 'Carlito' }`. |

`DEFAULT_DPI_SCALE` is exported as the default value of `dpiScale` (`1`).

## SVG functions

```ts
function convertMetafileToSvg(buffer: ArrayBuffer, options?: SvgConvertOptions): Promise<string | null>;
function convertMetafileToSvgDataUrl(buffer: ArrayBuffer, options?: SvgConvertOptions): Promise<string | null>;
function convertMetafileToSvgTree(buffer: ArrayBuffer, options?: SvgConvertOptions): Promise<SvgNode | null>;
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
