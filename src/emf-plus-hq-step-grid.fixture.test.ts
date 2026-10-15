/**
 * The step of axis-aligned HighQuality upscales at 1.37x and 1.55x against `hq-step-grid.json.gz`
 * (`HighQualityStepGridProbe.cs`, mode `hq-step-grid`): 17 source widths (8 to 40) by 10 heights (8 to 336) of
 * independent grey noise, both kernels, `DrawImage(destRect, srcRect)` at (4, 4).
 *
 * The step is the rounded reciprocal of the float32 scale (47,836 or 47,837 at 1.37x, 42,281 at 1.55x). Native
 * inverts the float32 matrix with float32 arithmetic, so the last bit of each axis' scale and of the determinant
 * decides the side of a half that 1.37x lands on (65536 / 1.37 is 47,836.496): the nearest-rounded scales `a` and
 * `d` give `r = fl(1 / fl(a d))` and the steps `round(65536 fl(d r))` (x) and `round(65536 fl(a r))` (y), which is
 * why the vertical step depends on the width (`nominalScale` in `DeferredImageResample`). The extent of the quad
 * follows the scale rounded toward minus infinity, so a destination edge on a whole pixel adds no column. That
 * reproduces 572 of the 680 draws (the plain rounding of the nearest scale, 438, as the test pinned before). The 108 left
 * are tall sources (heights 200 and 336 at 1.55x, 336 at 1.37x), each one to three rows wrong, and the 8, 16 and 32
 * wide sources of height 64 at 1.37x are exact.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { resampleImage } from './emf-plus-image-resample';
import { down32 } from './float32-down';

type Draw = [number, number, number, number, number, number, number, number, string];
const grid = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/hq-step-grid.json.gz', import.meta.url))).toString()) as { draws: Draw[] };

function differing([kernel, w, h, , dw, dh, bw, bh, red]: Draw): number {
	const fr = Math.fround;
	const native = Buffer.from(red, 'base64');
	const rgba = new Uint8ClampedArray(w * h * 4);
	let seed = (w * 7919 + h * 104729 + 1) >>> 0;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			const o = (y * w + x) * 4;
			rgba[o] = rgba[o + 1] = rgba[o + 2] = seed >>> 24;
			rgba[o + 3] = 255;
		}
	}
	const block = resampleImage(
		rgba,
		w,
		h,
		{ srcX: 0, srcY: 0, srcW: w, srcH: h, toDevice: [down32(fr(dw) / w), 0, 0, down32(fr(dh) / h), 4, 4], nominalScale: [fr(fr(dw) / w), fr(fr(dh) / h)], kernel: kernel === 6 ? 'hq-bilinear' : 'hq-bicubic', halfPixelOffset: false, pointsForm: false },
		{ w: bw, h: bh },
	);
	let bad = 0;
	for (let y = 0; y < bh; y++) {
		for (let x = 0; x < bw; x++) {
			let m = 0;
			if (block && x >= block.x && x < block.x + block.w && y >= block.y && y < block.y + block.h) {
				const o = ((y - block.y) * block.w + x - block.x) * 4;
				m = Math.round((block.rgba[o] * block.rgba[o + 3]) / 255);
			}
			if (m !== native[y * bw + x]) bad++;
		}
	}
	return bad;
}

describe('step grid at 1.37x and 1.55x (native captures)', () => {
	const groups: Record<string, { draws: number; exact: number }> = {};
	for (const d of grid.draws) {
		const g = (groups[`${d[0] === 6 ? 'tent' : 'cubic'} ${d[3] / 1000}x`] ??= { draws: 0, exact: 0 });
		g.draws++;
		if (differing(d) === 0) g.exact++;
	}

	it('has the expected draws', () => {
		expect(grid.draws).toHaveLength(680);
	});

	it('pins the exact draws per kernel and scale', () => {
		expect(groups).toEqual({
			'tent 1.37x': { draws: 170, exact: 150 },
			'tent 1.55x': { draws: 170, exact: 136 },
			'cubic 1.37x': { draws: 170, exact: 150 },
			'cubic 1.55x': { draws: 170, exact: 136 },
		});
	});
});
