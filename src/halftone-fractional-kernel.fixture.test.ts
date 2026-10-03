import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { halftoneSharpen } from './emf-gdi-stretch';

interface Capture {
	sw: number; sh: number; dw: number; dh: number; pattern: number; position: number;
	offset: number; scale: number; amplitude: number; dib: boolean; sourceId: number;
	start: number; length: number; output: string;
}
const { sources, captures }: { sources: string[]; captures: Capture[] } = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/halftone-fractional-kernel.json.gz', import.meta.url))).toString());
const key = (c: Capture): string => `${c.pattern}/${c.offset}/${c.scale}/${c.dib}`;
const baselines = new Map(captures.filter(c => c.amplitude === 128).map(c => [key(c), c]));
const sharpenedPeaks = new Map<number, number>();
function sharpenedPeak(c: Capture): number {
	let peak = sharpenedPeaks.get(c.sourceId);
	if (peak === undefined) {
		const bytes = Buffer.from(sources[c.sourceId], 'base64');
		const rgb = new Int32Array(c.sw * c.sh * 3);
		for (let i = 0; i < c.sw * c.sh; i++) for (let channel = 0; channel < 3; channel++) rgb[i * 3 + channel] = bytes[i * 4 + channel];
		halftoneSharpen(rgb, c.sw, c.sh);
		const x = c.pattern === 0 ? c.position : c.sw / 2;
		const y = c.pattern === 0 ? c.sh / 2 : c.position;
		peak = rgb[(y * c.sw + x) * 3 + 2];
		sharpenedPeaks.set(c.sourceId, peak);
	}
	return peak;
}

// Measured coefficients are intentionally not a production lookup table.
// The companion run-phase controls now validate bounded share placement.
// These controls isolate the subsequent colour arithmetic on held-out source
// amplitudes, without extrapolating the previous integer 2x/3x tent model.
describe('native filtered HALFTONE discrete phase and colour stages', () => {
	it('retains 1536 compact response lines and identical results from both public APIs', () => {
		expect(captures).toHaveLength(1536);
		expect(sources).toHaveLength(128);
		expect(baselines.size).toBe(384);
		const otherAPIs = new Map(captures.map(c => [`${c.pattern}/${c.offset}/${c.scale}/${c.amplitude}/${c.dib}`, c]));
		for (const c of captures) {
			const other = otherAPIs.get(`${c.pattern}/${c.offset}/${c.scale}/${c.amplitude}/${!c.dib}`)!;
			expect(c.output, key(c)).toBe(other.output);
			expect(Buffer.from(c.output, 'base64')).toHaveLength(c.length * 4);
		}
	});

	it('measures dyadic sixteenth shares without treating them as a general phase formula', () => {
		const levels = new Set<number>();
		for (const c of baselines.values()) {
			expect(sharpenedPeak(c), key(c)).toBe(160);
			const bytes = Buffer.from(c.output, 'base64');
			for (let i = 0; i < bytes.length; i += 4) {
				expect(bytes[i]).toBe(0);
				expect(bytes[i + 1]).toBe(0);
				expect(bytes[i + 2] % 10).toBe(0);
				levels.add(bytes[i + 2]);
			}
		}
		expect([...levels].sort((a, b) => a - b)).toEqual([0, 10, 30, 40, 60, 100, 120, 140]);
	});

	it('predicts all 1152 held-out amplitude responses exactly after native sharpening and half-up rounding', () => {
		const cases = captures.filter(c => c.amplitude !== 128);
		expect(cases).toHaveLength(1152);
		for (const c of cases) {
			const base = baselines.get(key(c))!;
			expect([c.start, c.length]).toEqual([base.start, base.length]);
			const actual = Buffer.from(c.output, 'base64');
			const measured = Buffer.from(base.output, 'base64');
			const peak = sharpenedPeak(c);
			expect(peak).toBe(c.amplitude + Math.floor(c.amplitude / 4));
			for (let i = 0; i < actual.length; i += 4) {
				const expected = Math.floor(measured[i + 2] * peak / 160 + 0.5);
				expect(actual[i], key(c)).toBe(0);
				expect(actual[i + 1], key(c)).toBe(0);
				expect(actual[i + 2], `${key(c)}, amplitude ${c.amplitude}, pixel ${c.start + i / 4}`).toBe(expected);
			}
		}
	});

	it('exposes discrete source-position mass changes at one fractional geometry', () => {
		const first = baselines.get('0/-8/237/false')!;
		const third = baselines.get('0/-6/237/false')!;
		expect([first.dw, first.dh]).toEqual([303, 76]);
		expect([third.dw, third.dh]).toEqual([303, 76]);
		const mass = (c: Capture): number => Buffer.from(c.output, 'base64').reduce((sum, value, i) => sum + (i % 4 === 2 ? value / 160 : 0), 0);
		expect(mass(first)).toBe(2.1875);
		expect(mass(third)).toBe(2.625);
	});
});
