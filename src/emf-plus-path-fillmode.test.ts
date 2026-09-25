import { describe, it, expect } from 'vitest';

import { emfPlusPathClipShape, isSingleSimpleFigure, parseEmfPlusPath } from './emf-plus-path';
import { flatteningContext, arcBeziers } from './emf-plus-flatten';
import type { ClipPathCmd } from './emf-clip-region';
import type { CanvasContext } from './emf-types';

/** An EmfPlusPath object: version, count, flags, float points, types. */
function pathBytes(flags: number, pts: Array<[number, number]>, types: number[]): DataView {
	const size = 12 + pts.length * 8 + ((pts.length + 3) & ~3);
	const v = new DataView(new ArrayBuffer(size));
	v.setUint32(0, 0xdbc01002, true);
	v.setUint32(4, pts.length, true);
	v.setUint32(8, flags, true);
	pts.forEach(([x, y], i) => {
		v.setFloat32(12 + i * 8, x, true);
		v.setFloat32(16 + i * 8, y, true);
	});
	types.forEach((t, i) => v.setUint8(12 + pts.length * 8 + i, t));
	return v;
}

const SQUARE: Array<[number, number]> = [
	[0, 0],
	[10, 0],
	[10, 10],
	[0, 10],
];

describe('EMF+ path FillMode', () => {
	it('reads Alternate (flags without 0x2000) as even-odd and Winding (0x2000) as nonzero', () => {
		const alt = parseEmfPlusPath(pathBytes(0, SQUARE, [0, 1, 1, 0x81]), 0, 100)!;
		const wind = parseEmfPlusPath(pathBytes(0x2000, SQUARE, [0, 1, 1, 0x81]), 0, 100)!;
		expect(alt.fillRule).toBe('evenodd');
		expect(wind.fillRule).toBe('nonzero');
	});

	it('clips with the path fill rule and marks only a provably simple figure simple', () => {
		const square = parseEmfPlusPath(pathBytes(0x2000, SQUARE, [0, 1, 1, 0x81]), 0, 100)!;
		const shape = emfPlusPathClipShape(square, [1, 0, 0, 1, 0, 0]);
		expect(shape.fillRule).toBe('nonzero');
		expect(shape.simple).toBe(true);
		const bowtie = parseEmfPlusPath(
			pathBytes(0, [[0, 0], [10, 10], [10, 0], [0, 10]], [0, 1, 1, 0x81]),
			0,
			100,
		)!;
		const b = emfPlusPathClipShape(bowtie, [1, 0, 0, 1, 0, 0]);
		expect(b.fillRule).toBe('evenodd');
		expect(b.simple).toBe(false);
	});

	it('treats several figures (which may overlap) as not simple', () => {
		const cmds: ClipPathCmd[] = [
			{ op: 'rect', x: 0, y: 0, w: 10, h: 10 },
			{ op: 'rect', x: 5, y: 5, w: 10, h: 10 },
		];
		expect(isSingleSimpleFigure(cmds)).toBe(false);
		expect(isSingleSimpleFigure([{ op: 'rect', x: 0, y: 0, w: 10, h: 10 }])).toBe(true);
	});
});

describe('GDI+ curve flattening', () => {
	it('builds an ellipse from quarter-turn Beziers with the 4/3 tan(sweep/4) control length', () => {
		const segs = arcBeziers(0, 0, 10, 10, 0, Math.PI * 2);
		expect(segs).toHaveLength(4);
		const k = (4 / 3) * Math.tan(Math.PI / 8);
		expect(segs[0][1].x).toBeCloseTo(10, 10);
		expect(segs[0][1].y).toBeCloseTo(10 * k, 10);
	});

	it('replaces curves with line segments within 0.25 device pixels of the curve', () => {
		const calls: Array<[string, number[]]> = [];
		const target = {
			beginPath: () => calls.push(['beginPath', []]),
			moveTo: (x: number, y: number) => calls.push(['moveTo', [x, y]]),
			lineTo: (x: number, y: number) => calls.push(['lineTo', [x, y]]),
			closePath: () => calls.push(['closePath', []]),
		} as unknown as CanvasContext;
		const c = flatteningContext(target, [2, 0, 0, 2, 0, 0]);
		c.beginPath();
		c.ellipse(20, 20, 10, 10, 0, 0, Math.PI * 2);
		expect(calls.some(([op]) => op === 'bezierCurveTo' || op === 'ellipse')).toBe(false);
		const pts = calls.filter(([op]) => op === 'lineTo' || op === 'moveTo').map(([, a]) => a);
		expect(pts.length).toBeGreaterThan(16);
		for (const [x, y] of pts) {
			// Every vertex lies on the circle (radius 10 world = 20 device pixels).
			expect(Math.abs(Math.hypot(x - 20, y - 20) - 10)).toBeLessThan(0.02);
		}
	});
});
