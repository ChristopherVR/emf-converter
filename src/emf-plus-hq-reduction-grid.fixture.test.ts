/**
 * Axis-aligned HighQuality reductions against `hq-reduction-grid.json.gz` (`HighQualityReductionGridProbe.cs`, mode
 * `hq-reduction-grid`): grey noise through `DrawImage(destRect, srcRect)`, both kernels, vertical reductions
 * 64 x 40 to 64 x h (h 9 to 37) and 64 x 40 to 64 x 20 at eight fractional tops, horizontal 40 x 8 to w x 8 (w 11 to 30) and
 * 40 x 8 to 20 x 8 at fifteen fractional origins (4 + 1/64 ... 4 + 63/64, a tie at every texel edge), and the geometries
 * of the `gpx-image-highqualitybicubic` fixture.
 *
 * Native weighs the edges of a reduction in 16.16 fixed point: the distance of a texel edge to the pixel's source
 * position in 1/65536 texel, times a multiplier, floored to 1/128 destination pixel. The tent's multiplier is
 * `round(2^32 / step)`, the cubic's is even (`2 round(s 32768)`), and a reduction's step rounds the reciprocal up from
 * a fraction of 0.47 (124,830.48 for 21/40 and 90,394.48 for 29/40 step by 124,831 and 90,395). The edges of a
 * draw are the unsnapped ones: an edge that the 1/16 grid rounds (half down) onto a whole pixel, 4 + 1/64 to 4 + 1/32 or
 * 4 + 63/64, still leaves that pixel out, and horizontally steps from the whole pixel (see `offsetU`).
 *
 * Before round 8 the edges were `floor(128 s (edge - position))` in floating point on the snapped edge and this
 * capture had 15,332 values off (73 of 148 draws exact); 146 of 148 draws are exact now and 2 values are off (25 values
 * before the start-position shift of `hqStartShift`, which closed the 64 x 48 to 58 x 20 draws at edge 98: see
 * `emf-plus-hq-reduction-positions.fixture.test.ts`).
 *
 * What is left: one value in each of the 64 x 40 to 64 x 16 and 64 x 48 to 25.6 x 21.6 tent draws.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { resampleImage } from './emf-plus-image-resample';
import { down32 } from './float32-down';

type Draw = [number, number, number, number, number, number, number, number, number, number, string];
const grid = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/hq-reduction-grid.json.gz', import.meta.url))).toString()) as { draws: Draw[] };

const GROUPS = ['vertical', 'horizontal', 'fixture'];

function differing([, kernel, w, h, dx, dy, dw, dh, bw, bh, red]: Draw): number {
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
		{ srcX: 0, srcY: 0, srcW: w, srcH: h, toDevice: [down32(fr(dw) / w), 0, 0, down32(fr(dh) / h), dx, dy], nominalScale: [fr(fr(dw) / w), fr(fr(dh) / h)], kernel: kernel === 6 ? 'hq-bilinear' : 'hq-bicubic', halfPixelOffset: false, pointsForm: false },
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

describe('HighQuality reductions in 16.16 fixed point (native captures)', () => {
	const groups: Record<string, { draws: number; exact: number; bad: number }> = {};
	for (const d of grid.draws) {
		const g = (groups[`${GROUPS[d[0]]} ${d[1] === 6 ? 'tent' : 'cubic'}`] ??= { draws: 0, exact: 0, bad: 0 });
		const bad = differing(d);
		g.draws++;
		g.bad += bad;
		if (bad === 0) g.exact++;
	}

	it('has the expected draws', () => {
		expect(grid.draws).toHaveLength(2 * (29 + 8 + 20 + 15 + 2));
	});

	it('pins the exact draws and differing values per group', () => {
		expect(groups).toEqual({
			'vertical tent': { draws: 37, exact: 36, bad: 1 },
			'vertical cubic': { draws: 37, exact: 37, bad: 0 },
			'horizontal tent': { draws: 35, exact: 35, bad: 0 },
			'horizontal cubic': { draws: 35, exact: 35, bad: 0 },
			'fixture tent': { draws: 2, exact: 1, bad: 1 },
			'fixture cubic': { draws: 2, exact: 2, bad: 0 },
		});
	});
});
