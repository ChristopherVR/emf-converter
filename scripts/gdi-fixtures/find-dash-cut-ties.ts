/**
 * Searches for dashed Beziers whose dash cut points sit within 6e-4 FIX of a rounding tie, and writes them as
 * `src/__fixtures__/gdi/dash-cut-tie-cases.txt` (the list `PathProbe.DashCutTies` widens natively, see
 * `generate.ps1 dash-cut-tie-probe`, which writes `dash-cut-ties.json.gz`):
 *
 *   bun scripts/gdi-fixtures/find-dash-cut-ties.ts [count] [seconds] [output]
 *
 * Each line is "cap width x0 y0 x1 y1 x2 y2 x3 y3 d0 d1 d2 d3": a flat-capped (cap 2) pen 3 pixels wide with a user-style dash array of
 * two or four pixel lengths (zero entries are dropped) on a random Bezier. The cut walk below is the one of `dashPieces` in
 * `src/gdi-raster-widen.ts` at one logical unit per device pixel, written out only far enough to read the unrounded cut positions
 * `x0 + d * t / len`. Cases are kept in bins of the log of the gap to the tie, one sign each, so rare small gaps are not drowned by large
 * ones (the gap bins 1e-12 to 1e-4; 200 per bin). The committed list came from a 25 minute run of this search (48.9 million
 * candidates, 2,027 cases); reruns are statistically equal, not identical (the stop is a time limit).
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { GdiRasterPath, geometricStyle } from '../../src/gdi-raster';

const want = Number(process.argv[2] ?? 2400);
const seconds = Number(process.argv[3] ?? 1500);
const output = process.argv[4] ?? resolve(import.meta.dir, '../../src/__fixtures__/gdi/dash-cut-tie-cases.txt');

let seed = 12345;
const rnd = (): number => {
	seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
	return seed / 4294967296;
};
const ri = (a: number, b: number): number => a + Math.floor(rnd() * (b - a + 1));

/** The smallest signed distance of any cut coordinate of a dashed polyline to a rounding tie (x.5), or 1 when none is near. */
function closestTie(pts: number[], dashes: number[], shorten: number): number {
	const pattern: number[] = [];
	for (let i = 0; i < dashes.length; i += 2) {
		const on = dashes[i];
		const off = dashes[i + 1] ?? 0;
		const s = Math.min(on, shorten);
		pattern.push(on - s, off + s);
	}
	let best = 1;
	let idx = 0;
	let left = pattern[0];
	for (let i = 0; i + 3 < pts.length; i += 2) {
		const x0 = pts[i];
		const y0 = pts[i + 1];
		const dx = pts[i + 2] - x0;
		const dy = pts[i + 3] - y0;
		const len = Math.sqrt(Math.floor(dx / 16) ** 2 + Math.floor(dy / 16) ** 2) * 16;
		if (len === 0) continue;
		let t = 0;
		while (len - t > left || left === 0) {
			t += left;
			for (const v of [x0 + (dx * t) / len, y0 + (dy * t) / len]) {
				const g = v - Math.floor(v) - 0.5;
				if (Math.abs(g) < Math.abs(best)) best = g;
			}
			idx = (idx + 1) % pattern.length;
			left = pattern[idx];
			if (left === 0 && pattern.every((p) => p === 0)) return best;
		}
		left -= len - t;
	}
	return best;
}

const chosen: string[] = [];
const bins = new Map<string, number>();
const started = Date.now();
while (chosen.length < want && Date.now() - started < seconds * 1000) {
	const pts = Array.from({ length: 8 }, () => ri(10, 250));
	const dashCount = rnd() < 0.5 ? 2 : 4;
	const d = Array.from({ length: dashCount }, () => ri(2, 30));
	const path = new GdiRasterPath();
	path.addBeziers(pts.map((v) => v * 16), true);
	const style = geometricStyle(0x10000 | 7, 3, d);
	const gap = closestTie(path.figures[0].pts, style!.map((v) => v * 16), 0);
	if (Math.abs(gap) >= 6e-4) continue;
	const bin = (gap < 0 ? '-' : '+') + Math.floor(Math.log10(Math.abs(gap) + 1e-12));
	if ((bins.get(bin) ?? 0) >= want / 12) continue;
	bins.set(bin, (bins.get(bin) ?? 0) + 1);
	chosen.push([2, 3, ...pts, ...d, ...Array(4 - dashCount).fill(0)].join(' '));
}
console.log(`${chosen.length} cases;`, [...bins.entries()].sort().map(([k, v]) => `${k}:${v}`).join(' '));
writeFileSync(output, chosen.join('\n') + '\n');
