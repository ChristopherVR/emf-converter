// Writes hq-cubic-weights-source.bin, the input of `HighQualityCubicWeightProbe.cs` (mode `hq-cubic-weights`).
//
// The probe draws a 1016-texel-wide image 128/127 times wider (the 16.16 step is then exactly 127 bins of 1/128
// texel, so every pixel moves one bin backwards and the 128 phases repeat eight times per row). Each destination
// value is a rounded sum of five texels with the phase's weights, so it only tells the weights apart when the
// exact sum lies close to a half level. This script picks, for every row and colour channel, the best of
// `CANDIDATES` random rows by how many of its windows lie within `EPS` of a half level under the analytic
// weights quantised at 1/65536, which is where a different set of weights changes the rounded value.
//
//   bun scripts/gdi-fixtures/generate-hq-cubic-source.ts <output.bin> [rows]
import { writeFileSync } from 'node:fs';

const SRC_W = 1016;
const CANDIDATES = 24;
const EPS = 0.004;

function cubicIntegral(t: number, a: number): number {
	const x = Math.min(2, Math.abs(t));
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

// Weights per phase of a pixel: pixel k has bin (127 k - 1) = (-k - 1) mod 128 and texel offset floor((127 k - 1) / 128).
const taps: { t0: number; w: number[] }[] = [];
for (let bin = 0; bin < 128; bin++) {
	const c = (bin + 0.5) / 128;
	const t0 = Math.ceil(c - 2.5);
	const w: number[] = [];
	for (let t = t0; t <= Math.floor(c + 2.5); t++) {
		w.push((Math.round(cubicIntegral(t + 0.5 - c, -1) * 65536) - Math.round(cubicIntegral(t - 0.5 - c, -1) * 65536)) / 65536);
	}
	taps.push({ t0, w });
}

function tieCount(row: Uint8Array): number {
	let n = 0;
	for (let k = 3; k < 1024 - 3; k++) {
		const ph = 127 * k - 1;
		const base = Math.floor(ph / 128);
		const { t0, w } = taps[((ph % 128) + 128) % 128];
		let s = 0;
		for (let i = 0; i < w.length; i++) {
			s += w[i] * (row[base + t0 + i] ?? 0);
		}
		if (Math.abs(s - Math.floor(s) - 0.5) < EPS) {
			n++;
		}
	}
	return n;
}

let seed = 91337;
const rnd = (): number => {
	seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
	return seed / 4294967296;
};

const rows = Number(process.argv[3] ?? 400);
const out = new Uint8Array(rows * SRC_W * 3);
for (let r = 0; r < rows; r++) {
	for (let ch = 0; ch < 3; ch++) {
		let best: Uint8Array | null = null;
		let bestN = -1;
		for (let cand = 0; cand < CANDIDATES; cand++) {
			const row = new Uint8Array(SRC_W);
			// A mix of full-range and mid-range rows keeps the clamp rarely reached while giving large sums.
			const lo = cand % 2 ? 0 : 64;
			const span = cand % 2 ? 256 : 128;
			for (let x = 0; x < SRC_W; x++) {
				row[x] = lo + Math.floor(rnd() * span);
			}
			const n = tieCount(row);
			if (n > bestN) {
				bestN = n;
				best = row;
			}
		}
		for (let x = 0; x < SRC_W; x++) {
			out[(r * SRC_W + x) * 3 + ch] = best![x];
		}
	}
}
writeFileSync(process.argv[2], out);
