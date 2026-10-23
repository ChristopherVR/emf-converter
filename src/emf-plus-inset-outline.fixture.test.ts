/**
 * The outline of an Inset stroke on a closed polygon against GDI+ (`inset-outline-probe`, `inset-outline.json.gz`): 120 polygons (40
 * triangles, 40 star-shaped polygons, 40 flattened ellipses, rounded rectangles and closed curves), each drawn with an Inset pen of width 2 to
 * 6 and a Miter, Bevel or Round join, aliased and antialiased, with the polygon `GraphicsPath.Widen` returns for the pen.
 *
 *  - Aliased: the pen at twice its width, centered, clipped to the polygon with the hard clip is GDI+'s stroke pixel for pixel, on all 120.
 *  - Antialiased: GDI+ fills the outline of those pixels (a polygon on whole-pixel coordinates, as `Widen` returns it); the rule that cuts
 *    the staircase corners reproduces it on most cases and differs by a few pixels at the sharpest tips (two pixels that only touch at a
 *    corner, a notch one pixel high).
 */
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { insetMaskOutline, insetStrokeCoverage } from './emf-plus-inset-outline';
import { figuresBox, rasterizePlusFill, toPlusFix } from './emf-plus-raster';
import { widenFigures, type DevicePen } from './emf-plus-widen';

type Rows = Array<[number, number, string]>;
interface Case {
	kind: string;
	join: number;
	width: number;
	src: number[];
	widen: number[];
	types: number[];
	aliased: Rows;
	aa: Rows;
}

const SIZE = 130;
const EXPECTED_AA_EXACT = 120;
const EXPECTED_AA_TOTAL = 0;
const EXPECTED_WIDEN_TOTAL = 0;
const cases: Case[] = JSON.parse(gunzipSync(readFileSync(fixturePath('inset-outline.json.gz'))).toString());

function bitmap(rows: Rows): Uint8Array {
	const out = new Uint8Array(SIZE * SIZE);
	for (const [y, x0, hex] of rows) {
		for (let i = 0; i < hex.length / 2; i++) {
			out[y * SIZE + x0 + i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
		}
	}
	return out;
}

/** The converter's coverage of the case, as `strokeGdiplus` builds it (identity transform). */
function render(c: Case, antialias: boolean): Uint8Array {
	const pen: DevicePen = { half: c.width, join: c.join === 2 ? 2 : c.join === 1 ? 1 : 0, miterLimit: 10, startCap: 0, endCap: 0, dashCap: 0, dash: null, dashOffset: 0, compound: null, inset: false };
	const fix = widenFigures([{ pts: c.src, closed: true, curved: false }], pen).map((poly) => poly.flatMap((p) => [toPlusFix(p.x), toPlusFix(p.y)]));
	const figure = [c.src.map(toPlusFix)];
	const box = figuresBox(fix, { w: SIZE, h: SIZE });
	const out = new Uint8Array(SIZE * SIZE);
	if (!box) {
		return out;
	}
	const cov = insetStrokeCoverage([fix], figure, antialias, false, box);
	for (let y = 0; y < box.h; y++) {
		for (let x = 0; x < box.w; x++) {
			out[(box.y + y) * SIZE + box.x + x] = cov[y * box.w + x];
		}
	}
	return out;
}

function differing(a: Uint8Array, b: Uint8Array): number {
	let n = 0;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			n++;
		}
	}
	return n;
}

describe('Inset stroke outline against GDI+ (inset-outline.json.gz)', () => {
	it('has the 120 captured cases', () => {
		expect(cases.length).toBe(120);
	});

	it('aliased: the pen at twice its width clipped to the polygon is GDI+ exactly, on every case', () => {
		const bad = cases.map((c, i) => [i, differing(render(c, false), bitmap(c.aliased))]).filter(([, n]) => n > 0);
		expect(bad).toEqual([]);
	});

	it('antialiased: the cut staircase outline matches GDI+ on most cases', () => {
		const diffs = cases.map((c) => differing(render(c, true), bitmap(c.aa)));
		const total = diffs.reduce((s, n) => s + n, 0);
		const exact = diffs.filter((n) => n === 0).length;
		expect({ exact, total }).toEqual({ exact: EXPECTED_AA_EXACT, total: EXPECTED_AA_TOTAL });
	});

	it('antialiased: GDI+ fills the Widen polygon it returns (the capture is self-consistent)', () => {
		// An antialiased fill of the Widen outline equals the antialiased DrawPath on polygons whose pen has no round join.
		let compared = 0;
		let total = 0;
		for (const c of cases) {
			if (c.join === 2) {
				continue;
			}
			const loops: number[][] = [];
			let cur: number[] = [];
			for (let i = 0; i < c.types.length; i++) {
				cur.push(toPlusFix(c.widen[2 * i]), toPlusFix(c.widen[2 * i + 1]));
				if (c.types[i] & 0x80) {
					loops.push(cur);
					cur = [];
				}
			}
			const box = figuresBox(loops, { w: SIZE, h: SIZE });
			if (!box) {
				continue;
			}
			const cov = rasterizePlusFill(loops, false, true, false, box);
			const out = new Uint8Array(SIZE * SIZE);
			for (let y = 0; y < box.h; y++) {
				for (let x = 0; x < box.w; x++) {
					out[(box.y + y) * SIZE + box.x + x] = cov[y * box.w + x];
				}
			}
			total += differing(out, bitmap(c.aa));
			compared++;
		}
		expect(compared).toBeGreaterThan(60);
		expect(total).toBe(EXPECTED_WIDEN_TOTAL);
	});
});

describe('insetMaskOutline', () => {
	const outline = (rows: string[]): number[][] => {
		const h = rows.length;
		const w = rows[0].length;
		const mask = new Uint8Array(w * h);
		rows.forEach((r, y) => [...r].forEach((ch, x) => (mask[y * w + x] = ch === '#' ? 1 : 0)));
		return insetMaskOutline(mask, w, h, 0, 0).map((l) => l.map((v) => v / 16));
	};

	it('a region of one rectangle keeps its four corners', () => {
		expect(outline(['..', '.#']).map((l) => l.join(','))).toEqual(['1,1,2,1,2,2,1,2']);
		expect(outline(['....', '.###']).map((l) => l.join(','))).toEqual(['1,1,4,1,4,2,1,2']);
	});

	it('in a region of several loops a single pixel is the triangle of its top left, bottom right and top right corners (walked counterclockwise from the top left, the bottom left one dropped)', () => {
		expect(outline(['#...', '....', '...#']).map((l) => l.join(','))).toEqual(['0,0,1,1,1,0', '3,2,4,3,4,2']);
	});

	it('a horizontal run loses its bottom left corner, a tall column its bottom right', () => {
		expect(outline(['###.', '....', '...#']).map((l) => l.join(','))).toEqual(['0,0,3,1,3,0', '3,2,4,3,4,2']);
		expect(outline(['#...', '#...', '....', '...#']).map((l) => l.join(','))).toEqual(['0,0,0,2,1,0', '3,3,4,4,4,3']);
	});

	it('a staircase stepping right under runs of three rows keeps both corners of each step; stepping left it is cut to a diagonal', () => {
		expect(outline(['.#######', '.#######', '.#######', '..######', '..######', '..######', '...#####', '...#####', '...#####']).map((l) => l.join(','))).toEqual([
			'1,0,1,3,2,3,2,6,3,6,3,9,8,9,8,0',
		]);
		expect(outline(['...#####', '...#####', '...#####', '..######', '..######', '..######', '.#######', '.#######', '.#######']).map((l) => l.join(','))).toEqual([
			'3,0,2,3,1,6,1,9,8,9,8,0',
		]);
	});
});

describe('Inset stroke outline: corner contacts (inset-contacts.json.gz)', () => {
	// 300 random polygons (triangles, self-crossing polygons, stars) with an Inset pen of width 1.6 to 9 (`inset-contacts-probe`). The
	// pairing of set pixels that touch only at a corner is the one GDI+'s region walker makes (`DpRegion::GetOutlinePoints`, ported in
	// `traceRegionLoops`); the hand-measured rule before it (a hole that touches itself is traced as separate holes, other contacts keep their
	// set pixels apart) left 51 of the 300 inexact.
	const contacts: Array<{ aliased: Rows; aa: Rows }> = JSON.parse(gunzipSync(readFileSync(fixturePath('inset-contacts.json.gz'))).toString());
	const box = { x: 0, y: 0, w: SIZE, h: SIZE };
	const diffs = contacts.map((c) => {
		const out = rasterizePlusFill(insetMaskOutline(bitmap(c.aliased), SIZE, SIZE, 0, 0), false, true, false, box);
		return differing(new Uint8Array(out), bitmap(c.aa));
	});

	it('is the captured set', () => {
		expect(contacts.length).toBe(300);
	});

	it('reproduces the antialiased outline on every case (all 300 exact, from 556 differing pixels with the hand-fitted corner rule and 945 with every contact traced apart)', () => {
		expect({ exact: diffs.filter((n) => n === 0).length, total: diffs.reduce((s, n) => s + n, 0) }).toEqual({ exact: 300, total: 0 });
	});
});

describe('Inset stroke outline: thin slivers (inset-slivers.json.gz)', () => {
	// 240 triangles 40 to 100 pixels long and 1.2 to 6 pixels thick in random directions (`inset-slivers-probe`), drawn with an Inset pen of
	// width 14 so that the whole triangle is stroke. Where overlapping figures cancel (even-odd) the surviving part of a ring is such a strip, and
	// this was the first suspect for the staircase corners that differ at the junctions of crossing rings: it is not. Every sliver is exact,
	// aliased and antialiased, so the corner rule is not what separates the rings of two figures (that is open, see the docs).
	const slivers: Case[] = JSON.parse(gunzipSync(readFileSync(fixturePath('inset-slivers.json.gz'))).toString());

	it('is the captured set', () => {
		expect(slivers.length).toBe(240);
	});

	it('240 of 240 exact aliased and antialiased', () => {
		const al = slivers.map((c) => differing(render(c, false), bitmap(c.aliased)));
		const aa = slivers.map((c) => differing(render(c, true), bitmap(c.aa)));
		expect({ aliased: al.reduce((s, n) => s + n, 0), aa: aa.reduce((s, n) => s + n, 0) }).toEqual({ aliased: 0, aa: 0 });
	});
});
