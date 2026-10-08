import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { halftoneBranch } from './emf-gdi-halftone-branch';
import { stretchHalftone } from './emf-gdi-stretch';

interface Capture { sw: number; sh: number; pattern: number; arrangement: number; scale: number; mode: number; dib: boolean; input: string; output: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/halftone-arrangement.json.gz', import.meta.url))).toString());
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

	it('reproduces all fifty controls exactly, choosing the branch from the source alone', () => {
		let filtered = 0;
		for (const c of captures) {
			const bytes = Buffer.from(c.input, 'base64');
			const source = new Uint8ClampedArray(bytes);
			for (let i = 0; i < source.length; i += 4) [source[i], source[i + 2]] = [source[i + 2], source[i]];
			const rgb = new Int32Array(c.sw * c.sh * 3);
			for (let p = 0; p < c.sw * c.sh; p++) for (let k = 0; k < 3; k++) rgb[p * 3 + k] = bytes[p * 4 + 2 - k];
			const label = `pattern ${c.pattern}, arrangement ${c.arrangement}, DIB ${c.dib}`;
			const verdict = halftoneBranch(rgb, c.sw, c.sh);
			expect(verdict === 'filter', label).toBe(differingBlocks(c) !== 0);
			if (verdict === 'filter') filtered++;
			const expected = Buffer.from(c.output, 'base64');
			const actual = stretchHalftone({ width: c.sw, height: c.sh, data: source }, 0, 0, c.sw, c.sh, c.sw * 2, c.sh * 2, undefined, true, c.dib).data;
			let differing = 0;
			for (let i = 0; i < actual.length; i += 4) {
				if (actual[i] !== expected[i + 2] || actual[i + 1] !== expected[i + 1] || actual[i + 2] !== expected[i]) differing++;
			}
			expect(differing, label).toBe(0);
		}
		expect(filtered).toBe(26);
	});
});
