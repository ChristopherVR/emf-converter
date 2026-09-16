/**
 * EMF/WMF converter, barrel re-export.
 *
 * This package converts Enhanced Metafile (EMF) and Windows Metafile (WMF)
 * binary buffers into PNG data-URL strings by parsing their record streams
 * and replaying the drawing operations onto an HTML Canvas, OffscreenCanvas,
 * or (in plain Node.js, with the optional `@napi-rs/canvas` package) a Node
 * canvas backend.
 *
 * The single public entry point is:
 * - {@link convertMetafileToDataUrl}, it auto-detects EMF (including embedded
 *   EMF+ / GDI+ records) vs. the older 16-bit WMF format and converts either
 *
 * @packageDocumentation
 */
export { convertMetafileToDataUrl, type EmfConvertOptions } from './emf-converter';
export { DEFAULT_DPI_SCALE } from './emf-canvas-helpers';
