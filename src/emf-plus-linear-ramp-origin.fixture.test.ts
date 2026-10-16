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
 * builds for each step is in the capture). With the converter's rounding of `u00` the sweeps differ from native in
 * 109, 59, 0 and 21 of 983,520 pixels each, and what differs is always the same thing:
 *
 * - `du` and `dv` are right (a single unit on `u00` repairs every pixel of the step, 480 of 480);
 * - the correction is +1 and never -1, on 66, 26, 0 and 19 of the 2,049 steps, and the fractional part of the
 *   converter's unrounded `u00` there is anywhere from 0.05 to 0.95 (sigma sweep) or 0.32 to 0.50 (the others), so no
 *   constant offset of the origin separates them (the 66 sigma steps need an offset of at least 0.83 of a unit while the
 *   steps that need no correction allow less than 0.0005);
 * - the 0 degree brush, whose matrix has no translation to round, never needs it, and the share of steps that do
 *   follows `N / w * 65536` (the 60 degree brush with 64 intervals: 3.2%, with 16: 1.3%; the 30 degree one: 0.9%);
 * - evaluating the inverse matrix in single precision (any order) or the closed form from the angle matches fewer
 *   steps than the double precision one (1,838 of 2,049 for the best single precision form against 1,983).
 * It is a sub-unit offset of the rotated brush's translation that the rounding rule set does not produce.
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
		sigma: { wrongCells: 109, stepsWrong: 66 },
		plain60: { wrongCells: 59, stepsWrong: 26 },
		sigma0: { wrongCells: 0, stepsWrong: 0 },
		a30: { wrongCells: 21, stepsWrong: 19 },
	};
	for (const scene of scenes) {
		it(`${scene.name}: the converter differs on at most ${expected[scene.name].wrongCells} cells and a +1 on the origin repairs each step`, () => {
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

/**
 * Round 9 (W5): the origin from the inverse of the composite `Scale(w / N, 1) Translate(rect.x, 0) Transform` in single precision, products and
 * sums rounded toward minus infinity and the determinant and quotients to nearest. A step is right when the origin it gives is one that makes
 * every compared pixel of the step exact (a step that the origin does not change counts as right for either). The converter's double precision
 * origin is right on 8,085 of the 8,196 steps; this one on 8,169, but two steps of the 0 degree brush that the converter has exact go wrong,
 * so it is only a measurement (the exact rule is still open).
 */
describe('linear gradient ramp origin from a single precision composite inverse (measurement, not used)', () => {
	const f32 = new Float32Array(1);
	const u32 = new Uint32Array(f32.buffer);
	const down = (x: number): number => {
		const r = Math.fround(x);
		if (r <= x) return r;
		f32[0] = r;
		if (r > 0) u32[0] -= 1;
		else if (r < 0) u32[0] += 1;
		else u32[0] = 0x80000001;
		return f32[0];
	};
	it('is right on 8,169 of 8,196 steps against 8,085 for the converter', () => {
		const px = new Uint8ClampedArray(4);
		let converterRight = 0;
		let compositeRight = 0;
		let total = 0;
		const wrongByScene: Record<string, number> = {};
		for (const scene of scenes) {
			const data = Buffer.from(scene.rgb, 'base64');
			const first = gradientOf(scene, 0);
			const table = buildLinearRampTable(linearRampOf(first)!, first.rect!);
			const intervals = table.intervals;
			for (let i = 0; i <= scene.last - scene.first; i++) {
				const grad = gradientOf(scene, i);
				const bd = scene.matrices[i];
				const b = bd.map(Math.fround);
				const rect = grad.rect!;
				const scale = intervals / rect.w;
				const det0 = bd[0] * bd[3] - bd[1] * bd[2];
				const ia0 = bd[3] / det0;
				const ic0 = -bd[2] / det0;
				const ie0 = -(ia0 * bd[4] + ic0 * bd[5]);
				const du = Math.round(ia0 * scale * FIX);
				const dv = Math.round(ic0 * scale * FIX);
				const u00 = Math.round((ie0 - rect.x) * scale * FIX);
				const rightFor = (candidate: number): boolean => {
					for (let r = 0; r < scene.rows.length; r++) {
						for (let x = 0; x < scene.w; x++) {
							writeRampColor(table, foldRampCoordinate(candidate + x * du + scene.rows[r] * dv, intervals, 'clamp'), px, 0, false);
							const o = ((i * scene.rows.length + r) * scene.w + x) * 3;
							if (data[o] !== px[0] || data[o + 1] !== px[1] || data[o + 2] !== px[2]) return false;
						}
					}
					return true;
				};
				// K = Scale(w / N, 1) Translate(rect.x, 0) Transform, its inverse's translation is the origin in units of the ramp
				const sc = Math.fround(rect.w / intervals);
				const rx = Math.fround(rect.x);
				const k0 = down(sc * b[0]);
				const k1 = down(sc * b[1]);
				const k4 = down(down(rx * b[0]) + b[4]);
				const k5 = down(down(rx * b[1]) + b[5]);
				const det = Math.fround(down(k0 * b[3]) - down(k1 * b[2]));
				const ia = Math.fround(b[3] / det);
				const ic = Math.fround(-b[2] / det);
				const ie = -down(down(ia * k4) + down(ic * k5));
				const composite = Math.round(ie * FIX);
				total++;
				if (rightFor(u00)) converterRight++;
				if (rightFor(composite)) compositeRight++;
				else wrongByScene[scene.name] = (wrongByScene[scene.name] ?? 0) + 1;
			}
		}
		expect(total).toBe(8196);
		expect(converterRight).toBe(8085);
		expect(compositeRight).toBe(8169);
		expect(wrongByScene).toEqual({ sigma: 13, plain60: 8, sigma0: 2, a30: 4 });
	});
});
