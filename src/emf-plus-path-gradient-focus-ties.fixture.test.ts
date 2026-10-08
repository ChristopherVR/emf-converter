import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pathGradientSampler } from './emf-plus-exact-fill';

/**
 * Pixels exactly on a copy's edge under an isotropic focus. Native finds them in float32 with the focus applied in ABSOLUTE
 * device coordinates (`focusCopyIndex` in `emf-plus-path-gradient-copies.ts`): the boundary point and the point where the
 * ray meets the focus polygon are positions on the pixel grid, rounded toward minus infinity, and the copy is
 * `floor(N t + 1/2)` with `t = (P - I) / (O - I)`. That decides which side a tie falls on at the right/bottom of the centre
 * and at the left/top, and for a focus that is not a binary fraction it makes the answer depend on the mantissa of the
 * boundary distance.
 *
 * Four native captures (all white to black, red and alpha only):
 * - `path-gradient-focus-edges.json.gz` (`PathGradientFocusEdgeProbe.cs`): the 400 even-sized rectangles of
 *   `path-gradient-edges` at the foci 0.25, 0.5, 0.75 (exact in float32) and 0.1, 0.3, 0.6 (not): 1,058,400 pixels. Before the
 *   absolute-coordinate chain 6,212 of them were wrong (52, 156, 72, 392, 484 and 5,056 per focus; the pixels on an axis and
 *   those whose larger boundary coordinate is the edge's own, 294 + 3,702 at 0.6, are now all exact but 7).
 * - `path-gradient-focus-thresholds.json.gz` (`PathGradientFocusThresholdProbe.cs`): eight rectangles painted with the focus at
 *   every float32 neighbour (+-8 ulps) of 0.6, 0.3, 0.1, 0.7, 0.2 and 0.4, so the f at which a tie flips can be read per pixel:
 *   the axis pixels of all 130,152 are exact, which fixes the chain (every candidate that rounds the focus point to nearest or
 *   computes it relative to the centre misses 210 or more).
 * - `path-gradient-focus-corners.json.gz` (`PathGradientFocusCornerProbe.cs`): the corner triangle of `path-gradient-corners` with
 *   an isotropic focus at six values (a slanted edge of 65 slopes, 12,091 pixels per focus; 600 wrong before) and with eight
 *   pairs of independent scales (the strip solver, open: counts pinned as floors).
 * - `path-gradient-focus-slants.json.gz` (`PathGradientFocusSlantProbe.cs`): the same triangle at 16 slopes with the focus at
 *   every float32 neighbour of 0.5, 0.6 and 0.3, the data for the slanted ties still open (see docs/outstanding-work.md).
 */
interface Capture {
	name: string;
	w: number;
	h: number;
	focus: number | [number, number];
	center: [number, number];
	points: [number, number][];
	ra: string;
}

function load(name: string): Capture[] {
	return JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${name}`, import.meta.url))).toString());
}

interface Totals { captures: number; native: number; exact: number; unpainted: number; axisWrong: number }

function measure(c: Capture, totals: Totals): void {
	const focus = Array.isArray(c.focus) ? c.focus : [c.focus, c.focus];
	const sampler = pathGradientSampler({
		boundary: c.points.map(([x, y]) => ({ x, y })),
		center: { x: c.center[0], y: c.center[1] },
		centerArgb: 0xffffffff,
		boundaryArgb: c.points.map(() => 0xff000000),
		focus: { x: focus[0], y: focus[1] },
		blend: null,
		preset: null,
		transform: null,
	}, 'clamp', [1, 0, 0, 1, 0, 0])!;
	const rgba = new Uint8ClampedArray(c.w * c.h * 4);
	sampler(0, 0, c.w, c.h, rgba);
	const native = Buffer.from(c.ra, 'base64');
	totals.captures++;
	for (let p = 0; p < c.w * c.h; p++) {
		if (native[p * 2 + 1] === 0) continue;
		totals.native++;
		if (rgba[p * 4 + 3] === 0) { totals.unpainted++; continue; }
		if (rgba[p * 4] === native[p * 2]) totals.exact++;
		else if (p % c.w === Math.round(c.center[0]) || Math.floor(p / c.w) === Math.round(c.center[1])) totals.axisWrong++;
	}
}

function group(captures: Capture[], keyOf: (c: Capture) => string): Map<string, Totals> {
	const groups = new Map<string, Totals>();
	for (const c of captures) {
		const key = keyOf(c);
		if (!groups.has(key)) groups.set(key, { captures: 0, native: 0, exact: 0, unpainted: 0, axisWrong: 0 });
		measure(c, groups.get(key)!);
	}
	return groups;
}

/** [captures, native pixels, exact pixels (floor), unpainted pixels (ceiling), wrong pixels on an axis through the centre (ceiling)]. */
type Expected = Record<string, [number, number, number, number, number]>;

function check(groups: Map<string, Totals>, expected: Expected): void {
	expect([...groups.keys()].sort()).toEqual(Object.keys(expected).sort());
	for (const [key, [captures, native, exact, unpainted, axisWrong]] of Object.entries(expected)) {
		const t = groups.get(key)!;
		expect(t.captures, key).toBe(captures);
		expect(t.native, key).toBe(native);
		expect(t.exact, key).toBeGreaterThanOrEqual(exact);
		expect(t.unpainted, key).toBeLessThanOrEqual(unpainted);
		expect(t.axisWrong, key).toBeLessThanOrEqual(axisWrong);
	}
}

describe('pixels on a copy edge under an isotropic focus', () => {
	it('reproduces the rectangle edges at six foci (focus-edges)', () => {
		check(group(load('path-gradient-focus-edges.json.gz'), (c) => `f${c.focus}`), {
			'f0.25': [400, 176400, 176364, 0, 0],
			'f0.5': [400, 176400, 176357, 0, 0],
			'f0.75': [400, 176400, 176350, 0, 0],
			'f0.1': [400, 176400, 176349, 0, 0],
			'f0.3': [400, 176400, 176367, 0, 0],
			'f0.6': [400, 176400, 175832, 0, 0],
		});
	});

	it('reproduces the float32 neighbours of six foci on the axes (focus-thresholds)', () => {
		check(group(load('path-gradient-focus-thresholds.json.gz'), (c) => `t${/^t([0-9.]+)-/.exec(c.name)![1]}`), {
			't0.6': [136, 21692, 21665, 0, 0],
			't0.3': [136, 21692, 21692, 0, 0],
			't0.1': [136, 21692, 21692, 0, 0],
			't0.7': [136, 21692, 21692, 0, 0],
			't0.2': [136, 21692, 21547, 0, 0],
			't0.4': [136, 21692, 21618, 0, 0],
		});
	});

	it('reproduces the corner triangle at six foci and pins the independent scales (focus-corners)', () => {
		check(group(load('path-gradient-focus-corners.json.gz'), (c) => /^[a-z][0-9._]+/.exec(c.name)![0]), {
			'i0.25': [130, 12091, 12081, 0, 0],
			'i0.5': [130, 12091, 12045, 0, 3],
			'i0.75': [130, 12091, 12079, 0, 0],
			'i0.1': [130, 12092, 12082, 1, 0],
			'i0.3': [130, 12092, 12065, 1, 1],
			'i0.6': [130, 12092, 12068, 1, 7],
			'a0.5_0.25': [130, 15041, 13892, 0, 14],
			'a0.25_0.5': [130, 12127, 9125, 0, 16],
			'a0.75_0.25': [130, 18145, 15937, 0, 15],
			'a0.3_0.6': [130, 12143, 8602, 0, 24],
			'a0.5_0': [130, 18401, 15213, 424, 82],
			'a0_0.5': [130, 12195, 6208, 0, 893],
			'a1_0.5': [130, 18135, 16949, 0, 15],
			'a0.5_1': [130, 12896, 7244, 0, 3],
		});
	});

	it('pins the slanted-edge ties still open (focus-slants)', () => {
		check(group(load('path-gradient-focus-slants.json.gz'), (c) => /^s[0-9.]+/.exec(c.name)![0]), {
			's0.5': [578, 34496, 34206, 20, 18],
			's0.6': [578, 34484, 34335, 8, 1],
			's0.3': [578, 34490, 34312, 14, 0],
		});
	});
});
