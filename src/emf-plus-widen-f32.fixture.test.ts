/**
 * The single precision dasher and cap of `emf-plus-widen-f32.ts` against `GraphicsPath.Widen` (`dash-widen.json.gz`, see
 * `emf-plus-dash-widen.fixture.test.ts`): the 54 open lines with Round dash caps. `Widen` returns floats, so every vertex of a dash is compared
 * bit for bit: the straight side's start point, and the 7 points of both caps (the Beziers' control points). This covers the cut points of
 * `getDashData` (the rounding mode and the order of operations decide the last bit), the unit direction of `CalculateGradientArray` and the
 * arithmetic of `SetRoundCap`.
 */
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { dashF32, gradientF32, offsetPointF32, roundCapF32, type PointF } from './emf-plus-widen-f32';
import { down32 } from './float32-down';

interface Case {
	kind: string;
	inset?: boolean;
	width: number;
	dashCap: number;
	style: number;
	pattern: number[] | null;
	offset: number;
	pts: number[];
	widen: number[];
	types: number[];
}

const STOCK: Record<number, number[]> = { 1: [3, 1], 2: [1, 1], 3: [3, 1, 1, 1], 4: [3, 1, 1, 1, 1, 1] };
const cases: Case[] = JSON.parse(gunzipSync(readFileSync(fixturePath('dash-widen.json.gz'))).toString());
const f = Math.fround;

/** The native polygons (closed by the 0x80 flag) as float points. */
function polygons(c: Case): PointF[][] {
	const out: PointF[][] = [];
	let cur: PointF[] = [];
	c.types.forEach((t, i) => {
		cur.push({ x: f(c.widen[2 * i]), y: f(c.widen[2 * i + 1]) });
		if (t & 0x80) {
			out.push(cur);
			cur = [];
		}
	});
	return out;
}

describe('single precision dashes and caps against GraphicsPath.Widen', () => {
	const lines = cases.filter((c) => !c.inset && c.dashCap === 2 && c.kind === 'line');

	it('has the 54 round-capped lines', () => {
		expect(lines.length).toBe(54);
	});

	it('cut points and cap points are bit for bit the native ones (239 dashes, 1,673 cap points)', () => {
		let dashes = 0;
		let capPoints = 0;
		let sides = 0;
		for (const c of lines) {
			const width = f(c.width);
			const pattern = (c.pattern ?? STOCK[c.style]).map((v) => f(v));
			// AdjustDashArrayForCaps: even entries a width shorter (at least 0.001 of a width), odd ones a width longer.
			const least = down32(f(0.001) * width);
			const dash = pattern.map((v, i) => {
				const d = down32(width * v);
				if (i % 2 === 1) {
					return down32(d + width);
				}
				const shortened = down32(d - width);
				return least > shortened ? least : shortened;
			});
			const pts: PointF[] = [
				{ x: f(c.pts[0]), y: f(c.pts[1]) },
				{ x: f(c.pts[2]), y: f(c.pts[3]) },
			];
			const mine = dashF32(pts, false, dash, down32(width * f(c.offset)));
			const native = polygons(c);
			expect(mine.length).toBeGreaterThanOrEqual(native.length);
			const half = down32(width * 0.5);
			native.forEach((poly, k) => {
				// A dash with the line's own cap at one end (or a dot) has another shape: skipped.
				if (poly.length !== 15) {
					return;
				}
				const d = mine[k];
				const g = gradientF32(d[0], d[d.length - 1]);
				const end = roundCapF32(d[d.length - 1], g, half, -half, false);
				const start = roundCapF32(d[0], g, half, -half, true);
				const side = offsetPointF32(d[0], g, -half);
				expect(side).toEqual(poly[0]);
				sides++;
				for (let i = 0; i < 7; i++) {
					expect(end[i]).toEqual(poly[1 + i]);
					expect(start[i]).toEqual(poly[8 + i]);
					capPoints += 2;
				}
				dashes++;
			});
		}
		expect(dashes).toBe(239);
		expect(sides).toBe(239);
		expect(capPoints).toBe(3346);
	});
});
