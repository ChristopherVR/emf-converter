/** Lite build: no native GDI+ colour-curve tables; colour-curve image effects leave colours unchanged. */
const IDENTITY = Uint8Array.from({ length: 256 }, (_, i) => i);

export function nativeCurveLookup(_curve: number, _intensity: number): Uint8Array {
	return IDENTITY;
}
