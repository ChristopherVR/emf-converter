/**
 * Real (non-mocked) integration coverage for the exact bitwise ROP2 combine,
 * using the same `@napi-rs/canvas` Node backend `node-canvas-backend.test.ts`
 * exercises for the rest of the package (vitest's default environment here
 * is plain Node: no `OffscreenCanvas`, no `document`). `ensureNodeCanvasModule`
 * is awaited up front so `createTempCanvas`/`createCanvas` succeed
 * deterministically regardless of what other test files have run first.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { canvasGetImageData, createCanvas, ensureNodeCanvasModule } from './emf-canvas-helpers';
import { R2_COPYPEN, R2_MASKPEN, R2_MERGEPEN, R2_XORPEN } from './emf-constants';
import { isExactRop2Bitwise, paintWithExactRop2 } from './emf-rop2-exact';
import type { CanvasContext } from './emf-types';

beforeAll(async () => {
	await ensureNodeCanvasModule();
});

function pixelAt(ctx: CanvasContext, x: number, y: number): [number, number, number] {
	const d = canvasGetImageData(ctx, x, y, 1, 1).data;
	return [d[0], d[1], d[2]];
}

describe('isExactRop2Bitwise', () => {
	it('is true for the bitwise AND/OR/XOR family', () => {
		expect(isExactRop2Bitwise(R2_MASKPEN)).toBe(true);
		expect(isExactRop2Bitwise(R2_MERGEPEN)).toBe(true);
		expect(isExactRop2Bitwise(R2_XORPEN)).toBe(true);
	});

	it('is false for a mode that already has an exact Canvas-native emulation', () => {
		expect(isExactRop2Bitwise(R2_COPYPEN)).toBe(false);
	});
});

describe('paintWithExactRop2', () => {
	it('returns false for a non-bitwise ROP2 mode', () => {
		const canvas = createCanvas(4, 4);
		expect(canvas).not.toBeNull();
		const handled = paintWithExactRop2(canvas!.ctx, R2_COPYPEN, '#ff0000', (c) => {
			c.fillRect(0, 0, 4, 4);
		});
		expect(handled).toBe(false);
	});

	it('computes an exact bitwise XOR (P^D) over a solid destination', () => {
		const canvas = createCanvas(4, 4);
		expect(canvas).not.toBeNull();
		const { ctx } = canvas!;
		// Destination: 0x336699 everywhere.
		ctx.fillStyle = '#336699';
		ctx.fillRect(0, 0, 4, 4);

		const handled = paintWithExactRop2(ctx, R2_XORPEN, '#0f0f0f', (c) => {
			c.fillRect(0, 0, 4, 4);
		});
		expect(handled).toBe(true);

		const [r, g, b] = pixelAt(ctx, 2, 2);
		// 0x33 ^ 0x0f = 0x3c, 0x66 ^ 0x0f = 0x69, 0x99 ^ 0x0f = 0x96.
		expect(r).toBe(0x33 ^ 0x0f);
		expect(g).toBe(0x66 ^ 0x0f);
		expect(b).toBe(0x99 ^ 0x0f);
	});

	it('computes an exact bitwise AND (P&D) over a solid destination', () => {
		const canvas = createCanvas(4, 4);
		const { ctx } = canvas!;
		ctx.fillStyle = '#f0f0f0';
		ctx.fillRect(0, 0, 4, 4);

		paintWithExactRop2(ctx, R2_MASKPEN, '#0f0f0f', (c) => {
			c.fillRect(0, 0, 4, 4);
		});

		const [r, g, b] = pixelAt(ctx, 1, 1);
		expect(r).toBe(0xf0 & 0x0f);
		expect(g).toBe(0xf0 & 0x0f);
		expect(b).toBe(0xf0 & 0x0f);
	});

	it('computes an exact bitwise OR (P|D) over a solid destination', () => {
		const canvas = createCanvas(4, 4);
		const { ctx } = canvas!;
		ctx.fillStyle = '#f0f0f0';
		ctx.fillRect(0, 0, 4, 4);

		paintWithExactRop2(ctx, R2_MERGEPEN, '#0f0f0f', (c) => {
			c.fillRect(0, 0, 4, 4);
		});

		const [r, g, b] = pixelAt(ctx, 3, 3);
		expect(r).toBe(0xf0 | 0x0f);
		expect(g).toBe(0xf0 | 0x0f);
		expect(b).toBe(0xf0 | 0x0f);
	});

	it('leaves pixels outside the drawn shape untouched (coverage 0)', () => {
		const canvas = createCanvas(4, 4);
		const { ctx } = canvas!;
		ctx.fillStyle = '#123456';
		ctx.fillRect(0, 0, 4, 4);

		paintWithExactRop2(ctx, R2_XORPEN, '#ffffff', (c) => {
			// Only paint the top-left 2x2 quadrant.
			c.fillRect(0, 0, 2, 2);
		});

		const untouched = pixelAt(ctx, 3, 3);
		expect(untouched).toEqual([0x12, 0x34, 0x56]);
		const touched = pixelAt(ctx, 0, 0);
		expect(touched).toEqual([0x12 ^ 0xff, 0x34 ^ 0xff, 0x56 ^ 0xff]);
	});
});
