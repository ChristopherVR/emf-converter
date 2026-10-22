import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pathGradientSampler } from './emf-plus-exact-fill';
import type { EmfPlusPathGradientShape, TransformMatrix } from './emf-types';

/**
 * Per-vertex surround colours with a Blend or InterpolationColors curve (round 11, `PathGradientVertexBlendProbe.cs`,
 * `path-gradient-vertex-blend.json.gz`): library triangles and quads with RGB(Y) vertices over a white or black centre, five Blend
 * curves, two preset ramps, uniform-surround controls of the same curves, a focus and a rotation.
 *
 * The Gouraud fan applies the curve to the centre's weight `1 - a - b` of each triangle (`adjustValue`; the other two weights are
 * scaled to share what is left) or, for a preset ramp, takes the ramp's colour at that weight and ignores the vertex colours
 * (`interpolatePresetColors`); the one-dimensional ramp of a uniform surround reads the same stored curves at its position. This
 * was written from the disassembly of gdiplus.dll before any of these images was captured and reproduces all of them.
 */
interface Capture {
	name: string;
	w: number;
	h: number;
	focus: [number, number];
	rotate: number;
	center: [number, number];
	centerArgb: number;
	points: [number, number][];
	colors: number[];
	blend: EmfPlusPathGradientShape['blend'];
	preset: EmfPlusPathGradientShape['preset'];
	bgra: string;
}

const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/path-gradient-vertex-blend.json.gz', import.meta.url))).toString());

function render(c: Capture): Uint8ClampedArray {
	const rad = (c.rotate * Math.PI) / 180;
	const cs = Math.cos(rad);
	const sn = Math.sin(rad);
	const matrix: TransformMatrix = [cs, sn, -sn, cs, c.w / 2 - (cs * c.w) / 2 + (sn * c.h) / 2, c.h / 2 - (sn * c.w) / 2 - (cs * c.h) / 2];
	const sampler = pathGradientSampler({
		boundary: c.points.map(([x, y]) => ({ x, y })),
		center: { x: c.center[0], y: c.center[1] },
		centerArgb: c.centerArgb,
		boundaryArgb: c.colors,
		focus: c.focus[0] > 0 ? { x: c.focus[0], y: c.focus[1] } : null,
		blend: c.blend,
		preset: c.preset,
		transform: null,
	}, 'clamp', matrix)!;
	const rgba = new Uint8ClampedArray(c.w * c.h * 4);
	sampler(0, 0, c.w, c.h, rgba);
	return rgba;
}

describe('per-vertex path gradients with a Blend or InterpolationColors curve (native)', () => {
	it('has 23 captures', () => {
		expect(captures).toHaveLength(23);
	});
	for (const c of captures) {
		it(`${c.name}: every premultiplied pixel is exact`, () => {
			const rgba = render(c);
			const native = Buffer.from(c.bgra, 'base64');
			let painted = 0;
			let wrong = 0;
			for (let p = 0; p < c.w * c.h; p++) {
				const k = p * 4;
				if (native[k + 3]) painted++;
				const a = rgba[k + 3];
				let d = Math.abs(a - native[k + 3]);
				for (let q = 0; q < 3; q++) d = Math.max(d, Math.abs(Math.round((rgba[k + q] * a) / 255) - native[k + 2 - q]));
				if (d) wrong++;
			}
			expect(painted).toBeGreaterThan(1800);
			expect(wrong).toBe(0);
		});
	}
});
