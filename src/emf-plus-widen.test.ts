import { describe, it, expect } from 'vitest';

import type { DeviceFigure } from './emf-plus-raster';
import { widenFigures, type DevicePen } from './emf-plus-widen';

const pen = (over: Partial<DevicePen> = {}): DevicePen => ({
	half: 2,
	join: 0,
	miterLimit: 10,
	startCap: 0,
	endCap: 0,
	dashCap: 0,
	dash: null,
	dashOffset: 0,
	compound: null,
	inset: false,
	...over,
});

const line = (pts: number[], closed = false): DeviceFigure => ({ pts, closed, curved: false });
const round = (polys: Array<Array<{ x: number; y: number }>>): number[][] =>
	polys.map((p) => p.flatMap((q) => [Math.round(q.x * 1000) / 1000, Math.round(q.y * 1000) / 1000]));

describe('widenFigures', () => {
	it('outlines an open segment with flat caps', () => {
		expect(round(widenFigures([line([0, 0, 10, 0])], pen()))).toEqual([[0, 2, 10, 2, 10, -2, 0, -2, 0, 2]]);
	});

	it('mitres the outside of a turn and keeps both offset points inside it', () => {
		// Right, then down (a clockwise turn on screen): the outside is the upper-right.
		const [poly] = round(widenFigures([line([0, 0, 10, 0, 10, 10])], pen()));
		expect(poly).toContain(12); // the miter corner (12, -2)
		// Inside the turn (the lower-left side): both offset end points, (10, 2) then (8, 0).
		expect(poly.slice(0, 8)).toEqual([0, 2, 10, 2, 8, 0, 8, 10]);
	});

	it('extends square caps and splits compound bands', () => {
		const [sq] = round(widenFigures([line([0, 0, 10, 0])], pen({ startCap: 1, endCap: 1 })));
		expect(Math.min(...sq.filter((_, i) => i % 2 === 0))).toBe(-2);
		expect(Math.max(...sq.filter((_, i) => i % 2 === 0))).toBe(12);
		const bands = widenFigures([line([0, 0, 10, 0])], pen({ compound: [0, 0.25, 0.75, 1] }));
		expect(bands).toHaveLength(2);
	});

	it('dashes along the line, dashing a closed figure from its last vertex', () => {
		const dashes = widenFigures([line([0, 0, 20, 0])], pen({ dash: [4, 4] }));
		expect(dashes).toHaveLength(3); // 0-4, 8-12, 16-20
		const closed = widenFigures([line([0, 0, 16, 0, 16, 16, 0, 16], true)], pen({ dash: [8, 8] }));
		// Perimeter 64 in 8 on, 8 off: four dashes; the first runs up the closing edge from (0, 16).
		expect(closed).toHaveLength(4);
		expect(round([closed[0]])[0].slice(0, 2)).toEqual([2, 16]);
	});

	it('shortens dashes with a round DashCap by a full width', () => {
		const [first] = widenFigures([line([0, 0, 40, 0])], pen({ dash: [12, 4], dashCap: 2 }));
		// Flat start at 0, the straight part ends at 12 - 4 = 8, the round cap reaches 10.
		expect(Math.max(...first.map((p) => p.x))).toBeCloseTo(10, 5);
	});

	it('puts an Inset pen wholly inside a closed figure', () => {
		const polys = widenFigures([line([0, 0, 10, 0, 10, 10, 0, 10], true)], pen({ inset: true }));
		for (const p of polys.flat()) {
			expect(p.x).toBeGreaterThanOrEqual(-1e-9);
			expect(p.x).toBeLessThanOrEqual(10 + 1e-9);
		}
	});
});
