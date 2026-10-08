import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { applyRedEyeCorrection } from './emf-plus-image-effects';

/**
 * Stage-by-stage red-eye controls (`scripts/gdi-fixtures/RedEyeStageProbe.cs`, `generate.ps1 redeye-stages`):
 * synthetic areas through `GdipBitmapApplyEffect`, one stage of the effect at a time.
 *
 * - fallback: one red pixel on grey, in nine area shapes and image offsets. Inside the circle of radius
 *   (w + h) / 6 around the area's middle the pixel is the centroid and the centre; outside it the centre
 *   is the middle (the exact native centre there is not reproduced: one level on 138 of 709 captures).
 * - luma: a left and a right class in one area. The centroid weight of a red pixel is its redness over
 *   the integer luma round((9 G + 2 B) / 11), 1 for luma 0.
 * - carry: two or three areas in one call. The previous area's centroid (image pixel-index coordinates, before
 *   any fallback) is added once to the next area's weighted sums; an area without red passes it on unchanged.
 * - strength: a two-valued field. The radial strength steps when the luma spread (30th to 70th
 *   percentile) exceeds 25, 40 and 80.
 * - highlight: a pixel whose luma is the area's one largest and 40 above the 70th percentile is
 *   corrected completely and leaves at most 5 x distance^2 levels of redness around it.
 * - state: the last call is an all-pure-red area; its strength is the strength the call(s) before it
 *   left behind (not reproduced: it depends on history, not on the area).
 */
interface Step { width: number; height: number; areas: number[][]; source: string; output: string }
interface StageCase { group: string; name: string; steps: Step[] }
const cases: StageCase[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/redeye-stages.json.gz', import.meta.url))).toString());

const run = (step: Step) => applyRedEyeCorrection(
	new Uint8ClampedArray(Buffer.from(step.source, 'base64')),
	step.width,
	step.height,
	step.areas.map((a) => ({ left: a[0], top: a[1], right: a[2], bottom: a[3] })),
);
/** Pixels, largest channel difference and channel sum of the model against the native output. */
function residual(step: Step): { pixels: number; max: number } {
	const actual = run(step);
	const expected = Buffer.from(step.output, 'base64');
	let pixels = 0;
	let max = 0;
	for (let i = 0; i < actual.length; i += 4) {
		let d = 0;
		for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(actual[i + c] - expected[i + c]));
		if (d) pixels++;
		max = Math.max(max, d);
	}
	return { pixels, max };
}
const last = (c: StageCase) => c.steps[c.steps.length - 1];
function summary(group: (c: StageCase) => boolean) {
	let n = 0;
	let exact = 0;
	let maxPixels = 0;
	let totalPixels = 0;
	let maxLevel = 0;
	for (const c of cases.filter(group)) {
		const r = residual(last(c));
		n++;
		if (!r.pixels) exact++;
		maxPixels = Math.max(maxPixels, r.pixels);
		totalPixels += r.pixels;
		maxLevel = Math.max(maxLevel, r.max);
	}
	return { n, exact, maxPixels, totalPixels, maxLevel };
}
/** Whether a fallback capture's pixel lies inside the circle where the centroid is the centre. */
function insideFallbackCircle(name: string): boolean {
	const m = /area (\d+)x(\d+) at (\d+),(\d+), pixel (\d+),(\d+)/.exec(name)!;
	const [w, h, ax, ay, x, y] = m.slice(1).map(Number);
	return Math.hypot(x + 0.5 - (ax + w / 2), y + 0.5 - (ay + h / 2)) < (w + h) / 6;
}

describe('native red-eye stage controls', () => {
	it('puts a lone red pixel at the centre in the sector at 90 degrees and the radius at the nearest edge (412 exact)', () => {
		expect(summary((c) => c.group === 'fallback' && insideFallbackCircle(c.name))).toEqual({ n: 412, exact: 412, maxPixels: 0, totalPixels: 0, maxLevel: 0 });
	});
	it('falls back to the area middle outside the circle (571 of 709 exact, the rest one pixel one level off)', () => {
		expect(summary((c) => c.group === 'fallback' && !insideFallbackCircle(c.name))).toEqual({ n: 709, exact: 571, maxPixels: 1, totalPixels: 138, maxLevel: 1 });
	});
	it('weights the centroid by redness over the integer luma (118 of 120 exact)', () => {
		expect(summary((c) => c.group === 'luma')).toEqual({ n: 120, exact: 118, maxPixels: 4, totalPixels: 6, maxLevel: 1 });
	});
	it('carries the previous area\'s centroid (pixel-index coordinates) once into the next, over areas without red (13 of 14 exact)', () => {
		expect(summary((c) => c.group === 'carry')).toEqual({ n: 14, exact: 13, maxPixels: 1, totalPixels: 1, maxLevel: 1 });
	});
	it('steps the strength at luma spreads above 25, 40 and 80 (the centre pixel is exact in 28 of 30 fields)', () => {
		const strength = cases.filter((c) => c.group === 'strength');
		let exactCentre = 0;
		for (const c of strength) {
			const s = last(c);
			const k = ((s.height >> 1) * s.width + (s.width >> 1)) * 4;
			const actual = run(s);
			const expected = Buffer.from(s.output, 'base64');
			if (actual[k] === expected[k] && actual[k + 1] === expected[k + 1] && actual[k + 2] === expected[k + 2]) exactCentre++;
		}
		expect(strength).toHaveLength(30);
		expect(exactCentre).toBe(28);
		// A random 51 x 51 field has rounding-sized residuals elsewhere; they are pinned, not closed.
		expect(summary((c) => c.group === 'strength')).toEqual({ n: 30, exact: 12, maxPixels: 65, totalPixels: 449, maxLevel: 8 });
	});
	it('corrects a highlight completely and pulls its surroundings in (62 of 81 exact)', () => {
		// The residuals left are one-pixel rounding and axis ties (axis cells of a symmetric scene), pinned.
		expect(summary((c) => c.group === 'highlight')).toEqual({ n: 81, exact: 62, maxPixels: 9, totalPixels: 96, maxLevel: 29 });
		// A pixel (255, 60, b) in a (255, 60, 0) field is a highlight from b = 217 (luma 89 against the 70th percentile 49):
		// its red and blue meet (no redness is left), natively and here. At b = 216 (rise 39) it keeps its redness.
		const centre = (name: string) => {
			const c = cases.find((q) => q.name === name)!;
			const s = last(c);
			const k = (7 * s.width + 7) * 4;
			const native = Buffer.from(s.output, 'base64');
			const ours = run(s);
			return { nativeLeft: native[k] - Math.max(native[k + 1], native[k + 2]), oursLeft: ours[k] - Math.max(ours[k + 1], ours[k + 2]) };
		};
		for (const b of [217, 220, 222]) {
			const { nativeLeft, oursLeft } = centre(`field (255,60,0), pixel (255,60,${b})`);
			expect(nativeLeft, `b ${b}`).toBe(0);
			expect(oursLeft, `b ${b}`).toBe(0);
		}
		const { nativeLeft, oursLeft } = centre('field (255,60,0), pixel (255,60,216)');
		expect(nativeLeft).toBeGreaterThan(0);
		expect(oursLeft).toBe(nativeLeft);
	});
});

describe('native red-eye history dependence (not reproduced)', () => {
	const stateCases = cases.filter((c) => c.group === 'state');
	/** Red removed from the middle pixel of the final pure-red 24 x 24 area: 30, 61, 80 or 91 are strengths 1/4, 1/2, 0.661, 3/4. */
	const finalRemoval = (c: StageCase) => { const s = last(c); return 200 - Buffer.from(s.output, 'base64')[(12 * s.width + 12) * 4]; };
	const strengthOfRemoval = (removed: number) => (removed <= 45 ? 0 : removed <= 70 ? 1 : removed <= 85 ? 2 : 3);
	const lumaSpread = (s: Step) => {
		const px = Buffer.from(s.source, 'base64');
		const lumas: number[] = [];
		for (let i = 0; i < px.length; i += 4) lumas.push(Math.floor((9 * px[i + 1] + 2 * px[i + 2] + 5) / 11));
		lumas.sort((a, b) => a - b);
		return lumas[Math.floor(0.7 * lumas.length)] - lumas[Math.floor(0.3 * lumas.length)];
	};

	it('gives one all-pure-red area four different native strengths depending on the calls before it', () => {
		const strengths = new Set(stateCases.map((c) => strengthOfRemoval(finalRemoval(c))));
		expect([...strengths].sort()).toEqual([0, 1, 2, 3]);
		// The model sees only the area: strength 1/4 (spread 0), so it matches only the cases that left that behind.
		const model = (c: StageCase) => run(last(c))[(12 * 24 + 12) * 4];
		const expectedR = (c: StageCase) => 200 - finalRemoval(c);
		const agree = stateCases.filter((c) => model(c) === expectedR(c)).length;
		expect(agree).toBe(stateCases.filter((c) => strengthOfRemoval(finalRemoval(c)) === 0).length);
	});
	it('takes the strength of the previous two-valued area (spread 25, 40, 80 are the steps)', () => {
		const ladder = stateCases.filter((c) => c.steps.length === 3 && /^two-valued 24x24 spread \d+, then a pure red 24x24$/.test(c.name));
		expect(ladder).toHaveLength(12);
		for (const c of ladder) {
			const spread = lumaSpread(c.steps[1]);
			const level = spread > 80 ? 3 : spread > 40 ? 2 : spread > 25 ? 1 : 0;
			expect(strengthOfRemoval(finalRemoval(c)), c.name).toBe(level);
		}
	});
	it('depends on the size of the earlier call (sizes 20 and up reach the 24 x 24 area, 8 to 16 do not)', () => {
		const bySize = stateCases.filter((c) => /^uniform 24x24, two-valued (\d+)x\1 spread 120/.test(c.name));
		expect(bySize.map((c) => /two-valued (\d+)x\1/.exec(c.name)![1] + ':' + strengthOfRemoval(finalRemoval(c)))).toEqual(['8:0', '12:0', '16:0', '20:3', '24:3', '28:3', '32:3', '40:3', '48:3']);
	});
	it('is reset by an area without red and kept through a repeated pure-red area', () => {
		const level = (name: string) => strengthOfRemoval(finalRemoval(stateCases.find((c) => c.name === name)!));
		expect(level('24x24: reset, spread 120, grey (no red), pure red')).toBe(0);
		expect(level('24x24: reset, spread 120, uniform, pure red')).toBe(0);
		expect(level('24x24: reset, spread 120, spread 30, pure red')).toBe(1);
		expect(level('24x24: reset, spread 120, pure red, pure red')).toBe(3);
	});
});
