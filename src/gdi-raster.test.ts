/**
 * Unit tests for the GDI rasteriser (`gdi-raster.ts`, `gdi-raster-widen.ts`).
 * The expected values are GDI's own, taken from real Windows output (the
 * `raster-*` parity fixtures cover the same rules end to end).
 */
import { describe, expect, it } from 'vitest';

import {
	arcBeziers,
	cosmeticLine,
	cosmeticStyle,
	ellipseBeziers,
	ellipseBeziersBox,
	fillPolygonSpans,
	flattenBezier,
	geometricStyle,
	GdiRasterPath,
	roundRectCorners,
	SpanList,
	strokeCosmetic,
	styleGapsUseBackground,
	toFix,
} from './gdi-raster';
import { penNib, widenPath } from './gdi-raster-widen';

/** Lit pixels of a line as "x,y" strings, in drawing order. */
function line(x0: number, y0: number, x1: number, y1: number): string[] {
	const out: string[] = [];
	cosmeticLine(x0 * 16, y0 * 16, x1 * 16, y1 * 16, (x, y) => out.push(`${x},${y}`));
	return out;
}

/** All pixels covered by `spans`, as "x,y" strings. */
function pixels(spans: SpanList): Set<string> {
	const s = new Set<string>();
	for (let i = 0; i < spans.length * 3; i += 3) {
		for (let x = spans.data[i + 1]; x < spans.data[i + 2]; x++) {
			s.add(`${x},${spans.data[i]}`);
		}
	}
	return s;
}

describe('SpanList', () => {
	it('merges a span that continues the previous one on the same row', () => {
		const s = new SpanList();
		s.add(3, 1, 2);
		s.add(3, 2, 5);
		s.add(4, 5, 6);
		expect(s.length).toBe(2);
		expect(Array.from(s.data.slice(0, 6))).toEqual([3, 1, 5, 4, 5, 6]);
		expect(s.bounds()).toEqual({ x0: 1, y0: 3, x1: 6, y1: 5 });
	});

	it('ignores empty spans and grows past its initial capacity', () => {
		const s = new SpanList();
		s.add(0, 4, 4);
		for (let i = 0; i < 100; i++) {
			s.add(i, 0, 1);
		}
		expect(s.length).toBe(100);
	});
});

describe('toFix', () => {
	it('rounds device pixels to 28.4 fixed point', () => {
		expect(toFix(1)).toBe(16);
		expect(toFix(0.53)).toBe(8);
		expect(toFix(-0.5)).toBe(-8);
	});
});

describe('cosmeticLine (GIQ)', () => {
	it('excludes the end pixel and lights one pixel per major step', () => {
		expect(line(0, 0, 4, 0)).toEqual(['0,0', '1,0', '2,0', '3,0']);
		expect(line(0, 0, 0, -3)).toEqual(['0,0', '0,-1', '0,-2']);
	});

	it('rounds an exact half towards the smaller minor coordinate (integer end points)', () => {
		// y = x / 2: at x = 1 the line passes exactly between rows 0 and 1.
		expect(line(0, 0, 4, 2)).toEqual(['0,0', '1,0', '2,1', '3,1']);
		expect(line(4, 2, 0, 0)).toEqual(['4,2', '3,1', '2,1', '1,0']);
		// x-minor tie on a y-major line.
		expect(line(0, 0, 2, 4)).toEqual(['0,0', '0,1', '1,2', '1,3']);
	});

	it('handles 28.4 fractional end points with the diamond-exit rule', () => {
		// (24.625, 14.125) -> (33.5, 13.875): GDI lights columns 25..33 on row 14.
		const out: string[] = [];
		cosmeticLine(394, 226, 536, 222, (x, y) => out.push(`${x},${y}`));
		expect(out).toEqual(['25,14', '26,14', '27,14', '28,14', '29,14', '30,14', '31,14', '32,14', '33,14']);
	});

	it('draws nothing for a zero-length line', () => {
		expect(line(3, 3, 3, 3)).toEqual([]);
	});
});

describe('fillPolygonSpans', () => {
	it('drops the right column and bottom row of an integer rectangle', () => {
		const px = pixels(fillPolygonSpans([[0, 0, 64, 0, 64, 48, 0, 48]], false));
		expect(px.size).toBe(4 * 3);
		expect(px.has('0,0')).toBe(true);
		expect(px.has('3,2')).toBe(true);
		expect(px.has('4,0')).toBe(false);
		expect(px.has('0,3')).toBe(false);
	});

	it('includes a pixel whose centre lies on a left or top edge only', () => {
		// Box 0.5..2.5 (FIX 8..40): centres 1 and 2 are strictly inside.
		const px = pixels(fillPolygonSpans([[8, 8, 40, 8, 40, 40, 8, 40]], false));
		expect([...px].sort()).toEqual(['1,1', '1,2', '2,1', '2,2']);
	});

	it('distinguishes ALTERNATE from WINDING for nested, same-direction figures', () => {
		const outer = [0, 0, 160, 0, 160, 160, 0, 160];
		const inner = [48, 48, 112, 48, 112, 112, 48, 112];
		const alternate = pixels(fillPolygonSpans([outer, inner], false));
		const winding = pixels(fillPolygonSpans([outer, inner], true));
		expect(alternate.has('5,5')).toBe(false);
		expect(winding.has('5,5')).toBe(true);
		expect(winding.size).toBe(100);
		expect(alternate.size).toBe(100 - 16);
	});

	it('clips rows to the requested range', () => {
		const px = pixels(fillPolygonSpans([[0, 0, 64, 0, 64, 64, 0, 64]], false, new SpanList(), 1, 3));
		expect(new Set([...px].map((p) => p.split(',')[1]))).toEqual(new Set(['1', '2']));
	});
});

describe('flattenBezier (GDI HFD)', () => {
	it('subdivides a 100 px curve into 16 uniform steps, rounded to FIX', () => {
		const out: number[] = [];
		flattenBezier(0, 0, 0, 1600, 1600, 1600, 1600, 0, out);
		expect(out.length / 2).toBe(16);
		expect(out.slice(0, 2)).toEqual([18, 281]);
		expect(out.slice(14, 16)).toEqual([800, 1200]);
		expect(out.slice(-2)).toEqual([1600, 0]);
	});

	it('emits a straight Bezier as one segment', () => {
		const out: number[] = [];
		flattenBezier(0, 0, 160, 0, 320, 0, 480, 0, out);
		expect(out).toEqual([480, 0]);
	});

	it('adapts the step along an asymmetric curve (matches GDI point for point)', () => {
		const out: number[] = [];
		flattenBezier(0, 0, 0, 88, 72, 160, 160, 160, out);
		expect(out).toEqual([13, 62, 47, 113, 98, 147, 160, 160]);
	});
});

describe('ellipseBeziers', () => {
	it('builds the path GDI builds for an inclusive box (GetPath)', () => {
		// Ellipse(32, 32, 352, 192) at 28.4 precision.
		expect(ellipseBeziers(32, 32, 352, 192)).toEqual([
			352, 112, 352, 68, 281, 32, 192, 32, 103, 32, 32, 68, 32, 112, 32, 156, 103, 192, 192, 192, 281, 192, 352, 156, 352, 112,
		]);
	});

	it('rounds odd half-extents the way GDI does', () => {
		// Height 5: right mid rounds down the box (3), left mid up it (2).
		const e = ellipseBeziers(0, 0, 200, 5);
		expect(e[1]).toBe(3);
		expect(e[13]).toBe(2);
	});

	it('applies the same componentwise rounding to a parallelogram', () => {
		const axis = ellipseBeziers(10, 20, 110, 70);
		const box = ellipseBeziersBox({ ax: 10, ay: 20, exx: 100, exy: 0, eyx: 0, eyy: 50 });
		expect(box).toEqual(axis);
	});
});

describe('roundRectCorners', () => {
	it('mirrors the top-right corner into the other three', () => {
		const q = roundRectCorners(0, 0, 320, 160, 96, 64);
		expect(q.slice(0, 8)).toEqual([320, 32, 320, 15, 299, 0, 272, 0]);
		expect(q.slice(8, 16)).toEqual([48, 0, 21, 0, 0, 15, 0, 32]);
		expect(q.slice(24, 32)).toEqual([272, 160, 299, 160, 320, 145, 320, 128]);
	});

	it('clamps the corner ellipse to the box', () => {
		const q = roundRectCorners(0, 0, 100, 40, 1000, 1000);
		expect(q[1]).toBe(20); // half the height
		expect(q[6]).toBe(50); // half the width
	});
});

describe('arcBeziers', () => {
	it('runs counter-clockwise through the top by default', () => {
		const a = arcBeziers(32, 32, 352, 192, 352, 32, 32, 32, false);
		// Starts on the radial towards the top-right, passes the top mid point.
		expect(a.slice(0, 2)).toEqual([305, 55]);
		expect(a).toContain(192);
		const ys = a.filter((_, i) => i % 2 === 1);
		expect(Math.min(...ys)).toBe(32);
		expect(Math.max(...ys)).toBeLessThan(112);
	});

	it('runs through the bottom when clockwise', () => {
		const a = arcBeziers(32, 32, 352, 192, 352, 32, 32, 32, true);
		const ys = a.filter((_, i) => i % 2 === 1);
		expect(Math.max(...ys)).toBe(192);
	});

	it('draws the whole ellipse when both radials coincide', () => {
		const a = arcBeziers(0, 0, 160, 160, 200, 80, 200, 80, false);
		expect(a.length).toBe(2 + 4 * 6);
	});
});

describe('GdiRasterPath', () => {
	it('keeps figures, closes them, and starts a new figure after a close', () => {
		const p = new GdiRasterPath();
		p.moveTo(0, 0);
		p.lineTo(16, 0);
		p.lineTo(16, 16);
		p.closeFigure();
		p.lineTo(32, 32);
		expect(p.figures.length).toBe(2);
		expect(p.figures[0].closed).toBe(true);
		expect(p.figures[1].pts).toEqual([0, 0, 32, 32]);
	});

	it('flattens Beziers as they are added', () => {
		const p = new GdiRasterPath();
		p.moveTo(0, 0);
		p.bezierTo(0, 1600, 1600, 1600, 1600, 0);
		expect(p.figures[0].pts.length).toBe(2 + 32);
	});
});

describe('pen styles', () => {
	it('uses GDI’s cosmetic dash lengths', () => {
		expect(cosmeticStyle(1)).toEqual([18, 6]);
		expect(cosmeticStyle(2)).toEqual([3, 3]);
		expect(cosmeticStyle(3)).toEqual([9, 6, 3, 6]);
		expect(cosmeticStyle(4)).toEqual([9, 3, 3, 3, 3, 3]);
		expect(cosmeticStyle(8)).toEqual([1, 1]);
		expect(cosmeticStyle(7, [3, 2, 5, 1])).toEqual([9, 6, 15, 3]);
		expect(cosmeticStyle(0)).toBeNull();
	});

	it('scales the geometric styles by the pen width', () => {
		expect(geometricStyle(0x10001, 3)).toEqual([9, 3]);
		expect(geometricStyle(0x10002, 4)).toEqual([4, 4]);
		expect(geometricStyle(0x10007, 3, [3, 2], 1)).toEqual([3, 2]);
		expect(geometricStyle(0x10008, 3)).toBeNull();
	});

	it('paints stock-style gaps with the background colour only', () => {
		expect(styleGapsUseBackground(1)).toBe(true);
		expect(styleGapsUseBackground(8)).toBe(false);
		expect(styleGapsUseBackground(7)).toBe(false);
	});

	it('steps a dash pattern once per lit pixel and restarts per figure', () => {
		const p = new GdiRasterPath();
		p.moveTo(0, 0);
		p.lineTo(40 * 16, 0);
		p.moveTo(0, 32);
		p.lineTo(8 * 16, 32);
		const on = new SpanList();
		const off = new SpanList();
		strokeCosmetic(p, on, off, [18, 6]);
		const row0 = [...pixels(on)].filter((q) => q.endsWith(',0')).length;
		expect(row0).toBe(18 + 16); // 0..17 on, 18..23 off, 24..39 on
		expect([...pixels(off)].filter((q) => q.endsWith(',0')).length).toBe(6);
		expect([...pixels(on)].filter((q) => q.endsWith(',2')).length).toBe(8);
	});
});

describe('widenPath', () => {
	it('uses GDI’s pixel nibs for pens up to six pixels', () => {
		expect(penNib(16)).toEqual([0, -8, -7, 0, 0, 8, 7, 0]);
		expect(penNib(48).length).toBe(16);
	});

	it('covers a round-capped horizontal line with GDI’s thickness', () => {
		const p = new GdiRasterPath();
		p.moveTo(64, 80);
		p.lineTo(288, 80);
		const polys = widenPath(p, { width: 48, cap: 'round', join: 'round', miterLimit: 10 });
		const px = pixels(fillPolygonSpans(polys, true));
		// A 3 px pen along row 5 covers rows 4..6.
		expect(new Set([...px].map((q) => q.split(',')[1]))).toEqual(new Set(['4', '5', '6']));
	});

	it('splits a dashed pen into separately capped dashes', () => {
		const p = new GdiRasterPath();
		p.moveTo(0, 80);
		p.lineTo(40 * 16, 80);
		const polys = widenPath(p, { width: 48, cap: 'flat', join: 'miter', miterLimit: 10, dashes: [9 * 16, 3 * 16] });
		expect(polys.length).toBe(4);
	});
});
