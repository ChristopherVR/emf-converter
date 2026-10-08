/**
 * The cases behind `__fixtures__/gdi/halftone-kernel-sides.json.gz` (`scripts/gdi-fixtures/generate-halftone-kernel-sides.ts`):
 * pseudo-random source/destination length pairs (8 to 57 source rows, ratios 1.05x to 16x, never an exact 2x) of the
 * HALFTONE enlargement in a mixed enlarge-and-reduce stretch, and the images (one colour per row) whose native output decides,
 * for every destination row with a cumulative share within `THRESHOLD` of a whole share, on which side of the integer the native
 * cumulative share lies. Deterministic, so the capture stores only the labelled boundaries.
 */

export const KERNEL_SIDE_SEEDS = [1, 2, 3];
export const KERNEL_SIDE_PAIRS = 400;
export const KERNEL_SIDE_IMAGES = 2000;
/** Rows are labelled when a cumulative share is this close to a whole share. */
export const KERNEL_SIDE_THRESHOLD = 0.004;

/** The `KERNEL_SIDE_PAIRS` length pairs of one seed. */
export function kernelSidePairs(seed: number): [number, number][] {
	let state = (seed * 2654435761 + 99) >>> 0;
	const rnd = (): number => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 4294967296;
	};
	const pairs: [number, number][] = [];
	while (pairs.length < KERNEL_SIDE_PAIRS) {
		const n = 8 + Math.floor(rnd() * 50);
		const ratio = 1.05 + rnd() * 15;
		const N = Math.round(n * ratio);
		if (N === 2 * n || N <= n || N > 700) continue;
		pairs.push([n, N]);
	}
	return pairs;
}

/** The per-row levels of every image of pair `k` of `seed` (`n` rows): levels[image][channel][row]. */
export function kernelSideLevels(seed: number, k: number, n: number): number[][][] {
	let state = ((k + seed * 1000) * 2246822519 + 4242) >>> 0;
	const next = (): number => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 4294967296;
	};
	return Array.from({ length: KERNEL_SIDE_IMAGES }, () => [0, 1, 2].map(() => Array.from({ length: n }, () => Math.floor(next() * 256))));
}
