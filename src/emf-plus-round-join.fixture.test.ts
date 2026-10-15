/**
 * A round join through a small turn against GDI+ (`round-join-probe`, `round-join-small-turn.json.gz`): 360 antialiased 3-point polylines
 * (a lead-in, a turn of 0.5 to 20 degrees to either side, a straight run) with flat caps, pen widths 3, 6 and 14, along three directions.
 *
 * GDI+ treats a round join through a turn of under about 8 degrees (cosine above 0.99) as a smooth vertex: only the incoming offset point
 * stays, on both sides (`ROUND_SMOOTH_DOT` in `emf-plus-widen.ts`). The straight run then has an edge 1/16 pixel off the exact offset line,
 * on the side where the 28.4 conversion rounds the tiny excess up. The shift appears once the incoming offset point's distance from the
 * exact line reaches half a 1/256 step, so it starts at about 2.5 degrees for a pen of width 6 and 1.5 for width 14. Turns of 8.5 degrees
 * and more, and straight lines, are exact. Before, such edges between the arcs of a round-joined rounded rectangle were one pixel too thick
 * in the aliased Inset sheet (`gpx-pen-inset-round-aliased`: 458 differing pixels) and `gpx-rec-beziers-aa` differed by 43 pixels.
 */
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { figuresBox, rasterizePlusFill, toPlusFix } from './emf-plus-raster';
import { widenFigures, type DevicePen } from './emf-plus-widen';

const SIZE = 200;
interface Case {
	width: number;
	direction: number;
	turn: number;
	points: number[];
	rows: Array<[number, number, string]>;
}
const cases: Case[] = JSON.parse(gunzipSync(readFileSync(fixturePath('round-join-small-turn.json.gz'))).toString());

function native(c: Case): Uint8Array {
	const out = new Uint8Array(SIZE * SIZE);
	for (const [y, x0, hex] of c.rows) {
		for (let i = 0; i < hex.length / 2; i++) {
			out[y * SIZE + x0 + i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
		}
	}
	return out;
}

function ours(c: Case): Uint8Array {
	const pen: DevicePen = { half: c.width / 2, join: 2, miterLimit: 10, startCap: 0, endCap: 0, dashCap: 0, dash: null, dashOffset: 0, compound: null, inset: false };
	const fix = widenFigures([{ pts: c.points, closed: false, curved: false }], pen).map((poly) => poly.flatMap((p) => [toPlusFix(p.x), toPlusFix(p.y)]));
	const box = figuresBox(fix, { w: SIZE, h: SIZE })!;
	const cov = rasterizePlusFill(fix, false, true, false, box);
	const out = new Uint8Array(SIZE * SIZE);
	for (let y = 0; y < box.h; y++) {
		for (let x = 0; x < box.w; x++) {
			out[(box.y + y) * SIZE + box.x + x] = cov[y * box.w + x];
		}
	}
	return out;
}

describe('round join through a small turn against GDI+', () => {
	it('has the 360 captured cases', () => {
		expect(cases.length).toBe(360);
	});

	it('every axis-aligned run and every diagonal run is exact', () => {
		const bad = cases.flatMap((c, i) => {
			const a = ours(c);
			const b = native(c);
			let n = 0;
			for (let k = 0; k < a.length; k++) {
				if (a[k] !== b[k]) {
					n++;
				}
			}
			return n > 0 ? [`${i}: width ${c.width} direction ${c.direction} turn ${c.turn}: ${n}`] : [];
		});
		expect(bad).toEqual([]);
	});
});
