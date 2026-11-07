/**
 * Lite build: no pure-JavaScript rasteriser. The lite build draws on the
 * browser's canvas only; without one, `createSurface` catches this error and
 * the conversion returns `null`.
 */
export class SoftwareRasterCanvas {
	readonly pixels = new Uint8ClampedArray(0);

	constructor(_width: number, _height: number) {
		throw new Error('The emf-converter lite build needs a browser canvas (OffscreenCanvas or document)');
	}
}
