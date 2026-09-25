import { describe, it, expect } from 'vitest';

import { figuresBox, rasterizePlusFill, recordDeviceFigures, recordPlusFigures, toPlusFix } from './emf-plus-raster';
import type { CanvasContext, TransformMatrix } from './emf-types';

const IDENTITY: TransformMatrix = [1, 0, 0, 1, 0, 0];

/** A square figure in 28.4 from device pixel corners. */
function square(x0: number, y0: number, x1: number, y1: number): number[] {
	return [x0, y0, x1, y0, x1, y1, x0, y1].map((v) => v * 16);
}

describe('toPlusFix', () => {
	it('rounds up to the next sixteenth, keeping exact sixteenths', () => {
		expect(toPlusFix(5.7)).toBe(92); // 91.2 -> 92 (GDI+: the ellipse top at 5.7 lands at 5.75)
		expect(toPlusFix(56.5)).toBe(904);
		expect(toPlusFix(10 + 1 / 64)).toBe(161);
		expect(toPlusFix(3 + 1e-9)).toBe(48); // double-precision noise stays put
	});
});

describe('rasterizePlusFill', () => {
	const box = { x: 0, y: 0, w: 6, h: 4 };

	it('paints a pixel aliased when its integer sample point is inside (top-left rule)', () => {
		// [1, 3) x [1, 2): samples at x = 1, 2 and y = 1.
		const cov = rasterizePlusFill([square(1, 1, 3, 2)], false, false, false, box);
		const lit = [...cov].map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
		expect(lit).toEqual([1 * 6 + 1, 1 * 6 + 2]);
	});

	it('samples half a pixel later under PixelOffsetMode Half', () => {
		// [1, 3) x [1, 2) sampled at x + 0.5: pixels 1 and 2 of row 1 (1.5, 2.5 inside).
		const cov = rasterizePlusFill([square(1, 1, 3, 2)], false, false, true, box);
		expect(cov[1 * 6 + 1]).toBe(255);
		expect(cov[1 * 6 + 2]).toBe(255);
		expect(cov[1 * 6 + 3]).toBe(0);
	});

	it('counts an 8 x 4 sample grid when antialiased', () => {
		// x from 1.25: pixel 1's samples at 0.5 + i/8 inside for i >= 6 (1.25, 1.375): 2 of 8 columns.
		const fig = [1.25, 0.5, 4, 0.5, 4, 1.5, 1.25, 1.5].map((v) => v * 16);
		const cov = rasterizePlusFill([fig], false, true, false, box);
		expect(cov[1 * 6 + 1]).toBe(Math.round((2 * 4 * 255) / 32));
		expect(cov[1 * 6 + 2]).toBe(255);
	});

	it('fills nonzero or even-odd', () => {
		const outer = square(0, 0, 6, 4);
		const inner = square(2, 1, 4, 3);
		expect(rasterizePlusFill([outer, inner], false, false, false, box)[2 * 6 + 2]).toBe(255);
		expect(rasterizePlusFill([outer, inner], true, false, false, box)[2 * 6 + 2]).toBe(0);
	});
});

describe('recordPlusFigures', () => {
	it('flattens an ellipse by GDI+ HFD onto 1/16-pixel points', () => {
		const figs = recordDeviceFigures((c) => c.ellipse(31.4, 24.65, 25.1, 18.95, 0, 0, 2 * Math.PI), IDENTITY);
		expect(figs).toHaveLength(1);
		// GraphicsPath.Flatten of this ellipse: 33 points, the first three below.
		expect(figs[0].pts.slice(0, 6)).toEqual([56.5, 24.6875, 56, 28.5, 54.5625, 32.0625]);
		expect(figs[0].pts.length / 2).toBe(33);
		expect(figs[0].curved).toBe(true);
	});

	it('rounds an axis-aligned rectangle to the nearest sixteenth when aliased', () => {
		const build = (c: CanvasContext): void => c.rect(10 + 1 / 64, 5, 40, 30);
		expect(recordPlusFigures(build, IDENTITY, true)[0][0]).toBe(160);
		expect(recordPlusFigures(build, IDENTITY, false)[0][0]).toBe(161);
	});

	it('throws for a path call it does not model', () => {
		expect(() => recordPlusFigures((c) => c.arc(0, 0, 1, 0, 1), IDENTITY)).toThrow();
	});
});

describe('figuresBox', () => {
	it('bounds the figures with a margin, clamped to the surface', () => {
		expect(figuresBox([square(2, 3, 5, 4)], { w: 10, h: 10 })).toEqual({ x: 1, y: 2, w: 6, h: 4 });
		expect(figuresBox([square(20, 20, 30, 30)], { w: 10, h: 10 })).toBeNull();
	});
});
