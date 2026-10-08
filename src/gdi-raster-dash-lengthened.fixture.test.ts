/**
 * Native `WidenPath` of 76 of the dashed Beziers of `dash-cut-ties.json.gz` (the 36 that differ, plus every 50th) behind a straight
 * run of 1, 64 and 512 whole periods of the dash pattern (`dash-lengthened-probe`; 622,592 FIX of walk before the curve at 512).
 * The run ends at the curve's start, so every cut on the curve falls on the same fractions and only the distance the walk has
 * already travelled changes.
 *
 * Result: the dash polygons of the curve are the same polygons at 1, 64 and 512 periods for all 76 curves. An accumulated
 * single-precision walk distance would move a cut by up to half a single-precision step of the distance (0.016 FIX at 512
 * periods, against tie gaps under 6e-4), so the 36 dash-cut ties are not an accumulation effect: the walk restarts its distance at
 * every segment and the decision is in the rounding of the sum `x0 + d * t / len` itself.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { GdiRasterPath, fillPolygonSpans, geometricStyle, type SpanList } from './gdi-raster';
import { widenPath } from './gdi-raster-widen';

interface Case {
	case: number;
	k: number;
	period: number;
	points: number[];
	cap: number;
	width: number;
	dashes: number[];
	expected: number[];
}
const cases: Case[] = JSON.parse(gunzipSync(readFileSync(fixturePath('dash-lengthened.json.gz'))).toString());

function pixels(spans: SpanList): Set<number> {
	const set = new Set<number>();
	for (let k = 0; k < spans.length * 3; k += 3) for (let x = spans.data[k + 1]; x < spans.data[k + 2]; x++) set.add(spans.data[k] * 4096 + x);
	return set;
}
function polygons(points: number[]): number[][] {
	const out: number[][] = [];
	for (let i = 0; i < points.length; i += 3) {
		if (points[i + 2] === 6) out.push([]);
		out[out.length - 1].push(points[i], points[i + 1]);
	}
	return out;
}
function differing(ours: number[][], native: number[][]): number {
	const a = pixels(fillPolygonSpans(ours, true));
	const b = pixels(fillPolygonSpans(native, true));
	let d = 0;
	for (const v of a) if (!b.has(v)) d++;
	for (const v of b) if (!a.has(v)) d++;
	return d;
}

it('cuts the curve at the same points however far the walk has already gone (76 curves at 1, 64 and 512 periods)', () => {
	expect(cases).toHaveLength(76 * 3);
	const byCase = new Map<number, Map<number, Case>>();
	for (const c of cases) {
		if (!byCase.has(c.case)) byCase.set(c.case, new Map());
		byCase.get(c.case)!.set(c.k, c);
	}
	expect(byCase.size).toBe(76);
	for (const [index, ks] of byCase) {
		const one = polygons(ks.get(1)!.expected);
		const tail = one.length - 3 - ks.get(1)!.dashes.length / 2;
		for (const k of [64, 512]) {
			const other = polygons(ks.get(k)!.expected);
			expect(other.slice(other.length - tail).map(String), `case ${index} at ${k} periods`).toEqual(one.slice(one.length - tail).map(String));
		}
	}
});

it('differs from the converter in 36, 34 and 32 of the 76 curves at 1, 64 and 512 periods, the walk being per segment', () => {
	const bad: Record<number, number> = { 1: 0, 64: 0, 512: 0 };
	for (const c of cases) {
		const p = c.points;
		const path = new GdiRasterPath();
		path.moveTo((p[0] - c.k * c.period) * 16, p[1] * 16);
		path.lineTo(p[0] * 16, p[1] * 16);
		path.bezierTo(p[2] * 16, p[3] * 16, p[4] * 16, p[5] * 16, p[6] * 16, p[7] * 16);
		const style = geometricStyle(0x10000 | 7, c.width, c.dashes);
		const ours = widenPath(path, {
			width: c.width * 16,
			cap: (['round', 'square', 'flat'] as const)[c.cap],
			join: 'round',
			miterLimit: 10,
			dashes: style ? style.map((v) => v * 16) : null,
			shortenDashes: false,
			wholePixelDashVectors: true,
		});
		if (differing(ours, polygons(c.expected)) > 0) bad[c.k]++;
	}
	expect(bad).toEqual({ 1: 36, 64: 34, 512: 32 });
});
