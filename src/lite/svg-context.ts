/**
 * Lite build: no SVG recorder. Every drawing context is a raster canvas, so
 * the SVG branches of the shared draw handlers are never taken.
 */
export class SvgContext {
	constructor() {
		throw new Error('SVG output is not part of the emf-converter lite build');
	}
}

export function isSvgContext(_ctx: unknown): _ctx is SvgContext {
	return false;
}

export function canReadBack(_ctx: unknown): boolean {
	return true;
}
