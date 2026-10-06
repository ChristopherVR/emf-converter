/**
 * Native `WidenPath` of solid and dashed geometric pens under rotated or sheared world transforms
 * (`general-matrix-pen-probe`, 576 outlines: eight matrices, widths 4 and 8, every cap, solid, dashed and user styles, four
 * line shapes). Native's pen is a circle in logical space, and a dashed pattern is laid out in logical length.
 *
 * `widenPath` with a `matrix` widens in logical space and maps the outline forward. It is not exact (the device-space
 * rounding rules, such as the half-pixel rule of 8 px pens, are not reproduced) but, for the five matrices that are not a
 * rotation with a uniform scale, it differs from native by about 22 pixels an outline where a uniform device-space pen
 * (the previous model) differed by about 266. The bounds below pin that.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { GdiRasterPath, fillPolygonSpans, geometricStyle, type SpanList } from './gdi-raster';
import { widenPath } from './gdi-raster-widen';

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
/** Pixel-difference bound per matrix (the sum over its 72 outlines), as measured. */
const MATRIX_BOUND: Record<number, number> = { 3: 559, 4: 336, 5: 3195, 6: 1382, 7: 2647 };

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
		const dx = (m[0] * x + m[2] * y) * 16;
		const dy = (m[1] * x + m[3] * y) * 16;
		if (i === 0) path.moveTo(dx, dy);
		else path.lineTo(dx, dy);
	});
	const dashes = geometricStyle(0x10000 | c.style, c.w, [6, 3, 2, 3], 1);
	return widenPath(path, {
		width: c.w * 16,
		matrix: m,
		cap: (['round', 'square', 'flat'] as const)[c.cap],
		join: 'round',
		miterLimit: 10,
		dashes: dashes ? dashes.map((v) => v * 16) : null,
		shortenDashes: c.style !== 7,
	});
}

it('approximates native rotated/sheared pens within the measured bounds', () => {
	expect(cases).toHaveLength(576);
	const total: Record<number, number> = {};
	for (const c of cases) {
		if (c.m < 3) continue;
		const native = pixels(fillPolygonSpans(nativePolygons(c), true));
		expect(native.size).toBeGreaterThan(0);
		const ours = pixels(fillPolygonSpans(oursPolygons(c), true));
		let diff = 0;
		for (const v of ours) if (!native.has(v)) diff++;
		for (const v of native) if (!ours.has(v)) diff++;
		// Even the worst outline stays within a fifth of its pixels.
		expect(diff, JSON.stringify({ ...c, points: undefined })).toBeLessThanOrEqual(native.size * 0.22);
		total[c.m] = (total[c.m] ?? 0) + diff;
	}
	for (const [m, bound] of Object.entries(MATRIX_BOUND)) {
		expect(total[Number(m)], `matrix ${m} totals ${JSON.stringify(total)}`).toBeLessThanOrEqual(bound);
	}
});
