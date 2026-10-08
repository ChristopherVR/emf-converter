import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { halftoneEnlargeTaps } from './emf-gdi-stretch';
import { KERNEL_TIE_CASES, KERNEL_TIE_IMAGES, kernelTieLevels } from './halftone-kernel-ties.fixture-helper';

/**
 * Raw native output of the HALFTONE enlargement rows whose destination centre lies exactly on a source pixel's edge or centre
 * (`generate-halftone-kernel-ties.ts`). Solving such a row for integer weights is ambiguous (the halves weigh 4096 shares
 * each, so the output depends on the sign of the tail term only), which made `halftone-kernel-rows` list tie "misses"
 * (`(10, 4086, 4091, 5)` against the formula's `(2, 4094, 4095, 1)`) that are not defects: the converter's rows reproduce every
 * native value.
 */
interface Capture { images: number; cases: { n: number; N: number; rows: number[]; output: string }[] }
const capture: Capture = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/halftone-kernel-ties.json.gz', import.meta.url))).toString());

function sharpen(levels: number[][][], n: number): number[][][] {
	return levels.map(ch => ch.map(seq => seq.map((v, y) => {
		const o = v + Math.floor((2 * v - seq[Math.max(0, y - 1)] - seq[Math.min(n - 1, y + 1)]) / 4);
		return o < 0 ? 0 : o > 255 ? 255 : o;
	})));
}

/** Values of the captured rows that `taps` (rows of [source, share of 8192]) reproduces / does not. */
function compare(taps: (n: number, N: number) => [number, number][][]): { good: number; bad: number } {
	let good = 0, bad = 0;
	capture.cases.forEach((c, k) => {
		const sharp = sharpen(kernelTieLevels(k, c.n), c.n);
		const native = Buffer.from(c.output, 'base64');
		const rows = taps(c.n, c.N);
		c.rows.forEach((x, r) => {
			for (let i = 0; i < KERNEL_TIE_IMAGES; i++) for (let ch = 0; ch < 3; ch++) {
				let sum = 0;
				for (const [j, share] of rows[x]) sum += share * sharp[i][ch][j];
				if (Math.floor((sum + 4096) / 8192) === native[(r * KERNEL_TIE_IMAGES + i) * 3 + ch]) good++; else bad++;
			}
		});
	});
	return { good, bad };
}

const modelTaps = (n: number, N: number): [number, number][][] => halftoneEnlargeTaps(n, N).map(row => row.map(([j, w]): [number, number] => [j, Math.round(w * 8192)]));

describe('native HALFTONE enlargement rows centred exactly on a source pixel edge or centre', () => {
	it('holds the captured cases', () => {
		expect(capture.images).toBe(KERNEL_TIE_IMAGES);
		expect(capture.cases.map(c => [c.n, c.N, c.rows])).toEqual(KERNEL_TIE_CASES);
		expect(capture.cases.reduce((a, c) => a + c.rows.length, 0)).toBe(38);
	});

	it('is reproduced exactly by the converter (every value of 38 rows over 400 random images)', () => {
		expect(compare(modelTaps)).toEqual({ good: 38 * KERNEL_TIE_IMAGES * 3, bad: 0 });
	});

	it('has the power to tell: the same rows without their tails, or with the spare share of a centre row moved the other way, fail', () => {
		// The tails of an edge-on row matter only through their sign and ratio: removing them changes outputs.
		const noTails = (n: number, N: number): [number, number][][] => modelTaps(n, N).map(row => (row.length > 2 ? row.slice(1, -1) : row));
		expect(compare(noTails).bad).toBeGreaterThan(300);
		// A tail on the wrong side (the left tail doubled, the right one removed) is wrong too.
		const lopsided = (n: number, N: number): [number, number][][] => modelTaps(n, N).map(row => {
			if (row.length !== 4) return row;
			const copy = row.map(([j, w]): [number, number] => [j, w]);
			copy[0][1] += copy[3][1] * 2; copy[1][1] -= copy[3][1] * 2; copy[3][1] = 0;
			return copy.filter(([, w]) => w !== 0);
		});
		expect(compare(lopsided).bad).toBeGreaterThan(100);
	});

	it('makes (655, 6881, 656) and (656, 6881, 655) the same row for every 8-bit input: the "centre phase of the factor 15" cannot be told apart', () => {
		for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) for (let c = 0; c < 256; c++) {
			if (Math.floor((655 * a + 6881 * b + 656 * c + 4096) / 8192) !== Math.floor((656 * a + 6881 * b + 655 * c + 4096) / 8192)) throw new Error(`${a},${b},${c}`);
		}
	});
});
