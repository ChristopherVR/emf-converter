import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pathGradientSampler } from './emf-plus-exact-fill';
import type { EmfPlusPathGradientShape, TransformMatrix } from './emf-types';

/**
 * Tiled path gradients under a rotation, shear or scale of the brush or the world (`PathGradientTileRotateProbe.cs`,
 * `path-gradient-tile-rotations.json.gz`): the white-to-black rectangles of `path-gradient-tiles` (40 x 30 at (20, 15),
 * 40.5 x 30.25 at (20.5, 15.5), 24 x 24 at (20.3, 15.7)) in Tile and TileFlipX over a 200 x 160 canvas, through a brush
 * rotation of 10, 30, 45, 90 and -20 degrees, a brush shear, a brush scale of 1.5 with a rotation of 30 degrees and a world
 * rotation of 30 and 90 degrees (192,000 pixels per transform).
 *
 * These keep the smooth ratio (`pathGradientSampler` for a tile with a rotation or shear), which is 40 to 57% exact and 88 to 95%
 * within two levels; the counts are pinned as floors. What the captures say about native:
 * - A tile with a rotation is not a stepped ramp sampled at the rotated position: at 30 degrees the lattice of the tiles is
 *   the rotated one (the white peaks of the 24 x 24 tile are 24 pixels apart along (cos 30, sin 30)), but the values
 *   between creases are smooth (20, 20, 17 levels per pixel where a 68-step ramp moves 3.75 at a time) and the peak is
 *   blurred (245 to 247, not 255), so native resamples a tile bitmap bilinearly. Sampling a brush-space bitmap through the
 *   rotation (the model of `fractionalTileSampler` with the full matrix) is 28 to 58% exact at 10, 30 and 45 degrees,
 *   92% within two levels: right in geometry, not in the details (bitmap size, supersampling by 2, 3, 4 and 8, half-pixel
 *   offsets in the device or in the texture, nearest-neighbour and 8-, 11- and 16-bit weights were tried).
 * - At exactly 90 degrees the bitmap is not rotated at all: it is STRETCHED, as a W x H bitmap, onto the device bounds of the
 *   rotated tile (30 x 40 for a 40 x 30 tile), with the bilinear weights of an unrotated fractional tile. The 40 x 30 tile
 *   is then 98.9% exact (TileFlipX 99.1%, where the mirror of the brush's x axis flips the device rows; 50% and 35% when the bitmap is rotated instead; the period-4 pattern of 13, 12, 12, 14 levels per row is
 *   a 3-to-4 resampling) and the 24 x 24 tile (where a stretch and a rotation agree) 100%; the fractional 40.5 x 30.25 tile is 52.5% exact and 99.5% within
 *   two levels (the bitmap size and the origin of the stretched cell are not settled).
 */
interface Capture {
	name: string;
	kind: string;
	wrap: number;
	w: number;
	h: number;
	bounds: [number, number, number, number];
	ra: string;
}

const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/path-gradient-tile-rotations.json.gz', import.meta.url))).toString());

const rad = (degrees: number): number => (degrees * Math.PI) / 180;
const rotation = (degrees: number): TransformMatrix => [Math.cos(rad(degrees)), Math.sin(rad(degrees)), -Math.sin(rad(degrees)), Math.cos(rad(degrees)), 0, 0];
const IDENTITY: TransformMatrix = [1, 0, 0, 1, 0, 0];
const kinds: Record<string, { brush: TransformMatrix | null; world: TransformMatrix }> = {
	brot10: { brush: rotation(10), world: IDENTITY },
	brot30: { brush: rotation(30), world: IDENTITY },
	brot45: { brush: rotation(45), world: IDENTITY },
	brot90: { brush: [0, 1, -1, 0, 0, 0], world: IDENTITY },
	'brot-20': { brush: rotation(-20), world: IDENTITY },
	bshear: { brush: [1, 0, 0.3, 1, 0, 0], world: IDENTITY },
	bscalerot: { brush: rotation(30).map((v, i) => (i < 4 ? v * 1.5 : v)) as TransformMatrix, world: IDENTITY },
	wrot30: { brush: null, world: rotation(30) },
	wrot90: { brush: null, world: [0, 1, -1, 0, 0, 0] },
};
const wraps = ['tile', 'tile-flip-x', 'tile-flip-y', 'tile-flip-xy'] as const;

function shapeOf(c: Capture, transform: TransformMatrix | null): EmfPlusPathGradientShape {
	const [x, y, w, h] = c.bounds;
	return {
		boundary: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
		center: { x: x + w / 2, y: y + h / 2 },
		centerArgb: 0xffffffff,
		boundaryArgb: [0xff000000, 0xff000000, 0xff000000, 0xff000000],
		focus: null,
		blend: null,
		preset: null,
		transform,
	};
}

describe('tiled path gradients under a rotation', () => {
	it('keeps the smooth ratio at its measured exactness for every transform', () => {
		// [pixels, exact floor, within two levels floor] per transform, over 6 captures each.
		const expected: Record<string, [number, number, number]> = {
			brot10: [192000, 86033, 181389],
			brot30: [192000, 88817, 175011],
			brot45: [192000, 101023, 173270],
			brot90: [192000, 77157, 168528],
			'brot-20': [192000, 76700, 176216],
			bshear: [192000, 76731, 171380],
			bscalerot: [192000, 109419, 182349],
			wrot30: [192000, 88817, 175008],
			wrot90: [192000, 77157, 168528],
		};
		const totals: Record<string, [number, number, number]> = {};
		for (const c of captures) {
			const km = kinds[c.kind];
			const sampler = pathGradientSampler(shapeOf(c, km.brush), wraps[c.wrap], km.world);
			const rgba = new Uint8ClampedArray(c.w * c.h * 4);
			sampler?.(0, 0, c.w, c.h, rgba);
			const native = Buffer.from(c.ra, 'base64');
			const t = (totals[c.kind] ??= [0, 0, 0]);
			for (let p = 0; p < c.w * c.h; p++) {
				if (native[p * 2 + 1] === 0) continue;
				t[0]++;
				const d = Math.abs(rgba[p * 4] - native[p * 2]);
				if (rgba[p * 4 + 3] && d === 0) t[1]++;
				if (rgba[p * 4 + 3] && d <= 2) t[2]++;
			}
		}
		expect(Object.keys(totals).sort()).toEqual(Object.keys(expected).sort());
		for (const [kind, [pixels, exact, within]] of Object.entries(expected)) {
			expect(totals[kind][0], kind).toBe(pixels);
			expect(totals[kind][1], kind).toBeGreaterThanOrEqual(exact);
			expect(totals[kind][2], kind).toBeGreaterThanOrEqual(within);
		}
	});

	/** The model of a 90 degree rotation: the brush-space bitmap stretched onto the device bounds of the rotated tile. */
	function stretched(c: Capture): { pixels: number; exact: number; within: number } {
		const [x0, y0, w, h] = c.bounds;
		const x1 = x0 + w;
		const y1 = y0 + h;
		const round = (v: number): number => Math.floor(v + 0.5);
		const bitmapW = round(x1) - round(x0);
		const bitmapH = round(y1) - round(y0);
		const kx = bitmapW / (x1 - x0);
		const ky = bitmapH / (y1 - y0);
		const toTile = (p: { x: number; y: number }): { x: number; y: number } => ({ x: (p.x - x0) * kx, y: (p.y - y0) * ky });
		const shape = shapeOf(c, null);
		const inner = pathGradientSampler({ ...shape, boundary: shape.boundary.map(toTile), center: toTile(shape.center) }, 'clamp', IDENTITY, false)!;
		const bitmap = new Uint8ClampedArray(bitmapW * bitmapH * 4);
		inner(0, 0, bitmapW, bitmapH, bitmap);
		// The mirror of the brush's x axis follows the rotation: it flips the device rows (the bitmap's second axis).
		const mirrorX = c.wrap === 2 || c.wrap === 3;
		const mirrorY = c.wrap === 1 || c.wrap === 3;
		const index = (i: number, n: number, mirror: boolean): number => {
			const period = mirror ? 2 * n : n;
			const p = ((i % period) + period) % period;
			return mirror && p >= n ? 2 * n - 1 - p : p;
		};
		// x' = -y, y' = x: the device bounds are [-y1, -y0] by [x0, x1].
		const originX = -y1;
		const originY = x0;
		const native = Buffer.from(c.ra, 'base64');
		let pixels = 0;
		let exact = 0;
		let within = 0;
		for (let y = 0; y < c.h; y++) {
			for (let x = 0; x < c.w; x++) {
				const p = y * c.w + x;
				if (native[p * 2 + 1] === 0) continue;
				pixels++;
				const u = ((x - originX) / (y1 - y0)) * bitmapW;
				const v = ((y - originY) / (x1 - x0)) * bitmapH;
				const iu = Math.floor(u);
				const iv = Math.floor(v);
				const wx = Math.floor((u - iu) * 2048 + 0.5) / 2048;
				const wy = Math.floor((v - iv) * 2048 + 0.5) / 2048;
				const c0 = index(iu, bitmapW, mirrorX);
				const c1 = index(iu + 1, bitmapW, mirrorX);
				const r0 = index(iv, bitmapH, mirrorY);
				const r1 = index(iv + 1, bitmapH, mirrorY);
				const texel = (cx: number, cy: number): number => bitmap[(cy * bitmapW + cx) * 4];
				const value = Math.floor((1 - wx) * (1 - wy) * texel(c0, r0) + wx * (1 - wy) * texel(c1, r0) + (1 - wx) * wy * texel(c0, r1) + wx * wy * texel(c1, r1) + 0.5);
				if (value === native[p * 2]) exact++;
				if (Math.abs(value - native[p * 2]) <= 2) within++;
			}
		}
		return { pixels, exact, within };
	}

	it('reproduces a 90 degree rotation as a stretch of the unrotated bitmap onto the rotated bounds', () => {
		const pick = (name: string): Capture => captures.find((c) => c.name === name)!;
		const rectangle = stretched(pick('rect-40x30-20-15-Tile-brot90'));
		expect(rectangle.pixels).toBe(32000);
		expect(rectangle.exact).toBeGreaterThanOrEqual(31632);
		expect(rectangle.within).toBe(rectangle.pixels);
		const square = stretched(pick('rect-24x24-20.3-15.7-Tile-brot90'));
		expect(square.exact).toBe(square.pixels);
		const flipped = stretched(pick('rect-24x24-20.3-15.7-TileFlipX-brot90'));
		expect(flipped.exact).toBe(flipped.pixels);
		const fractional = stretched(pick('rect-40.5x30.25-20.5-15.5-Tile-brot90'));
		expect(fractional.exact).toBeGreaterThanOrEqual(16800);
		expect(fractional.within / fractional.pixels).toBeGreaterThan(0.99);
	});
});
