import { decodeJpegPixelsLegacy } from './jpeg-decoder-legacy';
import { decodeJpegTurbo } from './jpeg-turbo';

/**
 * How a JPEG file is handled, decided from its frame header:
 * - `standard`: 8-bit Huffman-coded with one or three components, which canvas backends decode like Windows;
 * - `bundled`: arithmetic-coded or four-component (CMYK/YCCK), which only the bundled decoder reproduces
 *   (canvas backends refuse arithmetic coding and convert CMYK differently);
 * - `unsupported`: a sample precision other than 8 bits (12-bit JPEG). GDI+ reports "Unsupported JPEG data
 *   precision 12", fails to decode the image, and draws nothing for it.
 * `null` means the bytes are not a JPEG.
 */
export function jpegFamily(bytes: Uint8Array): 'standard' | 'bundled' | 'unsupported' | null {
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
	for (let position = 2; position + 4 <= bytes.length; ) {
		if (bytes[position] !== 0xff) {
			position++;
			continue;
		}
		const marker = bytes[position + 1];
		if (marker === 0xff) {
			position++;
			continue;
		}
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0) {
			position += 2;
			continue;
		}
		if (marker === 0xd9 || marker === 0xda) break;
		const length = bytes[position + 2] * 256 + bytes[position + 3];
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			if (position + 10 > bytes.length) return 'standard';
			if (bytes[position + 4] !== 8) return 'unsupported';
			const components = bytes[position + 9];
			return marker === 0xc9 || marker === 0xca || components === 4 ? 'bundled' : 'standard';
		}
		position += 2 + length;
	}
	return 'standard';
}

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
