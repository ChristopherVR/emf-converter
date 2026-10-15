/**
 * Pen end caps and joins against GDI+ (`cap-widen-probe`, `cap-widen-round.json.gz` and `cap-widen-custom.json.gz`): native pixels, aliased and
 * antialiased, of lines, polylines and Beziers drawn with Round, Flat, Square and Triangle caps and with custom line caps.
 *
 *  - Round caps and joins are Beziers (two of at most a quarter turn each, equal parts) flattened by GDI+'s own flattener
 *    (`flattenBezierGdiplus`): the older approximate flattener was one vertex off for pens of width 4 to 5.5.
 *  - A square cap has only its two extended corners as vertices (an extra vertex on the line was rounded to 28.4 off the edge).
 *  - The body of a custom-capped line gets a CLIPPED miter beyond the miter limit (not the plain pen's bevel), clipped where each offset edge is
 *    the limit away from the vertex (Euclidean).
 *  - Pens of width 1.5 or less are nominal-width lines (`emf-plus-nominal-line.ts`), not part of this survey.
 */
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { arrowCapPath, capPathLength, customCapGeometry, type EmfPlusCustomLineCap } from './emf-plus-custom-cap';
import { rasterizePlusFill, recordDeviceFigures, toPlusFix } from './emf-plus-raster';
import { widenFigures, type DevicePen } from './emf-plus-widen';

type Rows = Array<[number, number, string]>;
interface Case {
	cap: string;
	start?: string | null;
	kind?: string;
	join?: number;
	width: number;
	pts: number[];
	aliased: Rows;
	aa: Rows;
}

const SIZE = 140;
const box = { x: 0, y: 0, w: SIZE, h: SIZE };
const load = (name: string): Case[] => JSON.parse(gunzipSync(readFileSync(fixturePath(name))).toString());

function bitmap(rows: Rows): Uint8Array {
	const out = new Uint8Array(SIZE * SIZE);
	for (const [y, x0, hex] of rows) {
		for (let i = 0; i < hex.length / 2; i++) {
			out[y * SIZE + x0 + i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
		}
	}
	return out;
}

function differing(a: ArrayLike<number>, b: ArrayLike<number>): number {
	let n = 0;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			n++;
		}
	}
	return n;
}

const penFor = (width: number, cap: number, join = 0): DevicePen => ({ half: width / 2, join, miterLimit: 10, startCap: cap, endCap: cap, dashCap: 0, dash: null, dashOffset: 0, compound: null, inset: false });

function figuresOf(c: Case) {
	const p = c.pts;
	return recordDeviceFigures((ctx) => {
		ctx.moveTo(p[0], p[1]);
		if (c.kind === 'bezier' || c.cap === 'RoundBezier') {
			ctx.bezierCurveTo(p[2], p[3], p[4], p[5], p[6], p[7]);
		} else {
			for (let i = 2; i < p.length; i += 2) {
				ctx.lineTo(p[i], p[i + 1]);
			}
		}
	}, [1, 0, 0, 1, 0, 0]);
}

const toFix = (polys: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>): number[][] => polys.map((q) => q.flatMap((v) => [toPlusFix(v.x), toPlusFix(v.y)]));

/** `[exact cases, differing pixels]` of the converter against GDI+ over `cases`. */
function score(cases: Case[], render: (c: Case, aa: boolean) => Uint8ClampedArray): { aliased: [number, number]; aa: [number, number] } {
	const out = { aliased: [0, 0] as [number, number], aa: [0, 0] as [number, number] };
	for (const c of cases) {
		for (const aa of [false, true]) {
			const n = differing(render(c, aa), bitmap(aa ? c.aa : c.aliased));
			const s = aa ? out.aa : out.aliased;
			if (n === 0) {
				s[0]++;
			}
			s[1] += n;
		}
	}
	return out;
}

const CAP_NUMBER: Record<string, number> = { Flat: 0, Square: 1, Round: 2, RoundBezier: 2, Triangle: 3 };

describe('pen caps against GDI+ (cap-widen-round.json.gz)', () => {
	const cases = load('cap-widen-round.json.gz').filter((c) => c.width > 1.5);
	const render = (c: Case, aa: boolean): Uint8ClampedArray =>
		rasterizePlusFill(toFix(widenFigures(figuresOf(c), penFor(c.width, CAP_NUMBER[c.cap]))), false, aa, false, box);

	it('Flat, Square and Triangle caps on lines: exact', () => {
		const lines = cases.filter((c) => ['Flat', 'Square', 'Triangle'].includes(c.cap));

		expect(lines.length).toBe(195);
		expect(score(lines, render)).toEqual({ aliased: [195, 0], aa: [195, 0] });
	});

	it('Round caps on lines: exact, widths 4 to 5.5 included', () => {
		const lines = cases.filter((c) => c.cap === 'Round');

		expect(lines.length).toBe(172);
		expect(score(lines, render)).toEqual({ aliased: [172, 0], aa: [172, 0] });
	});

	it('Round caps on Beziers (7 of 98 differ antialiased by 1 to 33 pixels, not investigated)', () => {
		const curves = cases.filter((c) => c.cap === 'RoundBezier');

		expect(curves.length).toBe(98);
		expect(score(curves, render)).toEqual({ aliased: [96, 18], aa: [91, 57] });
	});
});

const mkPath = (pts: number[][], closed: boolean) => ({
	kind: 'plus-path' as const,
	points: pts.map(([x, y]) => ({ x, y })),
	types: Uint8Array.from(pts.map((_, i) => (i === 0 ? 0 : 1) | (closed && i === pts.length - 1 ? 0x80 : 0))),
	fillRule: 'nonzero' as const,
});

function arrow(w: number, h: number, mid: number, filled: boolean, ws = 1): EmfPlusCustomLineCap {
	const path = arrowCapPath(w, h, mid, filled);
	const len = capPathLength(path.points, path.types);
	return {
		kind: 'plus-customlinecap',
		capType: 1,
		baseCap: 0,
		baseInset: Math.fround(h / w),
		strokeStartCap: 0,
		strokeEndCap: 0,
		strokeJoin: 0,
		strokeMiterLimit: 5,
		widthScale: ws,
		fillPath: filled ? path : null,
		linePath: filled ? null : path,
		fillLength: filled ? len : 0,
		strokeLength: filled ? 0 : len,
		arrow: { width: w, height: h, middleInset: mid, filled },
	};
}

const kite = mkPath([[-1.5, -1.2], [0, 2], [1.5, -1.2], [0, -0.4]], true);
const arrowLine = mkPath([[-1.5, -0.6], [0, 1.4], [1.5, -0.6]], false);
const CUSTOM: Record<string, EmfPlusCustomLineCap> = {
	filled: arrow(3, 4, 0, true),
	open: arrow(2.5, 3, 0, false),
	mid: arrow(3.5, 4.5, 1.5, true),
	small: arrow(4, 3, 0, true, 0.6),
	fillCap: { kind: 'plus-customlinecap', capType: 0, baseCap: 0, baseInset: 0.5, strokeStartCap: 0, strokeEndCap: 0, strokeJoin: 0, strokeMiterLimit: 10, widthScale: 1.5, fillPath: kite, linePath: null, fillLength: capPathLength(kite.points, kite.types), strokeLength: 0 },
	lineCap: { kind: 'plus-customlinecap', capType: 0, baseCap: 2, baseInset: 1, strokeStartCap: 2, strokeEndCap: 3, strokeJoin: 2, strokeMiterLimit: 10, widthScale: 1, fillPath: null, linePath: arrowLine, fillLength: 0, strokeLength: capPathLength(arrowLine.points, arrowLine.types) },
	lineCap2: { kind: 'plus-customlinecap', capType: 0, baseCap: 0, baseInset: 0, strokeStartCap: 1, strokeEndCap: 0, strokeJoin: 1, strokeMiterLimit: 10, widthScale: 1, fillPath: null, linePath: arrowLine, fillLength: 0, strokeLength: capPathLength(arrowLine.points, arrowLine.types) },
};

describe('custom line caps against GDI+ (cap-widen-custom.json.gz)', () => {
	const cases = load('cap-widen-custom.json.gz');
	/** The outline `strokeGdiplus` fills for a custom-capped pen (`customCapOutline` in emf-plus-stroke.ts). */
	const render = (c: Case, aa: boolean): Uint8ClampedArray => {
		const geo = customCapGeometry(figuresOf(c), c.width, c.start ? CUSTOM[c.start] : null, CUSTOM[c.cap]);
		const join = c.join === 0 ? 3 : (c.join as number);
		const polys: Array<Array<{ x: number; y: number }>> = [];
		for (const fig of geo.figures) {
			for (const poly of widenFigures([fig], { ...penFor(Math.max(c.width, 1), 0, join), half: Math.max(c.width, 1) / 2 })) {
				polys.push(poly.slice().reverse());
			}
		}
		polys.push(...geo.polygons);
		return rasterizePlusFill(toFix(polys), false, aa, false, box);
	};

	it('is the captured set', () => {
		expect(cases.length).toBe(300);
	});

	it('lines with an end cap or both caps: every arrow, fill-path and line-path cap (one case off by 21 pixels: a 1-pixel pen, 1/16 pixel at the shortened end)', () => {
		const lines = cases.filter((c) => c.kind === 'line');
		expect(lines.length).toBe(200);
		expect(score(lines, render)).toEqual({ aliased: [200, 0], aa: [199, 21] });
	});

	it('polylines and Beziers with both caps and the pen joins Miter (clipped), Bevel and Round', () => {
		const bent = cases.filter((c) => c.kind !== 'line');
		expect(bent.length).toBe(100);
		expect(score(bent, render)).toEqual({ aliased: [99, 1], aa: [98, 5] });
	});
});
