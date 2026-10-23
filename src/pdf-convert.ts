/**
 * Metafile to PDF: replays the metafile onto the SVG backend and serialises
 * the resulting tree as a vector PDF (see `pdf-svg.ts`).
 *
 * @module pdf-convert
 */

import { convertMetafileToSvgTree, type SvgConvertOptions } from './emf-converter';
import { svgTreeToPdf, type PdfOptions } from './pdf-svg';

/** Options for {@link convertMetafileToPdf}: the SVG replay options plus {@link PdfOptions}. */
export interface PdfConvertOptions extends SvgConvertOptions, PdfOptions {}

/**
 * Converts an EMF or WMF buffer (format auto-detected) into a vector PDF
 * with one page. Drawing, clipping, gradients, patterns and images come
 * from the same replay as the SVG output; text is real text, in embedded
 * TrueType subsets when `fonts` is supplied and in the standard PDF fonts
 * otherwise.
 *
 * @returns The PDF file bytes, or `null` for an invalid/empty metafile.
 */
export async function convertMetafileToPdf(
	buffer: ArrayBuffer,
	options: PdfConvertOptions = {},
): Promise<Uint8Array | null> {
	const tree = await convertMetafileToSvgTree(buffer, { ...options, includeSize: true });
	return tree ? svgTreeToPdf(tree, options) : null;
}
