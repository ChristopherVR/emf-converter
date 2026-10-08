import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pathGradientSampler } from './emf-plus-exact-fill';

/**
 * What a uniform path gradient is computed from when the brush paints something other than a rectangle
 * (`PathGradientFillProbe.cs`, `path-gradient-fills.json.gz`): the same white-to-navy brush on a rectangle, a
 * triangle and a 24-gon ellipse, once filling the whole canvas (`-base`) and once through 1-, 6- and 20-pixel pens
 * (horizontal and diagonal lines, 4- and 16-pixel ellipse outlines), single-bit "Hg" text at 14 to 96 pixels and ellipse,
 * polygon and rectangle fills.
 *
 * Every painted pixel of every pen, glyph and fill equals the baseline pixel at the same place (56,503 pixels, none
 * differs): the step count and the copies follow the brush path alone, not the widened outline, the glyph outlines or the
 * string's layout rectangle, so the text and pen residuals of `gpx-text-pathgrad` and `gpx-pen-pathgrad` are the filled
 * shape's own edges and never the gradient.
 *
 * The baseline itself pins the rasteriser: the rectangle and the ellipse are exact (the ellipse's flat edges beside its
 * extremes are left unpainted by native, where the smooth ratio used to paint 8 pixels), the triangle differs by at most
 * one level on slanted-edge ties.
 */
interface Capture { name: string; w: number; h: number; center: [number, number]; points: [number, number][]; bgra: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/path-gradient-fills.json.gz', import.meta.url))).toString());
const bytes = new Map(captures.map((c) => [c.name, Buffer.from(c.bgra, 'base64')]));

describe('path-gradient pens, text and fills take the brush path\'s copies', () => {
	const ops = captures.filter((c) => !c.name.endsWith('-base'));
	it('covers three brush shapes and fifteen operations each', () => {
		expect(captures.length).toBe(48);
		expect(ops.length).toBe(45);
	});
	it('paints exactly the baseline colour wherever a pen, glyph or fill paints', () => {
		let painted = 0;
		let differ = 0;
		let outside = 0;
		for (const c of ops) {
			const base = bytes.get(`${c.name.split('-')[0]}-base`)!;
			const o = bytes.get(c.name)!;
			for (let p = 0; p < c.w * c.h; p++) {
				if (o[p * 4 + 3] === 0) continue;
				painted++;
				if (base[p * 4 + 3] === 0) { outside++; continue; }
				if (o[p * 4] !== base[p * 4] || o[p * 4 + 1] !== base[p * 4 + 1] || o[p * 4 + 2] !== base[p * 4 + 2]) differ++;
			}
		}
		expect(painted).toBe(56503);
		expect(differ).toBe(0);
		expect(outside).toBe(0);
	});
	// [native pixels, pixels differing at zero tolerance (ceiling), pixels beyond one level (ceiling), unpainted, extra]
	const EXPECTED: Record<string, [number, number, number, number, number]> = {
		'rect-base': [4800, 0, 0, 0, 0],
		'tri-base': [7500, 42, 0, 0, 0],
		'ell-base': [8382, 0, 0, 0, 0],
	};
	for (const [name, [native, differ, beyond, unpainted, extra]] of Object.entries(EXPECTED)) {
		it(`${name}: reproduced`, () => {
			const c = captures.find((x) => x.name === name)!;
			const sampler = pathGradientSampler({
				boundary: c.points.map(([x, y]) => ({ x, y })),
				center: { x: c.center[0], y: c.center[1] },
				centerArgb: 0xffffffff,
				boundaryArgb: c.points.map(() => 0xff140a78),
				focus: null,
				blend: null,
				preset: null,
				transform: null,
			}, 'clamp', [1, 0, 0, 1, 0, 0])!;
			const rgba = new Uint8ClampedArray(c.w * c.h * 4);
			sampler(0, 0, c.w, c.h, rgba);
			const nat = bytes.get(name)!;
			let n = 0, bad = 0, far = 0, miss = 0, more = 0;
			for (let p = 0; p < c.w * c.h; p++) {
				const na = nat[p * 4 + 3];
				const oa = rgba[p * 4 + 3];
				if (na === 0 && oa === 0) continue;
				if (na === 0) { more++; continue; }
				n++;
				if (oa === 0) { miss++; continue; }
				const d = Math.max(Math.abs(rgba[p * 4] - nat[p * 4 + 2]), Math.abs(rgba[p * 4 + 1] - nat[p * 4 + 1]), Math.abs(rgba[p * 4 + 2] - nat[p * 4]));
				if (d > 0) bad++;
				if (d > 1) far++;
			}
			expect(n).toBe(native);
			expect(bad).toBeLessThanOrEqual(differ);
			expect(far).toBeLessThanOrEqual(beyond);
			expect(miss).toBeLessThanOrEqual(unpainted);
			expect(more).toBeLessThanOrEqual(extra);
		});
	}
});
