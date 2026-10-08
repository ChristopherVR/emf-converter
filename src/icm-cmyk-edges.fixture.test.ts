import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { cmykInputCurve } from './jpeg-cmyk';

/**
 * Edge sweep of the Windows ICM module (`scripts/gdi-fixtures/cmyk-edge-sweep.py`, `generate.ps1 icm-cmyk-translate16`): every
 * 16-bit word along the 32 edges of the ink hypercube through `TranslateColors`, keeping the 256 lattice words `257 v` of
 * all 32 edges and words 0 to 4399 of two of them. Along an edge only one ink moves and the other three sit on grid
 * nodes, so the output is a one-dimensional function of the swept word between nodes of the table.
 *
 * What the capture shows about the interpolation:
 * - the module takes a 16-bit word in blocks of 16 words: inside a block every channel is a straight line of the word, rounded
 *   once (a weight r / 15 for r = 0 to 15 between two block-end values that are not whole numbers), and the first word of a block
 *   repeats the output of the last word of the one before. The blocks start at word 2 + 16 k in the first 257 words and shift by
 *   one word in each following 257 words (the 8-bit table index `word / 257` and its 16-word steps);
 * - at the lattice words 257 v, which are block ends, the output is NOT a once-rounded straight line of the table position
 *   `cmykInputCurve(v)` inside one grid cell: 412 of 1,095 (channel, cell) series of the unclipped edges need an error above
 *   half a level, so the "second rounding" is not a rounding of the output nor an error of a common interpolation position.
 */
const raw = gunzipSync(readFileSync(new URL('./__fixtures__/gdi/icm-cmyk-edges.bin.gz', import.meta.url)));
const words = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
const LATTICE = 32 * 256 * 3;
const EDGE_WORDS = 4400;
const lattice = (edge: number, v: number, channel: number) => words[(edge * 256 + v) * 3 + channel];
const sweep = (which: 0 | 1, word: number, channel: number) => words[LATTICE + (which * EDGE_WORDS + word) * 3 + channel];
const CELL = 4369;

/** Half the smallest height of a band that contains every point (the minimax straight line): at most 0.5 when one rounding of a line explains the outputs. */
function minimaxResidual(xs: number[], ys: number[]): number {
	const height = (b: number): number => {
		let lo = Infinity;
		let hi = -Infinity;
		for (let i = 0; i < xs.length; i++) {
			const v = ys[i] - b * xs[i];
			if (v < lo) lo = v;
			if (v > hi) hi = v;
		}
		return (hi - lo) / 2;
	};
	let lo = -70000;
	let hi = 70000;
	for (let it = 0; it < 400; it++) {
		const a = lo + (hi - lo) / 3;
		const b = hi - (hi - lo) / 3;
		if (height(a) < height(b)) hi = b;
		else lo = a;
	}
	return height((lo + hi) / 2);
}

/**
 * For each of the 16 alignments s, how many blocks of 16 words starting at `first + s + 16 k` (inside `[first, last + 16]`) are a
 * once-rounded straight line, over both swept edges and all three channels that move by 8 units or more in the block.
 */
function alignments(first: number, last: number): { tests: number; feasible: number[] } {
	let tests = 0;
	const feasible: number[] = [];
	for (let s = 0; s < 16; s++) {
		let n = 0;
		let ok = 0;
		for (let start = first + s; start + 15 <= last + 16 && start + 15 < EDGE_WORDS; start += 16) {
			for (const which of [0, 1] as const) {
				for (let c = 0; c < 3; c++) {
					const xs = Array.from({ length: 16 }, (_, r) => r);
					const ys = xs.map((r) => sweep(which, start + r, c));
					if (Math.max(...ys) - Math.min(...ys) < 8) continue;
					n++;
					if (minimaxResidual(xs, ys) <= 0.5 + 1e-9) ok++;
				}
			}
		}
		if (s === 0) tests = n;
		feasible.push(ok);
	}
	return { tests, feasible };
}

describe('Windows ICM CMYK edge sweep', () => {
	it('starts with one value for words 0, 1 and 2', () => {
		for (const which of [0, 1] as const) for (let c = 0; c < 3; c++) {
			expect(sweep(which, 1, c)).toBe(sweep(which, 0, c));
			expect(sweep(which, 2, c)).toBe(sweep(which, 0, c));
		}
	});
	it('is a once-rounded straight line of the word inside the blocks of 16 starting at word 2 + 16 k (15 of 15), and mostly not for the other alignments', () => {
		expect(alignments(2, 240)).toEqual({ tests: 15, feasible: [15, 7, 4, 2, 0, 0, 0, 2, 5, 3, 0, 0, 0, 2, 4, 7] });
	});
	it('moves the block alignment by one word in every following 257 words (second window: words 3 + 257 + 16 k)', () => {
		const second = alignments(300, 500);
		expect(second.tests).toBe(13);
		expect(second.feasible[7]).toBe(13);
		expect(Math.max(...second.feasible.filter((_, s) => s !== 7))).toBeLessThan(7);
	});
	it('is not a once-rounded straight line of the table position at the 8-bit lattice: 412 of 1,095 cells', () => {
		let cells = 0;
		let infeasible = 0;
		for (let edge = 0; edge < 32; edge++) {
			for (let c = 0; c < 3; c++) {
				let clipped = false;
				for (let v = 0; v < 256; v++) {
					const o = lattice(edge, v, c);
					if (o === 0 || o === 65535) clipped = true;
				}
				if (clipped) continue;
				for (let j = 0; j < 15; j++) {
					const vs: number[] = [];
					for (let v = 0; v < 256; v++) {
						const t = cmykInputCurve(v);
						if (j < 14 ? t >= CELL * j && t < CELL * (j + 1) : t >= CELL * 14) vs.push(v);
					}
					if (vs.length < 4) continue;
					cells++;
					if (minimaxResidual(vs.map((v) => cmykInputCurve(v) / CELL), vs.map((v) => lattice(edge, v, c))) > 0.5 + 1e-6) infeasible++;
				}
			}
		}
		expect({ cells, infeasible }).toEqual({ cells: 1095, infeasible: 412 });
	});
});
