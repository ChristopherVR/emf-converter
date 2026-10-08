/**
 * The cases behind `__fixtures__/gdi/halftone-filtered.json.gz`: native HALFTONE enlargements whose source
 * takes the filtered branch (`scripts/gdi-fixtures/HalftoneBoundaryProbe.cs`, `generate-halftone-filtered.ts`).
 * Everything here is deterministic, so the capture stores only the native output of each case and the test
 * regenerates the sources.
 *
 * Flags are the probe's: bit 2 / bit 3 mirror the destination horizontally / vertically, bits 4-6 select a
 * colour adjustment (3: colorfulness +40, 4: colorfulness +40 with gamma 1.5).
 */

export interface FilteredCase {
	id: string;
	group: 'whole' | 'large' | 'mirrored' | 'dithered';
	kind: number;
	w: number;
	h: number;
	dw: number;
	dh: number;
	flags: number;
}

/** The linear congruential generator every source seeds explicitly. */
export function lcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

/** RGB bytes of a source: 0 noise, 1 smooth sinusoids plus noise, 2 stripes plus noise. */
export function filteredSource(kind: number, w: number, h: number): Uint8Array {
	const next = lcg(kind * 7919 + w);
	const rgb = new Uint8Array(w * h * 3);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			for (let c = 0; c < 3; c++) {
				let v: number;
				if (kind === 0) v = Math.floor(next() * 256);
				else if (kind === 1) v = Math.floor(128 + 100 * Math.sin(x * 0.5 + c) * Math.cos(y * 0.4 + c) + next() * 20 - 10);
				else v = ((x >> 2) + (y >> 1) + c) % 2 ? 230 - c * 20 : 20 + c * 10 + Math.floor(next() * 30);
				rgb[(y * w + x) * 3 + c] = Math.max(0, Math.min(255, v));
			}
		}
	}
	return rgb;
}

const W = 64;
const H = 40;
const pair = (id: string, group: FilteredCase['group'], kind: number, dw: number, dh: number, flags = 0): FilteredCase => ({ id, group, kind, w: W, h: H, dw, dh, flags });

/** All cases, in capture order. */
export function filteredCases(): FilteredCase[] {
	const cases: FilteredCase[] = [];
	for (const s of [2, 3, 4, 5]) for (const kind of s <= 3 ? [0, 1, 2] : [1]) cases.push(pair(`whole-${s}x-k${kind}`, 'whole', kind, W * s, H * s));
	for (const [sx, sy] of [[2, 3], [3, 2], [2, 5], [5, 3]]) cases.push(pair(`whole-${sx}x${sy}`, 'whole', 1, W * sx, H * sy));
	for (const [dw, dh] of [[384, 240], [352, 220], [160, 260], [416, 100]]) cases.push(pair(`large-${dw}x${dh}`, 'large', 1, dw, dh));
	for (const flags of [4, 8]) cases.push(pair(`mirrored-3x-f${flags}`, 'mirrored', 1, W * 3, H * 3, flags));
	cases.push(pair('mirrored-7x-f12', 'mirrored', 1, W * 7, H * 7, 12));
	for (const [mode, s, mirror] of [[3, 2, 0], [3, 2, 4], [3, 2, 8], [3, 3, 0], [3, 3, 8], [4, 2, 0], [4, 2, 8]]) {
		cases.push(pair(`dithered-${s}x-m${mode}-f${mirror}`, 'dithered', 0, W * s, H * s, mirror | (mode << 4)));
	}
	cases.push(pair('dithered-7x-m3-f0', 'dithered', 0, W * 7, H * 7, 3 << 4));
	return cases;
}

/** One-axis profile sources: a random level per row (`v`) or column (`h`), the other axis constant. */
export const PROFILE_LENGTH = 320;
export const PROFILE_OTHER = 8;
export const PROFILE_SCALES = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
export const PROFILE_SEEDS = 1;

export function profileLevels(axis: 'v' | 'h', seed: number): number[][] {
	const next = lcg(300 + seed + (axis === 'h' ? 50 : 0));
	return [0, 1, 2].map(() => Array.from({ length: PROFILE_LENGTH }, () => 20 + Math.floor(next() * 216)));
}

export function profileSource(axis: 'v' | 'h', seed: number): { w: number; h: number; rgb: Uint8Array } {
	const levels = profileLevels(axis, seed);
	const w = axis === 'v' ? PROFILE_OTHER : PROFILE_LENGTH;
	// A horizontal profile needs nine rows: with exactly eight a 320-colour first row stays one colour short of the replicated-branch limit.
	const h = axis === 'v' ? PROFILE_LENGTH : PROFILE_OTHER + 1;
	const rgb = new Uint8Array(w * h * 3);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) rgb[(y * w + x) * 3 + c] = levels[c][axis === 'v' ? y : x];
	return { w, h, rgb };
}
