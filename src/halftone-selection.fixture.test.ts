import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { stretchHalftone } from './emf-gdi-stretch';
import { colorAdjustRgb, DEFAULT_COLOR_ADJUSTMENT } from './emf-gdi-color-adjust';
import { halftoneBranch } from './emf-gdi-halftone-branch';

interface Capture { sw: number; sh: number; pattern: number; scale: number; mode: number; dib: boolean; input: string; output: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/halftone-selection.json.gz', import.meta.url))).toString());
describe('native HALFTONE enlargement selection controls', () => {
	it('retains 240 captures with identical geometry across source-content variations', () => {
		expect(captures).toHaveLength(240);
		for (const c of captures) expect([c.sw, c.sh]).toEqual([256, 16]);
	});

	it('reproduces all 240 controls exactly: the 2x and 3x stretches, replicated or filtered, with and without a colour adjustment', () => {
		let exact = 0;
		for (let caseIndex = 0; caseIndex < captures.length; caseIndex++) {
			const c = captures[caseIndex];
			const source = new Uint8ClampedArray(Buffer.from(c.input, 'base64'));
			const expected = Buffer.from(c.output, 'base64');
			for (let i = 0; i < source.length; i += 4) [source[i], source[i + 2]] = [source[i + 2], source[i]];
			const gamma = c.mode === 2 ? 15000 : 10000;
			const adjustment = { ...DEFAULT_COLOR_ADJUSTMENT, flags: c.mode === 1 ? 2 : 0, redGamma: gamma, greenGamma: gamma, blueGamma: gamma };
			const actual = stretchHalftone({ width: c.sw, height: c.sh, data: source }, 0, 0, c.sw, c.sh, c.sw * c.scale, c.sh * c.scale,
				c.mode ? rgb => colorAdjustRgb(rgb, adjustment) : undefined, true, c.dib).data;
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
			const label = `pattern ${c.pattern}, scale ${c.scale}, adjustment ${c.mode}, DIB ${c.dib}`;
			expect(pixels, label).toBe(0);
			expect(maximum, label).toBe(0);
			expect(sum, label).toBe(0);
			exact++;
		}
		expect(exact).toBe(240);
	});

	it('selects the branch of every control from the source alone', () => {
		// 54 full-range band levels replicate, 55 levels filter, 256-level greyscale replicates, a
		// 214-colour palette texture filters: neither a distinct-seven-bit-colour count nor the geometry
		// decides, but halftoneBranch (the sweeps behind it are in halftone-boundary.fixture.test.ts)
		// predicts all 240 captures.
		const filtered = new Set<number>();
		for (const c of captures) {
			const bytes = Buffer.from(c.input, 'base64');
			const rgb = new Int32Array(c.sw * c.sh * 3);
			for (let p = 0; p < c.sw * c.sh; p++) for (let k = 0; k < 3; k++) rgb[p * 3 + k] = bytes[p * 4 + 2 - k];
			const out = Buffer.from(c.output, 'base64');
			const width = c.sw * c.scale;
			let uniform = true;
			for (let y = 0; y < c.sh && uniform; y++) for (let x = 0; x < c.sw && uniform; x++) {
				const first = (y * c.scale * width + x * c.scale) * 4;
				for (let dy = 0; dy < c.scale; dy++) for (let dx = 0; dx < c.scale; dx++) {
					const at = ((y * c.scale + dy) * width + x * c.scale + dx) * 4;
					if (out[at] !== out[first] || out[at + 1] !== out[first + 1] || out[at + 2] !== out[first + 2]) uniform = false;
				}
			}
			expect(halftoneBranch(rgb, c.sw, c.sh), `pattern ${c.pattern}`).toBe(uniform ? 'replicate' : 'filter');
			if (!uniform) filtered.add(c.pattern);
		}
		expect([...filtered].sort((a, b) => a - b)).toEqual([-109, 55, 64, 256, 1192, 1214, 1216, 1217]);
	});
});
