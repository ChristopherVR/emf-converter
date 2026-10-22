import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildLinearRampTable, foldRampCoordinate, linearRampOf, linearRampSampler, writeRampColor } from './emf-plus-linear-ramp';
import type { EmfPlusLinearGradient, EmfPlusLinearRamp, EmfPlusRectF } from './emf-types';

/**
 * The origin of a linear gradient's ramp coordinate, read to one 16.16 unit (`LinearRampOriginProbe.cs`,
 * `linear-ramp-origin.json.gz`).
 *
 * A pixel's colour changes where its ramp coordinate `u` crosses a multiple of 256, so moving the brush rectangle
 * by 2^-16 pixel at a time (2,049 steps, -1024 to +1024, three scanlines of 160 pixels each) places the origin
 * `u00` of the converter's affine form `u = u00 + x du + y dv` to a unit at every step, without trusting any
 * model of it. Four brushes: the `gpx-lin-sigma` one (rectangle 5,0,150,30, 60 degrees, `SetSigmaBellShape(0.35, 0.9)`),
 * the same without the bell shape, the bell shape at 0 degrees, and a 30 degree brush of 110 by 40 (the matrix GDI+
 * builds for each step is in the capture).
 *
 * Round 9 left the converter's double precision origin wrong on 66, 26, 0 and 19 of the 2,049 steps of the four sweeps
 * (109, 59, 0 and 21 of 983,520 pixels each), always by one unit upward, with no single-precision form that fitted.
 * Round 11 read `DpOutputLinearGradientSpan` in gdiplus.dll: the coefficients come from the brush matrix, the
 * ramp-to-rectangle matrix (`(right - x) / (N * 65536)` and `right - m * (N * 65536)` from the float32 rectangle) and their
 * product, inverted, in float32 with every product, sum and quotient rounded toward minus infinity (rounding to nearest in every operation
 * leaves 153 steps wrong, and rounding any one stage of the chain to nearest leaves 1 to 69). All four sweeps are
 * now exact on every pixel; `linear-ramp-world.json.gz` repeats the experiment under a world transform.
 */
interface Scene {
	name: string; w: number; rows: number[]; first: number; last: number;
	matrices: number[][]; blend: { factors: number[]; positions: number[] } | null; rgb: string;
}
const scenes: Scene[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/linear-ramp-origin.json.gz', import.meta.url))).toString());

const argb = (r: number, g: number, b: number): number => ((255 << 24) | (r << 16) | (g << 8) | b) >>> 0;
const defs: Record<string, { rect: (dx: number) => EmfPlusRectF; start: number; end: number }> = {
	sigma: { rect: (dx) => ({ x: Math.fround(5 + dx), y: 0, w: 150, h: 30 }), start: argb(250, 240, 10), end: argb(30, 0, 120) },
	plain60: { rect: (dx) => ({ x: Math.fround(5 + dx), y: 0, w: 150, h: 30 }), start: argb(250, 240, 10), end: argb(30, 0, 120) },
	sigma0: { rect: (dx) => ({ x: Math.fround(5 + dx), y: 0, w: 150, h: 30 }), start: argb(250, 240, 10), end: argb(30, 0, 120) },
	a30: { rect: (dx) => ({ x: Math.fround(10 + dx), y: 5, w: 110, h: 40 }), start: argb(230, 40, 30), end: argb(20, 90, 220) },
};

function gradientOf(scene: Scene, i: number): EmfPlusLinearGradient {
	const d = defs[scene.name];
	const ramp: EmfPlusLinearRamp = { startArgb: d.start, endArgb: d.end, preset: null, blend: scene.name.startsWith('sigma') ? scene.blend : null, gammaCorrected: false };
	return {
		type: 'linear', x1: 0, y1: 0, x2: 1, y2: 0, stops: [], wrapMode: 'clamp',
		rect: d.rect((scene.first + i) / 65536), transform: scene.matrices[i] as EmfPlusLinearGradient['transform'], ramp,
	} as EmfPlusLinearGradient;
}

const FIX = 65536;
function analyse(scene: Scene): { cells: number; wrongCells: number; stepsWrong: number; shifts: Record<number, number>; lowestCell: number } {
	const n = scene.last - scene.first + 1;
	const data = Buffer.from(scene.rgb, 'base64');
	let wrongCells = 0, stepsWrong = 0, lowestCell = 0;
	const shifts: Record<number, number> = {};
	const table = buildLinearRampTable(linearRampOf(gradientOf(scene, 0))!, gradientOf(scene, 0).rect!);
	const intervals = table.intervals;
	const px = new Uint8ClampedArray(4);
	for (let i = 0; i < n; i++) {
		const grad = gradientOf(scene, i);
		const out = new Uint8ClampedArray(160 * 100 * 4);
		linearRampSampler(grad, [1, 0, 0, 1, 0, 0], false, false)!(0, 0, 160, 100, out);
		let wrong = 0;
		for (let r = 0; r < scene.rows.length; r++) {
			for (let x = 0; x < scene.w; x++) {
				const o = ((i * scene.rows.length + r) * scene.w + x) * 3;
				const m = (scene.rows[r] * 160 + x) * 4;
				if (data[o] !== out[m] || data[o + 1] !== out[m + 1] || data[o + 2] !== out[m + 2]) wrong++;
			}
		}
		wrongCells += wrong;
		if (wrong === 0) continue;
		stepsWrong++;
		// Which shift of u00 makes the step exact (the converter's coefficients, see linearRampSampler)?
		const b = scene.matrices[i];
		const det = b[0] * b[3] - b[1] * b[2];
		const ia = b[3] / det, ic = -b[2] / det, ie = -(ia * b[4] + ic * b[5]);
		const rect = grad.rect!;
		const scale = intervals / rect.w;
		const du = Math.round(ia * scale * FIX), dv = Math.round(ic * scale * FIX);
		const u00 = Math.round((ie - rect.x) * scale * FIX);
		let best = 0, bestScore = -1;
		for (const s of [-2, -1, 0, 1, 2]) {
			let ok = 0;
			for (let r = 0; r < scene.rows.length; r++) {
				for (let x = 0; x < scene.w; x++) {
					writeRampColor(table, foldRampCoordinate(u00 + s + x * du + scene.rows[r] * dv, intervals, 'clamp'), px, 0, false);
					const o = ((i * scene.rows.length + r) * scene.w + x) * 3;
					if (data[o] === px[0] && data[o + 1] === px[1] && data[o + 2] === px[2]) ok++;
				}
			}
			if (ok > bestScore) { best = s; bestScore = ok; }
		}
		shifts[best] = (shifts[best] ?? 0) + 1;
		if (bestScore !== scene.rows.length * scene.w) lowestCell++;
	}
	return { cells: n * scene.rows.length * scene.w, wrongCells, stepsWrong, shifts, lowestCell };
}

describe('linear gradient ramp origin (native, 2^-16 pixel sweeps)', () => {
	const expected: Record<string, { wrongCells: number; stepsWrong: number }> = {
		sigma: { wrongCells: 0, stepsWrong: 0 },
		plain60: { wrongCells: 0, stepsWrong: 0 },
		sigma0: { wrongCells: 0, stepsWrong: 0 },
		a30: { wrongCells: 0, stepsWrong: 0 },
	};
	for (const scene of scenes) {
		it(`${scene.name}: the converter is exact on every cell`, () => {
			expect(scene.last - scene.first + 1).toBe(2049);
			const r = analyse(scene);
			expect(r.cells).toBe(983520);
			expect(r.wrongCells).toBeLessThanOrEqual(expected[scene.name].wrongCells);
			expect(r.stepsWrong).toBeLessThanOrEqual(expected[scene.name].stepsWrong);
			// every wrong step is repaired by exactly one unit on the origin, and only upward
			expect(r.lowestCell).toBe(0);
			expect(Object.keys(r.shifts).every((s) => s === '1')).toBe(true);
		});
	}
});
