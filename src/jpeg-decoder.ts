import { decodeJpegPixelsLegacy } from './jpeg-decoder-legacy';
import { decodeJpegTurbo } from './jpeg-turbo';
import { jpegFamily } from './jpeg-family';

export { jpegFamily };

/**
 * Decode a JPEG to RGBA. The bundled decoder reproduces libjpeg's output
 * (and therefore Windows') exactly for 8-bit Huffman and arithmetic-coded JPEG
 * with one or three components, and models Windows' colour-managed CMYK/YCCK
 * conversion (see `jpeg-cmyk.ts`); other files use the `jpeg-js` fallback.
 * Throws for a JPEG that Windows cannot decode either (see {@link jpegFamily}).
 */
export function decodeJpegPixels(bytes: Uint8Array, colorTransform?: boolean) {
	if (jpegFamily(bytes) === 'unsupported') throw new Error('Unsupported JPEG data precision');
	return decodeJpegTurbo(bytes, colorTransform) ?? decodeJpegPixelsLegacy(bytes, colorTransform);
}
