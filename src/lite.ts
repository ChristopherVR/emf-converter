/**
 * `emf-converter/lite`: a small browser build that renders EMF/WMF (with
 * EMF+) to PNG through the page's canvas, for apps that only need a raster
 * preview and care about bundle size.
 *
 * It replays every record the full build does, with these left out:
 * - JPEG, WebP, SVG and PDF output;
 * - the TrueType engine behind the `fonts` option: text is drawn with the
 *   canvas's `fillText` (use `fontFamilyMap` to pick installed or web fonts);
 * - the bundled image decoders: embedded JPEG, GIF and WebP images are
 *   decoded by the browser, and TIFF images are not drawn;
 * - Windows' measured colour tables (CMYK JPEG, `SetColorAdjustment`
 *   illuminants, GDI+ colour-curve effects) and the Johab code page.
 *
 * @packageDocumentation
 */
import {
	convertMetafileToDataUrl as convertToDataUrl,
	convertMetafileToImageData as convertToImageData,
	type EmfConvertOptions,
	type RgbaImage,
} from './emf-converter';
import type { MetafileInput } from './metafile-input';

export type { MetafileInput, RgbaImage };
export { DEFAULT_DPI_SCALE } from './emf-canvas-helpers';

/** {@link EmfConvertOptions} without the TrueType engine options the lite build has no use for. */
export type LiteConvertOptions = Omit<EmfConvertOptions, 'fonts' | 'fontSmoothing'>;

/**
 * Converts an EMF or WMF file (format auto-detected) to a PNG data URL, as
 * the full build's `convertMetafileToDataUrl` does.
 *
 * @returns A `data:image/png;base64,...` string, or `null` when the input is
 *   not a valid metafile, has empty bounds, or no canvas is available.
 */
export function convertMetafileToDataUrl(input: MetafileInput, options?: LiteConvertOptions): Promise<string | null> {
	return convertToDataUrl(input, options);
}

/** Renders an EMF or WMF file to straight RGBA pixels, as the full build's `convertMetafileToImageData` does. */
export function convertMetafileToImageData(input: MetafileInput, options?: LiteConvertOptions): Promise<RgbaImage | null> {
	return convertToImageData(input, options);
}
