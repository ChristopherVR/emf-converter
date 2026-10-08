import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { colorAdjustRgb, DEFAULT_COLOR_ADJUSTMENT } from './emf-gdi-color-adjust';
import { halftoneBranch, halftoneColorKey } from './emf-gdi-halftone-branch';
import { halftoneFilterDouble, halftoneSharpen } from './emf-gdi-stretch';
import {
	EDGE_ROW_HEIGHT, EDGE_ROW_WIDTH, boundaryGroups, edgeRowImage, rectangleCases, rectangleSource,
} from './halftone-boundary.fixture-helper';

interface Captured {
	version: number;
	groups: { name: string; description: string; labels: string; inputSha256: string }[];
	rectangles: { name: string; label: string }[];
	edgeRows: { column: number; samples: { a: number; b: number; c: number; label: string; rows: number[] }[] };
}
const capture: Captured = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/halftone-boundary.json.gz', import.meta.url))).toString());
vi.setConfig({ testTimeout: 120_000 });
const toInts = (rgb: Uint8Array): Int32Array => Int32Array.from(rgb);

// Native label of every sweep image: 'F' when Windows filtered the 2x enlargement (some 2 x 2 block of the output
// is not uniform), 'R' when it replicated. The expected counts are what the committed capture holds.
const SWEEPS = [
	{ images: 6468, filtered: 4527 }, { images: 3356, filtered: 1994 }, { images: 3927, filtered: 1821 }, { images: 827, filtered: 249 },
	{ images: 1734, filtered: 672 }, { images: 2169, filtered: 939 }, { images: 40, filtered: 21 }, { images: 1876, filtered: 687 }, { images: 8, filtered: 4 }, { images: 3000, filtered: 2255 }, { images: 4500, filtered: 1151 }, { images: 1858, filtered: 243 },
];

describe('native HALFTONE enlargement branch boundary sweeps', () => {
	const groups = boundaryGroups();

	it('regenerates the exact sources the capture was taken on', () => {
		expect(groups.map(g => g.name)).toEqual(capture.groups.map(g => g.name));
		groups.forEach((group, g) => {
			const hash = createHash('sha256');
			for (const image of group.images) hash.update(image.rgb());
			expect(hash.digest('hex'), group.name).toBe(capture.groups[g].inputSha256);
			expect(group.images.length, group.name).toBe(SWEEPS[g].images);
			expect(capture.groups[g].labels.length, group.name).toBe(SWEEPS[g].images);
			expect(capture.groups[g].labels.split('F').length - 1, group.name).toBe(SWEEPS[g].filtered);
		});
	});

	it('predicts every swept image (29,763 native labels, 2,408 of them with a height exactly the least row count past 2,304 pixels, and 4,500 of that height drawn after the rule for it was found)', () => {
		let verdicts = 0;
		groups.forEach((group, g) => {
			const labels = capture.groups[g].labels;
			const wrong: number[] = [];
			group.images.forEach((image, i) => {
				const verdict = halftoneBranch(toInts(image.rgb()), image.w, image.h);
				verdicts++;
				if ((verdict === 'filter') !== (labels[i] === 'F')) wrong.push(i);
			});
			expect(wrong, group.name).toEqual([]);
		});
		expect(verdicts).toBe(29763);
	});

	it('takes the verdict from the source rectangle alone, counted from the bottom row for StretchDIBits', () => {
		const cases = rectangleCases();
		expect(cases).toHaveLength(capture.rectangles.length);
		cases.forEach((c, i) => {
			const { rgb, width, height } = rectangleSource(c);
			expect(c.name).toBe(capture.rectangles[i].name);
			expect(halftoneBranch(toInts(rgb), width, height) === 'filter', c.name).toBe(capture.rectangles[i].label === 'F');
		});
		expect(capture.rectangles.filter(r => r.label === 'F')).toHaveLength(6);
	});
});

describe('the colour a native count distinguishes', () => {
	it('keeps every 24-bit colour apart except those whose red equals blue, which share top six bits of blue and green', () => {
		expect(halftoneColorKey(10, 20, 30)).not.toBe(halftoneColorKey(10, 21, 30));
		expect(halftoneColorKey(100, 100, 101)).not.toBe(halftoneColorKey(100, 100, 100));
		// Equal red and blue: only blue >> 2 and green >> 2 matter.
		expect(halftoneColorKey(100, 100, 100)).toBe(halftoneColorKey(103, 103, 103));
		expect(halftoneColorKey(100, 100, 100)).toBe(halftoneColorKey(101, 103, 101));
		expect(halftoneColorKey(100, 100, 100)).not.toBe(halftoneColorKey(104, 100, 104));
		expect(halftoneColorKey(100, 100, 100)).not.toBe(halftoneColorKey(100, 104, 100));
		expect(halftoneColorKey(0, 0, 0)).toBe(halftoneColorKey(3, 3, 3));
		// A colour whose red equals blue never collides with one whose red differs.
		expect(halftoneColorKey(100, 100, 100)).not.toBe(halftoneColorKey(100, 100, 99));
	});
});

describe('the filtered branch at the outer rows', () => {
	it('sharpens a replicated row above the source and interpolates it with the edge row, as 23 native column profiles show', () => {
		const { samples, column } = capture.edgeRows;
		expect(samples).toHaveLength(23);
		let clampOnlyWrong = 0;
		for (const s of samples) {
			expect(s.label).toBe('F');
			const rgb = toInts(edgeRowImage(s.a, s.b, s.c));
			const out = halftoneFilterDouble(rgb, EDGE_ROW_WIDTH, EDGE_ROW_HEIGHT);
			const rows = [0, 1, 2, 3].map(y => out[(y * EDGE_ROW_WIDTH * 2 + column) * 3]);
			expect(rows, `a ${s.a}, b ${s.b}, c ${s.c}`).toEqual(s.rows);
			// Sharpening the source and then clamping the sharpened rows (the interior rule) differs at row 0.
			const plain = rgb.slice();
			halftoneSharpen(plain, EDGE_ROW_WIDTH, EDGE_ROW_HEIGHT);
			const x = column >> 1;
			const clamped = plain[x * 3];
			if (clamped !== out[(0 * EDGE_ROW_WIDTH * 2 + column) * 3]) clampOnlyWrong++;
		}
		expect(clampOnlyWrong).toBeGreaterThan(0);
	});
});

describe('every native 2x capture of the older HALFTONE probes', () => {
	const load = (name: string): { sw: number; sh: number; scale: number; mode?: number; dib?: boolean; input: string; output: string }[] =>
		JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${name}`, import.meta.url))).toString());
	it('takes the branch the rule gives and, when filtered, is reproduced pixel for pixel by the filtered branch', () => {
		let captures = 0, filtered = 0, exactFiltered = 0;
		for (const name of ['halftone-transitions.json.gz', 'halftone-selection.json.gz', 'halftone-arrangement.json.gz']) {
			for (const c of load(name)) {
				if (c.scale !== 2) continue;
				captures++;
				const bytes = Buffer.from(c.input, 'base64');
				const rgb = new Int32Array(c.sw * c.sh * 3);
				for (let p = 0; p < c.sw * c.sh; p++) for (let k = 0; k < 3; k++) rgb[p * 3 + k] = bytes[p * 4 + 2 - k];
				const out = Buffer.from(c.output, 'base64');
				const width = c.sw * 2;
				let uniform = true;
				for (let y = 0; y < c.sh && uniform; y++) for (let x = 0; x < c.sw && uniform; x++) {
					const first = (y * 2 * width + x * 2) * 4;
					for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
						const at = ((y * 2 + dy) * width + x * 2 + dx) * 4;
						if (out[at] !== out[first] || out[at + 1] !== out[first + 1] || out[at + 2] !== out[first + 2]) uniform = false;
					}
				}
				const verdict = halftoneBranch(rgb, c.sw, c.sh);
				expect(verdict === 'filter', `${name} ${c.sw}x${c.sh}`).toBe(!uniform);
				if (uniform) continue;
				filtered++;
				const result = halftoneFilterDouble(rgb, c.sw, c.sh);
				if (c.mode) {
					const gamma = c.mode === 2 ? 15000 : 10000;
					colorAdjustRgb(result, { ...DEFAULT_COLOR_ADJUSTMENT, flags: c.mode === 1 ? 2 : 0, redGamma: gamma, greenGamma: gamma, blueGamma: gamma });
				}
				let differing = 0;
				for (let p = 0; p < c.sw * 2 * c.sh * 2; p++) {
					if (result[p * 3] !== out[p * 4 + 2] || result[p * 3 + 1] !== out[p * 4 + 1] || result[p * 3 + 2] !== out[p * 4]) differing++;
				}
				if (!differing) exactFiltered++;
			}
		}
		expect(captures).toBe(242);
		expect(filtered).toBe(80);
		expect(exactFiltered).toBe(80);
		
		
	});
});

describe('the images whose height is exactly the least row count past 2,304 pixels', () => {
	// The colour limit there is 289 + floor(o / 8), twice that of taller images, and the scan gives up as soon as the
	// colours plus one row of pixels for every duplicate row reach limit - 1 (not n - 2305 + limit with the next row
	// added, which is what taller images follow).
	it('are all predicted, including 2,408 older sweep sources and 4,500 later random ones', () => {
		const groups = boundaryGroups();
		let total = 0, filtered = 0;
		groups.forEach((group, g) => {
			group.images.forEach((image, i) => {
				if (image.h !== Math.floor(2304 / image.w) + 1 || image.w * image.h <= 2304 || image.w * image.h > 16384) return;
				total++;
				const label = capture.groups[g].labels[i] === 'F';
				if (label) filtered++;
				expect(halftoneBranch(toInts(image.rgb()), image.w, image.h) === 'filter', `${group.name} #${i}`).toBe(label);
			});
		});
		expect(total).toBe(8766);
		expect(filtered).toBeGreaterThan(1500);
	});
});
