/**
 * Unit tests for the EMF+ records and objects added alongside the
 * `emfplus-records` fixtures: point encodings, cardinal splines, arc angles,
 * container transforms, terminal-server clip rectangles, hatch patterns,
 * SourceCopy compositing and region masks. Golden values were read back
 * from GDI+ itself (GraphicsPath points, HatchBrush pixels).
 */
import { describe, expect, it } from 'vitest';

import { hatchMix, hatchTile, hatchWeight, HATCH_PATTERNS } from './emf-plus-brush-hatch';
import { ellipseArcAngles } from './emf-plus-draw-handlers';
import { sourceCopyPixels } from './emf-plus-exact-fill';
import { arcBeziers } from './emf-plus-flatten';
import { toPlusFix } from './emf-plus-raster';
import { readPlusPoints, readPointRCoord, PLUS_FLAG_COMPRESSED, PLUS_FLAG_RELATIVE } from './emf-plus-read-helpers';
import { maskBounds, regionPixelMask } from './emf-plus-region-mask';
import { cardinalSplineBeziers } from './emf-plus-spline';
import { containerRectTransform, decodeTsClipRects } from './emf-plus-state-handlers';

function bytes(...v: number[]): DataView {
	return new DataView(new Uint8Array(v).buffer);
}

describe('EmfPlusPointR (relative points)', () => {
	it('reads one byte when the top bit is set (7-bit signed), else two bytes big-endian (15-bit signed)', () => {
		expect(readPointRCoord(bytes(0x80 | 10), 0, 1)).toStrictEqual({ value: 10, size: 1 });
		expect(readPointRCoord(bytes(0x80 | 0x7f), 0, 1)).toStrictEqual({ value: -1, size: 1 });
		expect(readPointRCoord(bytes(0x80 | 0x40), 0, 1)).toStrictEqual({ value: -64, size: 1 });
		expect(readPointRCoord(bytes(0x01, 0x2c), 0, 2)).toStrictEqual({ value: 300, size: 2 });
		expect(readPointRCoord(bytes(0x7e, 0xd4), 0, 2)).toStrictEqual({ value: -300, size: 2 });
		expect(readPointRCoord(bytes(0x01), 0, 1)).toBeNull();
	});

	it('accumulates deltas from (0, 0) and rejects data that runs out', () => {
		// (10,10) then (+100, +5) then (-50, +60).
		const v = bytes(0x8a, 0x8a, 0x00, 0x64, 0x85, 0x80 | (-50 & 0x7f), 0x80 | 60);
		expect(readPlusPoints(v, 0, 7, 3, PLUS_FLAG_RELATIVE | PLUS_FLAG_COMPRESSED)).toStrictEqual([
			{ x: 10, y: 10 },
			{ x: 110, y: 15 },
			{ x: 60, y: 75 },
		]);
		expect(readPlusPoints(v, 0, 7, 4, PLUS_FLAG_RELATIVE)).toBeNull();
	});

	it('reads absolute 16-bit and float points', () => {
		const buf = new DataView(new ArrayBuffer(16));
		buf.setInt16(0, -5, true);
		buf.setInt16(2, 7, true);
		expect(readPlusPoints(buf, 0, 4, 1, PLUS_FLAG_COMPRESSED)).toStrictEqual([{ x: -5, y: 7 }]);
		buf.setFloat32(8, 1.5, true);
		buf.setFloat32(12, -2.25, true);
		expect(readPlusPoints(buf, 8, 16, 1, 0)).toStrictEqual([{ x: 1.5, y: -2.25 }]);
		expect(readPlusPoints(buf, 8, 16, 2, 0)).toBeNull();
	});
});

describe('cardinalSplineBeziers', () => {
	const pts = [
		{ x: 80, y: 10 },
		{ x: 120, y: 40 },
		{ x: 150, y: 20 },
		{ x: 130, y: 90 },
		{ x: 90.5, y: 70.25 },
	];
	const close = (got: Array<{ x: number; y: number }>, want: number[]): void => {
		expect(got.flatMap((p) => [p.x, p.y]).map((v) => Math.round(v * 1e3) / 1e3)).toStrictEqual(want.map((v) => Math.round(v * 1e3) / 1e3));
	};

	it("matches GraphicsPath.AddCurve at tension 0.5 and 1 (GDI+'s own control points)", () => {
		close(cardinalSplineBeziers(pts, 0.5, false), [
			80, 10, 86.667, 15, 108.333, 38.333, 120, 40, 131.667, 41.667, 148.333, 11.667, 150, 20, 151.667, 28.333, 139.917, 81.625, 130, 90, 120.083,
			98.375, 97.083, 73.542, 90.5, 70.25,
		]);
		close(cardinalSplineBeziers(pts, 1, false).slice(0, 4), [80, 10, 93.333, 20, 96.667, 36.667, 120, 40]);
	});

	it('closes a closed curve through the first point with wrapped tangents', () => {
		const bez = cardinalSplineBeziers(pts, 0.5, true);
		expect(bez).toHaveLength(1 + 3 * 5);
		close(bez.slice(0, 2), [80, 10, 84.917, 4.958]);
		close(bez.slice(-3), [82.167, 56.917, 75.083, 15.042, 80, 10]);
	});

	it('draws a run of segments of the whole curve (Offset, NumberOfSegments)', () => {
		close(cardinalSplineBeziers(pts, 0.5, false, 1, 2), [120, 40, 131.667, 41.667, 148.333, 11.667, 150, 20, 151.667, 28.333, 139.917, 81.625, 130, 90]);
		expect(cardinalSplineBeziers(pts, 0.5, false, 4, 1)).toStrictEqual([]);
		expect(cardinalSplineBeziers(pts.slice(0, 2), 0.5, true)).toStrictEqual([]);
	});
});

describe('GDI+ arcs', () => {
	it('measures arc angles as ray directions (GraphicsPath.AddArc start point)', () => {
		const { start, sweep } = ellipseArcAngles(30, 200, 25, 20);
		expect(35 + 25 * Math.cos(start)).toBeCloseTo(55.2721176, 4);
		expect(40 + 20 * Math.sin(start)).toBeCloseTo(51.7041054, 4);
		expect(35 + 25 * Math.cos(start + sweep)).toBeCloseTo(21.0662441, 4);
		expect(ellipseArcAngles(0, 400, 10, 5).sweep).toBeCloseTo(2 * Math.PI);
		expect(ellipseArcAngles(200, -120, 25, 20).sweep).toBeLessThan(0);
	});

	it('splits an arc into whole quarter turns from its start, then the remainder', () => {
		const { start, sweep } = ellipseArcAngles(30, 200, 25, 20);
		const segs = arcBeziers(35, 40, 25, 20, start, sweep);
		expect(segs).toHaveLength(3);
		// GraphicsPath.AddArc(10, 20, 50, 40, 30, 200): first segment end and last controls.
		expect(segs[0][3].x).toBeCloseTo(20.3698635, 3);
		expect(segs[0][3].y).toBeCloseTo(56.2177, 3);
		expect(segs[2][1].x).toBeCloseTo(16.4610615, 3);
		expect(segs[2][2].y).toBeCloseTo(24.7150078, 3);
	});
});

describe("GDI+'s float to 28.4 conversion", () => {
	it('rounds to 1/256 first, then up to the next sixteenth', () => {
		expect(toPlusFix(48.12606)).toBe(770); // GraphicsPath.Flatten: 48.125
		expect(toPlusFix(5.7)).toBe(92); // 5.75
		expect(toPlusFix(82.85)).toBe(1326);
		expect(toPlusFix(10)).toBe(160);
		expect(toPlusFix(-0.01) + 0).toBe(0);
	});
});

describe('containerRectTransform', () => {
	it('maps the source rectangle, in its unit, onto the destination rectangle', () => {
		expect(containerRectTransform({ x: 0, y: 0, w: 60, h: 40 }, { x: 0, y: 0, w: 30, h: 20 }, 2)).toStrictEqual([2, 0, 0, 2, 0, 0]);
		const t = containerRectTransform({ x: 0, y: 0, w: 40, h: 30 }, { x: 5, y: 5, w: 40, h: 30 }, 2)!;
		expect(t[0] * 5 + t[4]).toBeCloseTo(0);
		const mm = containerRectTransform({ x: 10, y: 0, w: 20, h: 20 }, { x: 0, y: 0, w: 10, h: 10 }, 6)!;
		expect(mm[0]).toBeCloseTo(20 / ((10 * 96) / 25.4));
		expect(containerRectTransform({ x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 0, h: 1 }, 2)).toBeNull();
	});
});

describe('decodeTsClipRects', () => {
	it('decodes compressed deltas: left, top from the previous bottom, right, height', () => {
		const v = bytes(0x80 | 20, 0x80 | 10, 0x00, 100, 0x80 | 50, 0x80 | 10, 0x80 | 5, 0x80 | 40, 0x80 | 20);
		expect(decodeTsClipRects(v, 0, 9, 0x8002)).toStrictEqual([
			{ l: 20, t: 10, r: 100, b: 60 },
			{ l: 30, t: 65, r: 140, b: 85 },
		]);
		expect(decodeTsClipRects(v, 0, 8, 0x8002)).toBeNull();
	});

	it('decodes uncompressed rectangles as absolute 16-byte RECTLs', () => {
		const buf = new DataView(new ArrayBuffer(16));
		[10, 10, 70, 40].forEach((n, i) => buf.setInt32(i * 4, n, true));
		expect(decodeTsClipRects(buf, 0, 16, 1)).toStrictEqual([{ l: 10, t: 10, r: 70, b: 40 }]);
		expect(decodeTsClipRects(buf, 0, 16, 2)).toBeNull();
	});
});

describe('hatch brushes', () => {
	it('holds the 53 GDI+ patterns', () => {
		expect(HATCH_PATTERNS).toHaveLength(53);
		expect(hatchWeight(0, 3, 0)).toBe(256); // Horizontal: the top row
		expect(hatchWeight(0, 3, 1)).toBe(0);
		expect(hatchWeight(52, 3, 3)).toBe(256); // SolidDiamond centre row
		expect(hatchWeight(99, 0, 0)).toBe(0);
	});

	it('antialiases the three diagonal styles like GDI+ (234/256 on the line, 64/256 beside it)', () => {
		expect(hatchWeight(2, 3, 3)).toBe(234);
		expect(hatchWeight(2, 4, 3)).toBe(64);
		expect(hatchWeight(3, 7, 0)).toBe(234);
		expect(hatchWeight(5, 3, 4)).toBe(234);
		// GDI+ pixels, black on white: 0x15 on the line, 0xbf beside it.
		expect(hatchMix(0xff000000, 0xffffffff, 234) & 0xff).toBe(0x15);
		expect(hatchMix(0xff000000, 0xffffffff, 64) & 0xff).toBe(0xbf);
		// Colour pair (200,40,100) on (10,220,60): 0xb73760 and 0x39af46.
		expect(hatchMix(0xffc82864, 0xff0adc3c, 234)).toBe(0xffb73760);
		expect(hatchMix(0xffc82864, 0xff0adc3c, 64)).toBe(0xff39af46);
	});

	it('builds the 8 x 8 tile', () => {
		const tile = hatchTile({ style: 1, fore: 0xff112233, back: 0xffffffff });
		expect(Array.from(tile.slice(0, 4))).toStrictEqual([0x11, 0x22, 0x33, 255]);
		expect(Array.from(tile.slice(4, 8))).toStrictEqual([255, 255, 255, 255]);
	});
});

describe('sourceCopyPixels', () => {
	it('keeps the brush colour and scales its alpha by the coverage, dropping the destination', () => {
		const data = new Uint8ClampedArray([200, 40, 40, 128, 200, 40, 40, 128, 200, 40, 40, 128]);
		const dst = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
		sourceCopyPixels(data, dst, new Uint8ClampedArray([255, 128, 0]));
		expect(Array.from(data)).toStrictEqual([200, 40, 40, 128, 200, 40, 40, 64, 200, 40, 40, 0]);
	});
});

describe('regionPixelMask', () => {
	it('evaluates the region tree pixel by pixel', () => {
		const box = { x: 0, y: 0, w: 10, h: 10 };
		const a = { type: 'rect' as const, x: 1, y: 1, width: 5, height: 5 };
		const b = { type: 'rect' as const, x: 3, y: 3, width: 5, height: 5 };
		const count = (m: Uint8Array | null): number => (m ? m.reduce((s, v) => s + v, 0) : -1);
		const id: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
		expect(count(regionPixelMask({ type: 'combine', combineMode: 1, left: a, right: b }, id, box, false))).toBe(9);
		expect(count(regionPixelMask({ type: 'combine', combineMode: 2, left: a, right: b }, id, box, false))).toBe(41);
		expect(count(regionPixelMask({ type: 'combine', combineMode: 3, left: a, right: b }, id, box, false))).toBe(32);
		expect(count(regionPixelMask({ type: 'combine', combineMode: 4, left: a, right: b }, id, box, false))).toBe(16);
		expect(count(regionPixelMask({ type: 'combine', combineMode: 5, left: a, right: b }, id, box, false))).toBe(16);
		expect(count(regionPixelMask({ type: 'infinite' }, id, box, false))).toBe(100);
		expect(maskBounds(regionPixelMask(a, id, box, false)!, box)).toStrictEqual({ x: 1, y: 1, w: 5, h: 5 });
		expect(maskBounds(new Uint8Array(100), box)).toBeNull();
	});
});
