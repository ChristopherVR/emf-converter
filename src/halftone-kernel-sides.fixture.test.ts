import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { halftoneEnlargeCumulative } from './emf-gdi-stretch';
import { KERNEL_SIDE_IMAGES, KERNEL_SIDE_PAIRS, KERNEL_SIDE_SEEDS, KERNEL_SIDE_THRESHOLD } from './halftone-kernel-sides.fixture-helper';

/**
 * Which side of a whole share the native cumulative share of a HALFTONE enlargement row lies on, labelled from the native output
 * of 2,000 random images per row (`generate-halftone-kernel-sides.ts`) for every row whose unrounded cumulative share
 * (`halftoneEnlargeCumulative`) is within 0.004 of a whole share. The formula (a closed form in double precision) is on the
 * wrong side in about 4% of them, always within 0.0035 of the integer and in mirror pairs (the native shares are exactly
 * mirror-symmetric): the native cumulative shares differ from the formula by about 5e-4 and at most a few thousandths, a few
 * units in the last place of a float32 near 1 (2^-23 * 8192 = 1e-3). Everything tried to explain that is recorded in
 * docs/outstanding-work.md (float32 at every site and combination of sites, the exponents, quantisation of the weights, the
 * cover and the kernel, a tabulated kernel): none gets more than a handful of labels right that the formula misses.
 */
interface Capture { seeds: number[]; pairs: number; images: number; threshold: number; boundaries: number[][] }
const capture: Capture = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/halftone-kernel-sides.json.gz', import.meta.url))).toString());

describe('native HALFTONE enlargement rows with a cumulative share near a whole share', () => {
	it('holds the labelled boundaries of the generator\'s three seeds', () => {
		expect(capture.seeds).toEqual(KERNEL_SIDE_SEEDS);
		expect(capture.pairs).toBe(KERNEL_SIDE_PAIRS);
		expect(capture.images).toBe(KERNEL_SIDE_IMAGES);
		expect(capture.threshold).toBe(KERNEL_SIDE_THRESHOLD);
		expect(capture.boundaries).toHaveLength(4773);
	});

	it('has the formula on the native side for 4,570 of them, the rest within 0.0035 of the integer and in mirror pairs', () => {
		const rows = new Map<string, Array<Array<[number, number]>>>();
		let right = 0, widest = 0;
		const labelled = new Set<string>(), missed = new Set<string>();
		for (const [n, N, x, j, c, above] of capture.boundaries) {
			const key = `${n},${N}`;
			let cumulative = rows.get(key);
			if (!cumulative) rows.set(key, cumulative = halftoneEnlargeCumulative(n, N));
			const cum = cumulative[x].find(e => e[0] === j)![1];
			labelled.add(`${key},${x},${j}`);
			if ((Math.ceil(cum - 1e-7) > c ? 1 : 0) === above) right++;
			else { widest = Math.max(widest, Math.abs(cum - c)); missed.add(`${key},${x},${j}`); }
		}
		expect({ right, wrong: capture.boundaries.length - right }).toEqual({ right: 4570, wrong: 203 });
		expect(widest).toBeLessThan(0.0035);
		// The boundary after source j of row x mirrors the boundary after source n - 2 - j of row N - 1 - x.
		let paired = 0;
		for (const k of missed) {
			const [n, N, x, j] = k.split(',').map(Number);
			if (missed.has(`${n},${N},${N - 1 - x},${n - 2 - j}`)) paired++;
		}
		expect({ distinct: missed.size, paired, distinctLabelled: labelled.size }).toEqual({ distinct: 195, paired: 194, distinctLabelled: labelled.size });
	});
});
