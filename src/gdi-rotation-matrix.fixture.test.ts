import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { rotationMatrix } from './gdi-font-engine';
import { fixturePath } from './__fixtures__/gdi-parity-harness';

/**
 * `rotation-matrix.json.gz` (RotationMatrixProbe.cs, `generate-rotation-matrix.ps1`, 16 October 2026): `GetGlyphOutline(GGO_NATIVE)`
 * of private fonts under a world rotation and under an escapement, in 1/64 pixel.
 *
 * - `axisint`: 2048 units per em, `head.flags` bit 3 ("force ppem to integer values", as every stock font here), glyph
 *   E004 = the points (0,0) and (1700 + j, 0) for j = 0..238 (every 8th and the last are stored). Rotated by 5 to 355 degrees
 *   in steps of 5 at ppem 9 to 20, 24, 28, 32, 36, 40, 44 and 48.
 * - `plain`: 64 units per em and no flag, glyph E000 = (0,0), (30000,0), (0,30000): 468 em out, so the matrix shows to a relative 1e-6.
 *
 * Findings pinned here: with the flag the glyph is scaled at the whole-pixel ppem `round(ppem * max(|cos|, |sin|))` (hinting runs at
 * that size) and the rotation is applied over its major component, the minor ones being `A / B` with `A` and `B` the components
 * rounded at 32 * ppem (a 16.16 em scale); without the flag the matrix is the exact rotation and the size is the ppem. Programs
 * (`prep`, `fpgm`, glyph instructions) change nothing: only `head.flags` does (experiment, not committed).
 */
interface Row { variant: string; mode: string; ppem: number; degrees: number; glyph: number; step: number; points: number[][] }
const rows: Row[] = JSON.parse(gunzipSync(readFileSync(fixturePath('rotation-matrix.json.gz'))).toString());

describe('the capture', () => {
	it('has 2 modes x 72 angles x (19 sizes of axisint + 2 of plain)', () => {
		expect(rows).toHaveLength(2 * 72 * (19 + 2));
		expect(rows.filter((r) => r.variant === 'axisint')).toHaveLength(2 * 72 * 19);
	});
});

describe('rotationMatrix', () => {
	const rot = (degrees: number): [number, number, number, number] => {
		const t = (degrees * Math.PI) / 180;
		return [Math.cos(t), Math.sin(t), -Math.sin(t), Math.cos(t)];
	};
	it('rotates exactly at the font size when the font does not force integer ppem', () => {
		const m = rot(25);
		expect(rotationMatrix(m, 20, false)).toEqual({ ppem: 0, matrix: m });
	});
	it('hints at the rounded major ppem and divides the rotation by its major component otherwise', () => {
		const r = rotationMatrix(rot(25), 20, true)!;
		expect(r.ppem).toBe(18);
		expect(r.matrix[0]).toBe(1);
		expect(r.matrix[3]).toBe(1);
		// A = round(sin25 * 20 * 32) = 270, B = round(cos25 * 20 * 32) = 580: the minor component is 270 / 580 (as a 16.16 number), not tan 25 = 0.4663
		expect(r.matrix[1]).toBeCloseTo(270 / 580, 5);
		expect(r.matrix[1] * 65536).toBe(Math.round(r.matrix[1] * 65536));
		expect(r.matrix[2]).toBe(-r.matrix[1]);
	});
	it('rounds the major component half up at 1/32 pixel (12 px at 45 degrees is hinted at 9, not 8: 8.4853 -> 8.5)', () => {
		expect(rotationMatrix(rot(45), 12, true)!.ppem).toBe(9);
		expect(rotationMatrix(rot(45), 20, true)!.ppem).toBe(14);
		expect(rotationMatrix(rot(40), 15, true)!.ppem).toBe(12);
	});
	it('keeps the signs and the major axis of other quadrants', () => {
		// 120 degrees: the sine is the major component (17.32 -> 17), the cosine (-0.5) the minor one
		const r = rotationMatrix(rot(120), 20, true)!;
		expect(r.ppem).toBe(17);
		expect(r.matrix[1]).toBe(1);
		expect(r.matrix[2]).toBe(-1);
		expect(r.matrix[0]).toBeLessThan(0);
		expect(r.matrix[3]).toBeLessThan(0);
		expect(r.matrix[0]).toBe(r.matrix[3]);
	});
	it('is not for a matrix that is not a rotation', () => {
		expect(rotationMatrix([1, 0.3, 0.3, 1], 20, true)).toBeNull();
	});
});

describe('against the native outlines', () => {
	const f32 = Math.fround;
	function predict(mode: string): { rows: number; fullRows: number; points: number; hits: number; targets: number; targetHits: number } {
		const out = { rows: 0, fullRows: 0, points: 0, hits: 0, targets: 0, targetHits: 0 };
		for (const r of rows) {
			if (r.variant !== 'axisint' || r.mode !== mode || r.degrees % 90 === 0) continue;
			const rad = (r.degrees * Math.PI) / 180;
			// a world rotation turns the text the other way round from an escapement of the same angle
			const sign = mode === 'world' ? 1 : -1;
			const rm = rotationMatrix([f32(Math.cos(rad)), f32(sign * Math.sin(rad)), f32(-sign * Math.sin(rad)), f32(Math.cos(rad))], r.ppem, true)!;
			let full = true;
			r.points.forEach((p, k) => {
				const j = k < r.points.length - 1 ? k * r.step : 238;
				const u = j === 0 ? 0 : 1700 + j - 1;
				const scaled = Math.round((u * rm.ppem * 64) / 2048);
				const x = Math.round(rm.matrix[0] * scaled);
				const y = Math.round(-rm.matrix[1] * scaled);
				out.points++;
				if (x === p[0] && y === p[1]) out.hits++;
				else full = false;
			});
			out.rows++;
			if (full) out.fullRows++;
			const last = r.points[r.points.length - 1];
			const nativeTarget = Math.round(Math.max(Math.abs(last[0]), Math.abs(last[1])) / ((1938 * 64) / 2048));
			out.targets++;
			if (nativeTarget === rm.ppem) out.targetHits++;
		}
		return out;
	}
	it('predicts the whole-pixel ppem and 96% of the far points under a world rotation', () => {
		const w = predict('world');
		expect(w.rows).toBe(1292);
		// 24 of the 1292 sizes sit where the native major component is a hair below the half pixel (32 px at 40 degrees:
		// 24.513 -> native 24; the half-up model gives 25) - the same fault the earlier plain rounding had at 52
		expect(w.targetHits).toBeGreaterThanOrEqual(1268);
		expect(w.hits).toBeGreaterThanOrEqual(38436);
		expect(w.fullRows).toBeGreaterThanOrEqual(484);
	});
	it('predicts 84% of the far points under an escapement (its sine and cosine are less precise: 3e-4)', () => {
		const e = predict('escapement');
		expect(e.targetHits).toBeGreaterThanOrEqual(1252);
		expect(e.hits).toBeGreaterThanOrEqual(33620);
	});
	it('is the exact rotation at the font size when head.flags bit 3 is clear (to 3e-5, the 16.16 matrix)', () => {
		let checked = 0;
		for (const r of rows) {
			if (r.variant !== 'plain' || r.mode !== 'world' || r.degrees % 90 === 0) continue;
			const rad = (r.degrees * Math.PI) / 180;
			const rm = rotationMatrix([f32(Math.cos(rad)), f32(Math.sin(rad)), f32(-Math.sin(rad)), f32(Math.cos(rad))], r.ppem, false)!;
			// point 1 is (30000, 0) font units = 30000 * ppem / 64 pixels = 30000 * ppem 1/64 pixels
			const length = 30000 * r.ppem;
			expect(Math.abs(r.points[1][0] - rm.matrix[0] * length)).toBeLessThan(length * 3e-5);
			expect(Math.abs(r.points[1][1] + rm.matrix[1] * length)).toBeLessThan(length * 3e-5);
			checked++;
		}
		expect(checked).toBe(2 * (72 - 4));
	});
});
