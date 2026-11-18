import type { SvgContext } from './svg-context';

export const SVG_CONTEXT = Symbol('SvgContext');

export function isSvgContext(ctx: unknown): ctx is SvgContext {
	return typeof ctx === 'object' && ctx !== null && SVG_CONTEXT in ctx;
}

export function canReadBack(ctx: unknown): boolean {
	return !isSvgContext(ctx) || ctx.canReadPixels;
}
