import { describe, it, expect } from 'vitest';

import { flattenCubic } from './emf-plus-brush-parser';
import { textureTexelAt, wrapTexel } from './emf-plus-brush-texture';
import {
	foldIntoTile,
	gdiplusBlendPixels,
	invertAffine,
	pathGradientSampler,
	textureSampler,
	tryFillPlusShapeExact,
} from './emf-plus-exact-fill';
import type { EmfPlusPathGradientShape, EmfPlusReplayCtx, EmfPlusTexture, TransformMatrix } from './emf-types';

const IDENTITY: TransformMatrix = [1, 0, 0, 1, 0, 0];

describe('wrapTexel', () => {
	it('repeats plainly for Tile', () => {
		expect([-2, -1, 0, 1, 2, 3].map((i) => wrapTexel(i, 3, false))).toEqual([1, 2, 0, 1, 2, 0]);
	});

	it('mirrors every odd period for the flip modes', () => {
		expect([-3, -1, 0, 2, 3, 4, 5, 6].map((i) => wrapTexel(i, 3, true))).toEqual([2, 0, 0, 2, 2, 1, 0, 0]);
	});
});

describe('textureTexelAt', () => {
	it('samples the texel under the pixel origin, wrapping per WrapMode', () => {
		// 2x2 texture scaled 4x: device pixels 0..3 read texel 0, 4..7 texel 1, 8.. wrap.
		const inv = invertAffine([4, 0, 0, 4, 0, 0])!;
		expect(textureTexelAt(inv, 2, 2, 'tile', 3, 0)).toBe(0);
		expect(textureTexelAt(inv, 2, 2, 'tile', 4, 0)).toBe(4);
		expect(textureTexelAt(inv, 2, 2, 'tile', 8, 0)).toBe(0);
		expect(textureTexelAt(inv, 2, 2, 'tile-flip-x', 8, 0)).toBe(4);
		expect(textureTexelAt(inv, 2, 2, 'tile', 0, 4)).toBe(8);
	});

	it('paints nothing outside the bitmap for Clamp', () => {
		expect(textureTexelAt(IDENTITY, 2, 2, 'clamp', 2, 0)).toBe(-1);
		expect(textureTexelAt(IDENTITY, 2, 2, 'clamp', -1, 0)).toBe(-1);
		expect(textureTexelAt(IDENTITY, 2, 2, 'clamp', 1, 1)).toBe(12);
	});
});

describe('textureSampler', () => {
	it('writes the wrapped texels of a device rectangle, honouring the brush transform', () => {
		const texture: EmfPlusTexture = {
			width: 2,
			height: 1,
			rgba: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]),
			wrapMode: 'tile',
			transform: [1, 0, 0, 1, 1, 0], // brush shifted right by one pixel
		};
		const sampler = textureSampler(texture, IDENTITY)!;
		const out = new Uint8ClampedArray(3 * 4);
		sampler(0, 0, 3, 1, out);
		// Device x=0 is texel -1 => wraps to texel 1 (blue); then red, blue.
		expect(Array.from(out)).toEqual([0, 0, 255, 255, 255, 0, 0, 255, 0, 0, 255, 255]);
	});
});

describe('foldIntoTile', () => {
	it('folds into the tile, mirroring odd tiles with the one-pixel lag', () => {
		expect(foldIntoTile(12, 0, 10, false, 1)).toBe(2);
		expect(foldIntoTile(12, 0, 10, true, 1)).toBe(7);
		expect(foldIntoTile(-3, 0, 10, false, 0)).toBe(7);
	});
});

describe('pathGradientSampler', () => {
	const shape: EmfPlusPathGradientShape = {
		center: { x: 2, y: 2 },
		centerArgb: 0xffffffff,
		boundary: [
			{ x: 0, y: 0 },
			{ x: 4, y: 0 },
			{ x: 4, y: 4 },
			{ x: 0, y: 4 },
		],
		boundaryArgb: [0xff000000, 0xff000000, 0xff000000, 0xff000000],
		blend: null,
		preset: null,
		focus: null,
		transform: null,
	};

	it('paints the centre colour at the centre and leaves Clamp pixels outside transparent', () => {
		const sampler = pathGradientSampler(shape, 'clamp', IDENTITY)!;
		const out = new Uint8ClampedArray(6 * 4);
		sampler(0, 2, 6, 1, out);
		expect(Array.from(out.subarray(8, 12))).toEqual([255, 255, 255, 255]); // x=2: centre
		expect(out[4 * 4 + 3]).toBe(0); // x=4: on the right edge, left unpainted
		expect(out[5 * 4 + 3]).toBe(0); // x=5: outside
	});

	it('repeats the tile for Tile', () => {
		const sampler = pathGradientSampler(shape, 'tile', IDENTITY)!;
		const out = new Uint8ClampedArray(8 * 4);
		sampler(0, 2, 8, 1, out);
		expect(Array.from(out.subarray(6 * 4, 6 * 4 + 4))).toEqual(Array.from(out.subarray(2 * 4, 2 * 4 + 4)));
	});
});

describe('flattenCubic', () => {
	it('keeps a straight cubic as one segment', () => {
		const out: Array<{ x: number; y: number; t: number }> = [];
		flattenCubic({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, out);
		expect(out).toEqual([{ x: 3, y: 0, t: 1 }]);
	});

	it('subdivides a curve until it is within 0.25 of its chords', () => {
		const out: Array<{ x: number; y: number; t: number }> = [];
		// A quarter circle of radius 40.
		const k = 0.5523 * 40;
		flattenCubic({ x: 40, y: 0 }, { x: 40, y: k }, { x: k, y: 40 }, { x: 0, y: 40 }, out);
		expect(out.length).toBeGreaterThanOrEqual(8);
		expect(out.length).toBeLessThanOrEqual(16);
		expect(out[out.length - 1]).toEqual({ x: 0, y: 40, t: 1 });
		for (let i = 1; i < out.length; i++) {
			expect(out[i].t).toBeGreaterThan(out[i - 1].t);
		}
		// Every vertex lies on (within float noise of) the ~radius-40 arc.
		for (const p of out) {
			expect(Math.abs(Math.hypot(p.x, p.y) - 40)).toBeLessThan(0.1);
		}
	});
});

describe('tryFillPlusShapeExact', () => {
	function rCtxWith(ctx: unknown, brush: unknown): EmfPlusReplayCtx {
		return {
			ctx,
			objectTable: new Map([[1, brush]]),
			worldTransform: [1, 0, 0, 1, 0, 0],
			pageUnit: 2,
			pageScale: 1,
			dpiScale: 1,
		} as unknown as EmfPlusReplayCtx;
	}

	it('declines inline colours and plain solid brushes under gdiAntialias: true', () => {
		const rCtx = rCtxWith({ canvas: { width: 10, height: 10 }, clip: () => {}, drawImage: () => {} }, {
			kind: 'plus-brush',
			color: 'red',
		});
		rCtx.gdiAntialias = true;
		expect(tryFillPlusShapeExact(rCtx, 0x8000, 0xffff0000, () => {}, null)).toBe(false);
		expect(tryFillPlusShapeExact(rCtx, 0, 1, () => {}, null)).toBe(false);
	});

	it('declines when the context exposes no surface size (e.g. a test stub)', () => {
		const texture: EmfPlusTexture = {
			width: 1,
			height: 1,
			rgba: new Uint8ClampedArray([1, 2, 3, 255]),
			wrapMode: 'tile',
			transform: null,
		};
		const rCtx = rCtxWith({ clip: () => {}, drawImage: () => {} }, { kind: 'plus-brush', color: 'red', texture });
		expect(tryFillPlusShapeExact(rCtx, 0, 1, () => {}, null)).toBe(false);
	});
});

describe('gdiplusBlendPixels', () => {
	it('blends as GDI+ does: premultiplied colour scaled by the sample share over the destination', () => {
		// (30, 90, 200) opaque over white with 18 of 32 samples: GDI+ paints (129, 163, 225).
		const data = new Uint8ClampedArray([30, 90, 200, 255]);
		const dst = new Uint8ClampedArray([255, 255, 255, 255]);
		expect(gdiplusBlendPixels(data, dst, new Uint8ClampedArray([Math.round((18 * 255) / 32)]))).toBe(true);
		expect([...data]).toEqual([129, 163, 225, 255]);
	});

	it('leaves uncovered pixels transparent and declines a translucent destination', () => {
		const data = new Uint8ClampedArray([1, 2, 3, 255, 1, 2, 3, 255]);
		const dst = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 128]);
		expect(gdiplusBlendPixels(data, dst, new Uint8ClampedArray([0, 255]))).toBe(false);
		expect(data[3]).toBe(0);
	});
});