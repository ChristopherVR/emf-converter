import type { SvgContext } from '../svg-context';

export function isSvgContext(_ctx: unknown): _ctx is SvgContext {
	return false;
}

export function canReadBack(_ctx: unknown): boolean {
	return true;
}
