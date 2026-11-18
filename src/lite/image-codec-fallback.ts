/**
 * Lite build: no bundled image decoders. Embedded JPEG, GIF, TIFF and WebP
 * images are decoded by the browser (`createImageBitmap`); formats it cannot
 * decode (TIFF, 12-bit or arithmetic-coded JPEG) are left undrawn. PNG and
 * BMP keep their built-in decoders (see `decodeImageBytesBuiltIn`).
 */
export const BUNDLED_IMAGE_CODECS = false;

export async function decodeImageCodecFallback(_bytes: Uint8Array): Promise<null> {
	return null;
}
