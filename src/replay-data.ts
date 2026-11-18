import { JOHAB_ROWS } from './emf-ansi-johab';
import { CHROMA_TIE_FLIPS } from './emf-gdi-chroma-tie-data';
import { ILLUMINANT_CUBE_DATA } from './emf-gdi-illuminant-data';
import type { ReplayDataKind } from './replay-data-preflight';

export { nativeCurveLookup } from './emf-plus-image-curves';

export const lazyReplayData = false;

export async function loadReplayData(_kinds: Iterable<ReplayDataKind>): Promise<void> {}

export function johabRow(lead: number): string | undefined {
	return JOHAB_ROWS[lead];
}

export function illuminantData(index: number): string | undefined {
	return ILLUMINANT_CUBE_DATA[index];
}

export function chromaTieFlips(key: string): readonly number[] | undefined {
	return CHROMA_TIE_FLIPS[key];
}
