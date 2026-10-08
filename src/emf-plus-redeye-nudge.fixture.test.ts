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
 * - Off the pixel centre on both axes (the four corners and the two pixels next to the corner: 42 scenes) native is exactly
 *   the luma-weight model in 40; the two others (pattern 1, blue 3, nudged at (30, 0) and (0, 30)) hold a pupil of luma 1
 *   and a ring whose weight 197 / 3 is not exactly representable.
 * - The pixels exactly on the horizontal axis through the centroid (dy = 0), both sides and the centre pixel, form ONE sector
 *   group with the right-hand pixels of the 0 to 6 degree sector (the left axis counts as angle 0, not 180). The model uses
 *   that, with the luma weights, for symmetric scenes whose float32 centroid is exactly the pixel centre (all weights exactly
 *   representable); the others keep the previous weights, and are the residual below: pattern 2 (the centroid sum carries
 *   float noise), the blue 3 ring (197 / 3) and one pixel in six that is the faint pixel's own edge.
 */
interface Step { token: string; width: number; height: number; source: string; output: string }
const records: Array<{ spec: string; runs: Step[][] }> = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/redeye-nudge.json.gz', import.meta.url))).toString());

describe('native red-eye symmetric scenes nudged by one faint pixel', () => {
	it('is exact in 59 of 77 scenes', () => {
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
		expect(exact).toBe(59);
		expect(inexact).toEqual(['Y31:1:2:15:30:1', 'Y31:1:2:30:15:1', 'Y31:4:2:15:30:1', 'Y31:4:2:30:15:1', 'Y31:5:2:15:30:1', 'Y31:5:2:30:15:1', 'Y31:1:8:15:30:1', 'Y31:1:8:30:15:1', 'Y31:2:8:15:15:3', 'Y31:2:8:0:15:47', 'Y31:2:8:30:15:22', 'Y31:1:3:15:15:69', 'Y31:1:3:30:0:13', 'Y31:1:3:0:30:13', 'Y31:1:3:15:0:32', 'Y31:1:3:15:30:33', 'Y31:1:3:0:15:65', 'Y31:1:3:30:15:53']);
	});
});
