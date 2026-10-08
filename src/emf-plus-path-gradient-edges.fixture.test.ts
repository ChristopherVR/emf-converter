import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pathGradientSampler } from './emf-plus-exact-fill';

/**
 * Pixels exactly on the edge of a nested copy of a uniform path gradient, one edge at a time
 * (`PathGradientEdgeProbe.cs`): 400 white-to-black rectangles from 2 x 2 to 40 x 40 pixels with the centre on a pixel
 * (`ri-`) and on a pixel centre (`rh-`), the same 400 drawn counter-clockwise (`c-`), eight sizes from each corner in
 * both windings (`o-`) and six sizes translated by whole and sixteenth pixels (`t-`). Each capture stores red and alpha.
 *
 * The rule that `emf-plus-path-gradient-copies.ts` implements was found on these (see docs/outstanding-work.md):
 * - Copy `q` of `N` has its edge on pixel (x, y) when the ratio of the pixel to the boundary is exactly `(2q + 1) / (2N)`.
 *   Native holds the ratio in binary fixed point, so the pixel is outside the copy when that fraction is a binary fraction
 *   (the odd part of `N` divides `2q + 1`) and inside when it is not, for a pixel that reads the exact coordinate of the
 *   edge (an x-major pixel on a vertical edge, a y-major pixel on a horizontal one): 0 of the ties of these captures differ.
 * - A pixel that reads the other coordinate goes through the position along the edge. On an edge directed to the right
 *   or straight down, the half before the centre's foot is inside unless that position is a binary fraction, the other
 *   half outside; on any other edge the first rule holds.
 * - Translation by whole pixels changes nothing, and neither does the starting vertex, only the winding.
 */
interface Capture {
	name: string;
	w: number;
	h: number;
	center: [number, number];
	points: [number, number][];
	ra: string;
}

const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/path-gradient-edges.json.gz', import.meta.url))).toString());

interface Totals { images: number; native: number; exact: number; naturalTies: number; naturalWrong: number; otherTies: number; otherWrong: number }

function measure(c: Capture, totals: Totals): void {
	const sampler = pathGradientSampler({
		boundary: c.points.map(([x, y]) => ({ x, y })),
		center: { x: c.center[0], y: c.center[1] },
		centerArgb: 0xffffffff,
		boundaryArgb: c.points.map(() => 0xff000000),
		focus: null,
		blend: null,
		preset: null,
		transform: null,
	}, 'clamp', [1, 0, 0, 1, 0, 0])!;
	const rgba = new Uint8ClampedArray(c.w * c.h * 4);
	sampler(0, 0, c.w, c.h, rgba);
	const native = Buffer.from(c.ra, 'base64');
	const xs = c.points.map((p) => p[0]);
	const ys = c.points.map((p) => p[1]);
	const w = Math.max(...xs) - Math.min(...xs);
	const h = Math.max(...ys) - Math.min(...ys);
	const steps = Math.ceil(2 * Math.hypot(w, h));
	totals.images++;
	for (let py = 0; py < c.h; py++) {
		for (let px = 0; px < c.w; px++) {
			const p = py * c.w + px;
			if (native[p * 2 + 1] === 0) continue;
			totals.native++;
			const right = rgba[p * 4 + 3] !== 0 && rgba[p * 4] === native[p * 2];
			if (right) totals.exact++;
			// Doubled distances from the centre, so half-pixel centres stay integral.
			const dx = Math.abs(px - c.center[0]) * 2;
			const dy = Math.abs(py - c.center[1]) * 2;
			// A tie on a vertical edge: dx / w * steps - 1/2 is a whole copy index; on a horizontal edge the same with dy and h.
			const onVertical = (2 * dx * steps - w) % (2 * w) === 0 && 2 * dx * steps - w >= 0 && dx * h >= dy * w;
			const onHorizontal = (2 * dy * steps - h) % (2 * h) === 0 && 2 * dy * steps - h >= 0 && dy * w >= dx * h;
			if (onVertical === onHorizontal) continue; // not a tie, or a tie on both edges at a corner
			const q = onVertical ? (2 * dx * steps - w) / (2 * w) : (2 * dy * steps - h) / (2 * h);
			if (q >= steps) continue;
			const natural = onVertical ? dx > dy : dy > dx;
			if (natural) {
				totals.naturalTies++;
				if (!right) totals.naturalWrong++;
			} else {
				totals.otherTies++;
				if (!right) totals.otherWrong++;
			}
		}
	}
}

const groups = new Map<string, Totals>();
for (const c of captures) {
	const key = c.name.split('-')[0];
	if (!groups.has(key)) groups.set(key, { images: 0, native: 0, exact: 0, naturalTies: 0, naturalWrong: 0, otherTies: 0, otherWrong: 0 });
	measure(c, groups.get(key)!);
}

/**
 * [images, native pixels, exact pixels (floor), pixels of the exact-coordinate rule, of those wrong (ceiling),
 * pixels of the along-the-edge rule, of those wrong (ceiling)]. Exact before the binary-fraction rule: ri 164,684, rh 158,192,
 * c 164,684, o 18,832, t 49,126 (the half-way colour of a tie is within a level of either answer); with that rule ri 176,222,
 * rh 176,008, c 176,222, o 24,944, t 58,472; every pixel of every capture is exact with the float32 rule of `floatCopyIndex`.
 */
const EXPECTED: Record<string, [number, number, number, number, number, number, number]> = {
	ri: [400, 176400, 176400, 8352, 0, 3080, 0],
	rh: [400, 176400, 176400, 12712, 0, 5168, 0],
	c: [400, 176400, 176400, 8352, 0, 3080, 0],
	o: [64, 25152, 25152, 4144, 0, 2144, 0],
	t: [180, 58980, 58980, 5312, 0, 4426, 0],
};

describe('pixels exactly on the edge of one nested copy', () => {
	it('covers every capture group', () => {
		expect([...groups.keys()].sort()).toEqual(Object.keys(EXPECTED).sort());
	});
	for (const [key, [images, native, exact, naturalTies, naturalWrong, otherTies, otherWrong]] of Object.entries(EXPECTED)) {
		it(`${key}: ${images} captures`, () => {
			const t = groups.get(key)!;
			expect(t.images).toBe(images);
			expect(t.native).toBe(native);
			expect(t.exact).toBeGreaterThanOrEqual(exact);
			expect(t.naturalTies).toBeGreaterThanOrEqual(naturalTies);
			expect(t.naturalWrong).toBeLessThanOrEqual(naturalWrong);
			expect(t.otherTies).toBeGreaterThanOrEqual(otherTies);
			expect(t.otherWrong).toBeLessThanOrEqual(otherWrong);
		});
	}
});
