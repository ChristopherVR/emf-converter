import { describe, it, expect, vi } from 'vitest';

import { writeTextureColor } from './emf-plus-brush-texture';
import { aliasedSampleShift, cssColorToArgb, isPlusAliased, solidSampler } from './emf-plus-exact-fill';
import { parseEmfPlusPenObject } from './emf-plus-object-complex';
import { applyPlusPenStyle, canvasLineCap, canvasLineJoin, penDashArray, strokePlusGeometry } from './emf-plus-stroke';
import type { CanvasContext, EmfPlusPen, EmfPlusReplayCtx } from './emf-types';

describe('parseEmfPlusPenObject (GDI+ optional-data order)', () => {
	it('reads caps, join, miter, dash offset/pattern and alignment, then keeps the whole brush', () => {
		// The exact bytes GDI+ recorded for gpx-pen-styles' first pen.
		const hex =
			'0210c0db000000009e030000000000000000004102000000010000000200000000008040' +
			'0000003f040000000000404000008032000080' +
			'3f0000803f010000000210c0db00000000c86e14ff';
		const bytes = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
		// Fix the pattern floats (3, 1, 1, 1) the hex above abbreviates.
		const v = new DataView(bytes.buffer);
		[3, 1, 1, 1].forEach((f, i) => v.setFloat32(44 + i * 4, f, true));
		const pen = parseEmfPlusPenObject(v, 0, bytes.length) as EmfPlusPen;
		expect(pen.width).toBe(8);
		expect(pen.startCap).toBe(2);
		expect(pen.endCap).toBe(1);
		expect(pen.lineJoin).toBe(2);
		expect(pen.miterLimit).toBe(4);
		expect(pen.dashOffset).toBe(0.5);
		expect(pen.dashPattern).toEqual([3, 1, 1, 1]);
		expect(pen.dashStyle).toBe(5);
		expect(pen.alignment).toBe(1);
		expect(pen.brush?.color).toBe(pen.color);
		expect(pen.color).toBe('rgba(20,110,200,1.000)');
	});
});

describe('pen geometry', () => {
	const pen: EmfPlusPen = { kind: 'plus-pen', color: '#000', width: 4, dashStyle: 3 };

	it('maps GDI+ caps and joins', () => {
		expect(canvasLineCap(0)).toBe('butt');
		expect(canvasLineCap(1)).toBe('square');
		expect(canvasLineCap(2)).toBe('round');
		expect(canvasLineJoin(0)).toBe('miter');
		expect(canvasLineJoin(1)).toBe('bevel');
		expect(canvasLineJoin(2)).toBe('round');
	});

	it('scales dash patterns by the pen width', () => {
		expect(penDashArray(pen)).toEqual([12, 4, 4, 4]);
		expect(penDashArray({ ...pen, dashStyle: 5, dashPattern: [2, 0.5] })).toEqual([8, 2]);
		expect(penDashArray({ ...pen, dashStyle: 0 })).toEqual([]);
	});

	it('caps dashes with the dash cap and offsets them in pen widths', () => {
		const ctx = { setLineDash: vi.fn() } as unknown as CanvasContext;
		applyPlusPenStyle(ctx, { ...pen, startCap: 2, dashOffset: 0.5 });
		expect(ctx.lineCap).toBe('butt');
		expect(ctx.lineDashOffset).toBe(2);
		expect(ctx.lineWidth).toBe(4);
	});

	it('strokes an inset pen at twice its width, clipped to a closed figure', () => {
		const calls: string[] = [];
		const ctx = new Proxy({} as Record<string, unknown>, {
			get: (t, p) => (p in t ? t[p as string] : (...a: unknown[]) => calls.push(`${String(p)}(${a.join(',')})`)),
			set: (t, p, v) => {
				t[p as string] = v;
				return true;
			},
		}) as unknown as CanvasContext;
		const rCtx = {
			ctx,
			worldTransform: [1, 0, 0, 1, 0, 0],
			pageUnit: 2,
			pageScale: 1,
			dpiScale: 1,
			objectTable: new Map(),
		} as unknown as EmfPlusReplayCtx;
		strokePlusGeometry(rCtx, { kind: 'plus-pen', color: '#f00', width: 3, dashStyle: 0, alignment: 1 }, (c) => c.rect(0, 0, 10, 10), null, true);
		expect(calls).toContain('clip()');
		expect(ctx.lineWidth).toBe(6);
	});
});

describe('writeTextureColor (GDI+ texture brush sampling)', () => {
	// 2x1 texture: black, white.
	const tex = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
	const at = (inv: number[], wrap: 'tile' | 'clamp' | 'tile-flip-x', x: number, half = false): number[] => {
		const out = new Uint8ClampedArray(4);
		writeTextureColor(inv as never, 2, 1, tex, wrap, half, x, 0, out, 0);
		return Array.from(out);
	};
	const inv4 = [0.25, 0, 0, 1, 0, 0]; // brush scaled 4x

	it('blends bilinearly with texel i at i under PixelOffsetMode None', () => {
		expect(at(inv4, 'tile', 0)[0]).toBe(0);
		expect(at(inv4, 'tile', 2)[0]).toBe(128);
		expect(at(inv4, 'tile', 4)[0]).toBe(255);
	});

	it('wraps the neighbour per WrapMode and fades to transparent under Clamp', () => {
		// u = 1.5: texel 1 (white) and texel 2 (tile: texel 0 black; flip: texel 1 white).
		expect(at(inv4, 'tile', 6)[0]).toBe(128);
		expect(at(inv4, 'tile-flip-x', 6)[0]).toBe(255);
		expect(at(inv4, 'clamp', 6)).toEqual([255, 255, 255, 128]);
	});

	it('samples pixel centres against texel centres under PixelOffsetMode Half', () => {
		// Pixel 0 -> point 0.5 -> u 0.125 -> centre space -0.375: texel 0 at 0.625, texel -1 at 0.375 (tile: white).
		expect(at(inv4, 'tile', 0, true)[0]).toBe(96);
	});
});

describe('aliased EMF+ helpers', () => {
	it('parses the colour strings the parsers produce', () => {
		expect(cssColorToArgb('rgba(255,0,0,1.000)')).toBe(0xffff0000);
		expect(cssColorToArgb('rgba(0,0,255,0.5)')).toBe(0x800000ff);
		expect(cssColorToArgb('#102030')).toBe(0xff102030);
		expect(cssColorToArgb('red')).toBeNull();
	});

	it('paints a flat colour everywhere', () => {
		const out = new Uint8ClampedArray(8);
		solidSampler(0x80102030)(0, 0, 2, 1, out);
		expect(Array.from(out)).toEqual([16, 32, 48, 128, 16, 32, 48, 128]);
	});

	it('samples at the integer device point under None and the centre under Half, less 1/32', () => {
		expect(aliasedSampleShift({ pixelOffsetMode: 0 } as EmfPlusReplayCtx)).toBe(0.5 - 1 / 32);
		expect(aliasedSampleShift({ pixelOffsetMode: 4 } as EmfPlusReplayCtx)).toBe(-1 / 32);
	});

	it('is aliased only under gdiAntialias: false with GDI+ antialiasing off', () => {
		const ctx = {} as CanvasContext;
		expect(isPlusAliased({ ctx, gdiAntialias: false } as EmfPlusReplayCtx)).toBe(true);
		expect(isPlusAliased({ ctx, gdiAntialias: false, antiAlias: true } as EmfPlusReplayCtx)).toBe(false);
		expect(isPlusAliased({ ctx } as EmfPlusReplayCtx)).toBe(false);
	});
});
