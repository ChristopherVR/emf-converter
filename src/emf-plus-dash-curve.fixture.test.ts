/**
 * Where GDI+ cuts the dashes of a pen on a Bezier curve (`dash-curve-probe`, `DashCurveProbe.cs`, `dash-curve.json.gz`): 120 random cubic Beziers
 * (a third of them quarter circles) followed by a 250 pixel line, a Center pen of width 2 with a Flat dash cap (7 and 5 pixel or 10 and 2 pixel
 * dashes), with `GraphicsPath.Flatten(0.25)` and the polygons `GraphicsPath.Widen(pen, new Matrix(), 0.25)` returns.
 *
 *  - `Widen(pen, matrix, 0.25)` is what `DrawPath` draws: filling it reproduces a dashed `DrawPath` with 0 differing aliased pixels on a dashed
 *    ellipse, closed curve and rounded path at pen widths 6, 14 and 28 (2 to 2,784 over the flatness values 0.001, 0.01, 0.05, 0.1, 0.2, 0.3, 0.5,
 *    1 and 2). The one-argument `Widen(pen)` is NOT the same on a path with a curve: it returns the straight part's coordinates ceiled
 *    to sixths of a pixel (a line at y = 51.0625 comes back at 51.1667, its end at x = 125.3125 at 125.3333; 10,386 of the 15,253 y coordinates
 *    of such a capture are multiples of 1/6) and on the same curves only 5,549 of 6,433 of its dash cuts sit within 0.3 pixels of the converter's (against 6,462 of 6,466 with the
 *    matrix). The captures made with it (`dash-widen`, `cap-widen`, `inset-outline`) are exact on lines and polygons; their curve cases (the
 *    Beziers of `cap-widen`) were not repeated with the matrix.
 *  - The converter flattens every curve exactly as GDI+ does (the vertices of `Flatten`, point for point: 120 of 120) and walks the chords
 *    exactly as GDI+ does: handed the same vertices as straight lines (`linesWiden`, the control path), GDI+ cuts the dashes where the converter
 *    does, to within 0.002 pixels over more than 6,000 cuts.
 *  - On the curves themselves 6,389 of the 6,466 native cuts have a converter cut within 0.05 pixels and 6,462 within 0.15 (the other four were not examined).
 *  - A flat dash end whose corner would lie BEHIND the offset point before it (a last segment shorter than the reach of a smooth join, on the
 *    inner side of the turn: 1.1 to 1.6 pixels after a vertex in the four ends of the width 28 sheet figures) ends at that point instead, so the end edge is slanted and
 *    27.89 to 27.93 pixels long, not 28. The converter used to keep the corner, which put a one-pixel tip on the clip of the Inset sheet
 *    (`gpx-pen-inset-dash-aliased`: 28 differing pixels, 0 now).
 */
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { recordDeviceFigures } from './emf-plus-raster';
import { widenFigures, type DevicePen } from './emf-plus-widen';

interface Case {
	b: number[];
	pat: [number, number];
	flat: number[];
	widen: number[];
	types: number[];
	linesWiden: number[];
	linesTypes: number[];
}

const cases: Case[] = JSON.parse(gunzipSync(readFileSync(fixturePath('dash-curve.json.gz'))).toString());

const figureOf = (c: Case) =>
	recordDeviceFigures((ctx) => {
		ctx.moveTo(c.b[0], c.b[1]);
		ctx.bezierCurveTo(c.b[2], c.b[3], c.b[4], c.b[5], c.b[6], c.b[7]);
		ctx.lineTo(c.b[6] + 250, c.b[7]);
	}, [1, 0, 0, 1, 0, 0]);

/** The midpoints of the polygons' cut edges (the edges as long as the pen is wide). */
function cuts(polys: number[][]): number[][] {
	const out: number[][] = [];
	for (const p of polys) {
		const m = p.length / 2;
		for (let i = 0; i < m; i++) {
			const j = (i + 1) % m;
			if (Math.abs(Math.hypot(p[2 * i] - p[2 * j], p[2 * i + 1] - p[2 * j + 1]) - 2) < 0.06) {
				out.push([(p[2 * i] + p[2 * j]) / 2, (p[2 * i + 1] + p[2 * j + 1]) / 2]);
			}
		}
	}
	return out;
}

function split(points: number[], types: number[]): number[][] {
	const polys: number[][] = [];
	for (let i = 0; i < types.length; i++) {
		if ((types[i] & 7) === 0) {
			polys.push([]);
		}
		polys[polys.length - 1].push(points[2 * i], points[2 * i + 1]);
	}
	return polys;
}

const nativePolys = (c: Case): number[][] => split(c.widen, c.types);

function converterPolys(c: Case): number[][] {
	const pen: DevicePen = { half: 1, join: 0, miterLimit: 10, startCap: 0, endCap: 0, dashCap: 0, dash: c.pat, dashOffset: 0, compound: null, inset: false };
	return widenFigures(figureOf(c), pen).map((poly) => poly.flatMap((p) => [p.x, p.y]));
}

describe('dashes on Bezier curves against GDI+ (dash-curve.json.gz)', () => {
	it('has the 120 captured cases', () => {
		expect(cases.length).toBe(120);
	});

	it('the converter flattens the curve as GDI+ does, point for point', () => {
		let same = 0;
		for (const c of cases) {
			const pts = figureOf(c)[0].pts;
			// The last point is the end of the line, which GDI+ holds as a float and the converter as 28.4.
			if (pts.length === c.flat.length && pts.slice(0, -2).every((v, i) => Math.abs(v - c.flat[i]) < 1e-9)) {
				same++;
			}
		}
		expect(same).toBe(120);
	});

	it('the walk along a polyline is exact: the same vertices as straight lines are cut where GDI+ cuts them', () => {
		const pen: DevicePen = { half: 1, join: 0, miterLimit: 10, startCap: 0, endCap: 0, dashCap: 0, dash: [0, 0], dashOffset: 0, compound: null, inset: false };
		let total = 0;
		let worst = 0;
		for (const c of cases) {
			const flat = c.flat.slice(0, -2);
			const pts = [...flat, flat[flat.length - 2] + 250, flat[flat.length - 1]];
			const o = cuts(widenFigures([{ pts, closed: false, curved: false }], { ...pen, dash: c.pat }).map((poly) => poly.flatMap((p) => [p.x, p.y])));
			for (const a of cuts(split(c.linesWiden, c.linesTypes))) {
				total++;
				worst = Math.max(worst, Math.min(...o.map((b) => Math.hypot(a[0] - b[0], a[1] - b[1]))));
			}
		}
		expect(total).toBeGreaterThan(5000);
		expect(worst).toBeLessThan(0.002);
	});

	it('the cuts of the dashes on the curves: a converter cut within 0.05 / 0.15 pixels of at least 6,389 / 6,462 of the 6,466 native cuts', () => {
		let total = 0;
		const within = [0, 0, 0];
		for (const c of cases) {
			const o = cuts(converterPolys(c));
			for (const a of cuts(nativePolys(c))) {
				let best = Infinity;
				for (const b of o) {
					best = Math.min(best, Math.hypot(a[0] - b[0], a[1] - b[1]));
				}
				total++;
				within[0] += best <= 0.05 ? 1 : 0;
				within[1] += best <= 0.15 ? 1 : 0;
				within[2] += best <= 0.3 ? 1 : 0;
			}
		}
		expect(total).toBe(6466);
		expect(within[0]).toBeGreaterThanOrEqual(6389);
		expect(within[1]).toBeGreaterThanOrEqual(6462);
		expect(within[2]).toBeGreaterThanOrEqual(6462);
	});
});
