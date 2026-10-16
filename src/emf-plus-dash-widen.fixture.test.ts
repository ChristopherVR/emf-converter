/**
 * Dashed pens against GDI+ (`dash-widen-probe`, `DashWidenProbe.cs`, `dash-widen.json.gz`): 480 random open lines, polylines and closed
 * triangles of widths 2 to 12 with Flat, Round and Triangle dash caps (custom patterns of 0.25 to 4 pen widths, so dashes shorter than the
 * cap are there, and stock styles; offsets 0, 0.5 and 1.25 widths; some lines with a Round start cap), then the rectangle, triangle and ten-point
 * star of the `gpx-pen-inset-dash*` sheets with Dash and DashDot, widths 3 to 14, Center and Inset. Each case holds the polygon
 * `GraphicsPath.Widen` returns and the pixels `DrawPath` paints, aliased and antialiased.
 *
 * What the capture shows (all measured with `Widen`):
 *  - GDI+ dashes the figure before widening and widens every dash as its own open figure. With a Round or Triangle DashCap a dash is straight
 *    for its length minus the pen width, the caps reaching half a width beyond both ends. A dash shorter than the pen width is a DOT: a straight
 *    part of 0.001 pen widths (the two short sides of the polygon are 0.002 long for a width 2 pen, 0.0045 for 4.5, 0.008 for 8 in all 386
 *    dots surveyed) and the caps of a dot touch.
 *  - A dash shorter than the cap still takes the cap's whole length of the pattern: the next dash starts one pen width after the straight
 *    part ends, whatever the dash length was (the pattern 2, 1, 0.5, 1.5 of a width 2 pen repeats every 11 pixels, not 10). The converter
 *    kept the period instead, which put every later dash of such a pattern off: 4,543 differing pixels of the Inset round-dash cases, 4,000
 *    over a dozen paths.
 *  - A dash of an open line whose cap would reach the line's end (the line ends within half a pen width of the straight part) is the line's
 *    last dash: it ends where its straight part does and takes the line's own end cap (a Flat cap shows as a flat end up to a pen width
 *    short of the end of the dash that the pattern would have drawn).
 *  - The caps are Beziers (types 3 in the `Widen` path), flattened as every other Bezier of a fill; filling the native `Widen` path with
 *    `flattenBezierGdiplus` and the 28.4 fill reproduces the native pixels (479 of 480 aliased, 475 antialiased), so the remaining differences
 *    are in the geometry (cut points, 1/16 pixel roundings of the control points of a cap), not in the rasteriser.
 */
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { insetStrokeCoverage } from './emf-plus-inset-outline';
import { figuresBox, rasterizePlusFill, recordDeviceFigures, toPlusFix } from './emf-plus-raster';
import { widenedPen } from './emf-plus-stroke';
import { widenFigures, type DevicePen } from './emf-plus-widen';

type Rows = Array<[number, number, string]>;
interface Case {
	kind: 'line' | 'polyline' | 'closed';
	inset?: boolean;
	width: number;
	dashCap: number;
	startCap: number;
	join: number;
	style: number;
	pattern: number[] | null;
	offset: number;
	pts: number[];
	aliased: Rows;
	aa: Rows;
}

const SIZE = 140;
const STOCK: Record<number, number[]> = { 1: [3, 1], 2: [1, 1], 3: [3, 1, 1, 1], 4: [3, 1, 1, 1, 1, 1] };
const cases: Case[] = JSON.parse(gunzipSync(readFileSync(fixturePath('dash-widen.json.gz'))).toString());

function bitmap(rows: Rows): Uint8Array {
	const out = new Uint8Array(SIZE * SIZE);
	for (const [y, x0, hex] of rows) {
		for (let i = 0; i < hex.length / 2; i++) {
			out[y * SIZE + x0 + i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
		}
	}
	return out;
}

const figuresOf = (c: Case) =>
	recordDeviceFigures((ctx) => {
		ctx.moveTo(c.pts[0], c.pts[1]);
		for (let i = 2; i < c.pts.length; i += 2) {
			ctx.lineTo(c.pts[i], c.pts[i + 1]);
		}
		if (c.kind === 'closed') {
			ctx.closePath();
		}
	}, [1, 0, 0, 1, 0, 0]);

const penOf = (c: Case, inset: boolean): DevicePen => ({
	half: c.width / 2,
	join: c.join,
	miterLimit: 10,
	startCap: c.startCap,
	endCap: 0,
	dashCap: c.dashCap,
	dash: (c.pattern ?? STOCK[c.style]).map((v) => v * c.width),
	dashOffset: c.offset * c.width,
	compound: null,
	inset,
});

function render(c: Case, antialias: boolean): Uint8ClampedArray {
	const figures = figuresOf(c);
	const toFix = (poly: ReadonlyArray<{ x: number; y: number }>): number[] => poly.flatMap((p) => [toPlusFix(p.x), toPlusFix(p.y)]);
	if (!c.inset) {
		const polys = widenFigures(figures, penOf(c, false)).map(toFix);
		return rasterizePlusFill(polys, false, antialias, false, { x: 0, y: 0, w: SIZE, h: SIZE });
	}
	const { fix, groups, insetFigures } = widenedPen(figures, penOf(c, true), toFix);
	const area = figuresBox(fix, { w: SIZE, h: SIZE });
	const out = new Uint8ClampedArray(SIZE * SIZE);
	if (!area || !insetFigures) {
		return out;
	}
	const cov = insetStrokeCoverage(groups, insetFigures, antialias, false, area, true);
	for (let y = 0; y < area.h; y++) {
		for (let x = 0; x < area.w; x++) {
			out[(area.y + y) * SIZE + area.x + x] = cov[y * area.w + x];
		}
	}
	return out;
}

/** `[exact cases, differing pixels]` over `selected`, aliased and antialiased. */
function score(selected: Case[]): { aliased: [number, number]; aa: [number, number] } {
	const out = { aliased: [0, 0] as [number, number], aa: [0, 0] as [number, number] };
	for (const c of selected) {
		for (const aa of [false, true]) {
			const r = render(c, aa);
			const nat = bitmap(aa ? c.aa : c.aliased);
			let n = 0;
			for (let i = 0; i < nat.length; i++) {
				if (r[i] !== nat[i]) {
					n++;
				}
			}
			const s = aa ? out.aa : out.aliased;
			if (n === 0) {
				s[0]++;
			}
			s[1] += n;
		}
	}
	return out;
}

const centered = cases.filter((c) => !c.inset);

describe('dashed pens against GDI+ (dash-widen.json.gz)', () => {
	it('has the 480 random cases and the 192 sheet-figure cases (96 Center, 96 Inset)', () => {
		expect(centered.length).toBe(576);
		expect(cases.length).toBe(672);
	});

	it('Flat dash caps: exact apart from 4 pixels (dashes shorter than a pixel at a cut)', () => {
		for (const kind of ['line', 'polyline', 'closed'] as const) {
			const selected = centered.filter((c) => c.dashCap === 0 && c.kind === kind);
			expect(selected.length).toBe(54);
			expect(score(selected).aliased[0]).toBeGreaterThanOrEqual(53);
		}
	});

	it('Round dash caps, open lines', () => {
		expect(score(centered.filter((c) => c.dashCap === 2 && c.kind === 'line'))).toEqual({ aliased: [52, 2], aa: [37, 50] });
	});

	it('Round dash caps, polylines', () => {
		expect(score(centered.filter((c) => c.dashCap === 2 && c.kind === 'polyline'))).toEqual({ aliased: [51, 28], aa: [26, 162] });
	});

	it('Round dash caps, closed figures', () => {
		expect(score(centered.filter((c) => c.dashCap === 2 && c.kind === 'closed'))).toEqual({ aliased: [94, 8], aa: [66, 178] });
	});

	it('Triangle dash caps, open lines', () => {
		expect(score(centered.filter((c) => c.dashCap === 3 && c.kind === 'line'))).toEqual({ aliased: [50, 5], aa: [36, 51] });
	});

	it('Triangle dash caps, polylines', () => {
		expect(score(centered.filter((c) => c.dashCap === 3 && c.kind === 'polyline'))).toEqual({ aliased: [46, 11], aa: [23, 150] });
	});

	it('Triangle dash caps, closed figures', () => {
		expect(score(centered.filter((c) => c.dashCap === 3 && c.kind === 'closed'))).toEqual({ aliased: [94, 6], aa: [68, 155] });
	});

	it('a dash shorter than the cap takes the cap length of the pattern (width 12, pattern 0.5, 1.5)', () => {
		const selected = centered.filter((c) => c.kind === 'line' && c.dashCap === 2 && c.width === 12 && c.pattern?.join() === '0.5,1.5');
		expect(selected.length).toBeGreaterThan(0);
		expect(score(selected).aliased[0]).toBe(selected.length);
	});

	it('Inset pens on the sheet figures with Round dash caps (the band along the inside of each edge)', () => {
		expect(score(cases.filter((c) => c.inset && c.dashCap === 2))).toEqual({ aliased: [20, 141], aa: [15, 602] });
	});
});
