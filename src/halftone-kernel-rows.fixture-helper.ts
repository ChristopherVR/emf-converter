/**
 * The probes behind `__fixtures__/gdi/halftone-kernel-rows.json.gz` (`scripts/gdi-fixtures/generate-halftone-kernel-rows.ts`):
 * source/destination length pairs and the constant-row random images that expose the integer weight rows of the HALFTONE
 * enlargement. Deterministic, so the capture stores only the solved rows.
 */

/** Source rows and destination rows of every measured enlargement (ratios 1.02x to 16x). */
export const KERNEL_ROW_PAIRS: [number, number][] = [
	[24, 25], [29, 31], [20, 22], [33, 38], [24, 29], [29, 37], [20, 27], [33, 47], [24, 36], [29, 46], [20, 33], [33, 58],
	[24, 44], [29, 57], [20, 41], [33, 73], [24, 56], [29, 73], [20, 53], [33, 92], [24, 73], [29, 96], [20, 71], [33, 125],
	[24, 98], [29, 128], [20, 94], [33, 163], [24, 127], [29, 168], [20, 128], [33, 234], [24, 187], [29, 249], [20, 190],
	[33, 347], [24, 281], [29, 383], [20, 302],
	[26, 27], [31, 34], [37, 42], [45, 54], [17, 21], [26, 34], [31, 43], [37, 54], [45, 69], [17, 28], [26, 44], [31, 56],
	[37, 70], [45, 90], [17, 36], [26, 59], [31, 74], [37, 94], [45, 122], [17, 49], [26, 81], [31, 105], [37, 137], [45, 180],
	[17, 73], [26, 120], [31, 152], [37, 189], [45, 248], [17, 102], [26, 174], [31, 229], [37, 303], [45, 405], [17, 170],
	[26, 286], [31, 388], [37, 518], [45, 720],
];

/** Images per pair; each gives three independent equations per destination row. */
export const KERNEL_ROW_IMAGES = 1200;

/** The per-row levels of every image of pair `index` (`n` rows): levels[image][channel][row]. */
export function kernelRowLevels(index: number, n: number): number[][][] {
	let state = (index * 2654435761 + 777) >>> 0;
	const next = (): number => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 4294967296;
	};
	return Array.from({ length: KERNEL_ROW_IMAGES }, () => [0, 1, 2].map(() => Array.from({ length: n }, () => Math.floor(next() * 256))));
}
