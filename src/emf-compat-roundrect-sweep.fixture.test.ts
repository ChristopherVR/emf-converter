/**
 * The corner extents of a RoundRect played back in `GM_COMPATIBLE` under maps that scale one axis or both
 * (`compat-roundrect-sweep-probe`, `CompatPlaybackProbe.RoundRectSweep`, `compat-roundrect-sweep.json.gz`): native `GetPath` of 2,560
 * RoundRects per map, axis and arc direction (10 box offsets, 16 box extents of 20 to 35 units, 16 corner extents of 1 to 16 units, a
 * cosmetic pen), for the scales 3/4, 4/3, 7/10, 10/7, 3/5, 3/2 and 5/3 viewport over window. Each record holds the call and the eight
 * corner end points of the path.
 *
 * What the captures decided (and the rule they did not):
 *  - The edges are `round(exact)` in 28.4 for every record (the two edges of the swept axis, all 71,680 records of the one-axis sweeps).
 *  - Dyadic scales (3/4, 3/2) give `hx`, `hy` = `round(E / 2)` of the exact corner extent `E` in every record.
 *  - A non-dyadic scale does not: `R - round(E / 2)` fits 89% to 92% of the corners (`E` the exact extent, `R` the rounded far edge;
 *    the converter's integer rule 73% to 86%) and no combination of the rounded edges, `floor`, `round` or `ceil` of `E`,
 *    `H / 2 - (H - E) / 2` forms, float32 arithmetic or fixed point precision of 1 to 20 fractional bits fits more (well over a hundred
 *    forms scored, none above 93%). Used for the unmirrored `compat-playback` RoundRects it lowers `geosq9` from 14 pixels to 0, `r34-null`
 *    and `r107-cosmetic` from 2 to 0, `r32x11-cosmetic` and `r34-geo5` from 1 to 0 and `r107-wide7` from 3 to 2, but raises `r107-geo5` from 0 to 9, `r34-cosmetic` from 0 to 2 and `r34-dash`
 *    from 1 to 14 (the dash phase follows the start point), so it is not shipped.
 *  - The half extent is a deterministic function of the scale and of the rounded box extent `H` and `floor(E)` (no group of equal
 *    `(H, floor(E))` holds two values), so a closed rule exists; it is not `H` alone and not the fractions of the edges alone.
 *  - Scaling the other axis as well changes none of the 2,560 `hx` of any map (the corner is decided per axis).
 *
 * Pinned below: the converter's RoundRect corners (`roundRectCorners`, the integer rule the shapes test pins) against the sweep, per
 * scale, as a ceiling that a better rule must lower. The four wide RoundRects of `compat-playback-r34-geosq9` are widened exactly by
 * `widenPath` once given native's own path, which locates that sheet's 14 pixels in the corner extents (`hy` 85 against our 86)
 * and not in the pen's round-join arcs.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { GdiRasterPath, roundRectCorners } from './gdi-raster';
import { widenPath } from './gdi-raster-widen';

interface Sweep {
	window: number;
	viewport: number;
	axis: number;
	dir: number;
	records: number[][];
}

const sweeps: Sweep[] = JSON.parse(gunzipSync(readFileSync(fixturePath('compat-roundrect-sweep.json.gz'))).toString());

function floorDiv(n: number, d: number): number {
	const q = Math.trunc(n / d);
	return n % d !== 0 && n < 0 !== d < 0 ? q - 1 : q;
}
const roundDiv = (n: number, d: number): number => floorDiv(2 * n + d, 2 * d);

/** The record's far and near edge, corner extent and native half extent along the swept axis. */
function measure(s: Sweep, r: number[]): { near: number; far: number; corner: number; half: number; exactCorner: number } {
	const axis = s.axis === 1 ? 1 : 0;
	const a0 = axis === 1 ? r[2] : r[1];
	const a1 = axis === 1 ? r[4] : r[3];
	const c = axis === 1 ? r[6] : r[5];
	const e = r.slice(7, 23);
	return {
		near: roundDiv(16 * a0 * s.viewport, s.window),
		far: roundDiv(16 * a1 * s.viewport, s.window),
		corner: c,
		half: axis === 1 ? Math.abs(e[1] - e[3]) : Math.abs(e[0] - e[2]),
		exactCorner: (16 * c * s.viewport) / s.window,
	};
}

describe('RoundRect corner extents against native GetPath under scaled maps', () => {
	it('holds 42 sweeps of 2,560 records (7 scales, 3 axis settings, 2 directions)', () => {
		expect(sweeps).toHaveLength(42);
		expect(sweeps.every((s) => s.records.length === 2560)).toBe(true);
	});

	it('puts every edge at round(exact)', () => {
		let wrong = 0;
		for (const s of sweeps.filter((x) => x.axis !== 2)) {
			for (const r of s.records) {
				const m = measure(s, r);
				const e = r.slice(7, 23);
				// The box edges: end points 0 and 3 give the far edge on x or the near edge on y; the bottom end point gives the other.
				const lo = s.axis === 1 ? Math.min(e[1], e[3], e[9], e[11]) : Math.min(e[0], e[2], e[8], e[10]);
				const hi = s.axis === 1 ? Math.max(e[1], e[3], e[9], e[11]) : Math.max(e[0], e[2], e[8], e[10]);
				if (lo !== m.near || hi !== m.far) wrong++;
			}
		}
		expect(wrong).toBe(0);
	});

	it('gives round(E / 2) for the dyadic scales', () => {
		let wrong = 0;
		for (const s of sweeps.filter((x) => x.axis !== 2 && (x.viewport * 4 === x.window * 3 || x.viewport * 2 === x.window * 3))) {
			for (const r of s.records) {
				const m = measure(s, r);
				if (m.half !== Math.floor(m.exactCorner / 2 + 0.5)) wrong++;
			}
		}
		expect(wrong).toBe(0);
	});

	it('makes the half extent a function of the scale, the rounded box extent and floor(E)', () => {
		let conflicts = 0;
		for (const s of sweeps.filter((x) => x.axis !== 2)) {
			const seen = new Map<string, number>();
			for (const r of s.records) {
				const m = measure(s, r);
				const key = `${m.far - m.near},${Math.floor(m.exactCorner)}`;
				const prior = seen.get(key);
				if (prior !== undefined && prior !== m.half) conflicts++;
				seen.set(key, m.half);
			}
		}
		expect(conflicts).toBe(0);
	});

	it('is the same for hx with the y axis scaled as well', () => {
		let differing = 0;
		for (const both of sweeps.filter((x) => x.axis === 2)) {
			const only = sweeps.find((x) => x.axis === 0 && x.window === both.window && x.viewport === both.viewport && x.dir === both.dir)!;
			both.records.forEach((r, i) => {
				if (Math.abs(r[7] - r[9]) !== Math.abs(only.records[i][7] - only.records[i][9])) differing++;
			});
		}
		expect(differing).toBe(0);
	});

	it('pins where the converter integer rule differs from native, per scale (a ceiling)', () => {
		const wrong: Record<string, number> = {};
		for (const s of sweeps.filter((x) => x.axis !== 2)) {
			let n = 0;
			for (const r of s.records) {
				const m = measure(s, r);
				const h = m.far - m.near;
				const E = Math.min(Math.round(m.exactCorner), h);
				// A box of the swept extent on both axes: only the swept axis' half extent is read back.
				const q = roundRectCorners(0, 0, h, h, E, E, false, s.dir === 2 && s.axis === 1);
				// q[1] is hy (top-right corner start y = t + hy) and q[6] is topX, so hx = r - q[6].
				const got = s.axis === 1 ? q[1] : h - q[6];
				if (got !== m.half) n++;
			}
			wrong[`${s.axis === 1 ? 'y' : 'x'} ${s.viewport}/${s.window} dir ${s.dir}`] = n;
		}
		expect(wrong).toEqual(expectedWrong);
	});
});

/** Records of 2,560 that the converter's integer rule gets wrong; the dyadic scales are exact. */
const expectedWrong: Record<string, number> = {
	'x 10/7 dir 1': 602,
	'x 10/7 dir 2': 602,
	'x 3/2 dir 1': 0,
	'x 3/2 dir 2': 0,
	'x 3/4 dir 1': 0,
	'x 3/4 dir 2': 0,
	'x 3/5 dir 1': 384,
	'x 3/5 dir 2': 384,
	'x 4/3 dir 1': 653,
	'x 4/3 dir 2': 653,
	'x 5/3 dir 1': 735,
	'x 5/3 dir 2': 735,
	'x 7/10 dir 1': 346,
	'x 7/10 dir 2': 346,
	'y 10/7 dir 1': 556,
	'y 10/7 dir 2': 602,
	'y 3/2 dir 1': 0,
	'y 3/2 dir 2': 0,
	'y 3/4 dir 1': 0,
	'y 3/4 dir 2': 0,
	'y 3/5 dir 1': 400,
	'y 3/5 dir 2': 384,
	'y 4/3 dir 1': 695,
	'y 4/3 dir 2': 653,
	'y 5/3 dir 1': 742,
	'y 5/3 dir 2': 735,
	'y 7/10 dir 1': 402,
	'y 7/10 dir 2': 346,
};

describe('compat-playback-r34-geosq9 RoundRects', () => {
	const cases: { rec: number[]; path: number[]; widened: number[] }[] = JSON.parse(gunzipSync(readFileSync(fixturePath('compat-playback-r34-geosq9-roundrects.json.gz'))).toString());

	it('are widened to native outlines from native paths', () => {
		expect(cases).toHaveLength(4);
		for (const c of cases) {
			const path = new GdiRasterPath();
			const pts: number[][] = [];
			for (let i = 0; i + 2 < c.path.length; i += 3) pts.push([c.path[i], c.path[i + 1], c.path[i + 2]]);
			path.moveTo(pts[0][0], pts[0][1]);
			for (let k = 1; k < pts.length; ) {
				if ((pts[k][2] & ~1) === 4) {
					path.bezierTo(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], pts[k + 2][0], pts[k + 2][1]);
					k += 3;
				} else {
					path.lineTo(pts[k][0], pts[k][1]);
					k++;
				}
			}
			path.closeFigure();
			const out = widenPath(path, {
				width: 192,
				cap: 'round',
				join: 'round',
				miterLimit: 10,
				dashes: null,
				shortenDashes: true,
				wholePixelDashVectors: false,
				cutToLogicalUnits: true,
				logicalScale: 4 / 3,
				capWidth: 192,
			});
			const ours = new Set<string>();
			for (const f of out) for (let i = 0; i + 1 < f.length; i += 2) ours.add(`${f[i]},${f[i + 1]}`);
			const native = new Set<string>();
			for (let i = 0; i + 2 < c.widened.length; i += 3) native.add(`${c.widened[i]},${c.widened[i + 1]}`);
			expect([...ours].filter((k) => !native.has(k))).toEqual([]);
			expect([...native].filter((k) => !ours.has(k))).toEqual([]);
		}
	});
});
