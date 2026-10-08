/**
 * The cases behind `__fixtures__/gdi/halftone-kernel-ties.json.gz` (`scripts/gdi-fixtures/generate-halftone-kernel-ties.ts`):
 * source/destination length pairs and the destination rows whose centre lies exactly on a source pixel's edge or centre
 * (`(2 x + 1) n` divisible by `N`), where HALFTONE's enlargement weights cannot be solved from outputs: the two halves of
 * such a row weigh exactly 4096 shares each, so the output `(s2 + s3) / 2 + delta` floors by the sign of the small tail term
 * `delta` alone and every tail on a ridge `k (m + 1, m)` reproduces the data. The capture stores the raw native output of
 * those rows instead; the test checks that the converter's rows reproduce every value.
 *
 * Images are 4 columns by `n` rows with one colour per row (as `halftone-kernel-rows`), drawn deterministically from the
 * pair index, so only the native output column is stored.
 */

/** [n, N, destination rows]: edge-on rows (even n, odd N: the middle row), centre rows (odd n) and the centre rows of the whole factor 15. */
export const KERNEL_TIE_CASES: [number, number, number[]][] = [
	// Centre on a source pixel's edge, tails of one to three shares (the cases a solved row got wrong), ratios 3.03x to 16.04x.
	[24, 73, [36]], [26, 79, [39]], [28, 85, [42]], [20, 81, [40]], [22, 89, [44]], [24, 97, [48]], [26, 105, [52]],
	[20, 101, [50]], [24, 121, [60]], [20, 121, [60]], [24, 145, [72]], [24, 169, [84]], [20, 141, [70]], [24, 193, [96]],
	[24, 217, [108]], [24, 241, [120]], [20, 201, [100]], [24, 265, [132]], [24, 289, [144]], [24, 313, [156]],
	[24, 337, [168]], [24, 361, [180]], [24, 385, [192]], [32, 129, [64]], [20, 301, [150]], [24, 99, [49]],
	// Edge-on rows with larger tails, which the weights solved from outputs got right.
	[24, 75, [37]], [24, 101, [50]], [26, 81, [40]], [24, 123, [61]],
	// Centre on a source pixel's centre (odd n): the spare share of an odd sum sits on either side with the same output.
	[29, 321, [160]], [31, 343, [171]], [19, 229, [114]],
	// The whole factor 15: centre rows 7 + 15 m, where the engine hands the spare share to the later pixel and the formula to the earlier.
	[20, 300, [22, 37, 52, 67]],
	// Not an exact tie, yet the solved row of `halftone-kernel-rows` (29 to 46, row 19) differs from the formula by a share and the formula reproduces the outputs.
	[29, 46, [19]],
];

/** Images per case. */
export const KERNEL_TIE_IMAGES = 400;

/** The per-row levels of every image of case `index` (`n` rows): levels[image][channel][row]. */
export function kernelTieLevels(index: number, n: number): number[][][] {
	let state = (index * 2246822519 + 4242) >>> 0;
	const next = (): number => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 4294967296;
	};
	return Array.from({ length: KERNEL_TIE_IMAGES }, () => [0, 1, 2].map(() => Array.from({ length: n }, () => Math.floor(next() * 256))));
}
