import type { ReplayDataKind } from './replay-data-preflight';

export const lazyReplayData = true;

let johabRows: typeof import('./emf-ansi-johab').JOHAB_ROWS | undefined;
let illuminantCubes: typeof import('./emf-gdi-illuminant-data').ILLUMINANT_CUBE_DATA | undefined;
let chromaTies: typeof import('./emf-gdi-chroma-tie-data').CHROMA_TIE_FLIPS | undefined;
let curveLookup: typeof import('./emf-plus-image-curves').nativeCurveLookup | undefined;

const loaders = {
	johab: async () => {
		johabRows ??= (await import('./emf-ansi-johab')).JOHAB_ROWS;
	},
	illuminants: async () => {
		illuminantCubes ??= (await import('./emf-gdi-illuminant-data')).ILLUMINANT_CUBE_DATA;
	},
	chromaTies: async () => {
		chromaTies ??= (await import('./emf-gdi-chroma-tie-data')).CHROMA_TIE_FLIPS;
	},
	colorCurve: async () => {
		curveLookup ??= (await import('./emf-plus-image-curves')).nativeCurveLookup;
	},
} satisfies Record<ReplayDataKind, () => Promise<void>>;

export async function loadReplayData(kinds: Iterable<ReplayDataKind>): Promise<void> {
	await Promise.all(Array.from(kinds, (kind) => loaders[kind]()));
}

export function johabRow(lead: number): string | undefined {
	if (lead < 128) return undefined;
	if (!johabRows) throw new Error('Johab replay data was not loaded');
	return johabRows[lead];
}

export function illuminantData(index: number): string | undefined {
	if (index === 0 || index === 6) return undefined;
	if (!illuminantCubes) throw new Error('GDI color replay data was not loaded');
	return illuminantCubes[index];
}

export function chromaTieFlips(key: string): readonly number[] | undefined {
	if (!chromaTies) throw new Error('GDI color replay data was not loaded');
	return chromaTies[key];
}

export function nativeCurveLookup(curve: number, intensity: number): Uint8Array {
	if (!curveLookup) throw new Error('GDI+ color curve replay data was not loaded');
	return curveLookup(curve, intensity);
}
