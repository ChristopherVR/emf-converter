import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pathGradientSampler } from './emf-plus-exact-fill';
import { unpremultipliedArgb } from './emf-plus-path-gradient-fan';
import { prepareOneD } from './emf-plus-path-gradient-oned';
import { prepareVertexGradient, vertexGradientColorAt } from './emf-plus-path-gradient-vertices';
import type { EmfPlusGradientWrapMode, EmfPlusPathGradientShape, TransformMatrix } from './emf-types';

/**
 * Where the converters' span windows come from (round 11, `PathGradientClipProbe.cs`, `path-gradient-clip.json.gz`). GDI+ asks a
 * path gradient for the spans of the shape it fills, one scanline at a time: a span that starts inside a gradient triangle
 * interpolates from its own start (a cut span, see `FanTriangle.row`), the colours of a one-dimensional ramp restart their solve at
 * the cut. The probe fills a per-vertex fan, a ramp with a focus and the same two tiled, with a small rectangle, a rectangle half off
 * the surface, an ellipse and a ten-point star (aliased, over transparent).
 *
 * The sampler is given the fill's coverage, so its window is the run of covered pixels of each row: all 16 images are exact. With
 * the fill's bounding box as the window (no coverage) the star's fan has 2 pixels wrong, which the window of each row's own span
 * gets right.
 */
interface Capture {
	name: string;
	w: number;
	h: number;
	focus: [number, number];
	wrap: number;
	center: [number, number];
	centerArgb: number;
	points: [number, number][];
	colors: number[];
	shape: 'rect' | 'ellipse' | 'poly';
	args: number[];
	bgra: string;
}

const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/path-gradient-clip.json.gz', import.meta.url))).toString());
const IDENTITY: TransformMatrix = [1, 0, 0, 1, 0, 0];
const WRAPS: EmfPlusGradientWrapMode[] = ['tile', 'tile-flip-x', 'tile-flip-y', 'tile-flip-xy', 'clamp'];

const shapeOf = (c: Capture): EmfPlusPathGradientShape => ({
	boundary: c.points.map(([x, y]) => ({ x, y })), center: { x: c.center[0], y: c.center[1] }, centerArgb: c.centerArgb, boundaryArgb: c.colors,
	focus: c.focus[0] > 0 ? { x: c.focus[0], y: c.focus[1] } : null, blend: null, preset: null, transform: null,
});

function premultiplied(argb: number | null): number[] {
	if (argb === null) return [0, 0, 0, 0];
	const a = argb >>> 24;
	return [a, Math.round((((argb >>> 16) & 255) * a) / 255), Math.round((((argb >>> 8) & 255) * a) / 255), Math.round(((argb & 255) * a) / 255)];
}

/** Wrong pixels among the native ones with the sampler's window (the fill's bounding box on the surface) and with each row's own span. */
function measure(c: Capture): { painted: number; box: number; rows: number } {
	const native = Buffer.from(c.bgra, 'base64');
	let bx0: number;
	let by0: number;
	let bx1: number;
	let by1: number;
	if (c.shape === 'poly') {
		const xs = c.args.filter((_, i) => i % 2 === 0);
		const ys = c.args.filter((_, i) => i % 2 === 1);
		[bx0, bx1, by0, by1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
	} else {
		[bx0, by0, bx1, by1] = [c.args[0], c.args[1], c.args[0] + c.args[2], c.args[1] + c.args[3]];
	}
	const x0 = Math.max(0, Math.floor(bx0));
	const y0 = Math.max(0, Math.floor(by0));
	const x1 = Math.min(c.w, Math.ceil(bx1));
	const y1 = Math.min(c.h, Math.ceil(by1));
	const w = x1 - x0;
	const rgba = new Uint8ClampedArray(w * (y1 - y0) * 4);
	// The fill's coverage (aliased: 0 or 255) tells the sampler the spans of the shape.
	const mask = new Uint8ClampedArray(w * (y1 - y0));
	for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mask[(y - y0) * w + (x - x0)] = native[(y * c.w + x) * 4 + 3] ? 255 : 0;
	pathGradientSampler(shapeOf(c), WRAPS[c.wrap], IDENTITY)!(x0, y0, w, y1 - y0, rgba, mask);
	const fan = prepareVertexGradient(shapeOf(c), IDENTITY);
	const ramp = fan ? null : prepareOneD(shapeOf(c), IDENTITY);
	let painted = 0;
	let box = 0;
	let rows = 0;
	for (let y = 0; y < c.h; y++) {
		for (let x = 0; x < c.w; x++) {
			const k = (y * c.w + x) * 4;
			if (!native[k + 3]) continue;
			painted++;
			const expected = [native[k + 3], native[k + 2], native[k + 1], native[k]];
			const o = ((y - y0) * w + (x - x0)) * 4;
			const inBox = x >= x0 && x < x1 && y >= y0 && y < y1 && rgba[o + 3] !== 0;
			const boxColor = inBox ? ((rgba[o + 3] << 24) | (rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2]) >>> 0 : null;
			if (!premultiplied(boxColor).every((v, i) => v === expected[i])) box++;
			if (c.wrap !== 4) continue;
			let left = x;
			let right = x + 1;
			while (left > 0 && native[(y * c.w + left - 1) * 4 + 3]) left--;
			while (right < c.w && native[(y * c.w + right) * 4 + 3]) right++;
			let rowColor: number | null;
			if (fan) rowColor = vertexGradientColorAt(fan, x, y, left, right);
			else {
				const v = ramp!.colorAt(x, y, left, right);
				rowColor = v === null ? null : unpremultipliedArgb(v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
			}
			if (!premultiplied(rowColor).every((v, i) => v === expected[i])) rows++;
		}
	}
	return { painted, box, rows };
}

describe('span windows of the path-gradient converters (native)', () => {
	it('has 16 captures', () => {
		expect(captures).toHaveLength(16);
	});
	for (const c of captures) {
		it(`${c.name}: ${c.shape}`, () => {
			const m = measure(c);
			expect(m.painted).toBeGreaterThan(100);
			expect(m.box).toBe(0);
			if (c.wrap === 4) expect(m.rows).toBe(0);
		});
	}
});
