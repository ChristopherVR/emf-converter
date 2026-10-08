import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pathGradientSampler } from './emf-plus-exact-fill';

/**
 * Large path gradients at fractional vertices (`PathGradientLargeProbe.cs`, `path-gradient-large.json.gz`): twelve white-to-black
 * triangles and quads of 300 to 700 pixels with every vertex and the centre on the 1/16 grid, so that `N` is 954 to 1,278 steps and
 * the products of the ray-and-edge computation need more than 24 bits. Whether those products and their differences are rounded to
 * float32 (as every other operation is) or computed exactly makes no difference to any of the 984,120 pixels (the two give the same
 * copy for every pixel), so the captures cannot say which native does; `floatCopyIndex` rounds them.
 *
 * Every pixel's copy is right (the nested copies agree with native at every pixel that is not within 0.02 of a step boundary); what differs
 * is the colour of 24 of the 13,657 steps seen: a step whose value `255 k / N` sits 0.0005 to 0.009 below a half level (12.49764, 68.4967,
 * 13.49089, ...) is rounded up by native and down by `pathGradientStepColor`, which moves 2,534 pixels (0.26%) one level. No quantisation of
 * the position `k / N` to 8 to 24 bits, and no float32 evaluation of the interpolation, explains them (the best, a 16-bit position rounded up,
 * still gets 18 of the 24 wrong; a fixed-point step accumulated from the centre colour gets 12 wrong at 18 fractional bits and is not stable
 * across bit counts). The clue is the size of the shift: the value native reaches is higher than `255 k / N` by about 6e-6 levels for every step
 * counted from the centre colour (`N - k`), so the rings near the boundary move most; the residual is pinned here as open.
 */
interface Capture { name: string; w: number; h: number; center: [number, number]; points: [number, number][]; ra: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/path-gradient-large.json.gz', import.meta.url))).toString());

describe('large path gradients at fractional vertices', () => {
	it('keeps every pixel within one level and all but 0.26% exact', () => {
		let native = 0;
		let differ = 0;
		let beyond = 0;
		let unpainted = 0;
		let extra = 0;
		for (const c of captures) {
			const sampler = pathGradientSampler({
				boundary: c.points.map(([x, y]) => ({ x, y })),
				center: { x: c.center[0], y: c.center[1] },
				centerArgb: 0xffffffff,
				boundaryArgb: c.points.map(() => 0xff000000),
				focus: null,
				blend: null,
				preset: null,
				transform: null,
			}, 'clamp', [1, 0, 0, 1, 0, 0])!;
			const rgba = new Uint8ClampedArray(c.w * c.h * 4);
			sampler(0, 0, c.w, c.h, rgba);
			const nat = Buffer.from(c.ra, 'base64');
			for (let p = 0; p < c.w * c.h; p++) {
				const na = nat[p * 2 + 1];
				const oa = rgba[p * 4 + 3];
				if (na === 0 && oa === 0) continue;
				if (na === 0) { extra++; continue; }
				native++;
				if (oa === 0) { unpainted++; continue; }
				const d = Math.abs(rgba[p * 4] - nat[p * 2]);
				if (d > 0) differ++;
				if (d > 1) beyond++;
			}
		}
		expect(captures).toHaveLength(12);
		expect(native).toBe(984120);
		expect(extra).toBe(0);
		expect(unpainted).toBe(0);
		expect(beyond).toBe(0);
		expect(differ).toBeLessThanOrEqual(2534);
	});
});
