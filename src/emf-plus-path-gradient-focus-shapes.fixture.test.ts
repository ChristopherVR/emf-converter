import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pathGradientSampler } from './emf-plus-exact-fill';

/**
 * A uniform path gradient with independent FocusScales is `N` nested copies whose vertices
 * sit on the line from the focus polygon to the boundary: copy `m` scales the boundary about
 * the centre by `f + (1 - f) (m + 1/2) / N` on each axis (`f` the scale of that axis), so the
 * horizontal and vertical extents move at different rates. `PathGradientFocusShapeProbe.cs`
 * captured a rectangle, an off-centre rectangle, a diamond and a triangle at ten scale pairs
 * each and 40 random triangles and quads (`path-gradient-focus-shapes.json.gz`).
 */
interface Capture {
	name: string;
	w: number;
	h: number;
	focus: [number, number];
	center: [number, number];
	points: [number, number][];
	bgra: string;
}

const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/path-gradient-focus-shapes.json.gz', import.meta.url))).toString());

interface Totals { images: number; native: number; exact: number; withinOne: number; unpainted: number; max: number }

function measure(c: Capture, totals: Totals): void {
	const sampler = pathGradientSampler({
		boundary: c.points.map(([x, y]) => ({ x, y })),
		center: { x: c.center[0], y: c.center[1] },
		centerArgb: 0xffffffff,
		boundaryArgb: c.points.map(() => 0xff000000),
		focus: { x: c.focus[0], y: c.focus[1] },
		blend: null,
		preset: null,
		transform: null,
	}, 'clamp', [1, 0, 0, 1, 0, 0])!;
	const rgba = new Uint8ClampedArray(c.w * c.h * 4);
	sampler(0, 0, c.w, c.h, rgba);
	const native = Buffer.from(c.bgra, 'base64');
	totals.images++;
	for (let p = 0; p < c.w * c.h; p++) {
		const k = p * 4;
		if (native[k + 3] === 0) continue;
		totals.native++;
		if (rgba[k + 3] === 0) { totals.unpainted++; continue; }
		const d = Math.abs(rgba[k] - native[k + 2]);
		if (d === 0) totals.exact++;
		if (d <= 1) totals.withinOne++;
		totals.max = Math.max(totals.max, d);
	}
}

const groups = new Map<string, Totals>();
for (const c of captures) {
	const key = /^[a-z]+/.exec(c.name)![0];
	if (!groups.has(key)) groups.set(key, { images: 0, native: 0, exact: 0, withinOne: 0, unpainted: 0, max: 0 });
	measure(c, groups.get(key)!);
}

/** [images, native pixels, exact pixels (floor), pixels within one level (floor), unpainted ceiling, max error ceiling]. */
const EXPECTED: Record<string, [number, number, number, number, number, number]> = {
	// Exact: the pixels of a fully focused axis (focus 1) on the shape's edge are ties of every copy at once and the span
	// rule of the scan converter decides them (49,966 and 49,964 exact before).
	rect: [10, 50000, 50000, 50000, 0, 0],
	rectoff: [10, 50000, 50000, 50000, 0, 0],
	// Not exact: the half-way colour of ties on a slanted copy edge, within a level (31,661 exact before; the pixels only
	// near an edge, and those on a vertical or horizontal edge, follow the scaled copy's own span rule).
	diamond: [10, 32000, 31689, 32000, 0, 1],
	// Beyond a level: 26 pixels where the strip solver's colour and native's differ by more than a step (not diagnosed
	// further; 37,409 exact before).
	tri: [10, 37556, 37413, 37530, 0, 242],
	// Beyond a level or unpainted: 80 more of the same kind (72 of them unpainted); 56,220 exact before.
	rnd: [40, 56654, 56254, 56574, 72, 246],
};

describe('independent focus scales as nested copies', () => {
	it('covers every shape group', () => {
		expect([...groups.keys()].sort()).toEqual(Object.keys(EXPECTED).sort());
	});
	for (const [key, [images, native, exact, withinOne, unpainted, max]] of Object.entries(EXPECTED)) {
		it(`${key}: ${images} captures`, () => {
			const t = groups.get(key)!;
			expect(t.images).toBe(images);
			expect(t.native).toBe(native);
			expect(t.exact).toBeGreaterThanOrEqual(exact);
			expect(t.withinOne).toBeGreaterThanOrEqual(withinOne);
			expect(t.unpainted).toBeLessThanOrEqual(unpainted);
			expect(t.max).toBeLessThanOrEqual(max);
		});
	}
});
