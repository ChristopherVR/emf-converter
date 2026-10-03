import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { stretchHalftone } from './emf-gdi-stretch';

interface Capture { sw: number; sh: number; pattern: number; arrangement: number; scale: number; mode: number; dib: boolean; input: string; output: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/halftone-arrangement.json.gz', import.meta.url))).toString());
// One compact row per original source, two APIs per each of five permutations.
// Triplets bound strict RGB differing pixels / max channel error / total error.
// Every zero triplet preserves an exact control; filtering is still unresolved.
const ceilings: number[][] = [
	[0,0,0], [0,0,0], [0,0,0], [0,0,0], [16265,64,180559], [16265,64,180559], [16330,112,1111481], [16330,112,1111481], [0,0,0], [0,0,0],
	[10133,64,220296], [10133,64,220296], [10133,64,220296], [10133,64,220296], [16228,64,180091], [16228,64,180091], [16343,112,1112535], [16343,112,1112535], [9496,64,220296], [9496,64,220296],
	[0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0],
	[0,0,0], [0,0,0], [0,0,0], [0,0,0], [16352,91,918509], [16352,91,918509], [0,0,0], [0,0,0], [0,0,0], [0,0,0],
	[16382,49,833635], [16382,49,833635], [16382,49,833635], [16382,49,833635], [16362,91,914139], [16362,91,914139], [16383,64,708241], [16383,64,708241], [16382,49,828141], [16382,49,828141],
];

function histogram(encoded: string): number[] {
	const bytes = Buffer.from(encoded, 'base64');
	const pixels = Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readUInt32LE(i * 4));
	return pixels.sort((a, b) => a - b);
}

function differingBlocks(c: Capture): number {
	const bytes = Buffer.from(c.output, 'base64');
	const width = c.sw * 2, height = c.sh * 2;
	let blocks = 0;
	for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
		let changed = false;
		for (const dx of [0, 1]) for (const dy of [0, 1]) for (let channel = 0; channel < 3; channel++) {
			if (bytes[((y + dy) * width + x + dx) * 4 + channel] !== bytes[(y * width + x) * 4 + channel]) changed = true;
		}
		if (changed) blocks++;
	}
	return blocks;
}

describe('native HALFTONE histogram-preserving arrangements', () => {
	it('holds palette, pixel histogram and geometry fixed across fifty controls', () => {
		expect(captures).toHaveLength(50);
		for (const c of captures) {
			const identity = captures.find(base => base.pattern === c.pattern && base.arrangement === 0 && base.dib === c.dib)!;
			expect([c.sw, c.sh, c.scale, c.mode]).toEqual([256, 16, 2, 0]);
			expect(histogram(c.input)).toEqual(histogram(identity.input));
		}
	});

	it('shows spatial branch changes and grayscale invariance on both public blit APIs', () => {
		const replicated: Record<number, number[]> = { 54: [0, 1, 4], 55: [], 2256: [0, 1, 2, 3, 4], 1128: [0, 1, 3, 4], 1192: [] };
		for (const c of captures) {
			const label = `pattern ${c.pattern}, arrangement ${c.arrangement}, DIB ${c.dib}`;
			expect(differingBlocks(c) === 0, label).toBe(replicated[c.pattern].includes(c.arrangement));
			const otherAPI = captures.find(other => other.pattern === c.pattern && other.arrangement === c.arrangement && other.dib !== c.dib)!;
			expect(c.output, label).toBe(otherAPI.output);
		}
	});

	it('retains all 24 exact controls and per-case strict residual ceilings for the filtered branch', () => {
		let exact = 0;
		for (let index = 0; index < captures.length; index++) {
			const c = captures[index];
			const source = new Uint8ClampedArray(Buffer.from(c.input, 'base64'));
			const expected = Buffer.from(c.output, 'base64');
			for (let i = 0; i < source.length; i += 4) [source[i], source[i + 2]] = [source[i + 2], source[i]];
			const actual = stretchHalftone({ width: c.sw, height: c.sh, data: source }, 0, 0, c.sw, c.sh, c.sw * 2, c.sh * 2, undefined, true, c.dib).data;
			let pixels = 0, maximum = 0, sum = 0;
			for (let i = 0; i < actual.length; i += 4) {
				let difference = 0;
				for (let channel = 0; channel < 3; channel++) {
					const delta = Math.abs(actual[i + channel] - expected[i + 2 - channel]);
					difference = Math.max(difference, delta);
					sum += delta;
				}
				if (difference) pixels++;
				maximum = Math.max(maximum, difference);
			}
			const label = `pattern ${c.pattern}, arrangement ${c.arrangement}, DIB ${c.dib}`;
			expect(pixels, label).toBeLessThanOrEqual(ceilings[index][0]);
			expect(maximum, label).toBeLessThanOrEqual(ceilings[index][1]);
			expect(sum, label).toBeLessThanOrEqual(ceilings[index][2]);
			if (!ceilings[index][0]) exact++;
		}
		expect(exact).toBe(24);
	});
});
