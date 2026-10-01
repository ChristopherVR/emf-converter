import { decodeJpegPixelsLegacy } from './jpeg-decoder-legacy';
import { decodeJpegTurbo } from './jpeg-turbo';

/**
 * Decode a JPEG to RGBA. The bundled decoder reproduces libjpeg's output
 * (and therefore Windows') exactly for 8-bit Huffman JPEG with one or three
 * components; other files use the `jpeg-js` fallback.
 */
export function decodeJpegPixels(bytes: Uint8Array, colorTransform?: boolean) {
	return decodeJpegTurbo(bytes, colorTransform) ?? decodeJpegPixelsLegacy(bytes, colorTransform);
}
