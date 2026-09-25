import { describe, it, expect } from 'vitest';

import { isHalfPixelOffset, resampleImage, resampleKernelFor } from './emf-plus-image-resample';
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
		expect(resampleKernelFor(7)).toBeNull(); // HighQualityBicubic: not modelled
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

	it('picks the nearest texel for NearestNeighbor', () => {
		const block = resampleImage(RGBA, 2, 1, spec({ kernel: 'nearest' }), { w: 100, h: 100 })!;
		expect(row(block)).toEqual([
			[0, 255],
			[0, 255],
			[255, 255],
			[255, 255],
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
