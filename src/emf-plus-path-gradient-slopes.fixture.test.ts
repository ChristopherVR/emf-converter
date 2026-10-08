import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pathGradientSampler } from './emf-plus-exact-fill';

/**
 * One copy edge at every slope (`PathGradientSlopeProbe.cs`, `path-gradient-slopes.json.gz`: white-to-black parallelograms,
 * a rectangle of 6 to 26 by 12 or 16 pixels sheared by every multiple of 1/2 pixel over its height, leaning either way) and
 * a single fan triangle with the centre on a vertex (`PathGradientCornerProbe.cs`, `path-gradient-corners.json.gz`: the opposite
 * edge takes every slope in steps of 3/8 pixel, four heights, five widths). Together they put 18,372 pixels exactly on the
 * edge of a nested copy (4,374 on slanted edges) that the earlier single-edge sweeps never reached.
 *
 * Every pixel of both sets is reproduced (the corner captures leave the centre pixel and the pixels on the two edges through
 * the centre unpainted, as native does). The rule is the float32 evaluation of `floatCopyIndex`: the ray from the centre
 * through the pixel meets the edge at `u = (ay dx - ax dy) / (ex dy - ey dx)`, the boundary point is `a + u e` and the ratio
 * is the pixel's distance over the boundary point's along the boundary point's larger coordinate, every operation rounded
 * toward minus infinity. A tie pixel is inside the copy `q` when `floor(N r + 1/2) <= q`. Before it, the slopes had 2,356
 * differing pixels (1,972 of them undecided ties) and the corner captures 3,182 (extra pixels on the edges through the centre
 * 1,325).
 */
interface Capture { name: string; w: number; h: number; center: [number, number]; points: [number, number][]; ra: string }

function measure(file: string): { captures: number; native: number; differ: number; unpainted: number; extra: number } {
	const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${file}`, import.meta.url))).toString());
	const totals = { captures: captures.length, native: 0, differ: 0, unpainted: 0, extra: 0 };
	for (const c of captures) {
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
		for (let p = 0; p < c.w * c.h; p++) {
			const na = native[p * 2 + 1];
			const oa = rgba[p * 4 + 3];
			if (na === 0 && oa === 0) continue;
			if (na === 0) { totals.extra++; continue; }
			totals.native++;
			if (oa === 0) totals.unpainted++;
			else if (rgba[p * 4] !== native[p * 2]) totals.differ++;
		}
	}
	return totals;
}

describe('copy edges of every slope', () => {
	it('reproduces every pixel of the sheared rectangles', () => {
		expect(measure('path-gradient-slopes.json.gz')).toEqual({ captures: 684, native: 156288, differ: 0, unpainted: 0, extra: 0 });
	});
	it('reproduces every pixel of the corner triangles', () => {
		expect(measure('path-gradient-corners.json.gz')).toEqual({ captures: 1720, native: 248716, differ: 0, unpainted: 0, extra: 0 });
	});
});
