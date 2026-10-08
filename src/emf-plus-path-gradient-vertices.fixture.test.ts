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
 * Before the fan-triangle model the same groups were exact on 29% (rgb), 22% (shape), 52% (redonly),
 * 0.8% (rand), 0.08% (randa), 0.5% (randf, focus scales), 1.0% (randr) and 0.2 to 0.6% (randt) of
 * their native pixels. Native ignores FocusScales when the surrounds differ per vertex.
 */
const EXPECTED: Record<string, [number, number, number, number, number]> = {
	rgb: [4, 33632, 33536, 33632, 1],
	shape: [8, 17484, 16470, 17484, 1],
	redonly: [6, 11655, 11529, 11655, 1],
	two: [1, 1843, 1836, 1843, 1],
	quad: [1, 3320, 3229, 3320, 1],
	pentagon: [1, 3702, 3616, 3702, 1],
	small: [2, 408, 390, 408, 1],
	rand: [120, 44454, 43911, 44454, 1],
	randa: [60, 20463, 20321, 20463, 1],
	randf: [40, 14766, 14577, 14766, 1],
	randr: [30, 7815, 7551, 7719, 24],
	randt_0: [10, 1686, 1644, 1686, 1],
	randt_1: [10, 1061, 1032, 1061, 1],
	randt_2: [10, 2951, 2921, 2951, 1],
	randt_3: [10, 2951, 2912, 2951, 1],
	randt_4: [10, 2949, 2825, 2878, 23],
	randt_5: [10, 2944, 2894, 2944, 1],
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
