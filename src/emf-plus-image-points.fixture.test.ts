/**
 * Plain Bilinear `DrawImagePoints` against native captures (`image-points.json.gz`, `image-points-positions.json.gz`;
 * `ImagePointsProbe.cs`, `scripts/gdi-fixtures/generate-image-points.ps1`).
 *
 * A metafile records `DrawImage(image, rectangle)` as a three-point draw with float32 noise in the points (a rectangle at
 * (20, 10) is recorded at (20.000030517578125, 10.000015258789062)), and the JPEG/PNG playback fixtures therefore take the
 * points path. Native runs the same bilinear resampler for both forms, but not with the same float arithmetic: with the
 * origin and size of one rectangle, the flip origins of a `DrawImage(destRect, srcRect)` and of the same draw with three
 * points differ by 20 to 30 float32 units (1.9e-6 pixel each) on every one of 144 columns. What the captures fix:
 *
 * - the horizontal position is the float32 round-down stepper of `DrawImage` (`writeTextureRect`), with the inverse
 *   built from the matrix inferred from the points: 71 of 144 flip origins of a clean origin land on the native float32
 *   value and every other is within two (the remaining misses are the float32 noise of the native arithmetic);
 * - the vertical position of the points form runs a relative 2^-21 above the exact one: 959 flip origins in eight
 *   geometries (source heights 7 to 100, destination heights 100 to 170, origins 10 to 90) are fit by
 *   `(y - oy) * sh / dh * (1 + e)` at e = 4.3e-7 to 5.5e-7 and not by any float32 rounding of the matrix (inverse
 *   entries moved by up to 14 float32 units, and the rounding toward minus infinity, nearest and toward plus infinity
 *   of the difference, product and sum, were tried). The mechanism is not known;
 * - what is left is a handful of columns whose position moves by up to 44 float32 units (8e-5 pixel) when the origin's
 *   y changes by 2^-16 pixel, independently of the row read (the five column sweeps of `image-points-positions.json.gz`, origins y = 10, 10 + 2^-16,
 *   10 + 2^-14, 10.001 and 10.5; the y = 10 and 10.5 sweeps agree, the others move 50 to 72 of 145 columns). This is
 *   the 12 pixels `codec-jpeg-arith-prog-420-dri2-playback` still differs by.
 * - the horizontal step of an axis-aligned points draw is the nearest float32 reciprocal of the scale, not the
 *   round-down chain of the matrix inverse (a 100 -> 100 draw with a 10 -> 8 vertical reduction: 3,155 differing
 *   pixels of 27,648 to 2).
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { down32 } from './float32-down';
import { resampleImage } from './emf-plus-image-resample';

const fround = Math.fround;

interface NoiseCase {
	sw: number;
	sh: number;
	dw: number;
	dh: number;
	dx: number;
	dy: number;
	width: number;
	height: number;
	seed: number;
	draws: { ox: number; oy: number; rgba: string }[];
}

interface PositionCase {
	axis: 0 | 1;
	points: boolean;
	sw: number;
	sh: number;
	dw: number;
	dh: number;
	ox0: number;
	oy0: number;
	queries: [number, number, number, number][];
}

const read = <T>(name: string): T => JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${name}`, import.meta.url))).toString('utf8'));

/** The points draw the converter builds for a record: `imageResampleSpec` with the float32 points of a rectangle. */
function pointsSpec(sw: number, sh: number, dw: number, dh: number, ox: number, oy: number) {
	const p1x = fround(ox);
	const p1y = fround(oy);
	const p2x = fround(ox + fround(dw));
	const p3y = fround(oy + fround(dh));
	return {
		srcX: 0,
		srcY: 0,
		srcW: sw,
		srcH: sh,
		toDevice: [down32((p2x - p1x) / sw), 0, 0, down32((p3y - p1y) / sh), p1x, p1y] as [number, number, number, number, number, number],
		kernel: 'bilinear' as const,
		halfPixelOffset: false,
		pointsForm: true,
	};
}

describe('native plain Bilinear DrawImagePoints, noise bitmaps (image-points.json.gz)', () => {
	const cases = read<NoiseCase[]>('image-points.json.gz');
	// Pixels more than a pixel and a half inside the destination whose native and rendered alpha are both opaque
	// (the half texel at the far edges fades to transparent, a separate question). Differing pixels, per case.
	const bounds = [264, 6, 50, 28, 2];

	it('has five geometries', () => {
		expect(cases).toHaveLength(5);
	});

	for (const [index, c] of cases.entries()) {
		it(`${c.sw}x${c.sh} to ${c.dw}x${c.dh} at ${c.dx}, ${c.dy}`, () => {
			const rgba = new Uint8ClampedArray(c.sw * c.sh * 4);
			let seed = c.seed >>> 0;
			const next = (): number => {
				seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
				return (seed >>> 16) & 255;
			};
			for (let i = 0; i < c.sw * c.sh; i++) rgba.set([next(), next(), next(), 255], i * 4);
			let differing = 0;
			let total = 0;
			for (const d of c.draws) {
				const native = Buffer.from(d.rgba, 'base64');
				const block = resampleImage(rgba, c.sw, c.sh, pointsSpec(c.sw, c.sh, c.dw, c.dh, d.ox, d.oy), { w: c.width, h: c.height });
				for (let y = Math.ceil(c.dy + 2); y < Math.floor(c.dy + c.dh - 2); y++) {
					for (let x = Math.ceil(c.dx + 2); x < Math.floor(c.dx + c.dw - 2); x++) {
						const i = (y * c.width + x) * 4;
						let m = [0, 0, 0, 0];
						if (block && x >= block.x && x < block.x + block.w && y >= block.y && y < block.y + block.h) {
							const j = ((y - block.y) * block.w + x - block.x) * 4;
							m = [block.rgba[j], block.rgba[j + 1], block.rgba[j + 2], block.rgba[j + 3]];
						}
						if (native[i + 3] !== 255 || m[3] !== 255) continue;
						total++;
						if (native[i] !== m[0] || native[i + 1] !== m[1] || native[i + 2] !== m[2]) differing++;
					}
				}
			}
			expect(differing).toBeLessThanOrEqual(bounds[index]);
		}, 120_000);
	}
});

describe('native plain Bilinear DrawImagePoints, flip origins (image-points-positions.json.gz)', () => {
	const cases = read<PositionCase[]>('image-points-positions.json.gz');
	const f32 = new Float32Array(1);
	const i32 = new Int32Array(f32.buffer);
	const fromBits = (n: number): number => {
		i32[0] = n;
		return f32[0];
	};

	it('has seven row sweeps, five origin classes of the column sweep and a rectangle control', () => {
		expect(cases.filter((c) => c.axis === 1)).toHaveLength(7);
		expect(cases.filter((c) => c.axis === 0 && c.points)).toHaveLength(5);
		expect(cases.filter((c) => !c.points)).toHaveLength(1);
	});

	// A query is [pixel, lo, hi, first flipping origin as float32 bits]. The model flips exactly at the native origin when
	// the green of the pixel changes between the float32 value before it and the native one. Those geometries put the
	// origin at 60 and 90, where a float32 unit is 3.8e-6 and 7.6e-6 pixel, so the exact count is a statement about the
	// vertical position to about a tenth of a 1/2048 bin.
	for (const [which, minimum] of [[5, 25], [6, 28]] as const) {
		const c = cases.filter((p) => p.axis === 1)[which];
		it(`rows of a ${c.sw} x ${c.sh} to ${c.dw} x ${c.dh} draw at y = ${c.oy0}`, () => {
			const rgba = new Uint8ClampedArray(c.sw * c.sh * 4);
			for (let y = 0; y < c.sh; y++) for (let x = 0; x < c.sw; x++) rgba.set([x % 2, y % 2, 0, 255], (y * c.sw + x) * 4);
			const green = (bits: number, row: number): number => {
				const block = resampleImage(rgba, c.sw, c.sh, pointsSpec(c.sw, c.sh, c.dw, c.dh, c.ox0, fromBits(bits)), { w: 300, h: 200 });
				const col = Math.floor(c.ox0 + c.dw / 2);
				if (!block || col < block.x || col >= block.x + block.w || row < block.y || row >= block.y + block.h) return -1;
				return block.rgba[((row - block.y) * block.w + col - block.x) * 4 + 1];
			};
			let exact = 0;
			let total = 0;
			for (const [row, , , native] of c.queries) {
				if (native === 0) continue;
				total++;
				if (green(native - 1, row) !== green(native, row)) exact++;
			}
			expect(total).toBe(72);
			expect(exact).toBeGreaterThanOrEqual(minimum);
		}, 120_000);
	}
});
