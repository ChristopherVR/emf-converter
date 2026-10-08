import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { halftoneMixedEngine, stretchHalftone } from './emf-gdi-stretch';
import { mixedEngineCases, mixedSource } from './halftone-mixed-engine.fixture-helper';

/**
 * 783 native HALFTONE stretches (`generate-halftone-mixed-engine.ts`) behind `halftoneMixedEngine` (which engine a mixed
 * enlarge-and-reduce stretch runs: the 1.5x reduction, the shrinking destination area, the filtered source) and the
 * despeckle size bands (sources of up to 2,304 and of more than 16,384 pixels are despeckled, those between are not).
 */
interface Capture { cases: { id: string; hash: string; output?: string }[] }
const capture: Capture = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/halftone-mixed-engine.json.gz', import.meta.url))).toString());
const cases = mixedEngineCases();

interface Result { exact: number; values: number; maximum: number }
function run(): Record<string, Result & { count: number }> {
	const groups: Record<string, Result & { count: number }> = {};
	cases.forEach((c, i) => {
		const rgb = mixedSource(c.kind, c.w, c.h, c.seed);
		const data = new Uint8ClampedArray(c.w * c.h * 4);
		for (let p = 0; p < c.w * c.h; p++) data.set([rgb[p * 3], rgb[p * 3 + 1], rgb[p * 3 + 2], 255], p * 4);
		const out = stretchHalftone({ width: c.w, height: c.h, data }, 0, 0, c.w, c.h, c.dw, c.dh).data;
		const flat = new Uint8Array(c.dw * c.dh * 3);
		for (let k = 0; k < c.dw * c.dh; k++) flat.set([out[k * 4], out[k * 4 + 1], out[k * 4 + 2]], k * 3);
		const entry = capture.cases[i];
		expect(entry.id).toBe(c.id);
		const g = (groups[c.group] ??= { count: 0, exact: 0, values: 0, maximum: 0 });
		g.count++;
		if (createHash('sha256').update(flat).digest('hex') === entry.hash) { g.exact++; return; }
		const native = Buffer.from(entry.output!, 'base64');
		for (let k = 0; k < flat.length; k++) {
			const d = Math.abs(flat[k] - native[k]);
			if (d) { g.values++; g.maximum = Math.max(g.maximum, d); }
		}
	});
	return groups;
}

describe('native mixed enlarge-and-reduce engine and despeckle bands', () => {
	const groups = run();

	it('reproduces every engine-grid, 1.5x-boundary, size-band and both-axes-reduction capture exactly', () => {
		expect(groups.grid).toEqual({ count: 280, exact: 280, values: 0, maximum: 0 });
		expect(groups.cap).toEqual({ count: 40, exact: 40, values: 0, maximum: 0 });
		expect(groups.band).toEqual({ count: 23, exact: 23, values: 0, maximum: 0 });
		expect(groups.reduce).toEqual({ count: 120, exact: 120, values: 0, maximum: 0 });
	});

	it('pins the residual of the area-boundary and random captures (a handful of boundary values one level off)', () => {
		expect(groups.area).toEqual({ count: 160, exact: 156, values: 24, maximum: 1 });
		expect(groups.random).toEqual({ count: 160, exact: 154, values: 13, maximum: 1 });
	});
});

describe('halftoneMixedEngine', () => {
	const noise = new Uint8Array(200 * 200 * 3);
	const check = (w: number, h: number, c: number): Uint8Array => new Uint8Array(w * h * 3).fill(c);
	it('takes the reduced sequence once the shrinking axis loses 1.5 pixels per pixel, not before', () => {
		expect(halftoneMixedEngine(check(80, 64, 7), 80, 64, 200, 42)).toBe('reduced');
		expect(halftoneMixedEngine(check(80, 64, 7), 80, 64, 200, 43)).toBe('nearest');
		expect(halftoneMixedEngine(check(80, 100, 7), 80, 100, 200, 66)).toBe('reduced');
		expect(halftoneMixedEngine(check(80, 50, 7), 80, 50, 200, 33)).toBe('nearest');
	});
	it('takes it for a destination with fewer pixels than the source (strictly), despeckled for small sources', () => {
		expect(halftoneMixedEngine(check(72, 60, 7), 72, 60, 90, 47)).toBe('reduced');
		expect(halftoneMixedEngine(check(72, 60, 7), 72, 60, 90, 48)).toBe('nearest');
		expect(halftoneMixedEngine(check(40, 40, 7), 40, 40, 50, 31)).toBe('despeckled');
		expect(halftoneMixedEngine(check(40, 40, 7), 40, 40, 50, 33)).toBe('nearest');
	});
	it('takes it whatever the destination when the source takes the filtered branch', () => {
		for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761 >>> 7) & 255;
		expect(halftoneMixedEngine(noise, 200, 200, 210, 199)).toBe('reduced');
	});
});
