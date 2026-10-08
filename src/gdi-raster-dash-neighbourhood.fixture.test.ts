/**
 * Native `WidenPath` around the three one-pixel residuals of `curve-widen.json` and `curve-dash.json`
 * (`dash-neighbourhood-probe`, `chord-closing-probe`).
 *
 * - Sample 128 (a flat-capped dotted arc, 5 px wide, one inner wedge missing at a sharp turn): 3 stock dash styles x widths 2 to 9 x 49
 *   end radials, plus solid pens. Every width-5 arc differed in one pixel (147 of 147), no other width did, and solid pens never did: a
 *   flat cap loops round the pen between the two inner sides of a flattened curve when that wedge holds two pen vertices or more and the
 *   join is not the boundary of two cubics. A wedge of one vertex is absent (a width-8 arc broke when it was added), and the boundary
 *   of two cubics already takes the true tangent (curve-widen sample 193 broke). All 2,484 captures now fill identically except the
 *   24 Bezier ones below.
 * - Sample 117 (a square-capped Bezier, user style 21 12 9 23, 13 px wide): the second control point moved by two pixels each way and
 *   the first dash 15 to 40 px long, 1,300 captures, 24 of which differ in one to three pixels. The vertices that differ are the end
 *   corners of a dash scaled by its real over its whole-pixel length, where the extension is an exact half (187 * 104 / 176 = 110.5,
 *   native 110; 4 * 112 / 128 = 3.5, native 4; 115 * 56 / 112 = 57.5, native 58): rounding those ties toward zero, away from zero, up
 *   or down, and nineteen orders of evaluating the product in double and float32, each fix 117 (or part of its family) and break
 *   at least one of the 18 samples among the 300 whose scaled extensions include an exact tie, so the rule is not a rounding mode
 *   or an evaluation order that was tried.
 * - Sample 206 (a chord of 356.6 degrees, bevel join, one pixel): the native `GetPath` of that chord widens exactly (5,820 of 5,841
 *   captures fill identically, the 21 others have a closing line under 8 FIX), so the pixel is in our arc geometry: the start point of
 *   the arc sits at y = 3627.49993 FIX, a rounding tie the converter resolved down and native up. Round 4 resolved it: the arc points are single precision (float32 nodes,
 *   float32 radius times unit coordinate; see `polygonTrig` and `arcBeziers`), 168 of the 169 neighbouring paths now equal native and the
 *   whole-path counts of the 900 arcs did not drop (an all-float32 evaluation had cost two of them and 5 to 13 large-circle points).
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GdiRasterPath, axisBox, fillPolygonSpans, geometricStyle, type SpanList } from './gdi-raster';
import { arcRasterPath } from './emf-gdi-raster-shapes';
import { widenPath } from './gdi-raster-widen';

const load = (name: string): any[] => JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${name}`, import.meta.url))).toString());
const dashes = load('curve-dash-neighbourhood.json.gz');
const closing = load('chord-closing.json.gz');

function polygons(points: number[]): number[][] {
	const out: number[][] = [];
	for (let i = 0; i < points.length; i += 3) {
		if (points[i + 2] === 6) out.push([]);
		out[out.length - 1].push(points[i], points[i + 1]);
	}
	return out;
}

function pixels(spans: SpanList): Set<number> {
	const set = new Set<number>();
	for (let k = 0; k < spans.length * 3; k += 3) for (let x = spans.data[k + 1]; x < spans.data[k + 2]; x++) set.add(spans.data[k] * 4096 + x);
	return set;
}

function differing(ours: number[][], native: number[][]): number {
	const a = pixels(fillPolygonSpans(ours, true));
	const b = pixels(fillPolygonSpans(native, true));
	let d = 0;
	for (const v of a) if (!b.has(v)) d++;
	for (const v of b) if (!a.has(v)) d++;
	return d;
}

function dashPath(c: any): GdiRasterPath {
	const path = new GdiRasterPath();
	if (c.kind === 'arc') {
		const [l, t, r, b] = (c.box as number[]).map((v) => v * 16);
		const onBox = (x: number, r0: number, r1: number, b0: number, b1: number) => (b0 + b1) / 2 + (r1 !== r0 ? ((x - (r0 + r1) / 2) * (b1 - b0)) / (r1 - r0) : x - (r0 + r1) / 2);
		const radial = (x: number, y: number): [number, number] => [onBox(x * 16, l, r, l, r - 16), onBox(y * 16, t, b, t, b - 16)];
		const rd = c.radials as number[];
		arcRasterPath(axisBox(l, t, r - 16, b - 16), radial(rd[0], rd[1]), radial(rd[2], rd[3]), false, 'arc', undefined, path);
	} else {
		path.addBeziers((c.points as number[]).map((v) => v * 16), true);
	}
	return path;
}

describe('dashed pens around curve-dash.json samples 117 and 128', () => {
	const results = dashes.map((c) => {
		const style = geometricStyle(0x10000 | c.style, c.width, c.dashes as number[]);
		const ours = widenPath(dashPath(c), {
			width: c.width * 16,
			cap: (['round', 'square', 'flat'] as const)[c.cap],
			join: 'round',
			miterLimit: 10,
			dashes: style ? style.map((v) => v * 16) : null,
			shortenDashes: c.style !== 7,
			wholePixelDashVectors: true,
		});
		return { c, d: differing(ours, polygons(c.expected)) };
	});

	it('captures 2,484 dashed or solid outlines: 1,300 Beziers and 1,184 arcs', () => {
		expect(dashes).toHaveLength(2484);
		expect(dashes.filter((c) => c.kind === 'arc')).toHaveLength(1184);
	});

	it('fills every arc identically, solid pens and every dash style (147 width-5 arcs differed before)', () => {
		expect(results.filter((r) => r.c.kind === 'arc' && r.d > 0)).toHaveLength(0);
	});

	it('keeps 24 of 1,300 square and flat Bezier dashes one to three pixels off (exact-half extension ties of a scaled dash end)', () => {
		const bad = results.filter((r) => r.c.kind !== 'arc' && r.d > 0);
		expect(bad).toHaveLength(24);
		expect(Math.max(...bad.map((r) => r.d))).toBeLessThanOrEqual(3);
		// Before the wedge rule 27 of the 1,300 differed.
	});
});

describe('near-complete chords around curve-widen.json sample 206', () => {
	const pathOf = (source: number[]): GdiRasterPath => {
		const pts: number[] = [];
		for (let i = 0; i < source.length; i += 3) pts.push(source[i], source[i + 1]);
		const path = new GdiRasterPath();
		path.addBeziers(pts, true);
		path.closeFigure();
		return path;
	};

	it('widens the native chord path of 5,841 captures: all but 21 (closing lines under 8 FIX) fill identically', () => {
		expect(closing).toHaveLength(5841);
		let bad = 0;
		for (const c of closing) {
			const ours = widenPath(pathOf(c.source), {
				width: 9 * 16,
				cap: (['round', 'square', 'flat'] as const)[c.cap],
				join: (['round', 'bevel', 'miter'] as const)[c.join],
				miterLimit: 10,
				wholePixelDashVectors: true,
			});
			if (differing(ours, polygons(c.expected)) > 0) bad++;
		}
		expect(bad).toBe(21);
	});

	it('builds the arc of sample 206 as native does in 168 of 169 neighbouring paths (single-precision arc points; 108 started a FIX off at a rounding tie)', () => {
		const neighbours = closing.filter((c) => c.radials && c.cap === 1 && c.join === 1);
		expect(neighbours).toHaveLength(169);
		let equal = 0;
		let startOnly = 0;
		for (const c of neighbours) {
			const [l, t, r, b] = (c.box as number[]).map((v) => v * 16);
			const onBox = (x: number, r0: number, r1: number, b0: number, b1: number) => (b0 + b1) / 2 + (r1 !== r0 ? ((x - (r0 + r1) / 2) * (b1 - b0)) / (r1 - r0) : x - (r0 + r1) / 2);
			const radial = (x: number, y: number): [number, number] => [onBox(x * 16, l, r, l, r - 16), onBox(y * 16, t, b, t, b - 16)];
			const rd = c.radials as number[];
			const path = new GdiRasterPath();
			arcRasterPath(axisBox(l, t, r - 16, b - 16), radial(rd[0], rd[1]), radial(rd[2], rd[3]), false, 'chord', undefined, path);
			const ours = path.getPath.pts;
			const native: number[] = [];
			for (let i = 0; i < c.source.length; i += 3) native.push(c.source[i], c.source[i + 1]);
			const differs = ours.map((v, i) => (v !== native[i] ? i : -1)).filter((i) => i >= 0);
			if (differs.length === 0) equal++;
			else if (differs.length === 1 && differs[0] === 1 && native[1] - ours[1] === 1) startOnly++;
		}
		expect({ equal, startOnly }).toEqual({ equal: 168, startOnly: 0 });
	});
});
