import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { halftoneEnlargeTaps } from './emf-gdi-stretch';
import { KERNEL_ROW_PAIRS } from './halftone-kernel-rows.fixture-helper';

/**
 * The integer weight rows (shares of 8192) Windows' HALFTONE gives each destination pixel of an axis enlarged by a
 * fractional or whole factor in a mixed enlarge-and-reduce stretch, measured for 78 source/destination length pairs
 * (`generate-halftone-kernel-rows.ts`). They fixed the closed form of the enlargement kernel behind
 * `halftoneEnlargeTaps` (two power laws, exponents 1/sqrt 2 and sqrt 2, meeting at a jump at half a pixel).
 * Round 6: of the 110 tie rows and the 7 interior misses, the tie rows (halves of exactly 4096 shares, so the weights cannot be
 * solved from outputs) and `29 -> 46 @ 19` are not converter defects (`halftone-kernel-ties.fixture.test.ts` checks the raw native
 * output); the six other misses are real and are pinned in `halftone-kernel-sides.fixture.test.ts` with the labelled
 * near-boundary rows around them.
 */
interface Capture { pairs: { n: number; N: number; rows: { x: number; w: [number, number][] }[] }[] }
const capture: Capture = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/halftone-kernel-rows.json.gz', import.meta.url))).toString());

describe('native HALFTONE enlargement weight rows', () => {
	it('holds the 78 measured pairs', () => {
		expect(capture.pairs.map(p => [p.n, p.N])).toEqual(KERNEL_ROW_PAIRS);
	});

	it('halftoneEnlargeTaps reproduces the measured rows (ties aside) exactly', () => {
		let rows = 0, exact = 0, ties = 0, tieExact = 0;
		const misses: string[] = [];
		for (const { n, N, rows: measured } of capture.pairs) {
			if (N === 2 * n) continue; // an exact 2x is plain linear interpolation, not the kernel
			const taps = halftoneEnlargeTaps(n, N);
			for (const row of measured) {
				const model = new Map(taps[row.x].map(([j, v]): [number, number] => [j, Math.round(v * 8192)]));
				const measuredMap = new Map(row.w);
				let same = true;
				for (const j of new Set([...model.keys(), ...measuredMap.keys()])) if ((model.get(j) ?? 0) !== (measuredMap.get(j) ?? 0)) same = false;
				// A tie: the destination pixel's centre lies on a source pixel's edge or centre.
				const tie = ((2 * row.x + 1) * n) % N === 0;
				if (tie) { ties++; if (same) tieExact++; } else { rows++; if (same) exact++; else misses.push(`${n}->${N}@${row.x}`); }
			}
		}
		expect({ rows, exact, ties, tieExact }).toEqual({ rows: 8159, exact: 8152, ties: 110, tieExact: 106 });
		expect(misses).toEqual(['29->46@19', '24->73@31', '24->73@41', '31->152@41', '31->152@110', '37->189@43', '37->189@145']);
	});
});
