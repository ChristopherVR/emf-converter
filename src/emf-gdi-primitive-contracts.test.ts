/** Generated semantic/containment regressions, not Windows or Visio golden images. */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureNodeCanvasModule } from './emf-canvas-helpers';
import { EMR_ARC, EMR_ARCTO, EMR_CHORD, EMR_ELLIPSE, EMR_PIE, EMR_RECTANGLE, EMR_ROUNDRECT } from './emf-constants';
import { handleEmfGdiShapeRecord } from './emf-gdi-draw-shapes';
import { flushRasterLayer } from './emf-gdi-raster-layer';
import { SvgContext } from './svg-context';
import type { CanvasContext, EmfGdiReplayCtx } from './emf-types';
import { defaultState } from './emf-types';
import { svgTreeToString, type SvgNode } from './svg-tree';

beforeAll(async () => { await ensureNodeCanvasModule(); });

const box = [20, 20, 60, 40] as const;

function replay(ctx: CanvasContext = createCanvas(96, 64).getContext('2d') as unknown as CanvasContext): EmfGdiReplayCtx {
	return {
		ctx, view: new DataView(new ArrayBuffer(128)), objectTable: new Map(), state: defaultState(), stateStack: [], inPath: false,
		windowOrg: { x: 0, y: 0 }, windowExt: { cx: 96, cy: 64 }, viewportOrg: { x: 0, y: 0 }, viewportExt: { cx: 96, cy: 64 },
		useMappingMode: false, clipSaveDepth: 0, bounds: { left: 0, top: 0, right: 96, bottom: 64 }, canvasW: 96, canvasH: 64,
		sx: 1, sy: 1, pathCmds: [],
	};
}

function draw(r: EmfGdiReplayCtx, type: number, words: readonly number[]): void {
	words.forEach((v, i) => r.view.setInt32(i * 4, v, true));
	expect(handleEmfGdiShapeRecord(r, type, 0, 8 + words.length * 4)).toBe(true);
}

function pixels(r: EmfGdiReplayCtx): Array<[number, number]> {
	flushRasterLayer(r);
	const rgba = r.ctx.getImageData(0, 0, 96, 64).data;
	const result: Array<[number, number]> = [];
	for (let y = 0; y < 64; y++) for (let x = 0; x < 96; x++) if (rgba[(y * 96 + x) * 4 + 3]) result.push([x, y]);
	return result;
}

function paths(n: SvgNode): SvgNode[] {
	return [...(n.tag === 'path' ? [n] : []), ...(n.children ?? []).flatMap(paths)];
}

const arcWords = (endX: number) => [...box, 60, 30, endX, 30];

describe('same-ray Arc/ArcTo/Chord semantics', () => {
	for (const type of [EMR_ARC, EMR_ARCTO, EMR_CHORD]) for (const direction of [1, 2]) for (const endX of [60, 80]) {
		it(`records a full ellipse for type ${type}, direction ${direction}, radial x=${endX}`, () => {
			const r = replay();
			r.inPath = true;
			r.state.arcDirection = direction;
			r.state.curX = 4;
			r.state.curY = 30;
			draw(r, type, arcWords(endX));
			const arc = r.pathCmds.find(c => c.op === 'ellipse');
			expect(arc?.op).toBe('ellipse');
			if (arc?.op !== 'ellipse') throw new Error('ellipse missing');
			expect(arc.endAngle - arc.startAngle).toBe(direction === 2 ? 2 * Math.PI : -2 * Math.PI);
			expect(arc.ccw).toBe(direction === 1);
			const all = r.rasterPath!.figures.flatMap(f => f.pts);
			const xs = all.filter((_, i) => i % 2 === 0);
			const ys = all.filter((_, i) => i % 2 !== 0);
			expect(Math.min(...xs)).toBeLessThanOrEqual(20 * 16);
			expect(Math.max(...xs)).toBe(60 * 16);
			expect(Math.min(...ys)).toBe(20 * 16);
			expect(Math.max(...ys)).toBe(40 * 16);
			expect([r.state.curX, r.state.curY]).toEqual(type === EMR_ARCTO ? [60, 30] : [4, 30]);
		});
	}

	for (const exact of [false, true]) for (const type of [EMR_ARC, EMR_ARCTO, EMR_CHORD]) {
		it(`paints all quadrants on ${exact ? 'exact raster' : 'smooth Canvas'} for type ${type}`, () => {
			const r = replay();
			r.gdiAntialias = !exact;
			r.state.brushStyle = 1;
			r.state.curX = 4;
			r.state.curY = 30;
			draw(r, type, arcWords(80));
			const ink = pixels(r);
			for (const [x, y] of [[20, 30], [60, 30], [40, 20], [40, 40]]) {
				expect(ink.some(p => Math.abs(p[0] - x) <= 1 && Math.abs(p[1] - y) <= 1)).toBe(true);
			}
			expect(ink.some(p => p[0] === 10 && p[1] === 30)).toBe(type === EMR_ARCTO);
		});
	}

	it('emits SVG curve segments rather than only a move for both coincidence forms', async () => {
		for (const endX of [60, 80]) {
			const ctx = new SvgContext(96, 64);
			const r = replay(ctx as unknown as CanvasContext);
			draw(r, EMR_ARC, arcWords(endX));
			const drawn = paths(await ctx.toTree());
			expect(drawn.length).toBeGreaterThan(0);
			expect(drawn.some(p => /[AC]/i.test(String(p.attrs.d)))).toBe(true);
		}
	});

	it('retains a full exact path when FIX rounding separates same-ray radial points', () => {
		const r = replay(); r.inPath = true; r.sx = 0.17; r.sy = 0.17;
		draw(r, EMR_ARC, [21, 21, 61, 41, 61, 41, 81, 51]);
		const points = r.rasterPath!.figures.flatMap(f => f.pts);
		const xs = points.filter((_, i) => i % 2 === 0);
		expect(Math.min(...xs)).toBeLessThanOrEqual(Math.round(21 * 0.17 * 16));
		expect(Math.max(...xs)).toBeGreaterThanOrEqual(Math.round(61 * 0.17 * 16) - 1);
	});

	it('starts Arc and Chord figures without a connector from the preceding path', () => {
		for (const type of [EMR_ARC, EMR_CHORD]) {
			const r = replay(); r.inPath = true; r.ctx.moveTo(4, 30);
			draw(r, type, arcWords(80));
			expect(r.pathCmds[0]).toEqual({ op: 'moveTo', x: 60, y: 30 });
		}
	});

	it('does not turn opposite radial rays into a full ellipse', () => {
		const r = replay(); r.inPath = true;
		draw(r, EMR_ARC, [...box, 60, 30, 20, 30]);
		const arc = r.pathCmds.find(c => c.op === 'ellipse');
		if (arc?.op !== 'ellipse') throw new Error('ellipse missing');
		expect(Math.abs(arc.endAngle - arc.startAngle)).toBe(Math.PI);
	});

	it('does not mistake LONG-coordinate nearly parallel rays for exact coincidence', () => {
		const r = replay(); r.inPath = true;
		draw(r, EMR_ARC, [-2, -2, 2, 2, 2147483646, 2147483647, 2147483645, 2147483646]);
		const arc = r.pathCmds.find(c => c.op === 'ellipse');
		if (arc?.op !== 'ellipse') throw new Error('ellipse missing');
		expect(Math.abs(arc.endAngle - arc.startAngle)).toBeLessThan(1e-12);
	});

	it('does not infer full-ellipse Pie semantics from Arc documentation', () => {
		const r = replay(); r.inPath = true;
		draw(r, EMR_PIE, arcWords(80));
		const arc = r.pathCmds.find(c => c.op === 'ellipse');
		if (arc?.op !== 'ellipse') throw new Error('ellipse missing');
		expect(arc.endAngle).toBe(arc.startAngle);
	});
});

const bounded = [EMR_RECTANGLE, EMR_ELLIPSE, EMR_ROUNDRECT, EMR_ARC, EMR_CHORD, EMR_PIE];
function shapeWords(type: number): readonly number[] {
	if (type === EMR_ROUNDRECT) return [...box, 12, 12];
	if ([EMR_ARC, EMR_CHORD, EMR_PIE].includes(type)) return [...box, 60, 30, 40, 20];
	return box;
}

describe('existing integer-grid PS_INSIDEFRAME containment', () => {
	for (const exact of [false, true]) for (const width of [2, 3, 4, 7]) for (const type of bounded) {
		it(`keeps type ${type}, width ${width} inside inclusive bounds on ${exact ? 'exact raster' : 'smooth Canvas'}`, () => {
			const r = replay();
			r.gdiAntialias = !exact;
			r.state.penStyle = 6;
			r.state.penWidth = width;
			draw(r, type, shapeWords(type));
			const ink = pixels(r);
			expect(ink.length).toBeGreaterThan(20);
			expect(ink.every(([x, y]) => x >= 20 && x <= 60 && y >= 20 && y <= 40)).toBe(true);
		});
	}

	it('retains inclusive containment when the generated SVG is rasterized', async () => {
		for (const width of [2, 3]) for (const type of bounded) {
			const ctx = new SvgContext(96, 64);
			const r = replay(ctx as unknown as CanvasContext);
			r.state.penStyle = 6; r.state.penWidth = width;
			draw(r, type, shapeWords(type));
			const image = await loadImage(Buffer.from(svgTreeToString(await ctx.toTree())));
			const rendered = replay(); rendered.ctx.drawImage(image as unknown as CanvasImageSource, 0, 0);
			const ink = pixels(rendered);
			expect(ink.length).toBeGreaterThan(20);
			expect(ink.every(([x, y]) => x >= 20 && x <= 60 && y >= 20 && y <= 40)).toBe(true);
		}
	});

});
