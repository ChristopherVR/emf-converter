/**
 * Native `WidenPath` of Beziers whose end tangent runs exactly opposite to their last flattened segment
 * (`curve-end-reversal-probe`: 240 curves, vertical and horizontal, 60 of each direction; identity and 2 by 1 anisotropic maps; square,
 * flat and round caps) and of two-segment polylines with a few-FIX second segment under the 1/16 anisotropic maps
 * (`tiny-final-segment-probe`: 588 captures).
 *
 * A Bezier whose second control point lies beyond its end point (`P2 - P3` along the curve's direction of travel) overshoots and returns.
 * The flattened polyline stops short of the overshoot, so its last segment still runs forward while the end tangent points back.
 * Native draws that last segment with the tangent's direction: the join at the last vertex is a reversal (a round wedge on the leading
 * side), and the cap follows the tangent. The turn at a join is therefore measured along the end tangent whenever the tangent opposes the
 * chord (`Seg.tx`, `Seg.ty`). Before, the join saw two parallel chords, drew nothing, and the sides of the last segment crossed (48 to 54
 * of the 240 curves differed under every cap and map, by up to 77 pixels, one in five of them; none differed when the previous segment
 * turned instead of continuing straight, which is why the 1,436 arcs and the 80 Beziers of the earlier captures never showed it). The two
 * arcs of `scaled-cap-sweep.json.gz` under the 2 by 1 map (31 and 32 pixels) are this case too: a final segment of one FIX that
 * "native closes with a round cap".
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { GdiRasterPath, fillPolygonSpans, type SpanList } from './gdi-raster';
import { widenPath, type WidenOptions } from './gdi-raster-widen';

const load = (name: string): any[] => JSON.parse(gunzipSync(readFileSync(fixturePath(name))).toString());

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
function differing(ours: number[][], native: number[][]): number {
	const a = pixels(fillPolygonSpans(ours, true));
	const b = pixels(fillPolygonSpans(native, true));
	let d = 0;
	for (const v of a) if (!b.has(v)) d++;
	for (const v of b) if (!a.has(v)) d++;
	return d;
}
function bezierPath(source: number[]): GdiRasterPath {
	const pts: number[] = [];
	for (let i = 0; i < source.length; i += 3) pts.push(source[i], source[i + 1]);
	const path = new GdiRasterPath();
	path.addBeziers(pts, true);
	return path;
}
const CAPS = ['round', 'square', 'flat'] as const;

it('widens a Bezier whose end tangent opposes its last segment as native does: 1,440 of 1,440 fill identically (304 differed)', () => {
	const cases = load('curve-end-reversal.json.gz');
	expect(cases).toHaveLength(1440);
	const bad: Record<string, number> = {};
	for (const c of cases) {
		const options: WidenOptions =
			c.map === 'id'
				? { width: 12 * 16, cap: CAPS[c.cap], join: 'round', miterLimit: 10, wholePixelDashVectors: true }
				: { width: 6 * 16, height: 12 * 16, cap: CAPS[c.cap], join: 'round', miterLimit: 10, cutToLogicalUnits: true, logicalScale: [0.5, 1] };
		if (differing(widenPath(bezierPath(c.source), options), nativePolygons(c.expected)) > 0) {
			const key = `${c.map}/${CAPS[c.cap]}`;
			bad[key] = (bad[key] ?? 0) + 1;
		}
	}
	expect(bad).toEqual({});
});

it('draws a few-FIX final segment along the thin axis of an elliptical nib as native does (588 captures; 24 flat-capped reversals differ in one pixel)', () => {
	const cases = load('tiny-final-segment-lines.json.gz');
	expect(cases).toHaveLength(588);
	let bad = 0;
	let largest = 0;
	for (const c of cases) {
		const path = new GdiRasterPath();
		for (let i = 0; i < c.source.length; i += 3) {
			if (i === 0) path.moveTo(c.source[0], c.source[1]);
			else path.lineTo(c.source[i], c.source[i + 1]);
		}
		const x = c.map === 'x16';
		const options: WidenOptions = {
			width: x ? 48 : 768,
			height: x ? 768 : 48,
			cap: CAPS[c.cap],
			join: 'round',
			miterLimit: 10,
			cutToLogicalUnits: true,
			logicalScale: x ? [1 / 16, 1] : [1, 1 / 16],
		};
		const d = differing(widenPath(path, options), nativePolygons(c.expected));
		if (d > 0) bad++;
		largest = Math.max(largest, d);
	}
	expect(bad).toBe(24);
	expect(largest).toBeLessThanOrEqual(1);
});

it('fills both anisotropic arcs that ended in a one-FIX segment identically (31 and 32 pixels before)', () => {
	const arcs = load('scaled-cap-sweep.json.gz').filter((c) => c.scale === 'aniso2');
	expect(arcs).toHaveLength(358);
	let bad = 0;
	for (const c of arcs) {
		const options: WidenOptions = { width: 6 * 16, height: 12 * 16, cap: 'square', join: 'round', miterLimit: 10, cutToLogicalUnits: true, logicalScale: [0.5, 1] };
		if (differing(widenPath(bezierPath(c.source), options), nativePolygons(c.expected)) > 0) bad++;
	}
	expect(bad).toBe(0);
});
