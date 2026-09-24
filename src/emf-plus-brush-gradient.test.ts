import { describe, it, expect, vi } from 'vitest';

import {
	createBrushGradient,
	linearGradientEndpoints,
	mulMatrix,
	pathGradientColorAt,
	stopColorAt,
} from './emf-plus-brush-gradient';
import type {
	CanvasContext,
	EmfPlusGradientStop,
	EmfPlusLinearGradient,
	EmfPlusPathGradientShape,
	EmfPlusRadialGradient,
	TransformMatrix,
} from './emf-types';

const IDENTITY: TransformMatrix = [1, 0, 0, 1, 0, 0];

function linear(overrides: Partial<EmfPlusLinearGradient> = {}): EmfPlusLinearGradient {
	return {
		type: 'linear',
		x1: 0,
		y1: 0,
		x2: 100,
		y2: 0,
		stops: [
			{ offset: 0, color: 'rgba(255,0,0,1)', argb: 0xffff0000 },
			{ offset: 1, color: 'rgba(0,0,255,1)', argb: 0xff0000ff },
		],
		wrapMode: 'clamp',
		...overrides,
	};
}

describe('mulMatrix', () => {
	it('returns the identity when both operands are the identity', () => {
		expect(mulMatrix(IDENTITY, IDENTITY)).toEqual(IDENTITY);
	});

	it('composes a translation with a scale (b applied first)', () => {
		const scale: TransformMatrix = [2, 0, 0, 2, 0, 0];
		const translate: TransformMatrix = [1, 0, 0, 1, 10, 5];
		// scale ∘ translate: translate first, then scale the result.
		expect(mulMatrix(scale, translate)).toEqual([2, 0, 0, 2, 20, 10]);
	});

	it('composes a rotation-like shear matrix correctly', () => {
		const a: TransformMatrix = [0, 1, -1, 0, 0, 0]; // 90 degree rotation
		const b: TransformMatrix = [1, 0, 0, 1, 3, 4];
		expect(mulMatrix(a, b)).toEqual([0, 1, -1, 0, -4, 3]);
	});
});

describe('linearGradientEndpoints', () => {
	it('returns the rect midline for an identity transform', () => {
		const pts = linearGradientEndpoints({ x: 10, y: 20, w: 100, h: 50 }, null);
		expect(pts).toEqual({ x1: 10, y1: 45, x2: 110, y2: 45 });
	});

	it('rotates the isoline direction under a 90 degree brush transform', () => {
		// Rotate 90 degrees about the origin: (x,y) -> (-y, x).
		const rot90: TransformMatrix = [0, 1, -1, 0, 0, 0];
		const pts = linearGradientEndpoints({ x: 0, y: 0, w: 10, h: 4 }, rot90);
		// p1 = map(0,2) = (-2,0); pe = map(10,2) = (-2,10).
		expect(pts.x1).toBeCloseTo(-2, 6);
		expect(pts.y1).toBeCloseTo(0, 6);
		expect(pts.x2).toBeCloseTo(-2, 6);
		expect(pts.y2).toBeCloseTo(10, 6);
	});

	it('falls back to the raw mapped segment for a degenerate (singular) transform', () => {
		const singular: TransformMatrix = [0, 0, 0, 0, 5, 5];
		const pts = linearGradientEndpoints({ x: 0, y: 0, w: 10, h: 4 }, singular);
		expect(pts).toEqual({ x1: 5, y1: 5, x2: 5, y2: 5 });
	});
});

describe('stopColorAt', () => {
	const stops: EmfPlusGradientStop[] = [
		{ offset: 0, color: 'rgba(255,0,0,1)', argb: 0xffff0000 },
		{ offset: 0.5, color: 'rgba(0,255,0,1)', argb: 0xff00ff00 },
		{ offset: 1, color: 'rgba(0,0,255,1)', argb: 0xff0000ff },
	];

	it('returns null when a stop lacks packed argb', () => {
		expect(stopColorAt([{ offset: 0, color: 'rgba(0,0,0,1)' }], 0)).toBeNull();
	});

	it('returns null for an empty stop list', () => {
		expect(stopColorAt([], 0.5)).toBeNull();
	});

	it('clamps below the first stop and above the last', () => {
		expect(stopColorAt(stops, -1)).toBe(0xffff0000);
		expect(stopColorAt(stops, 2)).toBe(0xff0000ff);
	});

	it('returns an exact stop colour at its own offset', () => {
		expect(stopColorAt(stops, 0.5)).toBe(0xff00ff00);
	});

	it('interpolates linearly between two stops', () => {
		// Halfway between red (0xffff0000) and green (0xff00ff00) at t=0.25 (of the 0..0.5 span).
		const c = stopColorAt(stops, 0.25) as number;
		expect((c >>> 24) & 0xff).toBe(255);
		expect((c >>> 16) & 0xff).toBe(128); // red channel: 255 -> 0 halfway
		expect((c >>> 8) & 0xff).toBe(128); // green channel: 0 -> 255 halfway
	});
});

describe('pathGradientColorAt', () => {
	// A unit square boundary centred at the origin, red/green/blue/white corners.
	function square(overrides: Partial<EmfPlusPathGradientShape> = {}): EmfPlusPathGradientShape {
		return {
			center: { x: 0, y: 0 },
			centerArgb: 0xffffffff,
			boundary: [
				{ x: -1, y: -1 },
				{ x: 1, y: -1 },
				{ x: 1, y: 1 },
				{ x: -1, y: 1 },
			],
			boundaryArgb: [0xffff0000, 0xff00ff00, 0xff0000ff, 0xff000000],
			blend: null,
			preset: null,
			focus: null,
			transform: null,
			...overrides,
		};
	}

	it('returns the centre colour exactly at the centre point', () => {
		expect(pathGradientColorAt(square(), 0, 0)).toBe(0xffffffff);
	});

	it('returns null outside the boundary', () => {
		expect(pathGradientColorAt(square(), 5, 5)).toBeNull();
	});

	it('returns a boundary vertex colour exactly at that vertex', () => {
		expect(pathGradientColorAt(square(), -1, -1)).toBe(0xffff0000);
	});

	it('blends toward the centre colour approaching the middle of an edge', () => {
		// Midpoint of the top-left -> top-right edge at half the way to centre.
		const c = pathGradientColorAt(square(), 0, -0.5) as number;
		expect(c).not.toBeNull();
		// Should sit between the (interpolated) surround colour and white.
		const g = (c >>> 8) & 0xff;
		expect(g).toBeGreaterThan(0);
	});

	it('applies a blend curve to bias the centre-ward falloff', () => {
		const withBlend = square({ blend: { positions: [0, 1], factors: [0, 1] } });
		const withoutBlend = square();
		const a = pathGradientColorAt(withBlend, 0, -0.9) as number;
		const b = pathGradientColorAt(withoutBlend, 0, -0.9) as number;
		expect(a).toBe(b); // linear blend curve matches the default linear falloff
	});

	it('uses preset colours (interpolation colours) when present, ignoring blend/surround', () => {
		const withPreset = square({
			preset: { positions: [0, 1], argb: [0xff112233, 0xff445566] },
		});
		expect(pathGradientColorAt(withPreset, -1, -1)).toBe(0xff112233); // boundary
		expect(pathGradientColorAt(withPreset, 0, 0)).toBe(0xff445566); // centre
	});

	it('shrinks the centre-colour region when a focus scale is set', () => {
		const withFocus = square({ focus: { x: 0.5, y: 0.5 } });
		// Just inside the focus radius: should be exactly the centre colour,
		// whereas without a focus the same point would already blend outward.
		expect(pathGradientColorAt(withFocus, 0, -0.2)).toBe(0xffffffff);
	});
});

describe('createBrushGradient', () => {
	it('returns null for a degenerate (zero-length) linear gradient with no rect', () => {
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

	it('uses the rect + transform (not the raw x1/y1/x2/y2) when a rect is present', () => {
		const addColorStop = vi.fn();
		const gradient = { addColorStop };
		const createLinearGradient = vi.fn(() => gradient);
		const ctx = { createLinearGradient } as unknown as CanvasContext;

		const grad = linear({
			wrapMode: 'clamp',
			x1: 999,
			y1: 999,
			x2: 999,
			y2: 999,
			rect: { x: 0, y: 0, w: 20, h: 10 },
			transform: null,
		});
		createBrushGradient(ctx, grad);
		expect(createLinearGradient).toHaveBeenCalledWith(0, 5, 20, 5);
	});

	it('falls back to a plain CanvasGradient for a tileable wrap mode when there is no drawing surface to unroll across', () => {
		const addColorStop = vi.fn();
		const gradient = { addColorStop };
		const createLinearGradient = vi.fn(() => gradient);
		// No `canvas` on ctx -> surfaceSize() is null -> tiledLinear() bails,
		// and no createPattern -> buildPattern() bails too -> plain fallback.
		const ctx = { createLinearGradient } as unknown as CanvasContext;

		const result = createBrushGradient(ctx, linear({ wrapMode: 'tile' }));
		expect(result).toBe(gradient);
	});

	it('unrolls a tiled linear gradient into one CanvasGradient spanning every visible period', () => {
		const addColorStop = vi.fn();
		const gradient = { addColorStop };
		const createLinearGradient = vi.fn(() => gradient);
		const ctx = {
			createLinearGradient,
			canvas: { width: 200, height: 100 },
		} as unknown as CanvasContext;

		const grad = linear({
			wrapMode: 'tile',
			rect: { x: 0, y: 0, w: 50, h: 10 },
			transform: null,
		});
		const result = createBrushGradient(ctx, grad, IDENTITY);
		expect(result).toBe(gradient);
		expect(createLinearGradient).toHaveBeenCalledTimes(1);
		// At least one hard stop per period boundary within the 200px-wide surface.
		expect(addColorStop.mock.calls.length).toBeGreaterThanOrEqual(4);
	});

	it('mirrors alternate periods for TileFlipX', () => {
		const calls: Array<[number, string]> = [];
		const addColorStop = vi.fn((offset: number, color: string) => calls.push([offset, color]));
		const gradient = { addColorStop };
		const createLinearGradient = vi.fn(() => gradient);
		const ctx = {
			createLinearGradient,
			canvas: { width: 100, height: 10 },
		} as unknown as CanvasContext;

		const grad = linear({
			wrapMode: 'tile-flip-x',
			rect: { x: 0, y: 0, w: 50, h: 10 },
			transform: null,
		});
		createBrushGradient(ctx, grad, IDENTITY);
		// Both the start and end colours must appear (a mirrored period reuses
		// the same two stop colours, just in reverse), and there must be more
		// than one period's worth of stops across the 100px-wide surface.
		expect(calls.length).toBeGreaterThan(2);
		const colors = new Set(calls.map(([, color]) => color));
		expect(colors.has('rgba(255,0,0,1)')).toBe(true);
		expect(colors.has('rgba(0,0,255,1)')).toBe(true);
	});

	it('builds a radial CanvasGradient for a path gradient with no exact shape geometry', () => {
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
			wrapMode: 'tile',
		};
		const result = createBrushGradient(ctx, grad);
		expect(result).toBe(gradient);
		expect(createRadialGradient).toHaveBeenCalledWith(10, 10, 0, 10, 10, 50);
	});

	it('falls back to the radial approximation when exact shape rendering has no pattern support', () => {
		const addColorStop = vi.fn();
		const gradient = { addColorStop };
		const createRadialGradient = vi.fn(() => gradient);
		// No createPattern -> the exact path-gradient pattern path bails.
		const ctx = { createRadialGradient } as unknown as CanvasContext;

		const grad: EmfPlusRadialGradient = {
			type: 'radial',
			cx: 0,
			cy: 0,
			r: 10,
			stops: [
				{ offset: 0, color: 'rgba(255,255,255,1)' },
				{ offset: 1, color: 'rgba(0,0,0,1)' },
			],
			wrapMode: 'clamp',
			shape: {
				center: { x: 0, y: 0 },
				centerArgb: 0xffffffff,
				boundary: [
					{ x: -10, y: -10 },
					{ x: 10, y: -10 },
					{ x: 10, y: 10 },
				],
				boundaryArgb: [0xff000000, 0xff000000, 0xff000000],
				blend: null,
				preset: null,
				focus: null,
				transform: null,
			},
		};
		const result = createBrushGradient(ctx, grad);
		expect(result).toBe(gradient);
	});

	it('returns null for a degenerate (zero-radius) radial gradient with no shape', () => {
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
