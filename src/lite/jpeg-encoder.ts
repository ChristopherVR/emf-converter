/** Lite build: PNG output only. */
export function encodeJpeg(): Uint8Array {
	throw new Error('JPEG output is not part of the emf-converter lite build');
}
