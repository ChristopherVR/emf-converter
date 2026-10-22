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
 * Round 10 bisected the stage without closing it: a chain that adds the inverse matrix's x entry once per pixel reproduces
 * 1,759 of 2,379 flips of the 73 isotropic captures and loses a few float32 units per pixel that depend on the matrix and on
 * where the fill starts. Round 11 read `DpOutputBilinearSpan::OutputSpan` in gdiplus.dll: native never steps by the matrix
 * entry. For a span of `n` pixels from `x0` (one scanline of the fill, or one run of covered pixels) it transforms the
 * two end pixels, `x0` and `x0 + n`, through the inverse matrix, divides the difference by `n` and adds that step to the
 * start once per pixel, every operation a float32 one rounded toward minus infinity. That reproduces every one of the 6,238
 * flips (a step that depends on the span's own ends is why the loss per addition varied with the fill start and the matrix,
 * and why no fixed lowering of the entry fitted).
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
function exactFlips(c: BisectCase, bareStep = false): { exact: number; total: number } {
	let exact = 0;
	let total = 0;
	for (const [pixel, , , first] of c.queries) {
		if (first === 0) continue;
		total++;
		const at = (bits: number): number => {
			const inv = inverseAt(c, bits);
			if (bareStep) {
				// The model of round 10: the start from the inverse, then the matrix's x entry added once per pixel.
				let u = down32(down32(inv[0] * c.x0) + inv[4]);
				for (let x = c.x0; x < pixel; x++) u = down32(u + inv[0]);
				return u;
			}
			const us = new Float64Array(c.width);
			const vs = new Float64Array(c.width);
			textureRowPositions(inv, c.x0, 0, us, vs);
			return us[pixel - c.x0];
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

	// 119 or 120 flips per capture of the 0.3 scale at fill starts 0 to 16, 60 to 254 per capture of the other scales, 148 in all for
	// the enlargements: the span model reproduces every one.
	for (const name of Object.keys(sets) as (keyof typeof sets)[]) {
		it(`reproduces every recorded flip of every ${name} matrix`, () => {
			for (const [i, c] of sets[name].entries()) {
				const { exact, total } = exactFlips(c);
				expect(exact, `${name} #${i} (scale ${c.matrix[0]} at ${c.x0})`).toBe(total);
			}
		});
	}

	it('counts 6,238 flips in all', () => {
		let total = 0;
		for (const cases of Object.values(sets)) for (const c of cases) total += exactFlips(c).total;
		expect(total).toBe(6238);
	});

	// The control: the matrix step added per pixel (round 10's model) misses most flips of the small fill starts.
	it('the bare matrix step reproduces only part of them', () => {
		const sum = (cs: BisectCase[]): number => cs.reduce((n, c) => n + exactFlips(c, true).exact, 0);
		expect(sum(sets.scale03)).toBeLessThan(1000);
		expect(sum(sets.upscale)).toBeLessThan(148);
		expect(sum([...sets.scale03, ...sets.scales, ...sets.random, ...sets.upscale])).toBeLessThan(6238);
	});
});
