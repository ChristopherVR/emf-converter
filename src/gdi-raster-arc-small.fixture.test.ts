/**
 * Native `GetPath` of 624 arcs 0.01 to 3 degrees wide on circles of 100,000 to 400,000 FIX radius (`arc-small-probe`, `arc-small.json.gz`:
 * thirteen sweeps, four radii, twelve arcs each, Arc, Chord and Pie in turn, both directions; round 5). Round 4 named this data as what
 * would separate float32 products from true fixed-point arithmetic at the control points of small pieces.
 *
 * What the captures show: the controls of such an arc are not on the chord. A 0.01 degree arc on a radius of 100,000 FIX has its
 * controls up to a dozen FIX off it, and an arc that starts on an axis has its first control exactly on the start point and its second a
 * third of the way (the cosine of 0.01 degrees rounds to 1.0 in single precision, so the numerator `p0.x - p3.x` of the tangent-line
 * intersection is exactly zero). That is the cancellation of single precision in `X = ((p3.y - p0.y), (p0.x - p3.x)) / det`: the
 * converter now solves the tangent lines of an arc of 3 degrees or less in single precision where the error it leaves is half a FIX or
 * more (`unitPiece`), which leaves the 900, 898 captured arcs, the 600 AngleArcs and the 1,500 WMF scaled paths as they were and takes
 * these 624 from 162 to 207 exact (and the 260 large-circle arcs from 187 to 191).
 *
 * 51 of the 52 arcs that start on the 0 degree axis are exact (the other is below the half-FIX threshold), the case where the rounded cosine makes the structure visible. Not reproduced (the open part): 417 arcs, none more than 146 FIX off and almost all within 2 FIX from 0.5 degrees up. Tried against
 * the captures without gain: single precision angles (`cos(fround(a))`), the end point as the start rotated by a single precision
 * sweep (190), polygon cosines and sines (8), the determinant as `sin(sweep)` (182 to 108), double-precision products rounded once (196),
 * fused multiply-adds in the determinant or the controls (no change), the controls from the normalised radial vectors (36 of 207
 * single-piece arcs against 94), a better conditioned line equation instead of Cramer's rule (91), and the tangent form
 * `X = p0 + tan(h) t0` (69). Of the single-piece arcs of 0.3 degrees or less, perturbing the four single-precision inputs by up to two
 * units of the last place finds no combination that reproduces the native controls for 23 of 96, so the missing step is not in the
 * rounding of the inputs.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { arcRasterPath } from './emf-gdi-raster-shapes';
import { axisBox } from './gdi-raster';

interface Arc {
	kind: number;
	clockwise: boolean;
	radius: number;
	sweep: number;
	box: number[];
	radials: number[];
	expected: number[];
}
const arcs: Arc[] = JSON.parse(gunzipSync(readFileSync(fixturePath('arc-small.json.gz'))).toString());

function dedupe(points: number[]): number[] {
	const out: number[] = [];
	for (let i = 0; i < points.length; i += 2) {
		if (!(out.length && out[out.length - 2] === points[i] && out[out.length - 1] === points[i + 1])) out.push(points[i], points[i + 1]);
	}
	return out;
}

function worst(c: Arc): number {
	const [l, t, r, b] = c.box.map((v) => v * 16);
	const box = axisBox(l, t, r - 16, b - 16);
	const onBox = (x: number, r0: number, r1: number, b0: number, b1: number) =>
		(b0 + b1) / 2 + (r1 !== r0 ? ((x - (r0 + r1) / 2) * (b1 - b0)) / (r1 - r0) : x - (r0 + r1) / 2);
	const radial = (x: number, y: number): [number, number] => [onBox(x * 16, l, r, l, r - 16), onBox(y * 16, t, b, t, b - 16)];
	const kind = (['arc', 'chord', 'pie'] as const)[c.kind];
	const mine = dedupe(arcRasterPath(box, radial(c.radials[0], c.radials[1]), radial(c.radials[2], c.radials[3]), c.clockwise, kind).path.getPath.pts);
	const native: number[] = [];
	for (let i = 0; i < c.expected.length; i += 3) native.push(c.expected[i], c.expected[i + 1]);
	const expected = dedupe(native);
	if (mine.length !== expected.length) return 99;
	let w = 0;
	for (let i = 0; i < expected.length; i++) w = Math.max(w, Math.abs(expected[i] - mine[i]));
	return w;
}

it('reproduces 207 of the 624 small arcs exactly (162 with double-precision tangent lines), 51 of the 52 that start on an axis among them', () => {
	expect(arcs).toHaveLength(624);
	let exact = 0;
	let aligned = 0;
	let alignedExact = 0;
	for (const c of arcs) {
		const w = worst(c);
		if (w === 0) exact++;
		// An arc that starts on the 0 degree axis (the first of each twelve).
		if (c.radials[1] === c.box[3] / 2 && c.radials[0] > c.box[2]) {
			aligned++;
			if (w === 0) alignedExact++;
		}
	}
	expect(exact).toBe(207);
	expect({ aligned, alignedExact }).toEqual({ aligned: 52, alignedExact: 51 });
});
