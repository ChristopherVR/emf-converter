/**
 * Native `WidenPath` of a flat-capped solid pen under rotated and sheared world transforms (`rotated-pen-vector-probe`,
 * 6,432 single segments: six matrices, widths 4 to 24, 120 random and 14 special logical directions each). Each cap corner is
 * the pen's perpendicular on the half-pixel grid. All 6,432 outlines match native exactly (5,310 of them before round 6, 5,608 with
 * the corrected nib alone): the rounding of the interpolated tangent point is the identity pen's, applied to the right nib
 * (`penPolygonMatrix`: the ellipse of the half-width images, see `gdi-rotated-pen-nibs.fixture.test.ts`), with its half-unit
 * bias taken from the sign of the interpolated coordinate and the odd-edge half unit from the half of the nib the support
 * vertex lies in.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { GdiRasterPath } from './gdi-raster';
import { widenPath } from './gdi-raster-widen';

interface NativeCase {
	m: number;
	w: number;
	dx: number;
	dy: number;
	points: number[];
}
const cases: NativeCase[] = JSON.parse(gunzipSync(readFileSync(fixturePath('rotated-pen-vectors.json.gz'))).toString());
const MATRICES = (
	[
		[0.8660254, 0.5, -0.5, 0.8660254],
		[0.7071068, 0.7071068, -0.7071068, 0.7071068],
		[1.7320508, 1, -0.5, 0.8660254],
		[1.5, -1.5, 1, 1],
		[1.5, 0.75, -0.75, 1.5],
		[2, 1, -1, 1],
	] as const
).map((row) => row.map(Math.fround) as [number, number, number, number]);

function ours(c: NativeCase): number[] {
	const m = MATRICES[c.m];
	const device = (x: number, y: number): [number, number] => [Math.round((m[0] * x + m[2] * y) * 16), Math.round((m[1] * x + m[3] * y) * 16)];
	const path = new GdiRasterPath();
	const a = device(60, 60);
	const b = device(60 + c.dx, 60 + c.dy);
	path.moveTo(a[0], a[1]);
	path.lineTo(b[0], b[1]);
	return widenPath(path, { width: c.w * 16, matrix: m, deviceNib: true, cap: 'flat', join: 'round', miterLimit: 10 })[0] ?? [];
}

it('matches all 6,432 native rotated-pen cap corners (5,310 before round 6)', () => {
	expect(cases).toHaveLength(6432);
	let exact = 0;
	for (const c of cases) {
		const native: number[] = [];
		for (let i = 0; i < c.points.length; i += 3) native.push(c.points[i], c.points[i + 1]);
		const got = ours(c);
		expect(got.length, JSON.stringify({ ...c, points: undefined })).toBe(native.length);
		if (got.every((v, i) => v === native[i])) {
			exact++;
			continue;
		}
		// Only the cap corners (the first four values) carry the half-pixel rounding; the far end repeats it.
		for (let i = 0; i < got.length; i++) {
			expect(Math.abs(got[i] - native[i]), JSON.stringify({ ...c, points: undefined })).toBeLessThanOrEqual(16);
		}
	}
	expect(exact).toBe(6432);
});
