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
import { R2_COPYPEN, R2_MASKPEN, R2_MERGEPEN, R2_NOP, R2_NOT, R2_XORPEN } from './emf-constants';
import { fillShapeExactOrFast } from './emf-gdi-shape-paint';
import {
	isExactRop2Bitwise,
	measurePathBox,
	paintWithExactRop2,
	paintWithRop2PerPixel,
	rop2ExactIndexForTest,
	rop2Rop3Index,
} from './emf-rop2-exact';
import { defaultState } from './emf-types';
import type { CanvasContext, EmfGdiReplayCtx } from './emf-types';

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

describe('rop2Rop3Index', () => {
	it('agrees with the hand-derived table for every bitwise mode', () => {
		for (let mode = 1; mode <= 16; mode++) {
			const table = rop2ExactIndexForTest(mode);
			if (table !== undefined) {
				expect(rop2Rop3Index(mode)).toBe(table);
			}
		}
	});

	it('maps the non-bitwise modes to their well-known ROP3 equivalents', () => {
		expect(rop2Rop3Index(1)).toBe(0x00); // R2_BLACK = BLACKNESS
		expect(rop2Rop3Index(R2_NOT)).toBe(0x55); // DSTINVERT
		expect(rop2Rop3Index(R2_NOP)).toBe(0xaa); // D
		expect(rop2Rop3Index(R2_COPYPEN)).toBe(0xf0); // PATCOPY
		expect(rop2Rop3Index(16)).toBe(0xff); // R2_WHITE = WHITENESS
	});

	it('is undefined outside 1..16', () => {
		expect(rop2Rop3Index(0)).toBeUndefined();
		expect(rop2Rop3Index(17)).toBeUndefined();
	});
});

describe('measurePathBox', () => {
	it('bounds path geometry, honouring translate and padding, clamped to the surface', () => {
		const box = measurePathBox(
			(c) => {
				c.translate(0.5, 0.5);
				c.moveTo(10, 20);
				c.lineTo(30, 25);
			},
			2,
			{ w: 100, h: 100 },
		);
		expect(box).toEqual({ x: 8, y: 18, w: 25, h: 10 });
	});

	it('returns null when nothing lands on the surface', () => {
		expect(measurePathBox((c) => c.rect(200, 200, 5, 5), 1, { w: 100, h: 100 })).toBeNull();
	});
});

describe('paintWithRop2PerPixel', () => {
	it('paints R2_COPYPEN without antialiasing, using the exact paint colour', () => {
		const canvas = createCanvas(10, 10);
		const { ctx } = canvas!;
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, 10, 10);
		// Edges at x = 1.7 and x = 8.3: pixels 1 and 8 are 30% covered (left
		// alone), 2 and 7 fully, and nothing is blended.
		const handled = paintWithRop2PerPixel(ctx, R2_COPYPEN, '#0f0f0f', (c) => {
			c.beginPath();
			c.rect(1.7, 1.7, 6.6, 6.6);
			c.fill();
		});
		expect(handled).toBe(true);
		expect(pixelAt(ctx, 2, 5)).toEqual([0x0f, 0x0f, 0x0f]);
		expect(pixelAt(ctx, 7, 5)).toEqual([0x0f, 0x0f, 0x0f]);
		expect(pixelAt(ctx, 1, 5)).toEqual([0xff, 0xff, 0xff]);
		expect(pixelAt(ctx, 8, 5)).toEqual([0xff, 0xff, 0xff]);
	});

	it('point-samples a fill at pixel centres, keeping a partly covered corner pixel in', () => {
		const canvas = createCanvas(10, 10);
		const { ctx } = canvas!;
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, 10, 10);
		// Corner at (2.4, 2.4): pixel (2, 2) is only 36% covered, but its
		// centre (2.5, 2.5) is inside, so GDI-style point sampling paints it.
		paintWithRop2PerPixel(
			ctx,
			R2_COPYPEN,
			'#000000',
			(c) => {
				c.beginPath();
				c.rect(2.4, 2.4, 5, 5);
				c.fill('nonzero');
			},
			1,
			'nonzero',
		);
		expect(pixelAt(ctx, 2, 2)).toEqual([0, 0, 0]);
		expect(pixelAt(ctx, 1, 2)).toEqual([0xff, 0xff, 0xff]);
	});

	it('honours the active clip region (putImageData alone would not)', () => {
		const canvas = createCanvas(10, 10);
		const { ctx } = canvas!;
		ctx.fillStyle = '#336699';
		ctx.fillRect(0, 0, 10, 10);
		ctx.save();
		ctx.beginPath();
		ctx.rect(0, 0, 5, 10);
		ctx.clip();
		paintWithRop2PerPixel(ctx, R2_XORPEN, '#ffffff', (c) => {
			c.fillRect(0, 0, 10, 10);
		});
		ctx.restore();
		expect(pixelAt(ctx, 2, 2)).toEqual([0x33 ^ 0xff, 0x66 ^ 0xff, 0x99 ^ 0xff]);
		expect(pixelAt(ctx, 7, 2)).toEqual([0x33, 0x66, 0x99]);
	});

	it('leaves the destination alone for R2_NOP', () => {
		const canvas = createCanvas(4, 4);
		const { ctx } = canvas!;
		ctx.fillStyle = '#123456';
		ctx.fillRect(0, 0, 4, 4);
		expect(paintWithRop2PerPixel(ctx, R2_NOP, '#ffffff', (c) => c.fillRect(0, 0, 4, 4))).toBe(true);
		expect(pixelAt(ctx, 1, 1)).toEqual([0x12, 0x34, 0x56]);
	});
});

describe('pattern brush + bitwise ROP2 fill (fillShapeExactOrFast)', () => {
	function patternRCtx(ctx: CanvasContext, rop2: number): EmfGdiReplayCtx {
		const state = defaultState();
		state.brushStyle = 3; // BS_PATTERN
		// A 2x2 tile: red, green / blue, white.
		state.brushPattern = {
			kind: 'bitmap',
			width: 2,
			height: 2,
			rgb: new Uint32Array([0xff0000, 0x00ff00, 0x0000ff, 0xffffff]),
		};
		state.rop2 = rop2;
		return {
			ctx,
			state,
			bounds: { left: 0, top: 0, right: 8, bottom: 8 },
			sx: 1,
			sy: 1,
		} as unknown as EmfGdiReplayCtx;
	}

	function fillRect(ctx: CanvasContext, rCtx: EmfGdiReplayCtx, x: number, y: number, w: number, h: number) {
		const build = (c: CanvasContext) => {
			c.beginPath();
			c.rect(x, y, w, h);
		};
		build(ctx);
		fillShapeExactOrFast(rCtx, build);
	}

	it('combines each pattern texel P with the destination D exactly (XOR)', () => {
		const canvas = createCanvas(8, 8);
		const { ctx } = canvas!;
		ctx.fillStyle = '#336699';
		ctx.fillRect(0, 0, 8, 8);
		fillRect(ctx, patternRCtx(ctx, R2_XORPEN), 2, 2, 4, 4);
		// Device pixel (2, 2) samples tile texel (0, 0) = red; (3, 2) green;
		// (2, 3) blue; (3, 3) white.
		expect(pixelAt(ctx, 2, 2)).toEqual([0x33 ^ 0xff, 0x66, 0x99]);
		expect(pixelAt(ctx, 3, 2)).toEqual([0x33, 0x66 ^ 0xff, 0x99]);
		expect(pixelAt(ctx, 2, 3)).toEqual([0x33, 0x66, 0x99 ^ 0xff]);
		expect(pixelAt(ctx, 3, 3)).toEqual([0x33 ^ 0xff, 0x66 ^ 0xff, 0x99 ^ 0xff]);
		// Outside the rectangle (right/bottom edge excluded, as in GDI): untouched.
		expect(pixelAt(ctx, 1, 1)).toEqual([0x33, 0x66, 0x99]);
		expect(pixelAt(ctx, 6, 6)).toEqual([0x33, 0x66, 0x99]);
	});

	it('combines exactly for AND (R2_MASKPEN) too', () => {
		const canvas = createCanvas(8, 8);
		const { ctx } = canvas!;
		ctx.fillStyle = '#f0f0f0';
		ctx.fillRect(0, 0, 8, 8);
		fillRect(ctx, patternRCtx(ctx, R2_MASKPEN), 0, 0, 8, 8);
		expect(pixelAt(ctx, 0, 0)).toEqual([0xf0, 0, 0]);
		expect(pixelAt(ctx, 1, 1)).toEqual([0xf0, 0xf0, 0xf0]);
	});

	it('writes the pattern unchanged under R2_COPYPEN', () => {
		const canvas = createCanvas(8, 8);
		const { ctx } = canvas!;
		ctx.fillStyle = '#336699';
		ctx.fillRect(0, 0, 8, 8);
		fillRect(ctx, patternRCtx(ctx, R2_COPYPEN), 0, 0, 8, 8);
		expect(pixelAt(ctx, 4, 4)).toEqual([0xff, 0, 0]);
		expect(pixelAt(ctx, 5, 4)).toEqual([0, 0xff, 0]);
	});
});
