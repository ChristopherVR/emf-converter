import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pathGradientSampler } from './emf-plus-exact-fill';

/**
 * Independent FocusScales on small squares and rectangles (`PathGradientFocusSmallProbe.cs`: 12 x 12 to 32 x 16, nine
 * scale pairs, centred (`sq-`) and with the centre off the middle (`off-`), white to black with a few dozen steps so
 * that one step is five to six levels). Each copy is the boundary scaled per axis about the centre point
 * (`f + (1 - f) (m + 1/2) / N` on each axis; the off-centre captures rule out scaling about the middle or a corner of the
 * focus rectangle), and the pixels on a vertical or horizontal edge of a copy follow the rules measured for the uniform
 * copies (`emf-plus-path-gradient-copies.ts`). A pixel on a slanted edge keeps the half-way colour. 16,161 and 16,894 of
 * the 16,992 pixels of each group were exact before those rules (the half-way colour of a tie is three levels off).
 */
interface Capture {
	name: string;
	w: number;
	h: number;
	focus: [number, number];
	center: [number, number];
	points: [number, number][];
	ra: string;
}

const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/path-gradient-focus-small.json.gz', import.meta.url))).toString());

interface Totals { images: number; native: number; exact: number; unpainted: number; max: number }

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
	const native = Buffer.from(c.ra, 'base64');
	totals.images++;
	for (let p = 0; p < c.w * c.h; p++) {
		if (native[p * 2 + 1] === 0) continue;
		totals.native++;
		if (rgba[p * 4 + 3] === 0) { totals.unpainted++; continue; }
		const d = Math.abs(rgba[p * 4] - native[p * 2]);
		if (d === 0) totals.exact++;
		totals.max = Math.max(totals.max, d);
	}
}

const groups = new Map<string, Totals>();
for (const c of captures) {
	const key = c.name.split('-')[0];
	if (!groups.has(key)) groups.set(key, { images: 0, native: 0, exact: 0, unpainted: 0, max: 0 });
	measure(c, groups.get(key)!);
}

/** [images, native pixels, exact pixels (floor), unpainted ceiling, max error ceiling]. */
const EXPECTED: Record<string, [number, number, number, number, number]> = {
	sq: [54, 16992, 16956, 0, 6],
	off: [54, 16992, 16989, 0, 6],
};

describe('independent focus scales on small shapes', () => {
	it('covers every group', () => {
		expect([...groups.keys()].sort()).toEqual(Object.keys(EXPECTED).sort());
	});
	for (const [key, [images, native, exact, unpainted, max]] of Object.entries(EXPECTED)) {
		it(`${key}: ${images} captures`, () => {
			const t = groups.get(key)!;
			expect(t.images).toBe(images);
			expect(t.native).toBe(native);
			expect(t.exact).toBeGreaterThanOrEqual(exact);
			expect(t.unpainted).toBeLessThanOrEqual(unpainted);
			expect(t.max).toBeLessThanOrEqual(max);
		});
	}
});
