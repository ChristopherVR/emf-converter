/**
 * Native `WidenPath` of bevel- and miter-joined geometric pens under rotated, sheared and mixed world transforms
 * (`general-matrix-pen-probe`, `general-matrix-pen-joins.json.gz`, 288 outlines: the eight matrices of `general-matrix-pen.json.gz`,
 * widths 4, 8 and 12, a bevel join and miter joins at limits 10 and 1.5, flat caps; open corners of 30, 90 and 150 degrees and a
 * closed triangle).
 *
 * Round 4 and earlier widened every non-round join in logical space and mapped the outline forward (the device-space rounding rules
 * of the nib did not apply): 42 of 288 outlines exact, 14,351 differing pixels. The device-space widening with the matrix's nib
 * (`deviceNib`) that round joins already used takes the joins too: 221 of 288 exact, 2,055 differing pixels. A pure shear (matrix 4) is
 * exact on all 36, the other shears on 33 and 33 of 36; the rest is the rotated nib's construction (docs/outstanding-work.md) and the
 * miter limit of the uniform scale 1.5 (matrices 2 and 7 at limit 1.5).
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { GdiRasterPath, fillPolygonSpans, type SpanList } from './gdi-raster';
import { widenPath } from './gdi-raster-widen';

interface Case {
	m: number;
	w: number;
	join: number;
	limit: number;
	shape: number;
	points: number[];
}
const cases: Case[] = JSON.parse(gunzipSync(readFileSync(fixturePath('general-matrix-pen-joins.json.gz'))).toString());
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
	[[10, 10], [70, 10], [30, 40]],
	[[10, 10], [60, 10], [60, 60]],
	[[10, 10], [40, 40], [70, 25]],
	[[10, 10], [60, 20], [20, 50]],
];
/** Exact outlines and differing pixels per matrix, summed over its 36 outlines. */
const EXPECTED: Record<number, { exact: number; pixels: number }> = {
	0: { exact: 26, pixels: 251 },
	1: { exact: 26, pixels: 510 },
	2: { exact: 24, pixels: 381 },
	3: { exact: 33, pixels: 35 },
	4: { exact: 36, pixels: 0 },
	5: { exact: 21, pixels: 427 },
	6: { exact: 33, pixels: 113 },
	7: { exact: 22, pixels: 338 },
};

function pixels(spans: SpanList): Set<number> {
	const set = new Set<number>();
	for (let k = 0; k < spans.length * 3; k += 3) for (let x = spans.data[k + 1]; x < spans.data[k + 2]; x++) set.add(spans.data[k] * 4096 + x);
	return set;
}
function nativePolygons(points: number[]): number[][] {
	const out: number[][] = [];
	for (let i = 0; i < points.length; i += 3) {
		if (points[i + 2] === 6) out.push([]);
		out[out.length - 1].push(points[i], points[i + 1]);
	}
	return out;
}

it('widens bevel and miter joins under a general matrix in device space: 221 of 288 native outlines exact, 2,055 differing pixels', () => {
	expect(cases).toHaveLength(288);
	const got: Record<number, { exact: number; pixels: number }> = {};
	for (const c of cases) {
		const m = MATRICES[c.m];
		const path = new GdiRasterPath();
		SOURCES[c.shape].forEach(([x, y], i) => {
			const dx = Math.round((m[0] * x + m[2] * y) * 16);
			const dy = Math.round((m[1] * x + m[3] * y) * 16);
			if (i === 0) path.moveTo(dx, dy);
			else path.lineTo(dx, dy);
		});
		if (c.shape === 3) path.closeFigure();
		const ours = widenPath(path, { width: c.w * 16, matrix: m, deviceNib: true, cap: 'flat', join: c.join === 1 ? 'bevel' : 'miter', miterLimit: c.limit, dashes: null });
		const a = pixels(fillPolygonSpans(ours, true));
		const b = pixels(fillPolygonSpans(nativePolygons(c.points), true));
		let d = 0;
		for (const v of a) if (!b.has(v)) d++;
		for (const v of b) if (!a.has(v)) d++;
		const e = (got[c.m] ??= { exact: 0, pixels: 0 });
		if (d === 0) e.exact++;
		e.pixels += d;
	}
	expect(got).toEqual(EXPECTED);
});
