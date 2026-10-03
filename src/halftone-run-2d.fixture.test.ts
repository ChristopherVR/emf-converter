import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { colorAdjustRgb, DEFAULT_COLOR_ADJUSTMENT } from './emf-gdi-color-adjust';
import { halftoneSharpen } from './emf-gdi-stretch';
import { measuredRunAxis, measuredRunCrop, type MeasuredCrop } from './halftone-run-phase.fixture-helper';

interface Capture extends MeasuredCrop {
	pattern: number; scale: number; mode: number; dib: boolean;
	translation: number; sourceId: number; output: string;
}
const { sources, captures }: { sources: string[]; captures: Capture[] } = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/halftone-run-2d.json.gz', import.meta.url))).toString());
const key = (c: Capture): string => `${c.sw}/${c.sh}/${c.pattern}/${c.scale}/${c.mode}`;
const sharpened = new Map<number, Int32Array>();
function source(c: Capture): Int32Array {
	let rgb = sharpened.get(c.sourceId);
	if (!rgb) {
		const bytes = Buffer.from(sources[c.sourceId], 'base64');
		rgb = new Int32Array(c.sw * c.sh * 3);
		for (let pixel = 0; pixel < c.sw * c.sh; pixel++) for (let channel = 0; channel < 3; channel++) rgb[pixel * 3 + channel] = bytes[pixel * 4 + 2 - channel];
		halftoneSharpen(rgb, c.sw, c.sh);
		sharpened.set(c.sourceId, rgb);
	}
	return rgb;
}
function checkExact(c: Capture): void {
	const crop = measuredRunCrop(source(c), c);
	if (c.mode) {
		const gamma = c.mode === 2 ? 15000 : 10000;
		colorAdjustRgb(crop, { ...DEFAULT_COLOR_ADJUSTMENT, flags: c.mode === 1 ? 2 : 0, redGamma: gamma, greenGamma: gamma, blueGamma: gamma });
	}
	const bytes = Buffer.from(c.output, 'base64');
	let count = 0, sum = 0, max = 0;
	for (let pixel = 0; pixel < c.cropW * c.cropH; pixel++) for (let channel = 0; channel < 3; channel++) {
		const difference = Math.abs(crop[pixel * 3 + channel] - bytes[pixel * 4 + 2 - channel]);
		if (difference) count++;
		sum += difference;
		max = Math.max(max, difference);
	}
	expect([count, sum, max], `${key(c)}/${c.dib}/${c.translation}`).toEqual([0, 0, 0]);
}

// Central RGB measurements validate bounded filtering arithmetic. They do not
// establish source-edge, alpha, or content-dependent native branch selection.
describe('native held-out two-dimensional HALFTONE filtering stages', () => {
	it('retains 432 native crops with identical API and translation results', () => {
		expect(captures).toHaveLength(432);
		expect(sources).toHaveLength(10);
		const groups = new Map<string, string>();
		for (const c of captures) {
			const prior = groups.get(key(c));
			if (prior) expect(c.output, `${key(c)}/${c.dib}/${c.translation}`).toBe(prior);
			else groups.set(key(c), c.output);
			expect(Buffer.from(c.output, 'base64')).toHaveLength(c.cropW * c.cropH * 4);
		}
		expect(groups.size).toBe(108);
	});

	it('predicts all 384 anisotropic RGB impulse, diagonal step, tile and ramp controls exactly', () => {
		const cases = captures.filter(c => c.pattern < 4);
		expect(cases).toHaveLength(384);
		for (const c of cases) checkExact(c);
	});

	it('predicts all 48 independently held-out hashed RGB and patch controls on a third geometry exactly', () => {
		const cases = captures.filter(c => c.pattern >= 4);
		expect(cases).toHaveLength(48);
		for (const c of cases) {
			expect([c.sw, c.sh]).toEqual([191, 53]);
			checkExact(c);
		}
	});

	it('distinguishes vertical-first intermediate rounding from both single rounding and horizontal-first filtering', () => {
		const c = captures.find(c => c.sw === 191 && c.pattern === 4 && c.scale === 225 && c.mode === 0 && !c.dib)!;
		const columns = measuredRunAxis(c.sw, c.dw), rows = measuredRunAxis(c.sh, c.dh), rgb = source(c), bytes = Buffer.from(c.output, 'base64');
		let singleErrors = 0, horizontalFirstErrors = 0;
		for (let y = 0; y < c.cropH; y++) for (let x = 0; x < c.cropW; x++) for (let channel = 0; channel < 3; channel++) {
			let single = 0, horizontalFirst = 0;
			for (const [yy, wy] of rows[y + c.cropY]) {
				let horizontal = 0;
				for (const [xx, wx] of columns[x + c.cropX]) horizontal += rgb[(yy * c.sw + xx) * 3 + channel] * wx;
				single += horizontal * wy;
				horizontalFirst += Math.floor(horizontal + 0.5) * wy;
			}
			const native = bytes[(y * c.cropW + x) * 4 + 2 - channel];
			if (Math.floor(single + 0.5) !== native) singleErrors++;
			if (Math.floor(horizontalFirst + 0.5) !== native) horizontalFirstErrors++;
		}
		expect(singleErrors).toBeGreaterThan(0);
		expect(horizontalFirstErrors).toBeGreaterThan(0);
		checkExact(c);
	});
});
