import { describe, it, expect } from 'vitest';

import { createBrushTexture } from './emf-plus-brush-texture';
import type { CanvasContext, EmfPlusTexture } from './emf-types';

function texture(overrides: Partial<EmfPlusTexture> = {}): EmfPlusTexture {
	// 2x2: red, green, blue, white (top-down RGBA).
	const rgba = new Uint8ClampedArray([
		255, 0, 0, 255, 0, 255, 0, 255, //
		0, 0, 255, 255, 255, 255, 255, 255,
	]);
	return { width: 2, height: 2, rgba, wrapMode: 'tile', transform: null, ...overrides };
}

describe('createBrushTexture', () => {
	it('returns null when the context lacks pattern support', () => {
		const ctx = {} as unknown as CanvasContext;
		expect(createBrushTexture(ctx, texture())).toBeNull();
	});

	it('returns null for a degenerate (zero-size) texture', () => {
		const ctx = { createPattern: () => null } as unknown as CanvasContext;
		expect(createBrushTexture(ctx, texture({ width: 0 }))).toBeNull();
		expect(createBrushTexture(ctx, texture({ height: 0 }))).toBeNull();
	});

	it('returns null when createPattern itself returns null (e.g. no canvas backend)', () => {
		const ctx = { createPattern: () => null } as unknown as CanvasContext;
		expect(createBrushTexture(ctx, texture())).toBeNull();
	});
});
