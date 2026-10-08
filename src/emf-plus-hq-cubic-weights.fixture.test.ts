/**
 * The measured integer weights of an upscaled HighQualityBicubic axis against the native capture they were read from
 * (`hq-cubic-weights.json.gz`; probe `HighQualityCubicWeightProbe.cs`, mode `hq-cubic-weights`, source rows from
 * `generate-hq-cubic-source.ts`).
 *
 * The capture draws 400 independent noise rows of 1,016 texels through an exact 128/127 upscale (1,024 pixels), so
 * pixel k sits at phase position 127 k bins of 1/128 texel and every pixel cycles through all 128 bins. The rows
 * were chosen so that about 2% of the sums fall within 0.02 of a half level; with 190 or more such sums per bin, one
 * integer weight vector per bin reproduces every value.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { hqCubicBinWeights } from './emf-plus-hq-cubic-weights';

const capture = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/hq-cubic-weights.json.gz', import.meta.url))).toString());

describe('measured HighQualityBicubic weights', () => {
	it('sums every bin to one and is symmetric about the half texel', () => {
		for (let bin = 0; bin < 128; bin++) {
			const { weights } = hqCubicBinWeights(bin);
			expect(weights).toHaveLength(5);
			expect(weights.reduce((a, b) => a + b, 0), `bin ${bin}`).toBe(65536);
			const mirror = hqCubicBinWeights(127 - bin).weights.slice().reverse();
			expect([...weights], `bin ${bin}`).toEqual(mirror);
		}
	});

	it('reproduces all 1,221,600 native values of the 128/127 upscale', () => {
		const source = Buffer.from(capture.source, 'base64');
		const dest = Buffer.from(capture.dest, 'base64');
		const { rows, srcW, destW } = capture as { rows: number; srcW: number; destW: number };
		expect([rows, srcW, destW]).toEqual([400, 1016, 1024]);
		let total = 0;
		let wrong = 0;
		let cdfWrong = 0;
		for (let k = 3; k < destW - 3; k++) {
			const phase = 127 * k;
			const bin = phase % 128;
			const base = Math.floor(phase / 128);
			const { first, weights } = hqCubicBinWeights(bin);
			// The same weights as the kernel's running integral with each texel edge rounded to 1/65536.
			const cdf = analyticWeights(bin);
			for (let row = 0; row < rows; row++) {
				for (let ch = 0; ch < 3; ch++) {
					let sum = 0;
					let cdfSum = 0;
					for (let i = 0; i < 5; i++) {
						const t = base + first + i;
						const v = t < 0 || t >= srcW ? 0 : source[(row * srcW + t) * 3 + ch];
						sum += weights[i] * v;
						cdfSum += cdf[i] * v;
					}
					const native = dest[(row * destW + k) * 3 + ch];
					const clamp = (s: number): number => Math.min(255, Math.max(0, Math.floor((s + 32768) / 65536)));
					total++;
					if (clamp(sum) !== native) wrong++;
					if (clamp(cdfSum) !== native) cdfWrong++;
				}
			}
		}
		expect(total).toBe(1_221_600);
		expect(wrong).toBe(0);
		// The analytic kernel integral with rounded edges, which the table replaces, misses 426 of them.
		expect(cdfWrong).toBe(426);
	});
});

/** Cubic (a = -1) running integral from zero, odd, saturating at one half. */
function cubicIntegral(t: number): number {
	const x = Math.min(2, Math.abs(t));
	const a = -1;
	let v: number;
	if (x < 1) {
		v = ((a + 2) * x ** 4) / 4 - ((a + 3) * x ** 3) / 3 + x;
	} else {
		const p1 = (a + 2) / 4 - (a + 3) / 3 + 1;
		const p = (y: number): number => a * (y ** 4 / 4 - (5 * y ** 3) / 3 + 4 * y * y - 4 * y);
		v = p1 + p(x) - p(1);
	}
	return Math.sign(t) * v;
}

/** Integer weights of the texels `first .. first + 4` from the kernel integral with edges rounded to 1/65536. */
function analyticWeights(bin: number): number[] {
	const centre = (bin + 0.5) / 128;
	const first = bin < 64 ? -2 : -1;
	const out: number[] = [];
	for (let i = 0; i < 5; i++) {
		const t = first + i;
		out.push(Math.round(cubicIntegral(t + 0.5 - centre) * 65536) - Math.round(cubicIntegral(t - 0.5 - centre) * 65536));
	}
	return out;
}
