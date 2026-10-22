/**
 * The geometry of `gpx-image-rotated-highqualitybicubic` against `hq-rotated-fixture.json.gz`
 * (`HighQualityRotatedFixtureProbe.cs`, mode `hq-rotated-fixture`): `DrawImage(src, {(30, 10), (90, 30), (15, 55)})` of a
 * 20 x 16 bitmap onto a white 160 x 100 bitmap with HighQualityBicubic, for the fixture's own pattern and eight noise
 * bitmaps, with the native axis-aligned pre-scale to 64 x 48 and the plain Bicubic draw of that native intermediate.
 *
 * Established:
 * - The native one-step draw equals its two-step form (pre-scale, then plain Bicubic rotation) to one pixel of 16,000
 *   for every source: the residual of the converter is not the pre-scale.
 * - The converter's pixels that differ are the same set for every source (3 to 5 of the 5 pixels the fixture misses), so the
 *   cause is geometric, not content: the inverse of this quad is exactly 0.96 and 0.32 per pixel, and every one of them
 *   samples the intermediate at a whole `v` (8, 16, 24, 32, 40), a tie of the 1/64 phase. Our 16.16 row stepper lands 1/65536
 *   texel below the tie there (the start rounds up by 0.44 and three steps of 20,972 against 20,971.52 take 1.44), and
 *   native lands on or above it.
 * - A start one unit later (or a row stepper that starts at the quad's first pixel instead of the padded image's) closes all
 *   five pixels, but loses 37 exact captures of `hq-rotated` (the ties of the 60 degree draws sit 0.0035 unit above a whole
 *   `v`, and native stays below those), so it is not shipped: see "Round 10: HighQuality image residuals" in
 *   outstanding-work.md. The stepper itself is right (an unrounded or truncated step puts 767 to 1,566 pixels off).
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { resampleImage } from './emf-plus-image-resample';

interface Draw {
	seed: number;
	src: string;
	whole: string;
	mid: string;
	two: string;
}
const draws = (JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/hq-rotated-fixture.json.gz', import.meta.url))).toString()) as { draws: Draw[] }).draws;
const W = 160;
const H = 100;

function rgbOf(base64: string): Uint8Array {
	const b = Buffer.from(base64, 'base64');
	const out = new Uint8Array(W * H * 3);
	for (let i = 0; i < W * H; i++) {
		out[i * 3] = b[i * 4 + 2];
		out[i * 3 + 1] = b[i * 4 + 1];
		out[i * 3 + 2] = b[i * 4];
	}
	return out;
}

function differing(a: Uint8Array, b: Uint8Array): string[] {
	const list: string[] = [];
	for (let i = 0; i < W * H; i++) {
		if (a[i * 3] !== b[i * 3] || a[i * 3 + 1] !== b[i * 3 + 1] || a[i * 3 + 2] !== b[i * 3 + 2]) list.push(`${i % W},${Math.floor(i / W)}`);
	}
	return list;
}

function model(d: Draw): Uint8Array {
	const s = Buffer.from(d.src, 'base64');
	const src = new Uint8ClampedArray(s.length);
	for (let i = 0; i < s.length; i += 4) {
		src[i] = s[i + 2];
		src[i + 1] = s[i + 1];
		src[i + 2] = s[i];
		src[i + 3] = s[i + 3];
	}
	const block = resampleImage(src, 20, 16, { srcX: 0, srcY: 0, srcW: 20, srcH: 16, toDevice: [3, 1, -0.9375, 2.8125, 30, 10], kernel: 'hq-bicubic', halfPixelOffset: false, pointsForm: true }, { w: W, h: H });
	const out = new Uint8Array(W * H * 3).fill(255);
	if (!block) return out;
	for (let y = 0; y < block.h; y++) {
		for (let x = 0; x < block.w; x++) {
			const o = (y * block.w + x) * 4;
			const a = block.rgba[o + 3];
			if (!a) continue;
			const p = ((y + block.y) * W + x + block.x) * 3;
			for (let c = 0; c < 3; c++) out[p + c] = Math.round((block.rgba[o + c] * a) / 255 + 255 - a);
		}
	}
	return out;
}

describe('gpx-image-rotated-highqualitybicubic geometry (native captures)', () => {
	it('has nine sources', () => {
		expect(draws.map((d) => d.seed)).toEqual([-1, 0, 1, 2, 3, 4, 5, 6, 7]);
	});

	it('draws in one step what the pre-scale plus plain Bicubic rotation draws, to one pixel', () => {
		expect(draws.map((d) => differing(rgbOf(d.whole), rgbOf(d.two)).length)).toEqual([1, 1, 1, 1, 1, 1, 1, 0, 1]);
	});

	it('misses the same pixels whatever the source, all on a whole intermediate v', () => {
		const misses = draws.map((d) => differing(model(d), rgbOf(d.whole)));
		expect(misses[0]).toEqual(['29,18', '25,25', '24,33', '20,40', '19,48']);
		expect(misses.map((m) => m.length)).toEqual([5, 5, 4, 5, 5, 4, 5, 3, 4]);
		const every = new Set(misses.flat());
		expect([...every].sort()).toEqual(['19,48', '20,40', '24,33', '25,25', '29,18']);
	});
});
