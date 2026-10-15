import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { applyRedEyeCorrection } from './emf-plus-image-effects';

/**
 * Symmetric 31 x 31 scenes with one faint red pixel (`generate.ps1 redeye-nudge`, `RedEyeStageProbe.RunSequence` token Y),
 * one fresh process each: seven scenes (`pattern:blue` 1:2, 4:2, 5:2, 1:8, 2:8, 1:3, 0:2), the pixel at the centre, in each
 * corner, next to a corner and at the middle of each edge. A corner pixel moves the centroid off the pixel centre on both
 * axes, an edge pixel on one axis only.
 *
 * - The centroid is formed in float32 arithmetic that truncates toward zero, row by row over pixel indices (the same arithmetic
 *   as the rest of the effect), so its noise decides which side of an axis the pixels exactly on it fall: with it all 77 scenes
 *   are exact (59 with the earlier special cases, which approximated that noise with other weights).
 * - The pixels exactly on the horizontal axis through the centroid (dy = 0), both sides and the centre pixel, form ONE sector
 *   group with the right-hand pixels of the 0 to 6 degree sector (the left axis counts as angle 0, not 180).
 * - The pixel at the end of a centred axis lies exactly on the radius in exact arithmetic: it is corrected (its truncated
 *   float32 distance is below the radius) but not counted in its sector (its squared distance is not below the squared radius).
 */
interface Step { token: string; width: number; height: number; source: string; output: string }
const records: Array<{ spec: string; runs: Step[][] }> = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/redeye-nudge.json.gz', import.meta.url))).toString());

describe('native red-eye symmetric scenes nudged by one faint pixel', () => {
	it('is exact in 77 of 77 scenes', () => {
		const inexact: string[] = [];
		let exact = 0;
		for (const r of records) {
			const step = r.runs[0][0];
			const out = applyRedEyeCorrection(new Uint8ClampedArray(Buffer.from(step.source, 'base64')), step.width, step.height, [{ left: 0, top: 0, right: step.width, bottom: step.height }]);
			const expected = Buffer.from(step.output, 'base64');
			let pixels = 0;
			for (let i = 0; i < out.length; i += 4) if (out[i] !== expected[i] || out[i + 1] !== expected[i + 1] || out[i + 2] !== expected[i + 2]) pixels++;
			if (!pixels) exact++;
			else inexact.push(`${r.spec}:${pixels}`);
		}
		expect(records).toHaveLength(77);
		expect(exact).toBe(77);
		expect(inexact).toEqual([]);
	});
});
