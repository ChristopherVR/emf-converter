import { describe, it, expect, vi } from 'vitest';

import { planAxisTile, buildTiledGradientPattern, createBrushGradient } from './emf-plus-brush-gradient';
import type { CanvasContext, EmfPlusLinearGradient, EmfPlusRadialGradient } from './emf-types';

function linear(
	overrides: Partial<EmfPlusLinearGradient> = {},
): EmfPlusLinearGradient {
	return {
		type: 'linear',
		x1: 0,
		y1: 0,
		x2: 100,
		y2: 0,
		stops: [
			{ offset: 0, color: 'rgba(255,0,0,1)' },
			{ offset: 1, color: 'rgba(0,0,255,1)' },
		],
		wrapMode: 'clamp',
		...overrides,
	};
}

describe('planAxisTile', () => {
	it('returns null for wrapMode clamp', () => {
		expect(planAxisTile(linear({ wrapMode: 'clamp' }))).toBeNull();
	});

	it('returns null for an angled (non-axis-aligned) gradient', () => {
		expect(planAxisTile(linear({ x1: 0, y1: 0, x2: 100, y2: 50, wrapMode: 'tile' }))).toBeNull();
	});

	it('plans a horizontal tile for a horizontal gradient', () => {
		const plan = planAxisTile(linear({ x1: 10, y1: 5, x2: 110, y2: 5, wrapMode: 'tile' }));
		expect(plan).toEqual({
			axis: 'horizontal',
			originX: 10,
			originY: 5,
			tileLength: 100,
			mirror: false,
			stops: [
				{ offset: 0, color: 'rgba(255,0,0,1)' },
				{ offset: 1, color: 'rgba(0,0,255,1)' },
			],
		});
	});

	it('plans a vertical tile for a vertical gradient', () => {
		const plan = planAxisTile(linear({ x1: 5, y1: 10, x2: 5, y2: 60, wrapMode: 'tile-flip-y' }));
		expect(plan).toEqual({
			axis: 'vertical',
			originX: 5,
			originY: 10,
			tileLength: 50,
			mirror: true,
			stops: [
				{ offset: 0, color: 'rgba(255,0,0,1)' },
				{ offset: 1, color: 'rgba(0,0,255,1)' },
			],
		});
	});

	it('sets mirror only for the wrap modes matching the tiling axis', () => {
		const horizontalFlipY = planAxisTile(
			linear({ x1: 0, y1: 0, x2: 100, y2: 0, wrapMode: 'tile-flip-y' }),
		);
		expect(horizontalFlipY?.mirror).toBe(false); // flip-Y has no visible effect on a horizontal axis

		const horizontalFlipX = planAxisTile(
			linear({ x1: 0, y1: 0, x2: 100, y2: 0, wrapMode: 'tile-flip-x' }),
		);
		expect(horizontalFlipX?.mirror).toBe(true);

		const horizontalFlipXY = planAxisTile(
			linear({ x1: 0, y1: 0, x2: 100, y2: 0, wrapMode: 'tile-flip-xy' }),
		);
		expect(horizontalFlipXY?.mirror).toBe(true);
	});

	it('reorients stops when the gradient runs against the world-increasing direction', () => {
		// x1 > x2: the gradient runs right-to-left, so world-increasing-x stops flip.
		const plan = planAxisTile(linear({ x1: 100, y1: 0, x2: 0, y2: 0, wrapMode: 'tile' }));
		expect(plan?.originX).toBe(0);
		expect(plan?.tileLength).toBe(100);
		expect(plan?.stops).toEqual([
			{ offset: 1, color: 'rgba(255,0,0,1)' },
			{ offset: 0, color: 'rgba(0,0,255,1)' },
		]);
	});

	it('rounds a fractional period to at least 1 pixel', () => {
		const plan = planAxisTile(linear({ x1: 0, y1: 0, x2: 0.2, y2: 0, wrapMode: 'tile' }));
		expect(plan?.tileLength).toBe(1);
	});
});

describe('buildTiledGradientPattern', () => {
	it('returns null when the context lacks createPattern', () => {
		const ctx = {} as unknown as CanvasContext;
		const plan = planAxisTile(linear({ x1: 0, y1: 0, x2: 100, y2: 0, wrapMode: 'tile' }))!;
		expect(buildTiledGradientPattern(ctx, plan)).toBeNull();
	});

	it('returns null when the tile canvas cannot be created (no OffscreenCanvas/document in this test environment)', () => {
		const ctx = { createPattern: vi.fn() } as unknown as CanvasContext;
		const plan = planAxisTile(linear({ x1: 0, y1: 0, x2: 100, y2: 0, wrapMode: 'tile' }))!;
		// createTempCanvas() returns null without OffscreenCanvas/document, so this
		// never even reaches ctx.createPattern.
		expect(buildTiledGradientPattern(ctx, plan)).toBeNull();
		expect(ctx.createPattern).not.toHaveBeenCalled();
	});
});

describe('createBrushGradient', () => {
	it('returns null for a degenerate (zero-length) linear gradient', () => {
		const ctx = { createLinearGradient: vi.fn() } as unknown as CanvasContext;
		expect(createBrushGradient(ctx, linear({ x1: 5, y1: 5, x2: 5, y2: 5 }))).toBeNull();
	});

	it('returns null when the context lacks gradient support', () => {
		const ctx = {} as unknown as CanvasContext;
		expect(createBrushGradient(ctx, linear())).toBeNull();
	});

	it('builds a plain CanvasGradient for wrapMode clamp', () => {
		const addColorStop = vi.fn();
		const gradient = { addColorStop };
		const createLinearGradient = vi.fn(() => gradient);
		const ctx = { createLinearGradient } as unknown as CanvasContext;

		const result = createBrushGradient(ctx, linear({ wrapMode: 'clamp' }));
		expect(result).toBe(gradient);
		expect(createLinearGradient).toHaveBeenCalledWith(0, 0, 100, 0);
		expect(addColorStop).toHaveBeenCalledTimes(2);
	});

	it('falls back to a plain CanvasGradient for a tileable wrap mode when pattern support is absent', () => {
		const addColorStop = vi.fn();
		const gradient = { addColorStop };
		const createLinearGradient = vi.fn(() => gradient);
		// No createPattern -> buildTiledGradientPattern returns null -> falls back.
		const ctx = { createLinearGradient } as unknown as CanvasContext;

		const result = createBrushGradient(ctx, linear({ wrapMode: 'tile' }));
		expect(result).toBe(gradient);
	});

	it('builds a radial CanvasGradient for a path (radial-approximated) gradient', () => {
		const addColorStop = vi.fn();
		const gradient = { addColorStop };
		const createRadialGradient = vi.fn(() => gradient);
		const ctx = { createRadialGradient } as unknown as CanvasContext;

		const grad: EmfPlusRadialGradient = {
			type: 'radial',
			cx: 10,
			cy: 10,
			r: 50,
			stops: [
				{ offset: 0, color: 'rgba(255,255,255,1)' },
				{ offset: 1, color: 'rgba(0,0,0,1)' },
			],
			wrapMode: 'tile', // parsed but intentionally not applied for path gradients
		};
		const result = createBrushGradient(ctx, grad);
		expect(result).toBe(gradient);
		expect(createRadialGradient).toHaveBeenCalledWith(10, 10, 0, 10, 10, 50);
	});

	it('returns null for a degenerate (zero-radius) radial gradient', () => {
		const ctx = { createRadialGradient: vi.fn() } as unknown as CanvasContext;
		const grad: EmfPlusRadialGradient = {
			type: 'radial',
			cx: 0,
			cy: 0,
			r: 0,
			stops: [],
			wrapMode: 'clamp',
		};
		expect(createBrushGradient(ctx, grad)).toBeNull();
	});
});
