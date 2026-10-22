/**
 * The start position of an axis-aligned HighQuality reduction against `hq-reduction-positions.json.gz`
 * (`HighQualityReductionPositionProbe.cs`, mode `hq-reduction-positions`): grey noise through
 * `DrawImage(destRect, srcRect)` with the destination edge swept from 4 to 2000 pixels, both kernels. The weights of a
 * reduction depend on the position of each destination pixel in 1/65536 texel; with dyadic scales every texel edge is a
 * tie, so one unit of the position moves an edge by a bin and a draw is exact only if the position is.
 *
 * Established (the fit of a constant offset of the position to every column of a draw): the position of a draw whose
 * left edge is at most 64 is the converter's `k step`, from 65 to 256 pixels it starts one unit early horizontally
 * (the `gpx-image-highqualitybicubic`, `-high` and `-highqualitybilinear` fixtures draw at 98: 12, 12 and 7 pixels
 * off before), two units from 257 to 512, and a vertical axis starts the same number of units late. The size is the
 * float32 step of the edge in 16.16 (see `hqStartShift`). Past 512 pixels the draws read 4 to 5 units (9 to 10 from
 * 1024) with a scale-dependent extra that is not modelled: those draws are the pinned inexact ones below.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { resampleImage } from './emf-plus-image-resample';
import { down32 } from './float32-down';

// [group, kernel, srcW (group 4: srcH), destW (group 4: destH), edge, columns, rows, red]
type Draw = [number, number, number, number, number, number, number, string];
const draws = (JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/hq-reduction-positions.json.gz', import.meta.url))).toString()) as { draws: Draw[] }).draws;
const fr = Math.fround;

/** Differing values of the stored window of a draw (red channel of the premultiplied bitmap). */
function differing([group, kernel, size, dest, edge, columns, rows, red]: Draw): number {
	const vertical = group === 4;
	const w = vertical ? 48 : size;
	const h = vertical ? size : 48;
	const dw = vertical ? 48 : dest;
	const dh = vertical ? dest : 20;
	const dx = vertical ? 4 : edge;
	const dy = vertical ? edge : 4;
	const native = Buffer.from(red, 'base64');
	const rgba = new Uint8ClampedArray(w * h * 4);
	let seed = (vertical ? w * 7919 + dest * 104729 + size * 13 + 1 : w * 7919 + dest * 104729 + 1) >>> 0;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			const o = (y * w + x) * 4;
			rgba[o] = rgba[o + 1] = rgba[o + 2] = seed >>> 24;
			rgba[o + 3] = 255;
		}
	}
	const bw = vertical ? w + 8 : Math.ceil(dx) + dw + 10;
	const bh = vertical ? Math.ceil(dy) + dh + 10 : 40;
	const block = resampleImage(
		rgba,
		w,
		h,
		{ srcX: 0, srcY: 0, srcW: w, srcH: h, toDevice: [down32(fr(dw) / w), 0, 0, down32(fr(dh) / h), dx, dy], nominalScale: [fr(fr(dw) / w), fr(fr(dh) / h)], kernel: kernel === 6 ? 'hq-bilinear' : 'hq-bicubic', halfPixelOffset: false, pointsForm: false },
		{ w: bw, h: bh },
	);
	const x0 = vertical ? 0 : Math.floor(dx) - 2;
	const y0 = vertical ? Math.floor(dy) - 2 : 0;
	let bad = 0;
	for (let y = 0; y < (vertical ? rows : bh); y++) {
		for (let x = 0; x < columns; x++) {
			const gx = x0 + x;
			const gy = y0 + y;
			let m = 0;
			if (block && gx >= block.x && gx < block.x + block.w && gy >= block.y && gy < block.y + block.h) {
				const o = ((gy - block.y) * block.w + gx - block.x) * 4;
				m = Math.round((block.rgba[o] * block.rgba[o + 3]) / 255);
			}
			if (m !== native[y * columns + x]) bad++;
		}
	}
	return bad;
}

const label = (d: Draw): string => `g${d[0]} ${d[1] === 6 ? 'tent' : 'cubic'} ${d[2]}>${d[3]} edge ${d[4]}`;

describe('HighQuality reduction start positions (native captures)', () => {
	const results = draws.map((d) => ({ d, bad: differing(d) }));
	const near = results.filter(({ d }) => d[4] <= 512);
	const far = results.filter(({ d }) => d[4] > 512);

	it('has the expected draws', () => {
		expect(draws).toHaveLength(2 * (19 * 14 + 28 + 10) + 2 * 5 * 10 + 141 * 3);
		expect(near).toHaveLength(936);
	});

	it('is exact for every horizontal draw with an edge up to 512 pixels but the 96 to 80 scale', () => {
		expect(near.filter(({ d, bad }) => d[0] !== 4 && bad > 0).map(({ d, bad }) => `${label(d)}: ${bad}`)).toEqual(['g1 tent 96>80 edge 4: 18', 'g1 cubic 96>80 edge 4: 20', 'g1 cubic 96>80 edge 98: 4']);
	});

	it('is exact for every vertical draw with an edge up to 512 pixels but the 64 to 50 scale past 256', () => {
		expect(near.filter(({ d, bad }) => d[0] === 4 && bad > 0).map(({ d, bad }) => `${label(d)}: ${bad}`)).toEqual(['g4 tent 64>50 edge 300: 240', 'g4 tent 64>50 edge 512: 240', 'g4 cubic 64>50 edge 300: 303', 'g4 cubic 64>50 edge 512: 303']);
	});

	it('pins the draws past 512 pixels, where the shift is not modelled', () => {
		expect({ draws: far.length, exact: far.filter(({ bad }) => bad === 0).length, bad: far.reduce((s, { bad }) => s + bad, 0) }).toEqual({ draws: 195, exact: 86, bad: 17291 });
	});
});
