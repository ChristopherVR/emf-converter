/**
 * Native `WidenPath` of solid and dashed geometric pens under rotated or sheared world transforms
 * (`general-matrix-pen-probe`, 576 outlines: eight matrices, widths 4 and 8, every cap, solid, dashed and user styles, four
 * line shapes). Native's pen is a circle in logical space, and a dashed pattern is laid out in logical length. The pen
 * polygon (`penPolygonMatrix`) is GDI's logical circle mapped through the matrix, rounded and flattened (`nib-matrix-pen`
 * captures the native nibs). Pure shears and shear-with-scale (matrices 3, 4 and 6) are exact on all 72 outlines each; the
 * matrices with a rotation keep a few pixels of residual, pinned below (the half-pixel rounding of a diagonal's perpendicular).
 *
 * Round 4: a rotation with a uniform scale maps the logical circle to a device circle, and a device circle narrower than 6.5 pixels
 * is one of the digital (Hobby) pens, not a rotated polygon. The 12 nibs of widths 1 to 6 under the 30 and 45 degree matrices
 * (`nib-matrix-pen.json.gz`) are exactly those pens; before, none of the 12 was. The rotated outlines fell from 1,087 and 424 differing
 * pixels (matrices 0 and 1) to 650 and 313; matrix 5 (a rotation with an unequal scale) is not a circle and is unchanged.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { GdiRasterPath, fillPolygonSpans, geometricStyle, type SpanList } from './gdi-raster';
import { penPolygonMatrix, widenPath } from './gdi-raster-widen';

interface NativeCase {
	m: number;
	w: number;
	cap: number;
	style: number;
	shape: number;
	points: number[];
}
const cases: NativeCase[] = JSON.parse(gunzipSync(readFileSync(fixturePath('general-matrix-pen.json.gz'))).toString());
type Matrix = [number, number, number, number];
const MATRICES: Matrix[] = [
	[0.8660254, 0.5, -0.5, 0.8660254],
	[0.7071068, 0.7071068, -0.7071068, 0.7071068],
	[1.5, 0, 0, 1.5],
	[1, 0, 0.5, 1],
	[1, 0.5, 0, 1],
	[1.7320508, 1, -0.5, 0.8660254],
	[2, 0, 1, 1],
	[1.5, -1.5, 1, 1],
];
const SOURCES = [
	[[10, 10], [70, 10]],
	[[10, 10], [10, 70]],
	[[10, 10], [60, 40]],
	[[10, 10], [40, 55], [70, 20]],
];
/** Pixel-difference bound per matrix (the sum over its 72 outlines), as measured; the exact ones are 0. */
const MATRIX_BOUND: Record<number, number> = { 0: 650, 1: 313, 3: 0, 4: 0, 5: 600, 6: 0, 7: 416 };

function pixels(spans: SpanList): Set<number> {
	const set = new Set<number>();
	for (let k = 0; k < spans.length * 3; k += 3) {
		for (let x = spans.data[k + 1]; x < spans.data[k + 2]; x++) set.add(spans.data[k] * 4096 + x);
	}
	return set;
}
function nativePolygons(c: NativeCase): number[][] {
	const polygons: number[][] = [];
	for (let i = 0; i < c.points.length; i += 3) {
		if (c.points[i + 2] === 6) polygons.push([]);
		polygons[polygons.length - 1].push(c.points[i], c.points[i + 1]);
	}
	return polygons;
}
function oursPolygons(c: NativeCase): number[][] {
	const m = MATRICES[c.m];
	const path = new GdiRasterPath();
	SOURCES[c.shape].forEach(([x, y], i) => {
		const dx = Math.round((m[0] * x + m[2] * y) * 16);
		const dy = Math.round((m[1] * x + m[3] * y) * 16);
		if (i === 0) path.moveTo(dx, dy);
		else path.lineTo(dx, dy);
	});
	const dashes = geometricStyle(0x10000 | c.style, c.w, [6, 3, 2, 3], 1);
	return widenPath(path, {
		width: c.w * 16,
		matrix: m,
		deviceNib: true,
		cap: (['round', 'square', 'flat'] as const)[c.cap],
		join: 'round',
		miterLimit: 10,
		dashes: dashes ? dashes.map((v) => v * 16) : null,
		shortenDashes: c.style !== 7,
	});
}

it('matches native sheared pens exactly and rotated pens within the measured bounds', () => {
	expect(cases).toHaveLength(576);
	const total: Record<number, number> = {};
	for (const c of cases) {
		if (c.m === 2) continue;
		const native = pixels(fillPolygonSpans(nativePolygons(c), true));
		expect(native.size).toBeGreaterThan(0);
		const ours = pixels(fillPolygonSpans(oursPolygons(c), true));
		let diff = 0;
		for (const v of ours) if (!native.has(v)) diff++;
		for (const v of native) if (!ours.has(v)) diff++;
		if (MATRIX_BOUND[c.m] === 0) {
			expect(diff, JSON.stringify({ ...c, points: undefined })).toBe(0);
		}
		total[c.m] = (total[c.m] ?? 0) + diff;
	}
	for (const [m, bound] of Object.entries(MATRIX_BOUND)) {
		expect(total[Number(m)], `matrix ${m} totals ${JSON.stringify(total)}`).toBeLessThanOrEqual(bound);
	}
});

it('uses the digital pens for the nibs of narrow pens under a rotation with a uniform scale (12 of 12 native nibs; none before)', () => {
	const nibs: Array<{ w: number; m: number; shape: number; points: number[] }> = JSON.parse(gunzipSync(readFileSync(fixturePath('nib-matrix-pen.json.gz'))).toString());
	let exact = 0;
	let total = 0;
	for (const c of nibs) {
		if (c.shape !== 0 || c.m > 1 || c.w > 6) continue;
		total++;
		const m = MATRICES[c.m];
		const pts: number[][] = [];
		for (let i = 0; i < c.points.length; i += 3) pts.push([c.points[i], c.points[i + 1]]);
		// The pen's centre is where the zero-length path maps; the outline repeats the vertices where the two caps meet.
		const cx = Math.round((m[0] * 20 + m[2] * 20) * 16);
		const cy = Math.round((m[1] * 20 + m[3] * 20) * 16);
		const native = new Set(pts.map((p) => `${p[0] - cx},${p[1] - cy}`));
		const ours = new Set(penPolygonMatrix(c.w * 16, m).map((p) => `${p[0]},${p[1]}`));
		if (native.size === ours.size && [...native].every((v) => ours.has(v))) exact++;
	}
	expect({ exact, total }).toEqual({ exact: 12, total: 12 });
});
