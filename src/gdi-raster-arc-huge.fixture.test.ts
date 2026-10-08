/**
 * Native `GetPath` of 720 Arcs on boxes of 2^20, 2^22 and 2^24 pixels (`arc-huge-probe`, `arc-huge.json.gz`; round 6): a FIX is
 * 1e-7 to 1e-9 of the radius, so the control points expose the single precision unit vectors of an arc that `arc-small.json.gz`
 * (radii of 100,000 to 400,000 FIX) hid under the integer grid. Sweeps 0.05 to 3 degrees, 40 starts per sweep (a fifth on the 0
 * axis, half of them clockwise), box sizes 2^20, 2^22 and 2^24 pixels, radials 8 million pixels away.
 *
 * What the capture shows:
 *
 *  - A clockwise arc whose start radial is on the 0 axis ends at 359.x degrees as angles in [0, 2 pi), and Windows takes it for the
 *    small arc it is (a sweep of 0.05 to 3 degrees clockwise from 0). The converter compared the two angles, took the 359 degrees
 *    between them for a large arc and built it with the 128-gon polygon trigonometry (a control point 353,943 FIX off at 2^22
 *    pixels). A clockwise arc is the y mirror image of a counter-clockwise one, so its radials are compared as mirrored angles
 *    (0 stays 0); a counter-clockwise arc from 0 to 359 degrees is a large one, and so is one whose radials are on either side of
 *    the axis (`arc-precise.json`, 900 and 900 arcs: unchanged).
 *  - Coordinates are single precision: above 2^26 FIX the native points are multiples of 8, above 2^27 of 16 (the centre plus the
 *    float32 product of radius and unit coordinate, summed in single precision). Below about 2^20 FIX the sum is exact: the
 *    nearest FIX of the exact sum fits all 52 axis-aligned small arcs, a float32 sum rounded half up 51 and half down 48
 *    (399964.515625 goes up and 399915.484375 down, where the float32 sum of both is x.5). On these boxes the float32 sum floored
 *    fits 48, 36 and 44 of the 48 axis-aligned end points at 2^20, 2^22 and 2^24 pixels and the exact sum rounded to nearest 48,
 *    12 and 0: no one rule covers both radii, so the model keeps the exact sum and the large boxes stay inexact.
 *  - The control points of an off-axis arc carry the rounding of two unit vectors, not an error of the radial angle: the angle
 *    model agrees with the native end points to 3e-7 radians (rms 2.6e-7 at 2^22 and 3.8e-7 at 2^24 pixels, no better than the
 *    quantisation of the float32 product), and the shared offset of the two controls (tangent-line intersection) is 40 to 740
 *    units of 1e-7 at 0.05 degrees, which is `ulp / sin(sweep)` of single precision unit vectors that the float32 candidates of
 *    `gdi-raster-arc-small.fixture.test.ts` do not reproduce. See docs/outstanding-work.md.
 *
 * Counts below are the arcs whose four points (both directions) are all exact.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { arcRasterPath } from './emf-gdi-raster-shapes';
import { axisBox } from './gdi-raster';

interface HugeArc {
	clockwise: boolean;
	size: number;
	sweep: number;
	box: number[];
	radials: number[];
	expected: number[];
}
const arcs: HugeArc[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/arc-huge.json.gz', import.meta.url))).toString());

function exact(c: HugeArc): boolean {
	const [l, t, r, b] = c.box.map((v) => v * 16);
	const box = axisBox(l, t, r - 16, b - 16);
	const onBox = (x: number, r0: number, r1: number, b0: number, b1: number) => (b0 + b1) / 2 + (r1 !== r0 ? ((x - (r0 + r1) / 2) * (b1 - b0)) / (r1 - r0) : x - (r0 + r1) / 2);
	const radial = (x: number, y: number): [number, number] => [onBox(x * 16, l, r, l, r - 16), onBox(y * 16, t, b, t, b - 16)];
	const mine = arcRasterPath(box, radial(c.radials[0], c.radials[1]), radial(c.radials[2], c.radials[3]), c.clockwise, 'arc').path.getPath.pts;
	for (let i = 0; i < 8; i++) if (mine[i] !== c.expected[(i >> 1) * 3 + (i & 1)]) return false;
	return true;
}

describe('native Arc paths on boxes of 2^20 to 2^24 pixels', () => {
	it('captures 720 arcs: 3 sizes x 6 sweeps x 40 starts', () => {
		expect(arcs).toHaveLength(720);
	});

	it('matches 42 of the 240 arcs on the 2^20 box and none above it (single precision coordinates are not modelled)', () => {
		const bySize: Record<number, number> = {};
		for (const c of arcs) {
			bySize[Math.log2(c.size)] = (bySize[Math.log2(c.size)] ?? 0) + (exact(c) ? 1 : 0);
		}
		// Before the clockwise small arc rule: 22 on the 2^20 box.
		expect(bySize).toEqual({ 20: 42, 22: 0, 24: 0 });
	});

	it('draws a clockwise arc from the 0 axis as the 3 degree arc it is', () => {
		// Starts 5, 15, 25 and 35 of each 40 are clockwise from the 0 axis: the second control sits within a sweep's chord of the
		// first and the end point within the radius times the sweep of the start (the 359 degree reading put it a quarter turn away).
		let near = 0;
		let total = 0;
		for (const [i, c] of arcs.entries()) {
			if (!c.clockwise || (i % 40) % 5 !== 0) continue;
			total++;
			const mine = (() => {
				const [l, t, r, b] = c.box.map((v) => v * 16);
				const box = axisBox(l, t, r - 16, b - 16);
				const onBox = (x: number, r0: number, r1: number, b0: number, b1: number) => (b0 + b1) / 2 + (r1 !== r0 ? ((x - (r0 + r1) / 2) * (b1 - b0)) / (r1 - r0) : x - (r0 + r1) / 2);
				const radial = (x: number, y: number): [number, number] => [onBox(x * 16, l, r, l, r - 16), onBox(y * 16, t, b, t, b - 16)];
				return arcRasterPath(box, radial(c.radials[0], c.radials[1]), radial(c.radials[2], c.radials[3]), c.clockwise, 'arc').path.getPath.pts;
			})();
			const radius = c.size * 8;
			const chord = Math.hypot(mine[6] - mine[0], mine[7] - mine[1]);
			if (chord < radius * ((c.sweep * Math.PI) / 180) * 1.01) near++;
		}
		expect({ near, total }).toEqual({ near: 72, total: 72 });
	});
});
