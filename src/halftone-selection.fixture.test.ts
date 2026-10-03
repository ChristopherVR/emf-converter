import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { stretchHalftone } from './emf-gdi-stretch';
import { colorAdjustRgb, DEFAULT_COLOR_ADJUSTMENT } from './emf-gdi-color-adjust';

interface Capture { sw: number; sh: number; pattern: number; scale: number; mode: number; dib: boolean; input: string; output: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/halftone-selection.json.gz', import.meta.url))).toString());
// Strict RGB residual ceilings [pixels, largest channel error, total channel error]
// in generator order: one row per source pattern, both scales/three adjustments/two APIs.
// Every zero triplet pins an exact control. Nonzero triplets expose the still
// unresolved filtered branch rather than hiding it behind an eight-level tolerance.
const ceilings: number[][] = [
	[0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0],
	[0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0],
	[0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0],
	[10133,64,220296], [10133,64,220296], [9736,124,317934], [9736,124,317934], [9542,90,176766], [9542,90,176766], [23359,96,564210], [23359,96,564210], [22149,158,795876], [22149,158,795876], [21805,129,451398], [21805,129,451398],
	[9889,64,220452], [9889,64,220452], [9134,124,317358], [9134,124,317358], [9254,90,176826], [9254,90,176826], [24254,96,568314], [24254,96,568314], [22602,158,800928], [22602,158,800928], [22656,129,455562], [22656,129,455562],
	[7906,64,217932], [7906,64,217932], [7866,124,315678], [7866,124,315678], [7596,90,173904], [7596,90,173904], [19035,96,557820], [19035,96,557820], [18407,158,790692], [18407,158,790692], [18151,129,444426], [18151,129,444426],
	[0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0],
	[0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0],
	[7584,33,89640], [7584,33,89640], [7584,79,177936], [7584,79,177936], [6694,29,46368], [6694,29,46368], [16929,55,229242], [16929,55,229242], [16869,105,449562], [16869,105,449562], [14428,46,119172], [14428,46,119172],
	[0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0],
	[0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0],
	[0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0],
	[0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0],
	[16382,49,833635], [16382,49,833635], [16382,105,1170450], [16382,105,1170450], [16382,39,654085], [16382,39,654085], [36862,74,2693639], [36862,74,2693639], [36862,136,3396006], [36862,136,3396006], [36860,71,2269254], [36860,71,2269254],
	[16383,101,1006893], [16383,101,1006893], [16383,163,1354217], [16383,163,1354217], [16383,93,812116], [16383,93,812116], [36863,131,3004486], [36863,131,3004486], [36863,187,3713177], [36863,187,3713177], [36863,134,2548669], [36863,134,2548669],
	[16383,99,1042909], [16383,99,1042909], [16383,161,1348526], [16383,161,1348526], [16383,90,862230], [16383,90,862230], [36863,127,3121480], [36863,127,3121480], [36862,184,3735219], [36862,184,3735219], [36863,134,2702829], [36863,134,2702829],
	[16383,95,1186171], [16383,95,1186171], [16383,157,1557898], [16383,157,1557898], [16383,89,972393], [16383,89,972393], [36863,127,3516409], [36863,127,3516409], [36862,184,4253495], [36862,184,4253495], [36863,128,3018577], [36863,128,3018577],
	[0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0],
	[0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0],
	[0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0],
];

describe('native HALFTONE enlargement selection controls', () => {
	it('retains 240 captures with identical geometry across source-content variations', () => {
		expect(captures).toHaveLength(240);
		expect(ceilings).toHaveLength(240);
		for (const c of captures) expect([c.sw, c.sh]).toEqual([256, 16]);
	});

	it('preserves 144 exact controls and individual RGB residual ceilings for every filtered control', () => {
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
			expect(pixels, label).toBeLessThanOrEqual(ceilings[caseIndex][0]);
			expect(maximum, label).toBeLessThanOrEqual(ceilings[caseIndex][1]);
			expect(sum, label).toBeLessThanOrEqual(ceilings[caseIndex][2]);
			if (!ceilings[caseIndex][0]) exact++;
		}
		expect(exact).toBe(144);
	});

	it('retains counterexamples to geometry-only and 216-colour threshold selectors', () => {
		// Same source and destination sizes: 54 full-range band levels replicate,
		// 55 levels filter, 256-level greyscale replicates, but 214-colour palette
		// texture filters. A count of distinct seven-bit RGB colours alone therefore
		// cannot select the native path. These are observations, not a runtime rule.
		for (const [pattern, replicated] of [[54, true], [55, false], [2256, true], [1214, false]] as const) {
			const index = captures.findIndex(c => c.pattern === pattern && c.scale === 2 && c.mode === 0 && !c.dib);
			expect(index).toBeGreaterThanOrEqual(0);
			expect(ceilings[index][0] === 0).toBe(replicated);
		}
	});
});
