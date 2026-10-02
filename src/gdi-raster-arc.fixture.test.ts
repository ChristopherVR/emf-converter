import { describe, expect, it } from 'vitest';
import nativeArcs from './__fixtures__/gdi/arc-paths.json';
import { axisBox } from './gdi-raster';
import { arcRasterPath } from './emf-gdi-raster-shapes';

/** Drops consecutive repeats (Windows emits zero-length Beziers where an arc starts or ends exactly on a quadrant boundary). */
function dedupe(points: number[]): number[] {
	const out: number[] = [];
	for (let i = 0; i < points.length; i += 2) {
		if (!(out.length && out[out.length - 2] === points[i] && out[out.length - 1] === points[i + 1])) {
			out.push(points[i], points[i + 1]);
		}
	}
	return out;
}

describe('native Arc, Chord and Pie paths (GM_COMPATIBLE, counter-clockwise)', () => {
	it('keeps every control and end point within a few FIX of GetPath, most of them exact', () => {
		expect(nativeArcs).toHaveLength(900);
		let exact = 0;
		let beyondOne = 0;
		let largest = 0;
		for (const c of nativeArcs) {
			const [l, t, r, b] = c.box.map((v) => v * 16);
			const box = axisBox(l, t, r - 16, b - 16);
			// The compatible-mode radials are measured on the box as given and carried onto the drawn one.
			const onBox = (x: number, r0: number, r1: number, b0: number, b1: number) =>
				(b0 + b1) / 2 + (r1 !== r0 ? ((x - (r0 + r1) / 2) * (b1 - b0)) / (r1 - r0) : x - (r0 + r1) / 2);
			const radial = (x: number, y: number): [number, number] => [onBox(x * 16, l, r, l, r - 16), onBox(y * 16, t, b, t, b - 16)];
			const kind = (['arc', 'chord', 'pie'] as const)[c.kind];
			const mine = dedupe(arcRasterPath(box, radial(c.radials[0], c.radials[1]), radial(c.radials[2], c.radials[3]), false, kind).path.getPath.pts);
			const native: number[] = [];
			for (let i = 0; i < c.expected.length; i += 3) native.push(c.expected[i], c.expected[i + 1]);
			const expected = dedupe(native);
			expect(mine).toHaveLength(expected.length);
			let worst = 0;
			for (let i = 0; i < expected.length; i++) worst = Math.max(worst, Math.abs(expected[i] - mine[i]));
			largest = Math.max(largest, worst);
			if (worst === 0) exact++;
			else if (worst > 1) beyondOne++;
		}
		// Measured: 662 exact, 234 one FIX off, 4 further (at most 5 FIX; before 234 exact and 180 beyond one, up to 31 FIX).
		expect(exact).toBeGreaterThanOrEqual(660);
		expect(beyondOne).toBeLessThanOrEqual(4);
		expect(largest).toBeLessThanOrEqual(5);
	});
});
