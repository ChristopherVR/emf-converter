/**
 * EMF/WMF converter, barrel re-export.
 *
 * This package converts Enhanced Metafile (EMF, including embedded EMF+ /
 * GDI+ records) and Windows Metafile (WMF) binary buffers into:
 *
 * - PNG data URLs, by replaying the drawing onto an HTML Canvas,
 *   OffscreenCanvas, or (in plain Node.js, with the optional
 *   `@napi-rs/canvas` package) a Node canvas backend:
 *   {@link convertMetafileToDataUrl}
 * - SVG, by replaying the same drawing onto an SVG recorder that needs no
 *   canvas at all: {@link convertMetafileToSvg} (markup),
 *   {@link convertMetafileToSvgDataUrl} (base64 data URL), and
 *   {@link convertMetafileToSvgTree} (a tree for {@link svgTreeToReact}
 *   / {@link svgTreeToJsx}, i.e. JSX/TSX rendering)
 *
 * Every entry point auto-detects EMF vs. WMF from the bytes.
 *
 * @packageDocumentation
 */
export {
	convertMetafileToDataUrl,
	convertMetafileToSvg,
	convertMetafileToSvgDataUrl,
	convertMetafileToSvgTree,
	type EmfConvertOptions,
	type SvgConvertOptions,
} from './emf-converter';
export { DEFAULT_DPI_SCALE } from './emf-canvas-helpers';
export {
	svgTreeToString,
	svgTreeToDataUrl,
	svgTreeToReact,
	svgTreeToJsx,
	type SvgNode,
	type SvgJsxOptions,
	type CreateElement,
} from './svg-tree';
