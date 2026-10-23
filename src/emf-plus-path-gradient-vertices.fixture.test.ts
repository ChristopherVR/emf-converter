import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pathGradientSampler } from './emf-plus-exact-fill';
import type { TransformMatrix } from './emf-types';

/**
 * Path gradients whose surround colours differ per vertex are Gouraud-shaded fan
 * triangles (see `emf-plus-path-gradient-vertices.ts`). `PathGradientVertexProbe.cs`
 * captured library triangles, quads and pentagons with RGB vertices over black and
 * white centres, 120 random polygons on a 1/16 grid, 60 translucent ones, 40 with a
 * focus, and 30 + 60 under world scales and rotations (`path-gradient-vertices.json.gz`).
 */
interface Capture {
	name: string;
	w: number;
	h: number;
	world: number;
	rotate: number;
	focus: [number, number];
	center: [number, number];
	centerArgb: number;
	points: [number, number][];
	colors: number[];
	bgra: string;
}

const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/path-gradient-vertices.json.gz', import.meta.url))).toString());

/** p' = T(c) R(rot) T(-c) S(world) p about the image centre, as the probe applies it. */
function deviceMatrix(c: Capture): TransformMatrix {
	const rad = (c.rotate * Math.PI) / 180;
	const cs = Math.cos(rad);
	const sn = Math.sin(rad);
	const w = c.world;
	return [cs * w, sn * w, -sn * w, cs * w, c.w / 2 - (cs * c.w) / 2 + (sn * c.h) / 2, c.h / 2 - (sn * c.w) / 2 - (cs * c.h) / 2];
}

interface Totals { images: number; native: number; exact: number; withinOne: number; extra: number; missing: number; max: number }

function measure(c: Capture, totals: Totals): void {
	const sampler = pathGradientSampler({
		boundary: c.points.map(([x, y]) => ({ x, y })),
		center: { x: c.center[0], y: c.center[1] },
		centerArgb: c.centerArgb,
		boundaryArgb: c.colors,
		focus: c.focus[0] > 0 || c.focus[1] > 0 ? { x: c.focus[0], y: c.focus[1] } : null,
		blend: null,
		preset: null,
		transform: null,
	}, 'clamp', deviceMatrix(c))!;
	const rgba = new Uint8ClampedArray(c.w * c.h * 4);
	sampler(0, 0, c.w, c.h, rgba);
	const native = Buffer.from(c.bgra, 'base64');
	totals.images++;
	for (let p = 0; p < c.w * c.h; p++) {
		const k = p * 4;
		const nativeAlpha = native[k + 3];
		const alpha = rgba[k + 3];
		if (nativeAlpha === 0 && alpha === 0) continue;
		if (nativeAlpha === 0) { totals.extra++; continue; }
		totals.native++;
		if (alpha === 0) { totals.missing++; continue; }
		let d = Math.abs(alpha - nativeAlpha);
		// the native bitmap is premultiplied
		for (let q = 0; q < 3; q++) d = Math.max(d, Math.abs(Math.round((rgba[k + q] * alpha) / 255) - native[k + 2 - q]));
		if (d === 0) totals.exact++;
		if (d <= 1) totals.withinOne++;
		totals.max = Math.max(totals.max, d);
	}
}

/** Capture name -> group: `rgb`, `shape`, `redonly`, `rand`, `randa`, `randf`, `randr`, `randt_0` ... */
function groupOf(name: string): string {
	const base = /^[a-z]+/.exec(name)![0];
	return name.includes('_') ? `${base}_${name.split('_')[1]}` : base;
}

const groups = new Map<string, Totals>();
for (const c of captures) {
	const key = groupOf(c.name);
	if (!groups.has(key)) groups.set(key, { images: 0, native: 0, exact: 0, withinOne: 0, extra: 0, missing: 0, max: 0 });
	measure(c, groups.get(key)!);
}

/**
 * [images, native pixels, exact pixels (floor), pixels within one level (floor), max error ceiling].
 * Every pixel of every group is exact since round 11 (the converter of gdiplus.dll, see `emf-plus-path-gradient-fan.ts`; 99.36% before,
 * with the fitted edge and span arithmetic of round 9). Native ignores FocusScales when the surrounds differ per vertex.
 */
const EXPECTED: Record<string, [number, number, number, number, number]> = {
	rgb: [4, 33632, 33632, 33632, 0],
	shape: [8, 17484, 17484, 17484, 0],
	redonly: [6, 11655, 11655, 11655, 0],
	two: [1, 1843, 1843, 1843, 0],
	quad: [1, 3320, 3320, 3320, 0],
	pentagon: [1, 3702, 3702, 3702, 0],
	small: [2, 408, 408, 408, 0],
	rand: [120, 44454, 44454, 44454, 0],
	randa: [60, 20463, 20463, 20463, 0],
	randf: [40, 14766, 14766, 14766, 0],
	randr: [30, 7815, 7815, 7815, 0],
	randt_0: [10, 1686, 1686, 1686, 0],
	randt_1: [10, 1061, 1061, 1061, 0],
	randt_2: [10, 2951, 2951, 2951, 0],
	randt_3: [10, 2951, 2951, 2951, 0],
	randt_4: [10, 2949, 2949, 2949, 0],
	randt_5: [10, 2944, 2944, 2944, 0],
};

describe('per-vertex surround colours (Gouraud fan triangles)', () => {
	it('covers every capture group', () => {
		expect([...groups.keys()].sort()).toEqual(Object.keys(EXPECTED).sort());
	});
	for (const [key, [images, native, exact, withinOne, max]] of Object.entries(EXPECTED)) {
		it(`${key}: ${images} captures`, () => {
			const t = groups.get(key)!;
			expect(t.images).toBe(images);
			expect(t.native).toBe(native);
			expect(t.exact).toBeGreaterThanOrEqual(exact);
			expect(t.withinOne).toBeGreaterThanOrEqual(withinOne);
			expect(t.max).toBeLessThanOrEqual(max);
		});
	}
});
