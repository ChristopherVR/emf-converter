import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { halftoneSharpen, stretchHalftone, type HalftoneTaps } from './emf-gdi-stretch';
import { colorAdjustRgb, DEFAULT_COLOR_ADJUSTMENT } from './emf-gdi-color-adjust';

interface Capture {
	sw: number; sh: number; dw: number; dh: number; scale: number; pattern: number;
	mode: number; dib: boolean; sourceId: number; cropX: number; cropY: number;
	cropW: number; cropH: number; output: string;
}
const { sources, captures }: { sources: string[]; captures: Capture[] } = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/halftone-kernel.json.gz', import.meta.url))).toString());
const rgba = (c: Capture): Uint8ClampedArray => {
	const bytes = new Uint8ClampedArray(Buffer.from(sources[c.sourceId], 'base64'));
	for (let i = 0; i < bytes.length; i += 4) [bytes[i], bytes[i + 2]] = [bytes[i + 2], bytes[i]];
	return bytes;
};
const adjustment = (c: Capture) => {
	const gamma = c.mode === 2 ? 15000 : 10000;
	return { ...DEFAULT_COLOR_ADJUSTMENT, flags: c.mode === 1 ? 2 : 0, redGamma: gamma, greenGamma: gamma, blueGamma: gamma };
};

// This is a bounded measurement model, deliberately kept out of production.
// Native integer 2x/3x controls agree with a half-source-pixel-integrated tent
// evaluated at nearest-eighth source positions after four-neighbour sharpening.
// The captured fractional ratio rejects extending this formula generally.
const tentIntegral = (x: number): number => x <= -1 ? 0 : x < 0 ? (x + 1) ** 2 / 2 : x < 1 ? 1 - (1 - x) ** 2 / 2 : 1;
function measuredAxis(source: number, destination: number): HalftoneTaps[] {
	return Array.from({ length: destination }, (_, pixel) => {
		const position = Math.round(((pixel + 0.5) * source / destination - 0.5) * 8) / 8;
		const row: HalftoneTaps = [];
		for (let sample = Math.floor(position) - 1; sample <= Math.floor(position) + 2; sample++) {
			const distance = position - sample;
			const weight = 2 * (tentIntegral(distance + 0.25) - tentIntegral(distance - 0.25));
			if (weight > 0) row.push([Math.max(0, Math.min(source - 1, sample)), weight]);
		}
		return row;
	});
}
const sharpened = new Map<number, Int32Array>();
function measuredCrop(c: Capture): Int32Array {
	let source = sharpened.get(c.sourceId);
	if (!source) {
		const bytes = rgba(c);
		source = new Int32Array(c.sw * c.sh * 3);
		for (let i = 0; i < c.sw * c.sh; i++) for (let channel = 0; channel < 3; channel++) source[i * 3 + channel] = bytes[i * 4 + channel];
		halftoneSharpen(source, c.sw, c.sh);
		sharpened.set(c.sourceId, source);
	}
	const columns = measuredAxis(c.sw, c.dw), rows = measuredAxis(c.sh, c.dh);
	const crop = new Int32Array(c.cropW * c.cropH * 3);
	for (let y = 0; y < c.cropH; y++) for (let x = 0; x < c.cropW; x++) {
		for (let channel = 0; channel < 3; channel++) {
			let value = 0;
			for (const [yy, wy] of rows[y + c.cropY]) for (const [xx, wx] of columns[x + c.cropX]) value += source[(yy * c.sw + xx) * 3 + channel] * wx * wy;
			crop[(y * c.cropW + x) * 3 + channel] = Math.floor(value + 0.5 + 1e-7);
		}
	}
	if (c.mode) colorAdjustRgb(crop, adjustment(c));
	return crop;
}
function largestDifference(c: Capture, actual: Int32Array): number {
	const expected = Buffer.from(c.output, 'base64');
	let largest = 0;
	for (let i = 0; i < c.cropW * c.cropH; i++) for (let channel = 0; channel < 3; channel++) largest = Math.max(largest, Math.abs(actual[i * 3 + channel] - expected[i * 4 + 2 - channel]));
	return largest;
}

describe('native HALFTONE central kernel measurements', () => {
	it('retains 216 impulse, step and ramp captures with twelve shared full source buffers', () => {
		expect(captures).toHaveLength(216);
		expect(sources).toHaveLength(12);
		for (const c of captures) {
			const otherAPI = captures.find(other => other.sw === c.sw && other.pattern === c.pattern && other.scale === c.scale && other.mode === c.mode && other.dib !== c.dib)!;
			expect(c.output).toBe(otherAPI.output);
		}
	});

	it('preserves all 72 nearest-branch central controls at integer and fractional ratios', () => {
		const cases = captures.filter(c => c.sw === 64);
		expect(cases).toHaveLength(72);
		for (const c of cases) {
			const result = stretchHalftone({ width: c.sw, height: c.sh, data: rgba(c) }, 0, 0, c.sw, c.sh, c.dw, c.dh,
				c.mode ? rgb => colorAdjustRgb(rgb, adjustment(c)) : undefined, true, c.dib).data;
			const crop = new Int32Array(c.cropW * c.cropH * 3);
			for (let y = 0; y < c.cropH; y++) for (let x = 0; x < c.cropW; x++) for (let channel = 0; channel < 3; channel++) crop[(y * c.cropW + x) * 3 + channel] = result[((y + c.cropY) * c.dw + x + c.cropX) * 4 + channel];
			expect(largestDifference(c, crop), `${c.pattern}/${c.scale}/${c.mode}/${c.dib}`).toBe(0);
		}
	});

	it('measures 96 filtered 2x/3x central responses exactly, including log and gamma', () => {
		const cases = captures.filter(c => c.sw > 64 && c.scale !== 237);
		expect(cases).toHaveLength(96);
		for (const c of cases) expect(largestDifference(c, measuredCrop(c)), `${c.sw}/${c.pattern}/${c.scale}/${c.mode}/${c.dib}`).toBe(0);
	});

	it('retains the fractional impulse counterexample to the integer response formula', () => {
		// The 2.37x source extents round independently to 303x76. Extending the
		// nearest-eighth integrated-tent formula misses fourteen channel levels.
		const c = captures.find(c => c.sw === 128 && c.pattern === 1 && c.scale === 237 && c.mode === 0 && !c.dib)!;
		expect([c.dw, c.dh]).toEqual([303, 76]);
		expect(largestDifference(c, measuredCrop(c))).toBe(14);
	});
});
