/** Lite build: PNG output only. */
export function encodeWebp(): Uint8Array {
	throw new Error('WebP output is not part of the emf-converter lite build');
}
