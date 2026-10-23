/**
 * EMF/WMF converter, barrel re-export.
 *
 * This package converts Enhanced Metafile (EMF, including embedded EMF+ /
 * GDI+ records) and Windows Metafile (WMF) binary buffers into:
 *
 * - PNG data URLs, by replaying the drawing onto an HTML Canvas,
 *   OffscreenCanvas, or (in plain Node.js, with the optional
 *   `@napi-rs/canvas` package) a Node canvas backend, and with no canvas at
 *   all the built-in pure-JavaScript rasteriser (for drawings without text,
 *   which needs a font engine): {@link convertMetafileToDataUrl}
 * - JPEG data URLs from the same rendering, encoded by the bundled
 *   encoder: {@link convertMetafileToJpegDataUrl}
 * - WebP data URLs (lossless by default, or lossy) from the same rendering,
 *   encoded by the bundled encoder: {@link convertMetafileToWebpDataUrl}
 * - SVG, by replaying the same drawing onto an SVG recorder that needs no
 *   canvas at all: {@link convertMetafileToSvg} (markup),
 *   {@link convertMetafileToSvgDataUrl} (base64 data URL), and
 *   {@link convertMetafileToSvgTree} (a tree for {@link svgTreeToReact}
 *   / {@link svgTreeToJsx}, i.e. JSX/TSX rendering)
 *
 * - Raw bytes of any of these ({@link convertMetafile}) and straight RGBA
 *   pixels ({@link convertMetafileToImageData})
 *
 * Every entry point auto-detects EMF vs. WMF from the bytes, and accepts an
 * `ArrayBuffer`, typed array / Node `Buffer`, or `Blob`, gzip-compressed
 * (`.emz` / `.wmz`) or not.
 *
 * @packageDocumentation
 */
export {
	convertMetafile,
	convertMetafileToImageData,
	convertMetafileToDataUrl,
	convertMetafileToJpegDataUrl,
	convertMetafileToSvg,
	convertMetafileToSvgDataUrl,
	convertMetafileToSvgTree,
	convertMetafileToWebpDataUrl,
	type ConvertOptions,
	type ConvertedImage,
	type MetafileOutputFormat,
	type RgbaImage,
	type EmfConvertOptions,
	type JpegConvertOptions,
	type SvgConvertOptions,
	type WebpConvertOptions,
} from './emf-converter';
export { convertMetafileToPdf, type PdfConvertOptions } from './pdf-convert';
export { svgTreeToPdf, type PdfOptions, type PdfDecodedImage } from './pdf-svg';
export type { MetafileInput } from './metafile-input';
export { DEFAULT_DPI_SCALE } from './emf-canvas-helpers';
export { loadSystemFonts, type LoadSystemFontsOptions } from './load-system-fonts';
export {
	svgTreeToString,
	svgTreeToDataUrl,
	svgTreeToReact,
	svgTreeToJsx,
	type SvgNode,
	type SvgJsxOptions,
	type CreateElement,
} from './svg-tree';
export {
	getMetafileInfo,
	type MetafileFont,
	type MetafileInfo,
	type MetafileInfoOptions,
	type MetafileRect,
} from './metafile-info';
