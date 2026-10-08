import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { applyRedEyeCorrection } from './emf-plus-image-effects';

/**
 * Falloff beyond the fallback circle (`generate.ps1 redeye-fallback-strength`, `RedEyeStageProbe.RunSequence` token F):
 * a lone red pixel on a grey 44 x 36 field that is uniform inside the disc around the area's middle and brighter outside it,
 * so the luma spread (0, 30, 60, 100 levels: strengths 1/4, 1/2, 0.661, 3/4) is set without touching the pixel's own sector.
 * The pixel lies beyond the circle of radius (w + h) / 6, so the area's middle stands in for the centroid; native then
 * corrects it as if the falloff were at least 0.33 (1 - u), linear in the distance u / radius, whatever the strength.
 */
interface Step { token: string; width: number; height: number; source: string; output: string }
const records: Array<{ spec: string; runs: Step[][] }> = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/redeye-fallback-strength.json.gz', import.meta.url))).toString());

describe('native red-eye falloff beyond the fallback circle', () => {
	it('is 0.33 (1 - u) for every strength: 72 lone pixels at luma spreads 0, 30, 60 and 100 are exact', () => {
		let n = 0;
		let exact = 0;
		const corrected = new Set<string>();
		for (const r of records) {
			for (const step of r.runs[0]) {
				n++;
				const src = new Uint8ClampedArray(Buffer.from(step.source, 'base64'));
				const out = applyRedEyeCorrection(src, step.width, step.height, [{ left: 0, top: 0, right: step.width, bottom: step.height }]);
				const expected = Buffer.from(step.output, 'base64');
				let same = true;
				for (let i = 0; i < out.length; i++) if (out[i] !== expected[i]) same = false;
				if (same) exact++;
				if (src.some((v, i) => v !== expected[i])) corrected.add(r.spec.slice(0, 20));
			}
		}
		expect(records).toHaveLength(4);
		expect({ n, exact }).toEqual({ n: 72, exact: 72 });
		expect(corrected.size).toBe(4);
	});
});
