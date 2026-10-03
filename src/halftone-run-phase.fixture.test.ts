import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { halftoneSharpen } from './emf-gdi-stretch';
import { measuredRunAxis } from './halftone-run-phase.fixture-helper';

interface Capture {
	sw: number; sh: number; dw: number; dh: number; pattern: number; position: number;
	offset: number; scale: number; amplitude: number; dib: boolean; sourceId: number;
	start: number; length: number; output: string; translation?: number;
}
const load = (name: string): { sources: string[]; captures: Capture[] } => JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${name}.json.gz`, import.meta.url))).toString());
const previous = load('halftone-fractional-kernel'), heldout = load('halftone-run-phase');
const key = (c: Capture): string => `${c.sw}/${c.sh}/${c.pattern}/${c.offset}/${c.scale}/${c.amplitude}`;

function checkResponses(data: typeof heldout): void {
	const sharp = new Map<number, Int32Array>();
	const axes = new Map<string, ReturnType<typeof measuredRunAxis>>();
	for (const c of data.captures) {
		let source = sharp.get(c.sourceId);
		if (!source) {
			const bytes = Buffer.from(data.sources[c.sourceId], 'base64');
			source = new Int32Array(c.sw * c.sh * 3);
			for (let i = 0; i < c.sw * c.sh; i++) for (let channel = 0; channel < 3; channel++) source[i * 3 + channel] = bytes[i * 4 + channel];
			halftoneSharpen(source, c.sw, c.sh);
			sharp.set(c.sourceId, source);
		}
		const sourceLength = c.pattern === 0 ? c.sw : c.sh, destinationLength = c.pattern === 0 ? c.dw : c.dh;
		const axisKey = `${sourceLength}/${destinationLength}`;
		let axis = axes.get(axisKey);
		if (!axis) { axis = measuredRunAxis(sourceLength, destinationLength); axes.set(axisKey, axis); }
		const bytes = Buffer.from(c.output, 'base64');
		for (let pixel = 0; pixel < c.length; pixel++) for (let channel = 0; channel < 3; channel++) {
			let value = 0;
			for (const [sample, weight] of axis[c.start + pixel]) {
				const x = c.pattern === 0 ? sample : Math.floor(c.sw / 2), y = c.pattern === 0 ? Math.floor(c.sh / 2) : sample;
				value += source[(y * c.sw + x) * 3 + channel] * weight;
			}
			expect(bytes[pixel * 4 + channel], `${key(c)}/${c.dib}/${c.translation ?? 0}, pixel ${c.start + pixel}, channel ${channel}`).toBe(Math.floor(value + 0.5));
		}
	}
}

describe('native HALFTONE discrete nearest-run phase measurements', () => {
	it('retains 576 held-out responses from two odd source extents, four ratios and three translations', () => {
		expect(heldout.captures).toHaveLength(576);
		expect(heldout.sources).toHaveLength(24);
		expect([...new Set(heldout.captures.map(c => `${c.sw}/${c.sh}`))]).toEqual(['173/47', '257/41']);
		const groups = new Map<string, string>();
		for (const c of heldout.captures) {
			const existing = groups.get(key(c));
			if (existing) expect(c.output, `${key(c)}/${c.dib}/${c.translation}`).toBe(existing);
			else groups.set(key(c), c.output);
			expect(Buffer.from(c.output, 'base64')).toHaveLength(c.length * 4);
		}
		expect(groups.size).toBe(96);
	});

	it('predicts every previous 1536 response using derived run placement without native coefficient lookups', () => {
		expect(previous.captures).toHaveLength(1536);
		checkResponses(previous);
	});

	it('predicts every held-out native response exactly after source sharpening and half-up rounding', () => {
		checkResponses(heldout);
	});

	it('normalizes each measured destination row, including both source boundaries', () => {
		const geometries = new Map([...previous.captures, ...heldout.captures].flatMap(c => [[`${c.sw}/${c.dw}`, [c.sw, c.dw]], [`${c.sh}/${c.dh}`, [c.sh, c.dh]]] as [string, number[]][]));
		for (const [key, [source, destination]] of geometries) for (const taps of measuredRunAxis(source, destination)) {
			expect(taps.reduce((sum, [, weight]) => sum + weight, 0), key).toBe(1);
			for (const [sample, weight] of taps) {
				expect(sample).toBeGreaterThanOrEqual(0);
				expect(sample).toBeLessThan(source);
				expect(weight).toBeGreaterThan(0);
			}
		}
	});
});
