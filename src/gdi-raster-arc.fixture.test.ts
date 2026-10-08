import { describe, expect, it } from 'vitest';
import nativeArcs from './__fixtures__/gdi/arc-paths.json';
import nativeArcsClockwise from './__fixtures__/gdi/arc-paths-cw.json';
import preciseArcs from './__fixtures__/gdi/arc-precise.json';
import angleArcPaths from './__fixtures__/gdi/angle-arc-paths.json';
import { angleArcFix, approximateArcAngle, axisBox, polygonTrig } from './gdi-raster';
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

interface NativeArc {
	kind: number;
	clockwise?: boolean;
	box: number[];
	radials: number[];
	expected: number[];
}

/** Our path and the native one for a capture, with the compatible-mode radials carried onto the drawn box, both without repeats. */
function compare(c: NativeArc, clockwise: boolean): { mine: number[]; expected: number[] } {
	const [l, t, r, b] = c.box.map((v) => v * 16);
	const box = axisBox(l, t, r - 16, b - 16);
	// The compatible-mode radials are measured on the box as given and carried onto the drawn one.
	const onBox = (x: number, r0: number, r1: number, b0: number, b1: number) =>
		(b0 + b1) / 2 + (r1 !== r0 ? ((x - (r0 + r1) / 2) * (b1 - b0)) / (r1 - r0) : x - (r0 + r1) / 2);
	const radial = (x: number, y: number): [number, number] => [onBox(x * 16, l, r, l, r - 16), onBox(y * 16, t, b, t, b - 16)];
	const kind = (['arc', 'chord', 'pie'] as const)[c.kind];
	const mine = dedupe(arcRasterPath(box, radial(c.radials[0], c.radials[1]), radial(c.radials[2], c.radials[3]), clockwise, kind).path.getPath.pts);
	const native: number[] = [];
	for (let i = 0; i < c.expected.length; i += 3) native.push(c.expected[i], c.expected[i + 1]);
	return { mine, expected: dedupe(native) };
}

/** Counts of captures that match exactly and the largest difference (FIX) seen over all of them. */
function score(arcs: NativeArc[], clockwise: (c: NativeArc) => boolean): { exact: number; largest: number } {
	let exact = 0;
	let largest = 0;
	for (const c of arcs) {
		const { mine, expected } = compare(c, clockwise(c));
		expect(mine).toHaveLength(expected.length);
		let worst = 0;
		for (let i = 0; i < expected.length; i++) {
			worst = Math.max(worst, Math.abs(expected[i] - mine[i]));
		}
		largest = Math.max(largest, worst);
		if (worst === 0) {
			exact++;
		}
	}
	return { exact, largest };
}

describe('native Arc, Chord and Pie paths (GM_COMPATIBLE)', () => {
	it('matches GetPath for the counter-clockwise captures: all 900 exact', () => {
		expect(nativeArcs).toHaveLength(900);
		const { exact, largest } = score(nativeArcs, () => false);
		// Measured: 900 exact (898 before the single-precision arc points; 662 before that, with 234 one FIX off and 4 up to 5 FIX off).
		expect(exact).toBeGreaterThanOrEqual(900);
		expect(largest).toBeLessThanOrEqual(1);
	});

	it('matches GetPath for the same captures under AD_CLOCKWISE: 898 of 900 exact, the rest one FIX off', () => {
		expect(nativeArcsClockwise).toHaveLength(900);
		const { exact, largest } = score(nativeArcsClockwise, () => true);
		expect(exact).toBeGreaterThanOrEqual(898);
		expect(largest).toBeLessThanOrEqual(1);
	});

	it('follows GetPath on a 40,000 px circle (3 millionths of the radius per FIX) to a few FIX', () => {
		const arcs = preciseArcs as NativeArc[];
		expect(arcs.length).toBeGreaterThanOrEqual(250);
		const { exact, largest } = score(arcs, (c) => c.clockwise === true);
		// Measured: 187 of 260 exact (182 before the single-precision arc points) and none more than 3 FIX off (the radials are whole pixels 8 million away).
		expect(exact).toBeGreaterThanOrEqual(187);
		expect(largest).toBeLessThanOrEqual(3);
	});
});

describe('the angle and trigonometry model behind GDI arcs', () => {
	it('approximates the arc tangent with 32 equal slope intervals per octant', () => {
		// Exact at the knots and on the axes, and always at most 80 microradians below the true angle in the first octant.
		expect(approximateArcAngle(1, 0)).toBe(0);
		expect(approximateArcAngle(0, 1)).toBeCloseTo(Math.PI / 2, 12);
		expect(approximateArcAngle(-1, 0)).toBeCloseTo(Math.PI, 12);
		expect(approximateArcAngle(0, -1)).toBeCloseTo((3 * Math.PI) / 2, 12);
		expect(approximateArcAngle(32, 12)).toBeCloseTo(Math.atan(12 / 32), 12);
		let worst = 0;
		for (let deg = 0; deg <= 45; deg += 0.05) {
			const a = (deg * Math.PI) / 180;
			worst = Math.max(worst, Math.abs(approximateArcAngle(Math.cos(a), Math.sin(a)) - a));
		}
		expect(worst).toBeLessThan(80e-6);
		expect(worst).toBeGreaterThan(70e-6);
		// Mirrored about the diagonal and into the other quadrants.
		expect(approximateArcAngle(0.3, 0.9)).toBeCloseTo(Math.PI / 2 - approximateArcAngle(0.9, 0.3), 12);
		expect(approximateArcAngle(-0.5, 0.2)).toBeCloseTo(Math.PI - approximateArcAngle(0.5, 0.2), 12);
	});

	it('puts the points on a regular 128-gon, linear in the angle, from a single-precision table', () => {
		const [c0, s0] = polygonTrig((2 * Math.PI * 5) / 128);
		// The nodes are float32 (the arc points of 3,581 captures need that: 972 start points of sample 206's neighbourhood sat on a tie).
		expect(c0).toBeCloseTo(Math.cos((2 * Math.PI * 5) / 128), 7);
		expect(s0).toBeCloseTo(Math.sin((2 * Math.PI * 5) / 128), 7);
		// Half way between two vertices the point is on the chord: inside the circle by 1 - cos(pi / 128).
		const [cm, sm] = polygonTrig((2 * Math.PI * 5.5) / 128);
		expect(Math.hypot(cm, sm)).toBeCloseTo(Math.cos(Math.PI / 128), 7);
		// Whole quarter turns are exact.
		expect(polygonTrig(Math.PI / 2)).toEqual([0, 1]);
		expect(polygonTrig(Math.PI)).toEqual([-1, 0]);
	});
});

describe('native AngleArc paths', () => {
	it('matches GetPath for 600 AngleArcs of every sweep: all but one exact, that one a FIX off', () => {
		const arcs = angleArcPaths as Array<{ x: number; y: number; radius: number; start: number; sweep: number; expected: number[] }>;
		expect(arcs).toHaveLength(600);
		let exact = 0;
		let largest = 0;
		for (const c of arcs) {
			const box = axisBox((c.x - c.radius) * 16, (c.y - c.radius) * 16, (c.x + c.radius) * 16, (c.y + c.radius) * 16);
			const mine = angleArcFix(box, c.start, c.sweep);
			// The path starts with a move to the current position (0, 0), then the line to the arc's start point.
			const native: number[] = [];
			for (let i = 3; i < c.expected.length; i += 3) {
				native.push(c.expected[i], c.expected[i + 1]);
			}
			expect(mine).toHaveLength(native.length);
			let worst = 0;
			for (let i = 0; i < native.length; i++) {
				worst = Math.max(worst, Math.abs(mine[i] - native[i]));
			}
			largest = Math.max(largest, worst);
			if (worst === 0) {
				exact++;
			}
		}
		// Measured: 599 exact (before: 71, with 86 having a different number of Beziers and 112 more than a FIX off).
		expect(exact).toBeGreaterThanOrEqual(598);
		expect(largest).toBeLessThanOrEqual(1);
	});
});
