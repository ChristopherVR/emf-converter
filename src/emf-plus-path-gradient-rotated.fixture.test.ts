import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pathGradientQuantum } from './emf-plus-brush-gradient';
import { pathGradientSampler } from './emf-plus-exact-fill';
import type { TransformMatrix } from './emf-types';

/**
 * A uniform path gradient is `N` nested copies of its boundary. Under a world or brush
 * transform `N` is not taken from the device bounding box of the transformed shape (a
 * rotation would grow it) but from the untransformed bounds `w` x `h` and the matrix's
 * linear part `M`: `ceil(|M(w, h)| + |M(w, -h)|)`, the sum of the two device diagonals of
 * the bounds. `PathGradientRotateProbe.cs` captured 70 white-to-black gradients (a
 * rectangle, a triangle and a wide rectangle, centre off the middle, fractional
 * translation) under rotations of 0 to 200 degrees, an anisotropic scale, shears and
 * mixed matrices (`path-gradient-rotated.json.gz`).
 */
interface Capture {
	name: string;
	kind: 'world' | 'brush';
	shape: string;
	w: number;
	h: number;
	matrix: TransformMatrix;
	center: [number, number];
	a: number;
	b: number;
	points: [number, number][];
	bgra: string;
}

const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/path-gradient-rotated.json.gz', import.meta.url))).toString());
const IDENTITY: TransformMatrix = [1, 0, 0, 1, 0, 0];

function exactShare(c: Capture): { exact: number; native: number } {
	const sampler = pathGradientSampler({
		boundary: c.points.map(([x, y]) => ({ x, y })),
		center: { x: c.center[0], y: c.center[1] },
		centerArgb: c.a,
		boundaryArgb: c.points.map(() => c.b),
		focus: null,
		blend: null,
		preset: null,
		transform: c.kind === 'brush' ? c.matrix : null,
	}, 'clamp', c.kind === 'world' ? c.matrix : IDENTITY)!;
	const rgba = new Uint8ClampedArray(c.w * c.h * 4);
	sampler(0, 0, c.w, c.h, rgba);
	const native = Buffer.from(c.bgra, 'base64');
	let exact = 0;
	let count = 0;
	for (let p = 0; p < c.w * c.h; p++) {
		const k = p * 4;
		if (native[k + 3] === 0) continue;
		count++;
		if (rgba[k + 3] !== 0 && rgba[k] === native[k + 2]) exact++;
	}
	return { exact, native: count };
}

describe('step count under rotated, scaled and sheared transforms', () => {
	const rectangle = [{ x: -30, y: -20 }, { x: 30, y: -20 }, { x: 30, y: 20 }, { x: -30, y: 20 }];
	it('follows the sum of the two device diagonals of the untransformed bounds', () => {
		// Native best step counts for a 60 x 40 box (found by scoring every count against the captures).
		const rotate = (deg: number): TransformMatrix => {
			const r = (deg * Math.PI) / 180;
			return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
		};
		expect(pathGradientQuantum(rectangle)).toBe(145);
		for (const deg of [15, 30, 45, 60, 90, 120, 200]) expect(pathGradientQuantum(rectangle, rotate(deg)), `${deg} degrees`).toBe(145);
		expect(pathGradientQuantum(rectangle, [1.5, 0, 0, 0.7, 0, 0])).toBe(189);
		expect(pathGradientQuantum(rectangle, [2 * Math.cos(Math.PI / 6), 2 * Math.sin(Math.PI / 6), -Math.sin(Math.PI / 6), Math.cos(Math.PI / 6), 0, 0])).toBe(253);
		expect(pathGradientQuantum(rectangle, [1, 0, 1, 1, 0, 0])).toBe(153);
		expect(pathGradientQuantum(rectangle, [1, 0, 2, 1, 0, 0])).toBe(191);
		expect(pathGradientQuantum(rectangle, [1, 1, 0, 1, 0, 0])).toBe(180);
		expect(pathGradientQuantum(rectangle, [1, -1, 0, 1, 0, 0])).toBe(180);
		expect(pathGradientQuantum(rectangle, [2, 0, 0.5, 1, 0, 0])).toBe(254);
		expect(pathGradientQuantum(rectangle, [1, 0, 0.5, 2, 0, 0])).toBe(203);
	});

	// Exact pixels among the native pixels, per category; a wrong step count leaves a capture near 45%
	// (over the 48 rotation, scale and shear captures the device-bounding-box count scored 61% and the untransformed bounds 74%).
	// What is not exact is the half-step ties and near-ties the earlier rounds documented.
	// [exact pixels, native pixels, lowest per-capture share in thousandths]
	const pinned: Record<string, [number, number, number]> = {
		rotation: [54084, 59360, 821],
		scale: [6992, 7798, 870],
		shear: [13344, 14848, 844],
		'rotation and scale': [13684, 14848, 890],
		matrices: [52835, 59382, 709],
	};

	it('reproduces every capture to the step', () => {
		expect(captures).toHaveLength(70);
		const groups: Record<string, { exact: number; native: number; lowest: number }> = {};
		for (const c of captures) {
			const key = /-rot\d+$/.test(c.name) ? 'rotation' : /rot30scale/.test(c.name) ? 'rotation and scale' : /-scale/.test(c.name) ? 'scale' : /-shear/.test(c.name) ? 'shear' : 'matrices';
			const { exact, native } = exactShare(c);
			const g = (groups[key] ??= { exact: 0, native: 0, lowest: 1 });
			g.exact += exact;
			g.native += native;
			g.lowest = Math.min(g.lowest, exact / native);
		}
		for (const [key, g] of Object.entries(groups)) {
			const expected = pinned[key];
			expect(expected, key).toBeDefined();
			expect(g.native, key).toBe(expected[1]);
			expect(g.exact, key).toBeGreaterThanOrEqual(expected[0]);
			expect(g.lowest, key).toBeGreaterThanOrEqual(expected[2] / 1000);
		}
		expect(Object.keys(groups).sort()).toEqual(Object.keys(pinned).sort());
	});
});
