import { describe, it, expect } from 'vitest';

import {
	axisFilter,
	cubicKernel,
	isHalfPixelOffset,
	mirroredOrigin,
	resampleImage,
	resampleNearest,
	resampleKernelFor,
} from './emf-plus-image-resample';
import type { DeferredImageResample } from './emf-types';

/** A 2x1 bitmap: opaque black, opaque white. */
const RGBA = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);

function spec(overrides: Partial<DeferredImageResample> = {}): DeferredImageResample {
	return {
		srcX: 0,
		srcY: 0,
		srcW: 2,
		srcH: 1,
		// 2x scale placed at device (10, 5).
		toDevice: [2, 0, 0, 2, 10, 5],
		kernel: 'bilinear',
		halfPixelOffset: false,
		...overrides,
	};
}

/** Red channel and alpha of device row 5 from x = 10 to 13 within a block. */
function row(block: NonNullable<ReturnType<typeof resampleImage>>): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	for (let x = 10; x < 14; x++) {
		const o = ((5 - block.y) * block.w + (x - block.x)) * 4;
		out.push([block.rgba[o], block.rgba[o + 3]]);
	}
	return out;
}

describe('resampleKernelFor / isHalfPixelOffset', () => {
	it('maps GDI+ InterpolationMode to a kernel', () => {
		expect(resampleKernelFor(0)).toBe('bilinear'); // Default
		expect(resampleKernelFor(3)).toBe('bilinear');
		expect(resampleKernelFor(5)).toBe('nearest');
		expect(resampleKernelFor(1)).toBe('bilinear'); // LowQuality
		expect(resampleKernelFor(4)).toBe('bicubic');
		expect(resampleKernelFor(6)).toBe('hq-bilinear');
		expect(resampleKernelFor(7)).toBe('hq-bicubic');
		expect(resampleKernelFor(2)).toBe('hq-bicubic'); // HighQuality
		expect(resampleKernelFor(99)).toBe('bilinear');
	});

	it('treats Half and HighQuality as pixel-centre offsets', () => {
		expect(isHalfPixelOffset(4)).toBe(true);
		expect(isHalfPixelOffset(2)).toBe(true);
		expect(isHalfPixelOffset(0)).toBe(false);
		expect(isHalfPixelOffset(3)).toBe(false);
	});
});

describe('resampleImage', () => {
	it('blends bilinearly on the GDI+ PixelOffsetMode None grid, fading the far edge out', () => {
		const block = resampleImage(RGBA, 2, 1, spec(), { w: 100, h: 100 })!;
		// u = (x - 10) / 2: 0 (black), 0.5 (half), 1 (white), 1.5 (white fading to transparent).
		expect(row(block)).toEqual([
			[0, 255],
			[128, 255],
			[255, 255],
			[255, 128],
		]);
	});

	it('picks the nearest texel for NearestNeighbor, a half rounding up', () => {
		const block = resampleImage(RGBA, 2, 1, spec({ kernel: 'nearest' }), { w: 100, h: 100 })!;
		// u = 0, 0.5, 1, 1.5: texel i sits at i, so 0.5 already picks texel 1,
		// and 1.5 picks texel 2, outside the image: GDI+ leaves the last half
		// texel along the far edges unpainted (measured on a 9 -> 36 texel draw).
		expect(row(block)).toEqual([
			[0, 255],
			[255, 255],
			[255, 255],
			[0, 0],
		]);
	});

	it('leaves pixels outside the destination transparent and clips to the surface', () => {
		const block = resampleImage(RGBA, 2, 1, spec(), { w: 12, h: 100 })!;
		expect(block.x + block.w).toBeLessThanOrEqual(12);
		const o = ((5 - block.y) * block.w + (9 - block.x)) * 4;
		expect(block.rgba[o + 3]).toBe(0);
	});

	it('returns null for a singular mapping', () => {
		expect(resampleImage(RGBA, 2, 1, spec({ toDevice: [0, 0, 0, 0, 0, 0] }), { w: 10, h: 10 })).toBeNull();
	});
});

describe('GDI+ resampling kernels', () => {
	it('uses Catmull-Rom (a = -0.5) for Bicubic and a = -1 for the high-quality cubic', () => {
		expect(cubicKernel(0, -0.5)).toBe(1);
		expect(cubicKernel(0.5, -0.5)).toBeCloseTo(0.5625, 10);
		expect(cubicKernel(1.25, -0.5)).toBeCloseTo(-0.0703125, 10);
		expect(cubicKernel(2, -1)).toBe(0);
	});

	it('point-samples the tent and cubic for Bilinear/Bicubic at any scale', () => {
		// Measured GDI+ weights, 31 -> 10 texels (s = 0.32): x = 1 -> u = 3.1.
		const bl = axisFilter('bilinear', 10 / 31, false);
		expect(bl.weight(3, 3.1)).toBeCloseTo(0.9, 10);
		expect(bl.weight(4, 3.1)).toBeCloseTo(0.1, 10);
		const bc = axisFilter('bicubic', 10 / 31, false);
		expect(bc.weight(2, 3.1)).toBeCloseTo(-0.0405, 4);
		expect(bc.weight(3, 3.1)).toBeCloseTo(0.9765, 4);
	});

	it('integrates the high-quality tent over each texel box, stretched by 1/scale when reducing', () => {
		// Upscaling: the quadratic B-spline (tent convolved with a unit box).
		const up = axisFilter('hq-bilinear', 4, false);
		expect(up.weight(0, 0)).toBeCloseTo(0.75, 10);
		expect(up.weight(1, 0)).toBeCloseTo(0.125, 10);
		expect(up.weight(0, 0.5)).toBeCloseTo(0.5, 10);
		// Reducing to s = 10/31: measured GDI+ weights around u = 15.5.
		const s = 10 / 31;
		const down = axisFilter('hq-bilinear', s, false);
		expect(down.weight(15, 15.5)).toBeCloseTo(s * (1 - s / 2), 10);
		expect(down.weight(13, 15.5)).toBeCloseTo(s * (1 - 2.5 * s), 10);
		let sum = 0;
		for (let i = 8; i <= 23; i++) {
			sum += down.weight(i, 15.5);
		}
		expect(sum).toBeCloseTo(1, 10);
	});

	it('copies texels unfiltered on an unscaled, integer-aligned high-quality axis', () => {
		const copy = axisFilter('hq-bicubic', 1, true);
		expect(copy.weight(7, 7)).toBe(1);
		expect(copy.weight(8, 7)).toBe(0);
	});

	it('mirrors the fractional part of a high-quality destination origin', () => {
		expect(mirroredOrigin(0.3)).toBeCloseTo(0.7, 10);
		expect(mirroredOrigin(2.3)).toBeCloseTo(2.7, 10);
		expect(mirroredOrigin(5)).toBe(5);
	});

	it('samples Half/HighQuality pixel centres against the recorder-shifted source rectangle', () => {
		// GDI+ records a Half-mode draw of a 2x1 image as src (-0.5, -0.5, 2, 1).
		const block = resampleImage(
			RGBA,
			2,
			1,
			spec({ srcX: -0.5, srcY: -0.5, toDevice: [2, 0, 0, 2, 11, 6], kernel: 'nearest', halfPixelOffset: true }),
			{ w: 100, h: 100 },
		)!;
		// Pixel centres 10.5, 11.5, 12.5, 13.5 -> u = -0.25, 0.25, 0.75, 1.25.
		expect(row(block)).toEqual([
			[0, 255],
			[0, 255],
			[255, 255],
			[255, 255],
		]);
	});

	it('applies the top-left rule to a rotated destination edge', () => {
		// A 1x1 texel rotated 45 degrees: its top vertex sits exactly on pixel (10, 5).
		const block = resampleImage(
			new Uint8ClampedArray([200, 100, 50, 255]),
			1,
			1,
			{ srcX: 0, srcY: 0, srcW: 1, srcH: 1, toDevice: [2, 2, -2, 2, 10, 5], kernel: 'nearest', halfPixelOffset: false },
			{ w: 100, h: 100 },
		)!;
		const at = (x: number, y: number): number => block.rgba[((y - block.y) * block.w + (x - block.x)) * 4 + 3];
		expect(at(10, 6)).toBe(255);
		// (10, 5) is on both top edges' shared vertex, a right edge for one of them.
		expect(at(10, 5)).toBe(0);
	});

	it('fades a bicubic edge through the transparent outside, clamping the negative lobe', () => {
		const block = resampleImage(RGBA, 2, 1, spec({ kernel: 'bicubic' }), { w: 100, h: 100 })!;
		for (const [r, a] of row(block)) {
			expect(r).toBeGreaterThanOrEqual(0);
			expect(r).toBeLessThanOrEqual(255);
			expect(a).toBeLessThanOrEqual(255);
		}
	});
});

describe('ImageAttributes WrapMode', () => {
	// u = 1.5 at device x = 13: half texel 1 (white), half the texel beyond the image.
	const lastPixel = (overrides: Partial<DeferredImageResample>): [number, number] => {
		const block = resampleImage(RGBA, 2, 1, spec(overrides), { w: 100, h: 100 })!;
		return row(block)[3];
	};

	it('fades to transparent without attributes', () => {
		expect(lastPixel({})).toEqual([255, 128]);
	});

	it('wraps beyond the bitmap under Tile and mirrors under TileFlipXY', () => {
		expect(lastPixel({ wrap: 'tile' })).toEqual([128, 255]); // texel 2 wraps to black texel 0
		expect(lastPixel({ wrap: 'tile-flip-xy' })).toEqual([255, 255]); // texel 2 mirrors to texel 1
	});

	it('reads the clamp colour beyond the bitmap under Clamp', () => {
		const [r, a] = lastPixel({ wrap: 'clamp', clampArgb: 0xff000000 });
		expect([r, a]).toEqual([128, 255]);
	});
});

describe('resampleNearest (GDI+ NearestNeighbor)', () => {
	// A 4x1 bitmap whose red channel is 10 x (texel index + 1).
	const STRIP = new Uint8ClampedArray([10, 0, 0, 255, 20, 0, 0, 255, 30, 0, 0, 255, 40, 0, 0, 255]);

	/** Texel index ('.' transparent) of device pixels x = 0..59 on row 1. */
	function row(s: Partial<DeferredImageResample>): string {
		const full = spec({ kernel: 'nearest', srcW: 4, srcH: 1, ...s });
		const block = resampleNearest(STRIP, 4, 1, full, { w: 80, h: 4 })!;
		let out = '';
		for (let x = 0; x < 60; x++) {
			const i = x - block.x;
			const o = ((1 - block.y) * block.w + i) * 4;
			out += i < 0 || i >= block.w || block.rgba[o + 3] === 0 ? '.' : String(block.rgba[o] / 10 - 1);
		}
		return out;
	}
	const run = (c: string, n: number): string => c.repeat(n);

	it('rounds texel boundaries half up and leaves the last half texel transparent (GDI+ output)', () => {
		// DrawImagePoints((10,0),(50,0),(10,4)) of the whole strip, PixelOffsetMode None.
		expect(row({ toDevice: [10, 0, 0, 4, 10, 0] })).toBe(run('.', 10) + run('0', 5) + run('1', 10) + run('2', 10) + run('3', 10) + run('.', 15));
	});

	it("reads the bitmap's own column beyond a source sub-rectangle's right edge", () => {
		// Source (1, 0, 2, 1) onto 40 pixels: GDI+ paints texel 3 for the last quarter.
		expect(row({ srcX: 1, srcW: 2, toDevice: [20, 0, 0, 4, -10, 0] })).toBe(run('.', 10) + run('1', 10) + run('2', 20) + run('3', 10) + run('.', 10));
	});

	it('steps a flipped axis in 16.16 fixed point, so its halves round down after the first pixel', () => {
		// Whole strip flipped: (50,0),(10,0),(50,4).
		expect(row({ toDevice: [-10, 0, 0, 4, 50, 0] })).toBe(run('.', 15) + run('3', 10) + run('2', 10) + run('1', 10) + run('0', 5) + run('.', 10));
		// Source (0.5, 0, 2, 1) flipped: the first pixel (exactly on a half) rounds up to texel 3.
		expect(row({ srcX: 0.5, srcW: 2, toDevice: [-20, 0, 0, 4, 60, 0] })).toBe(run('.', 10) + '3' + run('2', 19) + run('1', 20) + run('.', 10));
	});

	it('reads only the rows the source rectangle spans', () => {
		// A 1x4 column, source rows 1..3 onto 40 pixels: the last quarter (row 3) stays transparent.
		const block = resampleNearest(STRIP, 1, 4, spec({ kernel: 'nearest', srcY: 1, srcW: 1, srcH: 2, toDevice: [4, 0, 0, 20, 0, -10] }), { w: 8, h: 80 })!;
		const at = (y: number): number => block.rgba[((y - block.y) * block.w + 1 - block.x) * 4 + 3];
		expect(at(15)).toBe(255);
		expect(at(39)).toBe(255);
		expect(at(40)).toBe(0);
	});
});
