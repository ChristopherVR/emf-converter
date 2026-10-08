import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { flattenBezierGdiplus, gdiplusFix } from './emf-plus-bezier';
import { pathGradientSampler } from './emf-plus-exact-fill';
import type { EmfPlusGradientWrapMode } from './emf-types';

/**
 * A white-to-black path gradient over a rectangle or an ellipse whose origin and size are fractional, filled in every
 * tile mode over several tiles (`PathGradientTileProbe.cs`: sizes 40 x 30, 40.5 x 30.25, 37.75 x 22.5 and 24 x 24 at
 * five fractional origins; the rectangles in all four wrap modes, 5 ellipses tiled). Native renders the gradient into
 * a bitmap of `round(right) - round(left)` by `round(bottom) - round(top)` pixels, the shape scaled into it, and draws
 * it as a texture from the real bounds' corner at the scale real bounds over bitmap, bilinearly (weights to 1/2048), the
 * mirrored tiles reflecting at the texel edge. `fractionalTileSampler` in `emf-plus-exact-fill.ts` reproduces it:
 * 1,535,770 of 1,536,000 rectangle pixels exact and none more than a level off (196,492 + 194,320 + 192,015 + 189,776 = 772,603
 * with the smooth ratio the tile kept before).
 */
interface Capture {
	name: string;
	w: number;
	h: number;
	wrap: number;
	bounds: [number, number, number, number];
	center: [number, number];
	ra: string;
}

const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/path-gradient-tiles.json.gz', import.meta.url))).toString());
const wraps: EmfPlusGradientWrapMode[] = ['tile', 'tile-flip-x', 'tile-flip-y', 'tile-flip-xy'];
const K = 0.5522847498307935;

/** The flattened outline GDI+ gives `AddEllipse` for a rectangle. */
function ellipseOutline(x0: number, y0: number, w: number, h: number): { x: number; y: number }[] {
	const cx = x0 + w / 2;
	const cy = y0 + h / 2;
	const rx = w / 2;
	const ry = h / 2;
	const pts = [[cx + rx, cy],
		[cx + rx, cy + K * ry], [cx + K * rx, cy + ry], [cx, cy + ry],
		[cx - K * rx, cy + ry], [cx - rx, cy + K * ry], [cx - rx, cy],
		[cx - rx, cy - K * ry], [cx - K * rx, cy - ry], [cx, cy - ry],
		[cx + K * rx, cy - ry], [cx + rx, cy - K * ry], [cx + rx, cy]];
	const boundary = [{ x: pts[0][0], y: pts[0][1] }];
	for (let k = 0; k < 4; k++) {
		const curve = pts.slice(3 * k, 3 * k + 4).flatMap(([x, y]) => [gdiplusFix(x), gdiplusFix(y)]);
		boundary[boundary.length - 1] = { x: curve[0] / 16, y: curve[1] / 16 };
		const flat: number[] = [];
		flattenBezierGdiplus(curve, flat);
		for (let q = 0; q < flat.length; q += 2) boundary.push({ x: flat[q] / 16, y: flat[q + 1] / 16 });
	}
	boundary.pop();
	return boundary;
}

interface Totals { images: number; native: number; exact: number; withinOne: number; unpainted: number; max: number }

function measure(c: Capture, totals: Totals): void {
	const [x0, y0, w, h] = c.bounds;
	const boundary = c.name.startsWith('rect')
		? [{ x: x0, y: y0 }, { x: x0 + w, y: y0 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h }]
		: ellipseOutline(x0, y0, w, h);
	const sampler = pathGradientSampler({
		boundary,
		center: { x: c.center[0], y: c.center[1] },
		centerArgb: 0xffffffff,
		boundaryArgb: boundary.map(() => 0xff000000),
		focus: null,
		blend: null,
		preset: null,
		transform: null,
	}, wraps[c.wrap], [1, 0, 0, 1, 0, 0])!;
	const rgba = new Uint8ClampedArray(c.w * c.h * 4);
	sampler(0, 0, c.w, c.h, rgba);
	const native = Buffer.from(c.ra, 'base64');
	totals.images++;
	for (let p = 0; p < c.w * c.h; p++) {
		if (native[p * 2 + 1] === 0) continue;
		totals.native++;
		if (rgba[p * 4 + 3] === 0) { totals.unpainted++; continue; }
		const d = Math.abs(rgba[p * 4] - native[p * 2]);
		if (d === 0) totals.exact++;
		if (d <= 1) totals.withinOne++;
		totals.max = Math.max(totals.max, d);
	}
}

const groups = new Map<string, Totals>();
for (const c of captures) {
	const key = c.name.startsWith('rect') ? `rect/${wraps[c.wrap]}` : 'ellipse';
	if (!groups.has(key)) groups.set(key, { images: 0, native: 0, exact: 0, withinOne: 0, unpainted: 0, max: 0 });
	measure(c, groups.get(key)!);
}

/** [images, native pixels, exact pixels (floor), pixels within one level (floor), unpainted ceiling, max error ceiling]. */
const EXPECTED: Record<string, [number, number, number, number, number, number]> = {
	// The rest: weights of the bilinear filter at a fraction like .3 or .7 (a few dozen pixels a capture).
	'rect/tile': [20, 384000, 383925, 384000, 0, 1],
	'rect/tile-flip-x': [20, 384000, 383975, 384000, 0, 1],
	'rect/tile-flip-y': [20, 384000, 383915, 384000, 0, 1],
	'rect/tile-flip-xy': [20, 384000, 383955, 384000, 0, 1],
	// The ellipse: 36,555 exact and 4,064 unpainted before; the pixels of its edge (the flattened outline scaled into the tile) are not all reproduced.
	ellipse: [5, 78494, 58985, 74115, 140, 0],
};

describe('tiles cut from fractional bounds', () => {
	it('covers every group', () => {
		expect([...groups.keys()].sort()).toEqual(Object.keys(EXPECTED).sort());
	});
	for (const [key, [images, native, exact, withinOne, unpainted, max]] of Object.entries(EXPECTED)) {
		it(`${key}: ${images} captures`, () => {
			const t = groups.get(key)!;
			expect(t.images).toBe(images);
			if (native) expect(t.native).toBe(native);
			expect(t.exact).toBeGreaterThanOrEqual(exact);
			expect(t.withinOne).toBeGreaterThanOrEqual(withinOne);
			expect(t.unpainted).toBeLessThanOrEqual(unpainted || t.unpainted);
			expect(t.max).toBeLessThanOrEqual(max || t.max);
		});
	}
});
