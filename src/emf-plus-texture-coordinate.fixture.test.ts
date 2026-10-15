/**
 * The source-coordinate stage of a GDI+ texture brush against `texture-coordinate.json.gz`
 * (`TextureCoordinateProbe.cs`, `scripts/gdi-fixtures/generate-texture-coordinate.ps1`).
 *
 * The probe fills a 2 x 2 Tile texture (red = texel column parity, green = row parity, values 0 and 1) so that a
 * pixel's red or green flips exactly where its quantised source coordinate crosses a half texel, and sweeps the
 * brush translation in 65,536 steps of 2^-k pixels. The draw at which each pixel flips measures that pixel's native
 * coordinate to a thousandth of a bin, independently of any model. What it shows:
 *
 * - the inverse matrix is float32 with every operation rounded toward minus infinity (`invertTextureMatrix`; also
 *   checked on 4,000 random native `Matrix.Invert` results below);
 * - a row's first position is formed from it with products and sums that round the same way, and every further
 *   pixel adds the x step in float32 rounded toward minus infinity, so the position drifts below the exact one
 *   by up to a float32 unit per pixel (3 bins of 1/2048 by pixel 156 of a 0.45x reduction, 8 bins at u of 500),
 *   which is the residual the per-pixel model left on the recorded texture fixtures;
 * - the row starts at the left edge of the fill, whether that is a rectangle or a clip, and rows are independent.
 *
 * Each pixel is tested at its recorded flips: the model must change the filtered red/green between the draw before
 * the flip and the flip. The few misses left are single draws (one float32 unit of 2^-k) at the start of a row.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { invertTextureMatrix, textureRowPositions } from './emf-plus-brush-texture';
import { resampleImage } from './emf-plus-image-resample';
import type { TransformMatrix } from './emf-types';

interface Capture {
	matrix: number[];
	sx: number;
	sy: number;
	n: number;
	x0: number;
	y0: number;
	width: number;
	height: number;
	half: number;
	geo: number;
	flips: string;
}

const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(
	new URL('./__fixtures__/gdi/texture-coordinate.json.gz', import.meta.url),
)).toString('utf8'));

/** The filtered 0/1 channel of the 2 x 2 texture at texel-space position `p`: texel parity, 11-bit fraction, rounded. */
function channel(p: number): number {
	const i = Math.floor(p);
	const q = Math.round((p - i) * 2048);
	const t0 = ((i % 2) + 2) % 2;
	return ((2048 - q) * t0 + q * (1 - t0) + 1024) >> 11;
}

function missedFlips(c: Capture): number {
	const fround = Math.fround;
	const flips = new Int32Array(Buffer.from(c.flips, 'base64').buffer.slice(0));
	const positions = (j: number, y: number): [Float64Array, Float64Array] => {
		const tx = fround(c.matrix[4] + fround(j * c.sx));
		const ty = fround(c.matrix[5] + fround(j * c.sy));
		const inv = invertTextureMatrix([c.matrix[0], c.matrix[1], c.matrix[2], c.matrix[3], tx, ty] as TransformMatrix)!;
		const us = new Float64Array(c.width);
		const vs = new Float64Array(c.width);
		textureRowPositions(inv, c.half === 1, c.x0, c.y0 + y, us, vs);
		return [us, vs];
	};
	let missed = 0;
	for (let y = 0; y < c.height; y++) {
		const cache = new Map<number, [Float64Array, Float64Array]>();
		const at = (j: number): [Float64Array, Float64Array] => {
			let r = cache.get(j);
			if (!r) cache.set(j, (r = positions(j, y)));
			return r;
		};
		for (let x = 0; x < c.width; x++) {
			for (let ch = 0; ch < 2; ch++) {
				for (let s = 0; s < 2; s++) {
					const n = flips[((y * c.width + x) * 4) + ch * 2 + s];
					if (n < 1) continue;
					if (channel(at(n - 1)[ch][x]) === channel(at(n)[ch][x])) missed++;
				}
			}
		}
	}
	return missed;
}

describe('native Matrix.Invert (matrix-invert.json.gz)', () => {
	// 4,000 random float32 matrices (half of them sheared): every element of the inverse is the float32 result of
	// operations that all round toward minus infinity, det = a d - b c, r = 1 / det, then d r, -b r, -c r, a r and
	// ((c f - d e) r, (b e - a f) r). Rounding to nearest matches 898 of 2,000 axis-aligned linear elements.
	it('is reproduced bit for bit', () => {
		const rows: number[][] = JSON.parse(gunzipSync(readFileSync(
			new URL('./__fixtures__/gdi/matrix-invert.json.gz', import.meta.url),
		)).toString('utf8'));
		expect(rows).toHaveLength(4000);
		const f32 = new Float32Array(1);
		const bits = new Int32Array(f32.buffer);
		const value = (b: number): number => {
			bits[0] = b;
			return f32[0];
		};
		let wrong = 0;
		for (const r of rows) {
			const m = r.slice(0, 6).map(value) as TransformMatrix;
			const native = r.slice(6).map(value);
			const inv = invertTextureMatrix(m)!;
			if (inv.some((v, k) => v !== native[k])) wrong++;
		}
		expect(wrong).toBe(0);
	});
});

describe('native texture-brush source coordinates', () => {
	it('has 16 sweeps', () => {
		expect(captures).toHaveLength(16);
	});

	// Flips not reproduced, of 2,747 to 5,216 recorded per sweep (61,916 in all). Without the stepper (every position
	// computed per pixel from the double-precision inverse) 34,903 of them are missed (1,608 to 3,856 per sweep, none
	// for the identity matrix); with it 1,959 are, each a
	// single draw (one float32 unit of 2^-k) at the start of the row. The sweeps that start at a negative coordinate
	// (0, 3, 5, 7, 8) and Half (9, 10) keep most of them: the first position's rounding is not exact there.
	const bounds = [224, 27, 0, 96, 0, 40, 0, 616, 104, 496, 335, 0, 0, 0, 0, 21];
	for (const [index, c] of captures.entries()) {
		it(`sweep ${index}: ${c.matrix.join(',')} at ${c.x0}, half ${c.half}, geometry ${c.geo}`, () => {
			expect(missedFlips(c)).toBeLessThanOrEqual(bounds[index]);
		}, 60_000);
	}
});

interface LevelSweep {
	sw: number;
	sh: number;
	dw: number;
	dh: number;
	dx: number;
	dy: number;
	mode: number;
	axis: number;
	step: number;
	n: number;
	width: number;
	height: number;
	changes: number;
	source: string;
	first: string;
	count: string;
	when: string;
	what: string;
}

describe('native high-quality DrawImage positions (image-levels.json.gz)', () => {
	// ImageLevelProbe.cs: grey noise drawn with HighQualityBilinear (6) and HighQualityBicubic (7) while one origin
	// axis moves by 2^-16 pixel per draw; for every pixel, the draws at which its red changes and the value it changes
	// to. For each of the first eight changes of row 6, columns 12 to 39, the converter's model is searched within 300
	// draws of the native one for the same change (same level before, same level after): `exact` finds it at the
	// native draw, `near` within one draw. The horizontal axis agrees for 46% to 69% of the changes within a draw
	// (60% and 57% exactly on the 58-pixel reduction; the rest are late or early by a draw, or a level apart at a
	// phase-bin edge, 1/128 pixel = 512 draws); the vertical axis agrees for almost none, because native steps through
	// ±1 level dithering between neighbouring bins that the monotone model does not (the sequences have the same
	// range and slope: 150 to 140 over the first 21,333 draws against 150 to 138 over 22,528).
	const sweeps: LevelSweep[] = JSON.parse(gunzipSync(readFileSync(
		new URL('./__fixtures__/gdi/image-levels.json.gz', import.meta.url),
	)).toString('utf8'));
	// [exact at least, near at least] per sweep
	const floors: Array<[number, number]> = [[135, 155], [128, 148], [0, 3], [0, 1], [29, 73], [15, 28], [0, 2], [0, 0]];

	it('has 8 sweeps', () => {
		expect(sweeps).toHaveLength(8);
	});

	for (const [index, c] of sweeps.entries()) {
		it(`sweep ${index}: ${c.sw}x${c.sh} to ${c.dw}x${c.dh}, mode ${c.mode}, axis ${c.axis}`, () => {
			const fround = Math.fround;
			const source = Buffer.from(c.source, 'base64');
			const rgba = new Uint8ClampedArray(c.sw * c.sh * 4);
			for (let i = 0; i < source.length; i++) rgba.set([source[i], source[i], source[i], 255], i * 4);
			const first = Buffer.from(c.first, 'base64');
			const count = Buffer.from(c.count, 'base64');
			const when = new Int32Array(Buffer.from(c.when, 'base64').buffer.slice(0));
			const what = Buffer.from(c.what, 'base64');
			const step = fround(c.step);
			const y = 6;
			const cache = new Map<number, ReturnType<typeof resampleImage>>();
			const level = (j: number, x: number): number => {
				if (!cache.has(j)) {
					cache.set(j, resampleImage(rgba, c.sw, c.sh, {
						srcX: 0, srcY: 0, srcW: c.sw, srcH: c.sh,
						toDevice: [fround(fround(c.dw) / c.sw), 0, 0, fround(fround(c.dh) / c.sh),
							c.axis === 0 ? fround(fround(c.dx) + fround(j * step)) : fround(c.dx),
							c.axis === 1 ? fround(fround(c.dy) + fround(j * step)) : fround(c.dy)],
						kernel: c.mode === 7 ? 'hq-bicubic' : 'hq-bilinear', halfPixelOffset: false, pointsForm: false,
					}, { w: c.width, h: c.height }));
				}
				const b = cache.get(j);
				if (!b || x < b.x || x >= b.x + b.w || y < b.y || y >= b.y + b.h) return -1;
				const o = ((y - b.y) * b.w + x - b.x) * 4;
				return Math.round(b.rgba[o] * b.rgba[o + 3] / 255);
			};
			let exact = 0;
			let near = 0;
			for (let x = 12; x < Math.min(c.width - 6, 40); x++) {
				const q = y * c.width + x;
				let before = first[q];
				for (let k = 0; k < Math.min(count[q], 8); k++) {
					const j = when[q * c.changes + k];
					const after = what[q * c.changes + k];
					let found = Infinity;
					for (let d = 0; d <= 300 && found === Infinity; d++) {
						for (const s of d === 0 ? [0] : [-1, 1]) {
							const jj = j + s * d;
							if (jj >= 1 && jj < c.n && level(jj - 1, x) === before && level(jj, x) === after) {
								found = d;
								break;
							}
						}
					}
					if (found === 0) exact++;
					if (found <= 1) near++;
					before = after;
				}
			}
			expect(exact).toBeGreaterThanOrEqual(floors[index][0]);
			expect(near).toBeGreaterThanOrEqual(floors[index][1]);
		}, 120_000);
	}
});

interface ImageSweep {
	sw: number;
	sh: number;
	dw: number;
	dh: number;
	dx: number;
	dy: number;
	step: number;
	width: number;
	height: number;
	flips: string;
}

describe('native plain Bilinear DrawImage source coordinates (image-coordinate.json.gz)', () => {
	// ImageCoordinateProbe.cs: the same flip measurement for DrawImage(destRect, srcRect), sweeping the destination
	// origin by 2^-16 pixel per draw. The phase follows the real origin continuously (snapping it to 1/16 pixel
	// misses every flip), and the 0.45x reduction drifts exactly like the texture brush's. Misses left: one draw
	// (2^-16 pixel) at the start of the row, so these bounds are not about whole pixels but ulp-level ties.
	const sweeps: ImageSweep[] = JSON.parse(gunzipSync(readFileSync(
		new URL('./__fixtures__/gdi/image-coordinate.json.gz', import.meta.url),
	)).toString('utf8'));
	const bounds = [2493, 1813, 3003, 69, 1628, 1312, 2990];

	it('has 7 sweeps', () => {
		expect(sweeps).toHaveLength(7);
	});

	for (const [index, c] of sweeps.entries()) {
		it(`sweep ${index}: ${c.sw}x${c.sh} to ${c.dw}x${c.dh} at ${c.dx}, ${c.dy}`, () => {
			const fround = Math.fround;
			const rgba = new Uint8ClampedArray(c.sw * c.sh * 4);
			for (let y = 0; y < c.sh; y++) {
				for (let x = 0; x < c.sw; x++) {
					rgba.set([x % 2, y % 2, 0, 255], (y * c.sw + x) * 4);
				}
			}
			const flips = new Int32Array(Buffer.from(c.flips, 'base64').buffer.slice(0));
			const step = fround(c.step);
			const cache = new Map<number, ReturnType<typeof resampleImage>>();
			const draw = (j: number): ReturnType<typeof resampleImage> => {
				if (!cache.has(j)) {
					cache.set(j, resampleImage(rgba, c.sw, c.sh, {
						srcX: 0, srcY: 0, srcW: c.sw, srcH: c.sh,
						toDevice: [fround(fround(c.dw) / c.sw), 0, 0, fround(fround(c.dh) / c.sh),
							fround(fround(c.dx) + fround(j * step)), fround(fround(c.dy) + fround(j * step))],
						kernel: 'bilinear', halfPixelOffset: false, pointsForm: false,
					}, { w: c.width, h: c.height }));
				}
				return cache.get(j)!;
			};
			const value = (j: number, x: number, y: number, ch: number): number => {
				const b = draw(j);
				if (!b || x < b.x || x >= b.x + b.w || y < b.y || y >= b.y + b.h) return -1;
				return b.rgba[((y - b.y) * b.w + x - b.x) * 4 + ch];
			};
			let missed = 0;
			for (let y = 0; y < c.height; y++) {
				for (let x = 0; x < c.width; x++) {
					for (let ch = 0; ch < 2; ch++) {
						for (let s = 0; s < 2; s++) {
							const n = flips[((y * c.width + x) * 4) + ch * 2 + s];
							if (n >= 1 && value(n - 1, x, y, ch) === value(n, x, y, ch)) missed++;
						}
					}
				}
			}
			expect(missed).toBeLessThanOrEqual(bounds[index]);
		}, 60_000);
	}
});
