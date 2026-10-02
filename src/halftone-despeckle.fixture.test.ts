import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { halftoneDespeckle, stretchHalftone } from './emf-gdi-stretch';

/**
 * Native HALFTONE StretchBlt captures at exactly 2x of synthetic sources
 * (diagonal pairs and chains, checkers of several sizes, mixed-channel and
 * tie blocks, and random black/white, grey, palette and noise images of odd
 * and even sizes). A 2x enlargement replicates each pre-smoothed source pixel,
 * so `output` is the source after Windows' smoothing, one RGB triple per pixel.
 */
interface Case { name: string; w: number; h: number; input: string; output: string }

const cases: Case[] = JSON.parse(readFileSync(new URL('./__fixtures__/gdi/halftone-despeckle.json', import.meta.url), 'utf8'));

const rgb = (hex: string): Int32Array => {
	const out = new Int32Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
};

describe('native halftone enlargement pre-smoothing', () => {
	it('has the captures', () => {
		expect(cases.length).toBeGreaterThan(90);
	});

	it('halftoneDespeckle reproduces every capture exactly', () => {
		for (const c of cases) {
			const px = rgb(c.input);
			halftoneDespeckle(px, c.w, c.h);
			expect([...px], c.name).toEqual([...rgb(c.output)]);
		}
	});

	it('stretchHalftone reproduces the 2x enlargements exactly', () => {
		for (const c of cases) {
			const input = rgb(c.input);
			const data = new Uint8ClampedArray(c.w * c.h * 4);
			for (let i = 0; i < c.w * c.h; i++) data.set([input[i * 3], input[i * 3 + 1], input[i * 3 + 2], 255], i * 4);
			const out = stretchHalftone({ width: c.w, height: c.h, data }, 0, 0, c.w, c.h, c.w * 2, c.h * 2);
			const expected = rgb(c.output);
			let bad = 0;
			for (let y = 0; y < c.h * 2; y++) {
				for (let x = 0; x < c.w * 2; x++) {
					for (let ch = 0; ch < 3; ch++) {
						if (out.data[(y * c.w * 2 + x) * 4 + ch] !== expected[((y >> 1) * c.w + (x >> 1)) * 3 + ch]) bad++;
					}
				}
			}
			expect(bad, c.name).toBe(0);
		}
	});
});
