/**
 * Lite build: no TrueType engine. The `fonts` option is ignored and text is
 * always drawn with the canvas's own `fillText` (system or web fonts, after
 * `fontFamilyMap`). Only the values the converter reaches are provided.
 */
export const NONANTIALIASED_QUALITY = 3;
export const ANTIALIASED_QUALITY = 4;
export const CLEARTYPE_NATURAL_QUALITY = 6;

export class GdiFontCollection {
	readonly size = 0;

	static for(_sources: unknown, _smoothing?: unknown): GdiFontCollection {
		return new GdiFontCollection();
	}
}
