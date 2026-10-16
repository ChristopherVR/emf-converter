/**
 * Inset pens beyond the plain solid pen on one polygon, against GDI+ (`inset-cases-probe`, `inset-cases.json.gz`): 440 closed paths drawn with
 * `DrawPath`, aliased and antialiased.
 *
 *  - dash: dashed Inset pens (Dash, Dot, DashDot, DashDotDot and a custom pattern; dash offsets 0, 0.5 and 1.25). With flat dash caps the stroke
 *    is the pen at twice its width, centered, with the dash lengths in the pen's own width and the dash offset in the doubled one, clipped to
 *    the figure; with round caps it is the band along the inside of each edge, the caps centred on it, also clipped.
 *  - thin: pens of 0.5 to 1.5 pixels are nominal-width lines whatever the alignment (1.6 and 2 are ordinary Inset pens).
 *  - half: PixelOffsetMode Half moves the aliased samples half a pixel; the antialiased outline of the surviving pixels is not moved again.
 *  - multi: two or three overlapping closed polygons in one path. The clip is the interior by the path's fill mode (Alternate here: a pixel
 *    is kept when it lies in an odd number of the figures).
 *  - dashc: the dash cases with a Center pen (control): a closed figure with a Round dash cap keeps the straight part of each dash at its
 *    END, the other way round from an open line.
 */
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { insetStrokeCoverage } from './emf-plus-inset-outline';
import { nominalLineCoverage, recordNominalFigures } from './emf-plus-nominal-line';
import { figuresBox, rasterizePlusFill, recordDeviceFigures, toPlusFix } from './emf-plus-raster';
import { widenedPen } from './emf-plus-stroke';
import type { DevicePen } from './emf-plus-widen';

type Rows = Array<[number, number, string]>;
interface Case {
	kind: string;
	join: number;
	width: number;
	dash: number;
	dashCap: number;
	dashOffset: number;
	offset: number;
	figures: number[][];
	aliased: Rows;
	aa: Rows;
}

const SIZE = 130;
const box = { x: 0, y: 0, w: SIZE, h: SIZE };
const cases: Case[] = JSON.parse(gunzipSync(readFileSync(fixturePath('inset-cases.json.gz'))).toString());
const PATTERNS: Record<number, number[]> = { 1: [3, 1], 2: [1, 1], 3: [3, 1, 1, 1], 4: [3, 1, 1, 1, 1, 1], 5: [2, 1, 0.5, 1.5] };

function bitmap(rows: Rows): Uint8Array {
	const out = new Uint8Array(SIZE * SIZE);
	for (const [y, x0, hex] of rows) {
		for (let i = 0; i < hex.length / 2; i++) {
			out[y * SIZE + x0 + i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
		}
	}
	return out;
}

const build = (c: Case) => (ctx: { moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; closePath(): void }): void => {
	for (const f of c.figures) {
		ctx.moveTo(f[0], f[1]);
		for (let i = 2; i < f.length; i += 2) {
			ctx.lineTo(f[i], f[i + 1]);
		}
		ctx.closePath();
	}
};

/** The converter's coverage of the case, as `strokeGdiplus` builds it (identity transform). */
function render(c: Case, antialias: boolean): Uint8ClampedArray {
	const half = c.offset === 4 || c.offset === 2 || c.offset === 1;
	if (c.width <= 1.5 && c.kind !== 'dash' && c.kind !== 'dashc') {
		const figures = recordNominalFigures(build(c) as never, [1, 0, 0, 1, 0, 0]);
		return nominalLineCoverage(figures, { antialias, half, opaqueSolid: true, clip: box }, box);
	}
	const figures = recordDeviceFigures(build(c) as never, [1, 0, 0, 1, 0, 0]);
	const pen: DevicePen = {
		half: c.width / 2,
		join: c.join,
		miterLimit: 10,
		startCap: 0,
		endCap: 0,
		dashCap: c.dashCap,
		dash: c.kind === 'dash' || c.kind === 'dashc' ? PATTERNS[c.dash].map((v) => v * c.width) : null,
		dashOffset: c.dashOffset * c.width,
		compound: null,
		inset: c.kind !== 'dashc',
	};
	const { fix, groups, insetFigures } = widenedPen(figures, pen, (poly) => poly.flatMap((p) => [toPlusFix(p.x), toPlusFix(p.y)]));
	const area = figuresBox(fix, { w: SIZE, h: SIZE });
	const out = new Uint8ClampedArray(SIZE * SIZE);
	if (!area) {
		return out;
	}
	const cov = insetFigures ? insetStrokeCoverage(groups, insetFigures, antialias, half, area, true) : rasterizePlusFill(fix, false, antialias, half, area);
	for (let y = 0; y < area.h; y++) {
		for (let x = 0; x < area.w; x++) {
			out[(area.y + y) * SIZE + area.x + x] = cov[y * area.w + x];
		}
	}
	return out;
}

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

describe('Inset pens against GDI+ (inset-cases.json.gz)', () => {
	it('has the 440 captured cases', () => {
		expect(cases.length).toBe(440);
	});

	it('thin pens (0.5 to 1.5 pixels) are nominal-width lines, aliased and antialiased', () => {
		const thin = cases.filter((c) => c.kind === 'thin' && c.width <= 1.5);
		expect(thin.length).toBe(54);
		expect(score(thin)).toEqual({ aliased: [50, 8], aa: [54, 0] });
	});

	it('PixelOffsetMode Half and Default: the antialiased outline sits on the device pixels', () => {
		const half = cases.filter((c) => c.kind === 'half');
		expect(half.length).toBe(80);
		expect(score(half)).toEqual({ aliased: [80, 0], aa: [78, 38] });
	});

	it('dashed Inset pens with flat dash caps: the doubled pen clipped to the figure', () => {
		const flat = cases.filter((c) => c.kind === 'dash' && c.dashCap === 0);
		expect(score(flat)).toEqual({ aliased: [53, 18], aa: [50, 110] });
	});

	it('dashed Inset pens with round dash caps: the band along the inside of each edge, clipped', () => {
		const round = cases.filter((c) => c.kind === 'dash' && c.dashCap === 2);
		expect(score(round)).toEqual({ aliased: [38, 36], aa: [34, 244] });
	});

	it('paths of overlapping closed figures: the even-odd interior is the clip', () => {
		const multi = cases.filter((c) => c.kind === 'multi');
		expect(score(multi)).toEqual({ aliased: [49, 721], aa: [6, 3251] });
	});

	it('control: dashed Center pens, flat and round dash caps', () => {
		const flat = cases.filter((c) => c.kind === 'dashc' && c.dashCap === 0);
		const round = cases.filter((c) => c.kind === 'dashc' && c.dashCap === 2);
		expect({ flat: score(flat), round: score(round) }).toEqual({ flat: { aliased: [37, 18], aa: [35, 62] }, round: { aliased: [34, 6], aa: [13, 125] } });
	});
});
