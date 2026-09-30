import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodePng } from './png-decoder';

import { canvasGetImageData, createTempCanvas, ensureNodeCanvasModule } from './emf-canvas-helpers';
import { writeTextureColor } from './emf-plus-brush-texture';
import { arrowCapPath, type EmfPlusCustomLineCap } from './emf-plus-custom-cap';
import { aliasedSampleShift, cssColorToArgb, isPlusAliased, plusRasterMode, solidSampler } from './emf-plus-exact-fill';
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

	it('applies a pen-local uniform scale to its stroke width but not its dash lengths', () => {
		const calls: string[] = [];
		const ctx = new Proxy({} as Record<string, unknown>, {
			get: (t, p) => p in t ? t[p as string] : (...a: unknown[]) => calls.push(`${String(p)}(${a.join(',')})`),
			set: (t, p, v) => { t[p as string] = v; return true; },
		}) as unknown as CanvasContext;
		const rCtx = { ctx, worldTransform: [1, 0, 0, 1, 0, 0], pageUnit: 2, pageScale: 1, dpiScale: 1, objectTable: new Map() } as unknown as EmfPlusReplayCtx;
		strokePlusGeometry(rCtx, {
			kind: 'plus-pen', color: '#000', width: 2, dashStyle: 1,
			transform: [3, 0, 0, 3, 17, -9],
		}, (c) => c.moveTo(0, 0), null);
		expect(ctx.lineWidth).toBe(6);
		// GDI+ lays the dashes out in the untransformed width (2): 6 on, 2 off.
		const dash = calls.find((c) => c.startsWith('setLineDash('))!.slice(12, -1).split(',').map(Number);
		expect(dash[0]).toBeCloseTo(6, 9);
		expect(dash[1]).toBeCloseTo(2, 9);
	});

	it('matches native GDI+ pen-transform pixels for a scaled, rotated, translated pen', async () => {
		const { createCanvas } = await import('@napi-rs/canvas');
		const canvas = createCanvas(80, 64);
		const ctx = canvas.getContext('2d') as unknown as CanvasContext;
		ctx.fillStyle = '#fff';
		ctx.fillRect(0, 0, 80, 64);
		const rCtx = { ctx, worldTransform: [1, 0, 0, 1, 0, 0], pageUnit: 2, pageScale: 1, dpiScale: 1, objectTable: new Map() } as unknown as EmfPlusReplayCtx;
		strokePlusGeometry(rCtx, {
			kind: 'plus-pen', color: '#000', width: 2, dashStyle: 0,
			transform: [2.1213204, 2.1213204, -2.1213204, 2.1213204, 9, 12],
		}, (c) => { c.moveTo(12, 30); c.lineTo(68, 30); }, null);
		const pixels = ctx.getImageData!(0, 0, 80, 64).data;
		let minY = 64, maxY = -1, count = 0;
		for (let y = 0; y < 64; y++) for (let x = 0; x < 80; x++) {
			if (pixels[(y * 80 + x) * 4] < 128) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); count++; }
		}
		// Native GDI+ produces the same 6-pixel-wide stroke as scale 3 alone;
		// the pen transform's rotation and translation do not move/rotate the path.
		expect({ minY, maxY, count }).toEqual({ minY: 27, maxY: 32, count: 336 });
	});

	it('keeps a zero-width pen at its one-pixel minimum under pen scaling', () => {
		const calls: string[] = [];
		const ctx = new Proxy({} as Record<string, unknown>, {
			get: (t, p) => p in t ? t[p as string] : (...a: unknown[]) => calls.push(`${String(p)}(${a.join(',')})`),
			set: (t, p, v) => { t[p as string] = v; return true; },
		}) as unknown as CanvasContext;
		const rCtx = { ctx, worldTransform: [1, 0, 0, 1, 0, 0], pageUnit: 2, pageScale: 1, dpiScale: 1, objectTable: new Map() } as unknown as EmfPlusReplayCtx;
		strokePlusGeometry(rCtx, { kind: 'plus-pen', color: '#000', width: 0, dashStyle: 0, transform: [3, 0, 0, 3, 0, 0] }, (c) => c.moveTo(0, 0), null);
		expect(ctx.lineWidth).toBe(1);
	});

	it.each([
		['scale-x', [3, 0, 0, 1, 0, 0]],
		['scale-y', [1, 0, 0, 3, 0, 0]],
		['skew-x', [1, 0, 2, 1, 0, 0]],
		['skew-y', [1, 2, 0, 1, 0, 0]],
		['scale-x-aa', [3, 0, 0, 1, 0, 0]],
		['scale-y-aa', [1, 0, 0, 3, 0, 0]],
		['skew-x-aa', [1, 0, 2, 1, 0, 0]],
		['skew-y-aa', [1, 2, 0, 1, 0, 0]],
	] as const)('matches every native GDI+ pixel for an affine %s pen', async (name, transform) => {
		await ensureNodeCanvasModule();
		const { createCanvas } = await import('@napi-rs/canvas');
		const ctx = createCanvas(80, 64).getContext('2d') as unknown as CanvasContext;
		ctx.fillStyle = '#fff';
		ctx.fillRect(0, 0, 80, 64);
		const rCtx = { ctx, antiAlias: name.endsWith('-aa'), gdiAntialias: false, worldTransform: [1, 0, 0, 1, 0, 0], pageUnit: 2, pageScale: 1, dpiScale: 1, objectTable: new Map() } as unknown as EmfPlusReplayCtx;
		strokePlusGeometry(rCtx, {
			kind: 'plus-pen', color: '#000000', width: 4, dashStyle: 0,
			transform: [...transform],
		}, (c) => { c.moveTo(12, 30); c.lineTo(68, 30); }, null);
		const expected = (await decodePng(new Uint8Array(readFileSync(new URL(`./__fixtures__/gdi/pen-${name}.png`, import.meta.url)))))!;
		expect(Array.from(ctx.getImageData!(0, 0, 80, 64).data)).toEqual(Array.from(expected.data));
	});
});

describe('nonuniform and skewed pen transforms', () => {
	it.each([['squareanchor', 0x11], ['roundanchor', 0x12], ['diamondanchor', 0x13]] as const)('matches native %s cap pixels', async (name, cap) => {
		await ensureNodeCanvasModule();
		const { createCanvas } = await import('@napi-rs/canvas');
		for (const antiAlias of [false, true]) {
			const ctx = createCanvas(100, 100).getContext('2d') as unknown as CanvasContext;
			ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 100, 100);
			const rCtx = { ctx, antiAlias, gdiAntialias: false, worldTransform: [1, 0, 0, 1, 0, 0], pageUnit: 2, pageScale: 1, dpiScale: 1, objectTable: new Map() } as unknown as EmfPlusReplayCtx;
			const pen: EmfPlusPen = { kind: 'plus-pen', color: '#000000', width: 4, dashStyle: 0, startCap: cap, endCap: cap };
			for (const [x, y, ex, ey] of [[20, 25, 80, 25], [20, 50, 80, 80]]) strokePlusGeometry(rCtx, pen, (c) => { c.moveTo(x, y); c.lineTo(ex, ey); }, null);
			const expected = (await decodePng(new Uint8Array(readFileSync(new URL(`./__fixtures__/gdi/pen-anchor-${name}${antiAlias ? '-aa' : ''}-direct.png`, import.meta.url)))))!;
			const actual = ctx.getImageData!(0, 0, 100, 100).data;
			let mismatch = 0, max = 0;
			for (let i = 0; i < actual.length; i++) { const diff = Math.abs(actual[i] - expected.data[i]); if (diff > 1) mismatch++; max = Math.max(max, diff); }
			expect({ mismatch, max }, `${name} antialias=${antiAlias}`).toEqual({ mismatch: 0, max: 0 });
		}
	});
	it.each([false, true])('matches every native pixel for uniform-scale dashes (antialias=%s)', async (antiAlias) => {
		await ensureNodeCanvasModule();
		const { createCanvas } = await import('@napi-rs/canvas');
		const ctx = createCanvas(100, 100).getContext('2d') as unknown as CanvasContext;
		ctx.fillStyle = '#fff';
		ctx.fillRect(0, 0, 100, 100);
		const rCtx = { ctx, antiAlias, gdiAntialias: false, worldTransform: [1, 0, 0, 1, 0, 0], pageUnit: 2, pageScale: 1, dpiScale: 1, objectTable: new Map() } as unknown as EmfPlusReplayCtx;
		strokePlusGeometry(rCtx, { kind: 'plus-pen', color: '#000', width: 2, dashStyle: 1, transform: [3, 0, 0, 3, 0, 0] }, (c) => { c.moveTo(0, 50); c.lineTo(100, 50); }, null);
		const expected = (await decodePng(new Uint8Array(readFileSync(new URL(`./__fixtures__/gdi/pen-scale3-dash${antiAlias ? '-aa' : ''}-direct.png`, import.meta.url)))))!;
		expect(ctx.getImageData!(0, 0, 100, 100).data).toEqual(expected.data);
	});
	/** Strokes each path with `pen` in black on a white 100 x 100 canvas; returns each pixel's ink (0 to 1). */
	async function strokeOnCanvas(
		pen: EmfPlusPen,
		paths: Array<(c: CanvasContext) => void>,
		extra: Partial<EmfPlusReplayCtx> = {},
	): Promise<(x: number, y: number) => number> {
		const { createCanvas } = await import('@napi-rs/canvas');
		const canvas = createCanvas(100, 100);
		const ctx = canvas.getContext('2d') as unknown as CanvasContext;
		ctx.fillStyle = '#fff';
		ctx.fillRect(0, 0, 100, 100);
		const rCtx = {
			ctx,
			worldTransform: [1, 0, 0, 1, 0, 0],
			pageUnit: 2,
			pageScale: 1,
			dpiScale: 1,
			objectTable: new Map(),
			...extra,
		} as unknown as EmfPlusReplayCtx;
		for (const path of paths) {
			strokePlusGeometry(rCtx, pen, path, null);
		}
		const data = ctx.getImageData!(0, 0, 100, 100).data;
		return (x, y) => 1 - data[(y * 100 + x) * 4] / 255;
	}

	/** Total ink across column (or row) `at`: the stroke's thickness there, in pixels. */
	function run(ink: (x: number, y: number) => number, axis: 'col' | 'row', at: number): number {
		let n = 0;
		for (let i = 0; i < 100; i++) {
			n += axis === 'col' ? ink(at, i) : ink(i, at);
		}
		return n;
	}

	const horizontal = (c: CanvasContext): void => {
		c.moveTo(10, 20);
		c.lineTo(60, 20);
	};
	const vertical = (c: CanvasContext): void => {
		c.moveTo(50, 40);
		c.lineTo(50, 90);
	};
	const scaled: EmfPlusPen = { kind: 'plus-pen', color: '#000', width: 2, dashStyle: 0, transform: [4, 0, 0, 1, 0, 0] };

	for (const [label, extra] of [
		['aliased GDI+ raster', {}],
		['antialiased GDI+ raster', { antiAlias: true }],
		['Canvas stroke', { gdiAntialias: true }],
	] as Array<[string, Partial<EmfPlusReplayCtx>]>) {
		it(`widens a scale(4, 1) nib only horizontally (${label})`, async () => {
			const ink = await strokeOnCanvas(scaled, [horizontal, vertical], extra);
			// The nib is 8 wide and 2 tall: a horizontal line stays 2 pixels
			// thick, a vertical one of the same pen is 4 times as wide.
			const across = run(ink, 'col', 30);
			const along = run(ink, 'row', 65);
			expect(across).toBeCloseTo(2, 0);
			expect(along).toBeCloseTo(8, 0);
			expect(along / across).toBeCloseTo(4, 0);
			// The path itself does not move: both strokes stay centred on it.
			let cx = 0;
			for (let x = 0; x < 100; x++) {
				cx += x * ink(x, 65);
			}
			expect(Math.abs(cx / along + 0.5 - 50)).toBeLessThanOrEqual(0.5);
		});
	}

	it('shears the nib of a skewed pen, slanting a flat line end', async () => {
		// x' = x + y: the round nib becomes an ellipse sheared along x, so a
		// vertical line is sqrt(2) times as wide, and its flat cap (square to
		// the path in pen space) runs along (2, 1) in world space: the right
		// edge of the stroke reaches 4 pixels further down than the left.
		const pen: EmfPlusPen = { kind: 'plus-pen', color: '#000', width: 8, dashStyle: 0, transform: [1, 0, 1, 1, 0, 0] };
		const ink = await strokeOnCanvas(pen, [(c) => {
			c.moveTo(50, 20);
			c.lineTo(50, 80);
		}]);
		const dark = (x: number, y: number): boolean => ink(x, y) > 0.5;
		expect(Math.abs(run(ink, 'row', 50) - 8 * Math.SQRT2)).toBeLessThanOrEqual(1);
		const bottom = (x: number): number => {
			let y = 99;
			while (y > 0 && !dark(x, y)) {
				y--;
			}
			return y;
		};
		const top = (x: number): number => {
			let y = 0;
			while (y < 99 && !dark(x, y)) {
				y++;
			}
			return y;
		};
		expect(Math.abs(bottom(54) - bottom(46) - 4)).toBeLessThanOrEqual(1);
		expect(Math.abs(top(54) - top(46) - 4)).toBeLessThanOrEqual(1);
		// A horizontal line keeps the nib's vertical extent: 8 pixels.
		const flat = await strokeOnCanvas(pen, [horizontal]);
		expect(run(flat, 'col', 35)).toBeCloseTo(8, 0);
	});

	it('lays dashes out in world space under a nonuniform nib, as GDI+ does', async () => {
		// Dash 3 on, 1 off in pen widths (2): 8 world pixels per period along
		// the path whatever the (4, 1) nib does to the pen (pen-scale4x1-dash).
		const pen: EmfPlusPen = { ...scaled, dashStyle: 1 };
		const ink = await strokeOnCanvas(pen, [(c) => {
			c.moveTo(0, 50);
			c.lineTo(100, 50);
		}], { gdiAntialias: true });
		const starts: number[] = [];
		for (let x = 1; x < 100; x++) {
			if (ink(x, 50) > 0.5 && !(ink(x - 1, 50) > 0.5)) {
				starts.push(x);
			}
		}
		expect(starts).toEqual([8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 96]);
	});

	it('writes an SVG stroke under world x nib with the unchanged path', async () => {
		const { SvgContext } = await import('./svg-context');
		const ctx = new SvgContext(100, 100);
		const rCtx = { ctx, worldTransform: [1, 0, 0, 1, 0, 0], pageUnit: 2, pageScale: 1, dpiScale: 1, objectTable: new Map() } as unknown as EmfPlusReplayCtx;
		strokePlusGeometry(rCtx, scaled, vertical, null);
		const tree = await ctx.toTree();
		const paths: Array<Record<string, string>> = [];
		const walk = (n: { tag: string; attrs?: Record<string, string>; children?: unknown[] }): void => {
			if (n.tag === 'path' && n.attrs?.stroke) {
				paths.push(n.attrs);
			}
			(n.children as (typeof n)[] | undefined)?.forEach(walk);
		};
		walk(tree as never);
		expect(paths).toHaveLength(1);
		expect(paths[0]).toMatchObject({ transform: 'matrix(4 0 0 1 0 0)', 'stroke-width': '2', d: 'M12.5 40l0 50' });
	});

	it('fills the widened outline for a gradient pen in SVG, keeping the paint in world space', async () => {
		const { SvgContext } = await import('./svg-context');
		const ctx = new SvgContext(100, 100);
		const rCtx = { ctx, worldTransform: [1, 0, 0, 1, 0, 0], pageUnit: 2, pageScale: 1, dpiScale: 1, objectTable: new Map() } as unknown as EmfPlusReplayCtx;
		const gradient = ctx.createLinearGradient(0, 0, 100, 0);
		gradient.addColorStop(0, '#000');
		gradient.addColorStop(1, '#f00');
		const fill = { kind: 'plus-brush', color: '#000' } as unknown as NonNullable<EmfPlusPen['brush']>;
		const pen: EmfPlusPen = { ...scaled, brush: fill };
		const spy = vi.spyOn(await import('./emf-plus-state-handlers'), 'brushPaint').mockReturnValue(gradient as unknown as CanvasGradient);
		try {
			strokePlusGeometry(rCtx, pen, vertical, null);
		} finally {
			spy.mockRestore();
		}
		const tree = await ctx.toTree();
		const found: Array<Record<string, string>> = [];
		const walk = (n: { tag: string; attrs?: Record<string, string>; children?: unknown[] }): void => {
			if (n.tag === 'path' && n.attrs) {
				found.push(n.attrs);
			}
			(n.children as (typeof n)[] | undefined)?.forEach(walk);
		};
		walk(tree as never);
		const outline = found.find((a) => a.fill?.startsWith('url('));
		expect(outline).toBeDefined();
		expect(outline!.stroke).toBeUndefined();
		expect(outline!.transform).toBeUndefined();
		// The outline spans the nib's 8-pixel width about x = 50.
		const xs = [...outline!.d.matchAll(/M([\d.]+)/g)].map((m) => Number(m[1]));
		expect(Math.min(...xs)).toBeGreaterThanOrEqual(45.9);
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

	it('follows the recorded SmoothingMode unless gdiAntialias: true', () => {
		const ctx = {} as CanvasContext;
		expect(isPlusAliased({ ctx, gdiAntialias: false } as EmfPlusReplayCtx)).toBe(true);
		expect(isPlusAliased({ ctx } as EmfPlusReplayCtx)).toBe(true);
		expect(isPlusAliased({ ctx, antiAlias: true } as EmfPlusReplayCtx)).toBe(false);
		expect(plusRasterMode({ ctx } as EmfPlusReplayCtx)).toBe('aliased');
		expect(plusRasterMode({ ctx, antiAlias: true } as EmfPlusReplayCtx)).toBe('gdiplus-aa');
		expect(plusRasterMode({ ctx, gdiAntialias: false, antiAlias: true } as EmfPlusReplayCtx)).toBe('gdiplus-aa');
		expect(plusRasterMode({ ctx, gdiAntialias: true } as EmfPlusReplayCtx)).toBe('canvas');
		expect(plusRasterMode({ ctx, gdiAntialias: true, antiAlias: true } as EmfPlusReplayCtx)).toBe('canvas');
	});
});

describe('custom caps of gradient pens', () => {
	// A filled AdjustableArrowCap(3, 4): at pen width 4 the arrow is 12 wide
	// and 16 long, its tip on the line's end.
	const arrow: EmfPlusCustomLineCap = {
		kind: 'plus-customlinecap',
		capType: 1,
		baseCap: 0,
		baseInset: 4 / 3,
		strokeStartCap: 0,
		strokeEndCap: 0,
		strokeJoin: 0,
		strokeMiterLimit: 10,
		widthScale: 1,
		fillPath: arrowCapPath(3, 4, 0, true),
		linePath: null,
		fillLength: 4,
		strokeLength: 0,
		arrow: { width: 3, height: 4, middleInset: 0, filled: true },
	};
	// Red at x = 0 to blue at x = 100, laid out in world space.
	const brush: NonNullable<EmfPlusPen['brush']> = {
		kind: 'plus-brush',
		color: 'rgba(255,0,0,1.000)',
		gradient: {
			type: 'linear',
			x1: 0,
			y1: 50,
			x2: 100,
			y2: 50,
			wrapMode: 'tile',
			rect: { x: 0, y: 0, w: 100, h: 100 },
			transform: null,
			// As parsed: the recorded ramp selects GDI+'s exact sampler.
			ramp: { startArgb: 0xffff0000, endArgb: 0xff0000ff, preset: null, blend: null, gammaCorrected: false },
			stops: [
				{ offset: 0, color: 'rgba(255,0,0,1.000)' },
				{ offset: 1, color: 'rgba(0,0,255,1.000)' },
			],
		},
	};
	const pen: EmfPlusPen = { kind: 'plus-pen', color: 'rgba(255,0,0,1.000)', width: 4, dashStyle: 0, brush, customEndCap: arrow };
	const line = (c: CanvasContext): void => {
		c.moveTo(10, 50);
		c.lineTo(80, 50);
	};
	const rCtxFor = (ctx: CanvasContext): EmfPlusReplayCtx =>
		({
			ctx,
			worldTransform: [1, 0, 0, 1, 0, 0],
			pageUnit: 2,
			pageScale: 1,
			dpiScale: 1,
			objectTable: new Map(),
			gdiAntialias: true,
		}) as unknown as EmfPlusReplayCtx;

	it('paints the arrow with the gradient on the Canvas route (gdiAntialias: true)', async () => {
		await ensureNodeCanvasModule();
		const surface = createTempCanvas(100, 100);
		if (!surface) {
			throw new Error('@napi-rs/canvas backend unavailable');
		}
		const ctx = surface.ctx;
		ctx.fillStyle = '#fff';
		ctx.fillRect(0, 0, 100, 100);
		strokePlusGeometry(rCtxFor(ctx), pen, line, [
			{ x: 10, y: 50 },
			{ x: 80, y: 50 },
		]);
		const data = canvasGetImageData(ctx, 0, 0, 100, 100).data;
		const px = (x: number, y: number): number[] => Array.from(data.subarray((y * 100 + x) * 4, (y * 100 + x) * 4 + 3));
		// Beside the line (half width 2) but inside the arrow's wings, which
		// are 12 wide at x = 64 and narrow to the tip at x = 80.
		for (const y of [47, 52]) {
			const [r, g, b] = px(70, y);
			expect(g).toBeLessThan(40);
			// The gradient's colour at x = 70: 30 % red, 70 % blue.
			expect(Math.abs(r - 0.3 * 255)).toBeLessThan(25);
			expect(Math.abs(b - 0.7 * 255)).toBeLessThan(25);
		}
		// The line keeps the gradient too: mostly red near its start.
		const [r0, , b0] = px(20, 50);
		expect(r0).toBeGreaterThan(b0);
		// Past the tip and outside the wings: untouched.
		expect(px(84, 50)).toEqual([255, 255, 255]);
		expect(px(70, 40)).toEqual([255, 255, 255]);
	});

	it('fills the capped outline with the gradient paint in SVG', async () => {
		const { SvgContext } = await import('./svg-context');
		const ctx = new SvgContext(100, 100);
		strokePlusGeometry(rCtxFor(ctx as unknown as CanvasContext), pen, line, null);
		const tree = await ctx.toTree();
		const paths: Array<Record<string, string>> = [];
		let gradients = 0;
		const walk = (n: { tag: string; attrs?: Record<string, string>; children?: unknown[] }): void => {
			if (n.tag === 'path' && n.attrs) {
				paths.push(n.attrs);
			}
			if (n.tag === 'linearGradient') {
				gradients++;
			}
			(n.children as (typeof n)[] | undefined)?.forEach(walk);
		};
		walk(tree as never);
		expect(gradients).toBe(1);
		expect(paths).toHaveLength(1);
		const outline = paths[0];
		expect(outline.fill).toMatch(/^url\(/);
		expect(outline.stroke).toBeUndefined();
		// One outline takes in the line and the arrow: 12 wide about y = 50,
		// its tip at x = 80.
		const pts = svgPathPoints(outline.d);
		const xs = pts.map((p) => p.x);
		const ys = pts.map((p) => p.y);
		expect(Math.min(...xs)).toBeCloseTo(10, 1);
		expect(Math.max(...xs)).toBeCloseTo(80, 1);
		expect(Math.min(...ys)).toBeCloseTo(44, 1);
		expect(Math.max(...ys)).toBeCloseTo(56, 1);
	});
});

/** The absolute vertices of an SVG path made of M/L/H/V/Z commands (either case). */
function svgPathPoints(d: string): Array<{ x: number; y: number }> {
	const out: Array<{ x: number; y: number }> = [];
	let x = 0;
	let y = 0;
	let sx = 0;
	let sy = 0;
	for (const [, cmd, args] of d.matchAll(/([MmLlHhVvZz])([^MmLlHhVvZz]*)/g)) {
		const n = (args.match(/-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? []).map(Number);
		const rel = cmd === cmd.toLowerCase();
		switch (cmd.toUpperCase()) {
			case 'M':
			case 'L':
				for (let i = 0; i + 1 < n.length; i += 2) {
					x = rel ? x + n[i] : n[i];
					y = rel ? y + n[i + 1] : n[i + 1];
					if (cmd.toUpperCase() === 'M' && i === 0) {
						sx = x;
						sy = y;
					}
					out.push({ x, y });
				}
				break;
			case 'H':
				for (const v of n) {
					x = rel ? x + v : v;
					out.push({ x, y });
				}
				break;
			case 'V':
				for (const v of n) {
					y = rel ? y + v : v;
					out.push({ x, y });
				}
				break;
			default:
				x = sx;
				y = sy;
		}
	}
	return out;
}
