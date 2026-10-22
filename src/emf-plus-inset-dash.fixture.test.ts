/**
 * Inset pens on dashed and mixed paths against GDI+ (`inset-dash-probe`, `InsetDashProbe.cs`, `inset-dash.json.gz`): 113 `DrawPath` captures,
 * aliased and antialiased.
 *
 * What `GpPath::GetWidenedPath` does with an Inset pen (read from gdiplus.dll in round 11, then confirmed with these captures):
 *  - a closed subpath is widened at twice the pen's width, centered (dashes laid out with their lengths in the pen's own width), and clipped to
 *    the path's interior; its Round dash caps are double round caps (`GpPathWidener::SetDoubleRoundCap`: a semicircle of a quarter of the doubled
 *    width over each half of it). Inside the figure on a straight edge only the inner semicircle survives the clip, which looked like one cap
 *    centered in a band of the pen's own width; at a reflex vertex the outer one shows too (the `star` sweep: a dash that ends within a pen width
 *    of a vertex has a tail around the corner; the band model missed all of it). A Triangle dash cap leaves no tip at all (`star-triangle`).
 *  - an open subpath of the same path is stroked as a Center pen of the pen's own width, not clipped, and its outline winds the other way round
 *    from the clipped regions' outlines, so where it overlaps a region the two cancel (`mixed`).
 */
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { insetStrokeCoverage } from './emf-plus-inset-outline';
import { figuresBox, rasterizePlusFill, recordDeviceFigures, toPlusFix } from './emf-plus-raster';
import { widenedPen } from './emf-plus-stroke';
import type { DevicePen } from './emf-plus-widen';

type Rows = Array<[number, number, string]>;
interface Case {
	kind: string;
	width: number;
	join: number;
	dashCap: number;
	pattern: number[] | null;
	offset: number;
	figures: Array<{ closed: boolean; pts: number[] }>;
	aliased: Rows;
	aa: Rows;
}

const SIZE = 130;
const cases: Case[] = JSON.parse(gunzipSync(readFileSync(fixturePath('inset-dash.json.gz'))).toString());

function bitmap(rows: Rows): Uint8Array {
	const out = new Uint8Array(SIZE * SIZE);
	for (const [y, x0, hex] of rows) {
		for (let i = 0; i < hex.length / 2; i++) {
			out[y * SIZE + x0 + i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
		}
	}
	return out;
}

/** The converter's coverage of the case, as `strokeGdiplus` builds it (identity transform, Alternate fill mode). */
function render(c: Case, antialias: boolean): Uint8Array {
	const figures = recordDeviceFigures((ctx) => {
		for (const f of c.figures) {
			ctx.moveTo(f.pts[0], f.pts[1]);
			for (let i = 2; i < f.pts.length; i += 2) {
				ctx.lineTo(f.pts[i], f.pts[i + 1]);
			}
			if (f.closed) {
				ctx.closePath();
			}
		}
	}, [1, 0, 0, 1, 0, 0]);
	const pen: DevicePen = {
		half: c.width / 2,
		join: c.join,
		miterLimit: 10,
		startCap: 0,
		endCap: 0,
		dashCap: c.dashCap,
		dash: c.pattern ? c.pattern.map((v) => v * c.width) : null,
		dashOffset: c.offset * c.width,
		compound: null,
		inset: true,
	};
	const { fix, groups, insetFigures, open } = widenedPen(figures, pen, (poly) => poly.flatMap((p) => [toPlusFix(p.x), toPlusFix(p.y)]));
	const box = figuresBox(fix, { w: SIZE, h: SIZE });
	const out = new Uint8Array(SIZE * SIZE);
	if (!box) {
		return out;
	}
	const cov = insetFigures ? insetStrokeCoverage(groups, insetFigures, antialias, false, box, true, open) : rasterizePlusFill(fix, false, antialias, false, box);
	for (let y = 0; y < box.h; y++) {
		for (let x = 0; x < box.w; x++) {
			out[(box.y + y) * SIZE + box.x + x] = cov[y * box.w + x];
		}
	}
	return out;
}

/** `[exact renderings, differing pixels]` over `selected`, aliased and antialiased. */
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

describe('Inset pens on dashed and mixed paths (inset-dash.json.gz)', () => {
	it('has the 113 captured cases', () => {
		expect(cases.length).toBe(113);
		expect(cases.filter((c) => c.kind === 'star').length).toBe(61);
		expect(cases.filter((c) => c.kind === 'star-triangle').length).toBe(15);
		expect(cases.filter((c) => c.kind === 'lshape').length).toBe(25);
		expect(cases.filter((c) => c.kind === 'mixed').length).toBe(12);
	});

	it('Round dash caps over the reflex vertices of a star', () => {
		expect(score(cases.filter((c) => c.kind === 'star'))).toEqual({ aliased: [61, 0], aa: [61, 0] });
	});

	it('Triangle dash caps leave no tip', () => {
		expect(score(cases.filter((c) => c.kind === 'star-triangle'))).toEqual({ aliased: [15, 0], aa: [15, 0] });
	});

	it('a dash across the reflex vertex of an L', () => {
		expect(score(cases.filter((c) => c.kind === 'lshape'))).toEqual({ aliased: [25, 0], aa: [25, 0] });
	});

	it('a closed rectangle with an open line or polyline in one path, solid and dashed', () => {
		expect(score(cases.filter((c) => c.kind === 'mixed'))).toEqual({ aliased: [12, 0], aa: [12, 0] });
	});
});
