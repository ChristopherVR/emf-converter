import { describe, it, expect } from 'vitest';

import { arrowCapPath, capPathLength, customCapGeometry, parseCustomLineCap } from './emf-plus-custom-cap';
import type { DeviceFigure } from './emf-plus-raster';

/** Bytes from a hex dump ("02 10 c0 db ..."). */
function bytes(hex: string): DataView {
	const arr = Uint8Array.from(hex.trim().split(/\s+/).map((h) => parseInt(h, 16)));
	return new DataView(arr.buffer);
}

// Real GDI+ recordings (Graphics.FromImage(Metafile), EmfPlusOnly): the
// custom caps of `new AdjustableArrowCap(3, 4, true)` and of
// `new CustomLineCap(null, V, LineCap.Round, 0.5f)` with V = (-1,0)-(0,1)-(1,0).
const ARROW_CAP =
	'02 10 c0 db 01 00 00 00 00 00 40 40 00 00 80 40 00 00 00 00 01 00 00 00 00 00 00 00 00 00 00 00 ' +
	'00 00 00 00 00 00 20 41 00 00 80 3f 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00';
const LINE_CAP =
	'02 10 c0 db 00 00 00 00 02 00 00 00 02 00 00 00 00 00 00 3f 00 00 00 00 00 00 00 00 00 00 00 00 ' +
	'00 00 20 41 00 00 80 3f 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 1c 00 00 00 02 10 c0 db ' +
	'03 00 00 00 00 60 00 00 ff ff 00 00 00 00 01 00 01 00 00 00 00 01 01 00';

const line = (...pts: number[]): DeviceFigure => ({ pts, closed: false, curved: false });

describe('parseCustomLineCap', () => {
	it('reads a recorded AdjustableArrowCap and rebuilds its fill path', () => {
		const v = bytes(ARROW_CAP);
		const cap = parseCustomLineCap(v, 0, v.byteLength)!;
		expect(cap.capType).toBe(1);
		expect(cap.arrow).toEqual({ width: 3, height: 4, middleInset: 0, filled: true });
		expect(cap.baseInset).toBeCloseTo(4 / 3, 6);
		expect(cap.widthScale).toBe(1);
		expect(cap.linePath).toBeNull();
		expect(cap.fillPath!.points).toEqual([
			{ x: 1.5, y: -4 },
			{ x: 0, y: 0 },
			{ x: -1.5, y: -4 },
		]);
		expect(Array.from(cap.fillPath!.types)).toEqual([0, 1, 0x81]);
		expect(cap.fillLength).toBe(4);
	});

	it('reads a recorded default cap with a (compressed) line path', () => {
		const v = bytes(LINE_CAP);
		const cap = parseCustomLineCap(v, 0, v.byteLength)!;
		expect(cap.capType).toBe(0);
		expect(cap.baseCap).toBe(2);
		expect(cap.baseInset).toBe(0.5);
		expect(cap.strokeMiterLimit).toBe(10);
		expect(cap.fillPath).toBeNull();
		expect(cap.linePath!.points).toEqual([
			{ x: -1, y: 0 },
			{ x: 0, y: 1 },
			{ x: 1, y: 0 },
		]);
		// No crossing of the negative y axis: the stroke length is 0 (GDI+ uses 1).
		expect(cap.strokeLength).toBe(0);
	});

	it('rejects short data and unknown types', () => {
		const v = bytes(ARROW_CAP);
		expect(parseCustomLineCap(v, 0, 40)).toBeNull();
		const bad = bytes(ARROW_CAP.replace(/^02 10 c0 db 01/, '02 10 c0 db 07'));
		expect(parseCustomLineCap(bad, 0, bad.byteLength)).toBeNull();
	});
});

describe('capPathLength / arrowCapPath', () => {
	it('is the deepest crossing of the negative y axis', () => {
		const closed = Uint8Array.from([0, 1, 0x81]);
		expect(capPathLength([{ x: -1, y: -1 }, { x: 0, y: 2 }, { x: 1, y: -1 }], closed)).toBe(1);
		// Measured with GraphicsPath.Widen: this triangle's radius is 2.375 pen widths.
		expect(capPathLength([{ x: -3, y: -0.5 }, { x: 0, y: 2 }, { x: 1, y: -3 }], closed)).toBeCloseTo(2.375, 6);
		// Open, crossing only above the origin.
		expect(capPathLength([{ x: -1, y: -1 }, { x: 0, y: 2 }, { x: 1, y: -1 }], Uint8Array.from([0, 1, 1]))).toBe(0);
	});

	it('builds the arrow as GDI+ does (middle point only when filled)', () => {
		const filled = arrowCapPath(3, 4, 1, true);
		expect(filled.points).toEqual([
			{ x: 1.5, y: -4 },
			{ x: 0, y: 0 },
			{ x: -1.5, y: -4 },
			{ x: 0, y: -3 },
		]);
		expect(capPathLength(filled.points, filled.types)).toBe(3);
		const open = arrowCapPath(3, 4, 1, false);
		expect(open.points).toHaveLength(3);
		expect(open.types[2] & 0x80).toBe(0);
	});
});

describe('customCapGeometry', () => {
	const arrow = parseCustomLineCap(bytes(ARROW_CAP), 0, 60)!;
	const v = parseCustomLineCap(bytes(LINE_CAP), 0, 88)!;

	it('shortens a line by BaseInset x scale and places a filled arrow at its end', () => {
		// GraphicsPath.Widen, 4 px pen, (20,50)-(120,50): line to 114.666672,
		// arrow (104,44) (120,50) (104,56).
		const geo = customCapGeometry([line(20, 50, 120, 50)], 4, null, arrow);
		expect(geo.figures).toHaveLength(1);
		expect(geo.figures[0].pts[2]).toBeCloseTo(114.666672, 4);
		expect(geo.figures[0].pts[3]).toBe(50);
		expect(geo.polygons).toHaveLength(1);
		const poly = geo.polygons[0];
		expect(poly[0].x).toBeCloseTo(104, 5);
		expect(poly[0].y).toBeCloseTo(44, 5);
		expect(poly[1]).toEqual({ x: 120, y: 50 });
		expect(poly[2].x).toBeCloseTo(104, 5);
		expect(poly[2].y).toBeCloseTo(56, 5);
	});

	it('points the cap from where its radius meets the line, dropping the vertices inside it', () => {
		// GraphicsPath.Widen of (20,50)-(100,50)-(103,44), 4 px pen, arrow end:
		// line (20,50)-(98.05,46.0), arrow (85.9176,44.43786) (103,44) (90.4176,55.56215).
		const geo = customCapGeometry([line(20, 50, 100, 50, 103, 44)], 4, null, arrow);
		const pts = geo.figures[0].pts;
		expect(pts).toHaveLength(4);
		expect(pts[2]).toBeCloseTo(98.0559, 3);
		expect(pts[3]).toBeCloseTo(46.0, 3);
		const poly = geo.polygons[0];
		expect(poly[0].x).toBeCloseTo(85.9176, 3);
		expect(poly[0].y).toBeCloseTo(44.43786, 3);
		expect(poly[2].x).toBeCloseTo(90.4176, 3);
		expect(poly[2].y).toBeCloseTo(55.56215, 3);
	});

	it('moves the end back along the cap direction even past the previous vertex', () => {
		// A stroke-path cap of radius 4 (scale 4, length 1) with BaseInset 2 on a
		// last segment 6.7 long: Widen ends the line at (99.4223, 51.1553).
		const inset2 = { ...v, baseInset: 2 };
		const geo = customCapGeometry([line(20, 50, 100, 50, 103, 44)], 4, null, inset2);
		const pts = geo.figures[0].pts;
		expect(pts).toHaveLength(6);
		expect(pts[4]).toBeCloseTo(99.4223, 3);
		expect(pts[5]).toBeCloseTo(51.1553, 3);
		// The cap's V is widened with the pen width (miter tip 2 / sin 45 past it).
		const xs = geo.polygons.flat().map((p) => p.x);
		expect(Math.max(...xs)).toBeGreaterThan(104.7);
	});

	it('widens a stroke-path cap at least one pixel wide and draws a fill cap at scale 2 or more', () => {
		const thin = customCapGeometry([line(10, 50, 60, 50)], 0.25, null, arrow);
		const tip = thin.polygons[0][1];
		expect(tip).toEqual({ x: 60, y: 50 });
		// Scale max(0.25, 2) = 2: the base is 8 px back.
		expect(thin.polygons[0][0].x).toBeCloseTo(52, 5);
		const stroked = customCapGeometry([line(10, 50, 60, 50)], 0.25, null, v);
		// Half width 0.5 around a 0.25-scaled V.
		const ys = stroked.polygons.flat().map((p) => p.y);
		expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(1);
	});

	it('leaves closed figures alone and drops a figure shorter than the cap', () => {
		const closed: DeviceFigure = { pts: [10, 10, 60, 10, 30, 40], closed: true, curved: false };
		const geo = customCapGeometry([closed], 4, arrow, arrow);
		expect(geo.figures).toEqual([closed]);
		expect(geo.polygons).toHaveLength(0);
		const short = customCapGeometry([line(10, 10, 13, 10)], 4, null, arrow);
		expect(short.figures).toHaveLength(0);
		expect(short.polygons).toHaveLength(1);
	});

	it('does not mutate its input', () => {
		const fig = line(20, 50, 120, 50);
		customCapGeometry([fig], 4, arrow, arrow);
		expect(fig.pts).toEqual([20, 50, 120, 50]);
	});
});
