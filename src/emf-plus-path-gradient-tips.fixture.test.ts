import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pathGradientSampler } from './emf-plus-exact-fill';

/**
 * The tip pixels of a uniform path gradient (`PathGradientTipProbe.cs`, `path-gradient-tips.json.gz`): a white-to-black
 * triangle whose apex sits at every 1/16 pixel offset in x and y (256 clamped captures, `tc-`) and in x only (16 tiled
 * captures whose bounds stay on whole pixels, `tt-`), and an ellipse shifted by every 1/16 offset (256 clamped captures,
 * `ec-`, and one tiled, `et-`). The pixel on an apex or an extreme point, and the flat edge pixels beside it, are unpainted
 * by native when the nested copies' scan conversion leaves them outside the boundary: none of the 529 captures has a pixel
 * we paint and native does not, or the reverse (the smooth ratio painted 2 in the tiled ellipse and 5 over the tiled triangles before; the clamped captures never had any).
 * Every pixel of every capture is exact: the pixels that were one step off (110 of 185,646 clamped triangle pixels, 216 of
 * 27,666 tiled triangle pixels and 31 of 316,689 clamped ellipse pixels, all slanted-edge ties) follow the float32 rule of
 * `floatCopyIndex`.
 */
interface Capture { name: string; w: number; h: number; center: [number, number]; points: [number, number][]; ra: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/path-gradient-tips.json.gz', import.meta.url))).toString());

interface Totals { captures: number; native: number; differ: number; unpainted: number; extra: number }
const groups = new Map<string, Totals>();
for (const c of captures) {
	const boundary = c.points.map(([x, y]) => ({ x, y }));
	if (boundary.length > 1 && boundary[0].x === boundary[boundary.length - 1].x && boundary[0].y === boundary[boundary.length - 1].y) boundary.pop();
	const wrap = c.name.startsWith('tt') || c.name.startsWith('et') ? 'tile' : 'clamp';
	const sampler = pathGradientSampler({
		boundary,
		center: { x: c.center[0], y: c.center[1] },
		centerArgb: 0xffffffff,
		boundaryArgb: boundary.map(() => 0xff000000),
		focus: null,
		blend: null,
		preset: null,
		transform: null,
	}, wrap, [1, 0, 0, 1, 0, 0])!;
	const rgba = new Uint8ClampedArray(c.w * c.h * 4);
	sampler(0, 0, c.w, c.h, rgba);
	const nat = Buffer.from(c.ra, 'base64');
	const key = c.name.split('-')[0];
	const t = groups.get(key) ?? { captures: 0, native: 0, differ: 0, unpainted: 0, extra: 0 };
	t.captures++;
	for (let p = 0; p < c.w * c.h; p++) {
		const na = nat[p * 2 + 1];
		const oa = rgba[p * 4 + 3];
		if (na === 0 && oa === 0) continue;
		if (na === 0) { t.extra++; continue; }
		t.native++;
		if (oa === 0) { t.unpainted++; continue; }
		if (rgba[p * 4] !== nat[p * 2]) t.differ++;
	}
	groups.set(key, t);
}

/** [captures, native pixels, differing pixels (ceiling), unpainted (ceiling), extra (ceiling)]. */
const EXPECTED: Record<string, [number, number, number, number, number]> = {
	tc: [256, 185646, 0, 0, 0],
	tt: [16, 27666, 0, 0, 0],
	ec: [256, 316689, 0, 0, 0],
	et: [1, 2904, 0, 0, 0],
};

describe('tip pixels of a uniform path gradient', () => {
	for (const [key, [count, native, differ, unpainted, extra]] of Object.entries(EXPECTED)) {
		it(`${key}: ${count} captures`, () => {
			const t = groups.get(key)!;
			expect(t.captures).toBe(count);
			expect(t.native).toBe(native);
			expect(t.differ).toBeLessThanOrEqual(differ);
			expect(t.unpainted).toBeLessThanOrEqual(unpainted);
			expect(t.extra).toBeLessThanOrEqual(extra);
		});
	}
});
