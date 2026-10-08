import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pathGradientSampler } from './emf-plus-exact-fill';

/**
 * Pixels exactly on the edge of a nested copy of a uniform path gradient (`PathGradientTieProbe.cs`: integer-sized
 * rectangles and diamonds centred on a pixel, so a copy at half scale has an edge on a pixel row, column or
 * diagonal). Native decides them by float arithmetic that is not reproduced: a rectangle's top-edge tie row is
 * inside the copy for a short run of columns near the left end and outside for the rest at half scale and mostly
 * inside at scales 0.1, 0.3, 0.7 and 0.9; the same ties on the bottom edge are outside at half scale; the 45-degree edge
 * of a diamond is inside for the first 14 pixels from the top vertex on one side and outside for the next 16, and
 * irregular on the other three. The sampler gives such a pixel the colour half way between the two steps, so
 * all but 142 of the 61,924 pixels are within a level (none beyond two) and the exact count is what a rule would add.
 */
interface Capture {
	name: string;
	w: number;
	h: number;
	center: [number, number];
	points: [number, number][];
	bgra: string;
}

const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/path-gradient-ties.json.gz', import.meta.url))).toString());

interface Totals { images: number; native: number; exact: number; withinOne: number; unpainted: number; max: number }

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
	rect: [14, 46868, 46082, 46758, 0, 2],
	diamond: [7, 15056, 14804, 15024, 0, 2],
};

describe('pixels exactly on a copy edge', () => {
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
