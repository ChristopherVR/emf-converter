/**
 * Axis-aligned HighQuality DrawImage against native noise draws (`hq-phases.json.gz`; probe
 * `HighQualityPhaseProbe.cs`, mode `hq-phases`): 24 independent noise rows of 256 texels, each replicated over
 * seven identical rows so the vertical pass is the identity, drawn through 32 source/destination rectangles with
 * both kernels, plain and mirrored (a destination rectangle with a negative width).
 *
 * What the draws establish, and what the pinned counts still leave open:
 * - Upscales (step `round(65536 / scale)`, phase `floor((P - 1) / 512)` with the measured cubic table, the tent at the
 *   bin top) are exact for every whole-source draw except the sub-rectangles whose step is a whole number of bins
 *   (`250 -> 256`, `200 -> 256`), where native positions sit on a bin edge and which side the edge falls on is not
 *   decided by the step alone.
 * - Reductions follow the destination-space rule (texel edges rounded down to 1/128 pixel, kernel integral
 *   differences) and are exact at 0.9x, 0.8x, 0.75x, 0.5x and 0.4x; 0.65x, 0.6x and 0.3x leave a few values off
 *   by a level where an edge falls exactly at the end of the kernel.
 * - A mirrored draw steps backwards from the far end, `(covered pixels - k)` steps from the right, shifted by a few
 *   units that grow with the source width; mirrored unit scale (open: native copies it exactly for a rectangle but
 *   filters it for reversed points) keeps the general path.
 * - The phase offset of a fractional left edge follows the unsnapped edge.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { resampleImage } from './emf-plus-image-resample';

interface Draw {
	kernel: number;
	srcX: number;
	srcW: number;
	destX: number;
	destW: number;
	bitmapW: number;
	dest: string;
}

const capture = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/hq-phases.json.gz', import.meta.url))).toString()) as {
	srcW: number;
	rows: number;
	src: string;
	draws: Draw[];
};

const REP = 7;

function build(): Uint8ClampedArray {
	const src = Buffer.from(capture.src, 'base64');
	const height = capture.rows * REP;
	const rgba = new Uint8ClampedArray(capture.srcW * height * 4);
	for (let y = 0; y < height; y++) {
		const row = Math.floor(y / REP);
		for (let x = 0; x < capture.srcW; x++) {
			const o = (y * capture.srcW + x) * 4;
			rgba[o] = src[(row * capture.srcW + x) * 3];
			rgba[o + 1] = src[(row * capture.srcW + x) * 3 + 1];
			rgba[o + 2] = src[(row * capture.srcW + x) * 3 + 2];
			rgba[o + 3] = 255;
		}
	}
	return rgba;
}

/** Number of the values of a draw (every row, three channels) that differ from the native capture. */
function mismatches(rgba: Uint8ClampedArray, d: Draw): number {
	const height = capture.rows * REP;
	const mirror = d.destW < 0;
	const width = Math.abs(d.destW);
	const scale = Math.fround(width) / Math.fround(d.srcW);
	const toDevice: [number, number, number, number, number, number] = mirror ? [-scale, 0, 0, 1, d.destX + width, 0] : [scale, 0, 0, 1, d.destX, 0];
	const block = resampleImage(
		rgba,
		capture.srcW,
		height,
		{ srcX: d.srcX, srcY: 0, srcW: d.srcW, srcH: height, toDevice, kernel: d.kernel === 7 ? 'hq-bicubic' : 'hq-bilinear', halfPixelOffset: false },
		{ w: d.bitmapW, h: height },
	);
	const native = Buffer.from(d.dest, 'base64');
	let bad = 0;
	for (let r = 0; r < capture.rows; r++) {
		const y = r * REP + 3;
		for (let x = 0; x < d.bitmapW; x++) {
			for (let ch = 0; ch < 3; ch++) {
				let v = 0;
				if (block && x >= block.x && x < block.x + block.w && y >= block.y && y < block.y + block.h) {
					const o = ((y - block.y) * block.w + x - block.x) * 4;
					v = Math.round((block.rgba[o + ch] * block.rgba[o + 3]) / 255);
				}
				if (v !== native[(r * d.bitmapW + x) * 3 + ch]) bad++;
			}
		}
	}
	return bad;
}

function group(d: Draw): string {
	const scale = Math.abs(d.destW) / d.srcW;
	const kind = d.destW < 0 ? 'mirror' : 'plain';
	const shape = scale < 1 ? 'reduction' : d.srcW !== capture.srcW ? 'sub-rectangle' : Number.isInteger(d.destX) ? 'upscale' : 'fractional origin';
	return `${d.kernel === 7 ? 'bicubic' : 'bilinear'} ${kind} ${shape}`;
}

describe('axis-aligned high-quality draws against native noise captures', () => {
	const rgba = build();
	const tally: Record<string, { n: number; exact: number; bad: number }> = {};
	const perDraw = new Map<Draw, number>();
	for (const d of capture.draws) {
		const bad = mismatches(rgba, d);
		perDraw.set(d, bad);
		const g = (tally[group(d)] ??= { n: 0, exact: 0, bad: 0 });
		g.n++;
		g.bad += bad;
		if (!bad) g.exact++;
	}

	it('has the expected draws', () => {
		expect(capture.draws).toHaveLength(108);
		expect(capture.rows).toBe(24);
	});

	it('pins the exact and inexact counts per group', () => {
		// `bad` counts values (24 rows x 3 channels x the destination width) off by any amount.
		expect(tally).toEqual({
			'bicubic plain upscale': { n: 9, exact: 9, bad: 0 },
			'bicubic plain reduction': { n: 9, exact: 6, bad: 326 },
			'bicubic plain fractional origin': { n: 5, exact: 4, bad: 32 },
			'bicubic plain sub-rectangle': { n: 4, exact: 2, bad: 19849 },
			'bicubic mirror upscale': { n: 9, exact: 7, bad: 145 },
			'bicubic mirror reduction': { n: 9, exact: 6, bad: 689 },
			'bicubic mirror fractional origin': { n: 5, exact: 5, bad: 0 },
			'bicubic mirror sub-rectangle': { n: 4, exact: 4, bad: 0 },
			'bilinear plain upscale': { n: 9, exact: 9, bad: 0 },
			'bilinear plain reduction': { n: 9, exact: 6, bad: 85 },
			'bilinear plain fractional origin': { n: 5, exact: 4, bad: 23 },
			'bilinear plain sub-rectangle': { n: 4, exact: 2, bad: 16228 },
			'bilinear mirror upscale': { n: 9, exact: 7, bad: 108 },
			'bilinear mirror reduction': { n: 9, exact: 6, bad: 354 },
			'bilinear mirror fractional origin': { n: 5, exact: 5, bad: 0 },
			'bilinear mirror sub-rectangle': { n: 4, exact: 4, bad: 0 },
		});
	});

	it('is exact for both kernels at 0.9x, 0.8x, 0.75x and 0.5x, where texel edges sit on the 1/128 grid at 0.8x, 0.75x and 0.5x', () => {
		for (const width of [230.4, 204.8, 192, 128]) {
			const draws = capture.draws.filter((d) => d.destW > 0 && d.destX === 0 && Math.abs(d.destW - width) < 1e-3);
			expect(draws, `${width}`).toHaveLength(2);
			for (const d of draws) {
				expect(perDraw.get(d), `${width} kernel ${d.kernel}`).toBe(0);
			}
		}
	});
});
