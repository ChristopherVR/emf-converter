/**
 * `gdiplus-span-stretch.ts` (GDI+'s `DpOutputSpanStretch`, read from gdiplus.dll) against native axis-aligned HighQuality
 * draws: `hq-reduction-grid.json.gz` (grey noise through `DrawImage(destRect, srcRect)`, both kernels, reductions on each axis,
 * fractional origins and the geometry of the `gpx-image-highqualitybicubic` fixture) and `hq-axis-noise.json.gz` (one row of
 * noise stretched by 0.25 to 7.1, both kernels).
 *
 * The destination rectangle the span gets is the float32 chain of the rectangle form (`rectFormDeviceMatrix`,
 * `deviceDestRect`); nothing else is fitted. What the span cannot say is which pixels the aliased fill of the destination
 * rectangle covers, so the grid test takes the columns and rows from the 1/16 pixel grid, which is why the four draws with a
 * left or top edge a hair above a whole pixel (`4 + 1/64`, `4 + 1/32`) are left out of the exact count.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { deviceDestRect, rectFormDeviceMatrix } from './gdiplus-image-points';
import { createStretch, stretchRun } from './gdiplus-span-stretch';

const load = (name: string): any => JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${name}.json.gz`, import.meta.url))).toString());

const IDENTITY = [1, 0, 0, 1, 0, 0] as const;

function destinationOf(src: readonly number[], dest: readonly number[]): [number, number, number, number] {
	return deviceDestRect(rectFormDeviceMatrix(src, dest, IDENTITY)!, src);
}

describe('DpOutputSpanStretch against native reductions', () => {
	type Draw = [number, number, number, number, number, number, number, number, number, number, string];
	const grid = load('hq-reduction-grid') as { draws: Draw[] };
	const GROUPS = ['vertical', 'horizontal', 'fixture'];

	it('reproduces 144 of the 148 draws of the grid exactly', () => {
		const groups: Record<string, { draws: number; exact: number; bad: number }> = {};
		const snap = (v: number): number => Math.floor(Math.fround(v) * 16 + 0.5);
		for (const [group, kernel, w, h, dx, dy, dw, dh, bw, bh, red] of grid.draws) {
			const native = Buffer.from(red, 'base64');
			const pixels = new Uint8Array(w * h * 4);
			let seed = (w * 7919 + h * 104729 + 1) >>> 0;
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < w; x++) {
					seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
					const o = (y * w + x) * 4;
					pixels[o] = pixels[o + 1] = pixels[o + 2] = seed >>> 24;
					pixels[o + 3] = 255;
				}
			}
			const src = [0, 0, w, h];
			const state = createStretch({ kernel: kernel === 6 ? 'tent' : 'cubic', pixels, width: w, height: h, src: src as [number, number, number, number], dest: destinationOf(src, [dx, dy, dw, dh]) })!;
			const x0 = (snap(dx) + 15) >> 4;
			const x1 = (snap(dx + dw) + 15) >> 4;
			const y0 = (snap(dy) + 15) >> 4;
			const y1 = (snap(dy + dh) + 15) >> 4;
			let bad = 0;
			for (let y = 0; y < bh; y++) {
				const run = y >= y0 && y < y1 ? stretchRun(state, y, x0, x1) : null;
				for (let x = 0; x < bw; x++) {
					const value = run && x >= run.x && x < run.x + run.pixels.length / 4 ? run.pixels[(x - run.x) * 4] : 0;
					if (value !== native[y * bw + x]) bad++;
				}
			}
			const g = (groups[`${GROUPS[group]} ${kernel === 6 ? 'tent' : 'cubic'}`] ??= { draws: 0, exact: 0, bad: 0 });
			g.draws++;
			g.bad += bad;
			if (bad === 0) g.exact++;
		}
		expect(groups).toEqual({
			'vertical tent': { draws: 37, exact: 36, bad: 128 },
			'vertical cubic': { draws: 37, exact: 36, bad: 124 },
			'horizontal tent': { draws: 35, exact: 34, bad: 16 },
			'horizontal cubic': { draws: 35, exact: 34, bad: 16 },
			'fixture tent': { draws: 2, exact: 2, bad: 0 },
			'fixture cubic': { draws: 2, exact: 2, bad: 0 },
		});
	});
});

describe('DpOutputSpanStretch against native noise rows', () => {
	it('reproduces every covered value of the 1,024-texel rows, upscaled and reduced, with both kernels', () => {
		const noise = load('hq-axis-noise') as any[];
		const values = Buffer.from(noise[0].source, 'base64');
		const n = values.length;
		const pixels = new Uint8Array(n * 8 * 4);
		for (let y = 0; y < 8; y++) {
			for (let x = 0; x < n; x++) {
				const o = (y * n + x) * 4;
				pixels[o] = pixels[o + 1] = pixels[o + 2] = values[x];
				pixels[o + 3] = 255;
			}
		}
		const stats: Record<string, { n: number; px: number; bad: number }> = {};
		for (const c of noise.slice(1)) {
			const row = Buffer.from(c.row, 'base64');
			const src = [0, 0, n, 8];
			const state = createStretch({ kernel: c.kernel === 7 ? 'cubic' : 'tent', pixels, width: n, height: 8, src: src as [number, number, number, number], dest: destinationOf(src, [0, 0, Math.fround(n * c.sx), 8]) })!;
			const run = stretchRun(state, 4, 0, c.w)!;
			const g = (stats[`k${c.kernel} ${c.sx > 1 ? 'upscale' : 'reduction'}`] ??= { n: 0, px: 0, bad: 0 });
			g.n++;
			// The draw covers the columns up to its destination's right edge; the span's own range is one column wider.
			const covered = Math.ceil(Math.fround(n * c.sx));
			for (let x = 3; x < Math.min(c.w - 3, covered); x++) {
				if (x < run.x || x >= run.x + run.pixels.length / 4) continue;
				g.px++;
				if (run.pixels[(x - run.x) * 4 + 1] !== row[x]) g.bad++;
			}
		}
		expect(stats).toEqual({
			'k6 upscale': { n: 17, px: 46569, bad: 0 },
			'k7 upscale': { n: 17, px: 46569, bad: 0 },
			'k6 reduction': { n: 8, px: 4536, bad: 0 },
			'k7 reduction': { n: 8, px: 4536, bad: 0 },
		});
	});
});
