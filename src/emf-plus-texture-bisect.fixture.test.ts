/**
 * The source coordinate of single texture-brush pixels at the resolution of one float32 unit of the brush
 * translation (`texture-bisect-*.json.gz`, `TextureBisectProbe.cs`, `scripts/gdi-fixtures/generate-texture-bisect.ps1`).
 *
 * `texture-coordinate.json.gz` sweeps the translation in steps of 2^-14 to 2^-17 pixel, which resolves a pixel's
 * coordinate to a few float32 units of u. This probe bisects the translation over consecutive float32 values instead
 * (a 2 x 2 Tile texture whose filtered red flips where the quantised coordinate crosses a half texel, a one row fill from
 * pixel `x0`, no world transform): the first translation at which a pixel flips is that pixel's native coordinate to
 * about 1 to 4 times 2^-22 texel. A query is [pixel, lo, hi, first flipping translation as float32 bits]; the model
 * (`invertTextureMatrix` + `textureRowPositions`) flips exactly when its filtered red differs between the translation
 * before the native flip and the native flip.
 *
 * What the four captures (115 matrices, 6,238 flips) show, with the current model as the baseline:
 *
 * - The float32 round-toward-minus-infinity stepper is exact when the fill starts at pixel 7 or later (every query of
 *   the 0.3 scale at starts 7, 8, 9, 12 and 16, and 0.6 at 8) and fails when it starts at pixel 5 or earlier (at most 2 of
 *   120 flips; start 6 is in between, 41 of 120). The native chain depends on where the fill starts, not only on where a
 *   pixel is: the first flipping translation of pixel 30 of the 0.3 scale is 37, 32, 31, 31, 28, 28, 24, 24, 19, 19 and 9
 *   float32 units of the translation below the start-16 capture for fill starts 0, 1, 2, 3, 4, 5, 6, 7, 8, 9 and 12.
 *   A chain started at the wrong pixel (1 to 16 earlier, aligned down to 4, 8 or 16) or a different start formula does not
 *   reproduce the small starts.
 * - The per-pixel step is not the inverse's x entry. Lowering it by `k` float32 units (k = 1 to 3, a different k per
 *   matrix) removes most misses of every small-start capture: 0.5 and 0.25 and 0.125 (k = 2) from 173, 348 and 698 misses
 *   to 14, 90 and 164, 0.4 and 0.2 (k = 1) from 271 and 510 to 36 and 162, 0.6 and 0.3 (k = 3) from 118 and 787 to 17 and 149,
 *   and the fifteen enlargements (a 2x to 16x draw starts at pixel 0 with a tiny u) from 140 of 148 flips missed to 3. Fit as
 *   a continuous step, the lowering is 0.8 to 2.3 times 2^-23 relative to the true reciprocal and varies with the matrix's
 *   mantissa; no float32 formula tried (rounded determinant and reciprocal in all three directions, the matrix raised by
 *   0.5 to 3 times 2^-23 before inversion, 1 / (m + k ulp), Newton-refined reciprocals) reproduces the fitted values.
 * - For scales whose inverse is a power of two (0.5, 0.25, 0.125) the flips at a fill start of 8 occur only at the
 *   translations where the inverse translation crosses a multiple of 2^-19 (every one of the 60 and 120 queries of 0.5 and
 *   0.25 sits at the same residue of 8 and 8 units of 2^-22), although the float32 spacing of u there is 4 to 32 units:
 *   the native coordinate is quantised on a 2^-19 grid in the translation however large u grows.
 * - Everything the stepper gets wrong in the recorded `gpx-texture-*` fixtures (1 to 2 pixels each) is this family.
 *
 * The first test pins, per capture and per matrix, the number of flips the shipped model reproduces exactly (a
 * lower bound: a better model may raise it). The second pins the step-lowering observation as a bound on the remaining
 * misses of a chain whose step is the inverse's entry lowered by k float32 units; the third pins the translation grid.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { invertTextureMatrix, textureRowPositions } from './emf-plus-brush-texture';
import { down32 } from './float32-down';
import type { TransformMatrix } from './emf-types';

interface BisectCase {
	matrix: [number, number, number, number];
	ty: number;
	x0: number;
	columns: number;
	width: number;
	wrap: number;
	queries: [number, number, number, number][];
}

const read = (name: string): BisectCase[] =>
	JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/texture-bisect-${name}.json.gz`, import.meta.url))).toString('utf8'));

const f32 = new Float32Array(1);
const i32 = new Int32Array(f32.buffer);
const fromBits = (n: number): number => {
	i32[0] = n;
	return f32[0];
};
/** The float32 `k` units above (or, negative, below) `x`, for a positive `x`. */
const stepUnits = (x: number, k: number): number => {
	f32[0] = x;
	i32[0] += k;
	return f32[0];
};

/** The filtered 0/1 channel of the 2 x 2 texture at texel-space position `p`: texel parity, 11-bit fraction, rounded. */
function channel(p: number): number {
	const i = Math.floor(p);
	const q = Math.round((p - i) * 2048);
	const t0 = ((i % 2) + 2) % 2;
	return ((2048 - q) * t0 + q * (1 - t0) + 1024) >> 11;
}

function inverseAt(c: BisectCase, bits: number): TransformMatrix {
	return invertTextureMatrix([c.matrix[0], c.matrix[1], c.matrix[2], c.matrix[3], fromBits(bits), c.ty] as TransformMatrix)!;
}

/** Flips (of the queries that have one) at which the model's filtered red changes between the bits before and the native bits. */
function exactFlips(c: BisectCase, step?: (a: number) => number): { exact: number; total: number } {
	let exact = 0;
	let total = 0;
	for (const [pixel, , , first] of c.queries) {
		if (first === 0) continue;
		total++;
		const at = (bits: number): number => {
			const inv = inverseAt(c, bits);
			if (!step) {
				const us = new Float64Array(c.width);
				const vs = new Float64Array(c.width);
				textureRowPositions(inv, false, c.x0, 0, us, vs);
				return us[pixel - c.x0];
			}
			const s = step(inv[0]);
			let u = down32(down32(inv[0] * c.x0) + inv[4]);
			for (let x = c.x0; x < pixel; x++) u = down32(u + s);
			return u;
		};
		if (channel(at(first - 1)) !== channel(at(first))) exact++;
	}
	return { exact, total };
}

describe('native texture-brush coordinates at float32 resolution (texture-bisect-*.json.gz)', () => {
	const sets = {
		scale03: read('scale03'),
		scales: read('scales'),
		random: read('random'),
		upscale: read('upscale'),
	};

	it('has 12 + 18 + 70 + 15 matrices', () => {
		expect(sets.scale03).toHaveLength(12);
		expect(sets.scales).toHaveLength(18);
		expect(sets.random).toHaveLength(70);
		expect(sets.upscale).toHaveLength(15);
	});

	// Flips reproduced exactly per matrix by the shipped stepper (the totals are in the comments). The 0.3 scale at
	// fill starts 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12 and 16: 120 of 120 from start 7 on, 2 or fewer up to start 5.
	const expected: Record<keyof typeof sets, number[]> = {
		// totals: 119, then 120 each
		scale03: [1, 2, 2, 2, 2, 2, 41, 120, 120, 120, 120, 120],
		// 0.5, 0.25, 0.4, 0.2, 0.6, 0.125 at starts 0, 2 and 8; totals 60 x3, 118/120/120, 99/98/96, 177/180/180, 60 x3, 254/250/220
		scales: [2, 2, 3, 2, 4, 4, 6, 6, 10, 8, 10, 9, 1, 1, 60, 4, 10, 12],
		random: [
			92, 89, 14, 1, 16, 12, 40, 13, 34, 9, 37, 21, 38, 4, 4, 15, 42, 11, 12, 20, 70, 17, 22, 14, 21, 15, 12, 11, 22, 34, 12, 40, 17, 18, 34,
			13, 7, 19, 20, 18, 14, 31, 16, 27, 46, 15, 21, 138, 12, 12, 71, 25, 14, 11, 14, 13, 21, 13, 4, 3, 34, 19, 15, 13, 21, 63, 18, 8, 67, 20,
		],
		upscale: [1, 1, 1, 1, 0, 0, 0, 0, 2, 0, 0, 1, 0, 0, 1],
	};
	for (const name of Object.keys(sets) as (keyof typeof sets)[]) {
		it(`reproduces at least the recorded flips of every ${name} matrix`, () => {
			const got = sets[name].map((c) => exactFlips(c).exact);
			for (const [i, g] of got.entries()) expect(g, `${name} #${i} (scale ${sets[name][i].matrix[0]} at ${sets[name][i].x0})`).toBeGreaterThanOrEqual(expected[name][i]);
		});
	}

	it('is exact from fill start 7 on for the 0.3 scale and loses almost everything below start 6', () => {
		for (const c of sets.scale03) {
			const { exact, total } = exactFlips(c);
			if (c.x0 >= 7) expect(exact).toBe(total);
			else if (c.x0 <= 5) expect(exact).toBeLessThanOrEqual(2);
			else expect(exact).toBeLessThan(total);
		}
	});

	// Lowering the step by k float32 units (a different k per matrix) removes most of the remaining misses of the
	// small-start captures. [matrix scale, k, misses of the shipped step, misses with the lowered step per capture start].
	const lowered: [number, number, number[]][] = [
		[0.5, -2, [3, 3, 8]],
		[0.25, -2, [25, 27, 38]],
		[0.4, -1, [4, 4, 28]],
		[0.2, -1, [45, 48, 69]],
		[0.6, -3, [0, 17, 0]],
		[0.125, -2, [50, 51, 63]],
		[0.3, -3, [0, 113, 34, 2, 0, 0, 0, 0, 0, 0, 0, 0]],
	];
	for (const [scale, k, bounds] of lowered) {
		it(`the 0.${String(scale).slice(2)} scale needs a step ${-k} float32 unit${k === -1 ? '' : 's'} below the inverse's entry`, () => {
			const cs = [...sets.scale03, ...sets.scales].filter((c) => c.matrix[0] === scale);
			expect(cs).toHaveLength(bounds.length);
			let shippedMisses = 0;
			let loweredMisses = 0;
			for (const [i, c] of cs.entries()) {
				const shipped = exactFlips(c);
				const low = exactFlips(c, (a) => stepUnits(a, k));
				shippedMisses += shipped.total - shipped.exact;
				loweredMisses += low.total - low.exact;
				expect(low.total - low.exact, `${scale} at ${c.x0}`).toBeLessThanOrEqual(bounds[i]);
			}
			expect(loweredMisses).toBeLessThan(shippedMisses);
		});
	}

	// The enlargements (the JPEG playbacks draw a 7.03x one): the shipped step reproduces 8 of 148 flips, a step lowered
	// by k float32 units (k per matrix from the fit; 6, 10 and 16 have no flips or no miss at k = 0) leaves 3.
	it('the enlargements need a step 1 to 3 float32 units below the inverse entry', () => {
		const k: Record<number, number> = { 2: -2, 2.6: -2, 3: -2, 4: -2, 5: -1, 7: -1, 7.027: -1, 8: -2, 2.3: -3, 1.55: -2, 1.37: -2, 0.9: -2 };
		let shippedMissed = 0;
		let loweredMissed = 0;
		let total = 0;
		for (const c of sets.upscale) {
			const shipped = exactFlips(c);
			const low = k[c.matrix[0]] === undefined ? shipped : exactFlips(c, (a) => stepUnits(a, k[c.matrix[0]]));
			total += shipped.total;
			shippedMissed += shipped.total - shipped.exact;
			loweredMissed += low.total - low.exact;
		}
		expect(total).toBe(148);
		expect(shippedMissed).toBe(140);
		expect(loweredMissed).toBeLessThanOrEqual(3);
	});

	// The inverse translation grid: for the scales 0.5 and 0.25 at a fill start of 8, every flip is at a translation
	// where T - e, the distance of the inverse translation e from the half-texel threshold T, has the same residue modulo
	// 8 units of 2^-22 (1 and 2): the native coordinate moves in steps of 2^-19 although the float32 spacing of u is
	// 4 units at 13 and 32 units at 70.
	for (const [scale, residue] of [[0.5, 1], [0.25, 2]] as const) {
		it(`flips of the ${scale} scale at start 8 sit on one residue of a 2^-19 grid`, () => {
			const c = sets.scales.find((s) => s.matrix[0] === scale && s.x0 === 8)!;
			const a = inverseAt(c, c.queries[0][3])[0];
			const unit = 2 ** -22;
			let n = 0;
			for (const [pixel, , , first] of c.queries) {
				if (first === 0) continue;
				const e = inverseAt(c, first)[4];
				const approx = e + pixel * a;
				let threshold = 0;
				let best = 9;
				for (const k of [Math.floor(approx) - 1, Math.floor(approx), Math.floor(approx) + 1]) {
					for (const f of [1023.5, 1024.5]) {
						const t = k + f / 2048;
						if (Math.abs(t - approx) < best) {
							best = Math.abs(t - approx);
							threshold = t;
						}
					}
				}
				expect((((Math.round((threshold - e) / unit) % 8) + 8) % 8)).toBe(residue);
				n++;
			}
			expect(n).toBe(c.queries.length);
		});
	}
});
