/** Optional canvas backend for the Node package entry. */
export async function loadNodeCanvasModule(): Promise<typeof import('@napi-rs/canvas')> {
	return import(/* webpackIgnore: true */ /* @vite-ignore */ '@napi-rs/canvas');
}
