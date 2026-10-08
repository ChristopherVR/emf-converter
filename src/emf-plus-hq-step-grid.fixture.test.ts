/**
 * The step of axis-aligned HighQuality upscales at 1.37x and 1.55x against `hq-step-grid.json.gz`
 * (`HighQualityStepGridProbe.cs`, mode `hq-step-grid`): 17 source widths (8 to 40) by 10 heights (8 to 336) of
 * independent grey noise, both kernels, `DrawImage(destRect, srcRect)` at (4, 4).
 *
 * The converter's step is the rounded reciprocal (`round(65536 / scale)`: 47,836 at 1.37x, 42,281 at 1.55x). Native
 * agrees for most sizes and differs for others by one unit in the step or a few units of offset; no float32 form of
 * the scale, its reciprocal or the matrix inverse that was tried (see docs/outstanding-work.md, round 6) predicts
 * which. This test pins how many draws the plain rounding reproduces, so a change to the step shows up as a count
 * change and may only raise it.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { resampleImage } from './emf-plus-image-resample';

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
		{ srcX: 0, srcY: 0, srcW: w, srcH: h, toDevice: [fr(dw / w), 0, 0, fr(dh / h), 4, 4], kernel: kernel === 6 ? 'hq-bilinear' : 'hq-bicubic', halfPixelOffset: false, pointsForm: false },
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
			'tent 1.37x': { draws: 170, exact: 83 },
			'tent 1.55x': { draws: 170, exact: 136 },
			'cubic 1.37x': { draws: 170, exact: 83 },
			'cubic 1.55x': { draws: 170, exact: 136 },
		});
	});
});
