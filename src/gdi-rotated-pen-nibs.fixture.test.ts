/**
 * Native `WidenPath` of a geometric pen under rotated, sheared, scaled and mirrored world transforms, read from long segments
 * (`rotated-pen-vector-probe`, round 6; `rotated-pen-nibs.json.gz` and `rotated-pen-sweep.json.gz`). The round caps of a long
 * segment show the pen's polygon (the nib) vertex by vertex, which the zero-length path of `nib-angle-sweep.json.gz` does not (that
 * path is a dot, not the polygon). What the captures fix:
 *
 *  - the nib is the ellipse of a box centred on the pen position (the path of an Ellipse under the same matrix) whose half edges are
 *    the images of the logical half width along the two logical axes, each component of an image rounded to nearest with the tie at
 *    a quarter (`floor(|v| + 0.75)`): 864 of 864 captured nibs of widths 5 to 40 are exact, under 14 rotations and scales (10 to
 *    300 degrees, 0.75x to 2x), shears, unequal scales, a rotation with unequal scales and three mirrors. The rounding bias is sharp:
 *    0.20 and 0.30 reproduce 433 and 448 of 476 (widths 7 to 40, rotations only), 0.25 all of them;
 *  - the perpendicular of a flat cap follows the same interpolation as an identity pen's, with two differences under a matrix:
 *    the half-unit bias follows the sign of the interpolated coordinate itself (a nib can lie on the other side of the direction's
 *    normal), and the further half unit of an odd pen edge is added for a support vertex in the first (explicitly flattened) half of
 *    the nib and subtracted in the second (an identity pen has only its vertex 0 in its first half there). 6,432 of 6,432 captured
 *    flat-cap corners in `rotated-pen-vectors.json.gz` are exact (5,608 before);
 *  - square caps extend by the device vector over the logical vector cut to whole units, as under a scale.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { GdiRasterPath, fillPolygonSpans, type SpanList } from './gdi-raster';
import { penPolygonMatrix, widenPath } from './gdi-raster-widen';

type Matrix = [number, number, number, number];
const read = (name: string): any[] => JSON.parse(gunzipSync(readFileSync(fixturePath(name))).toString());

it('reproduces all 864 native nibs read from long round-capped segments, vertex for vertex', () => {
	const nibs = new Map<string, { m: Matrix; w: number; pulled: boolean; native: Set<string> }>();
	for (const c of read('rotated-pen-nibs.json.gz')) {
		const m = (c.c !== undefined ? [c.a, c.b, c.c, c.d] : [c.a, c.b, -c.b, c.a]).map(Math.fround) as Matrix;
		const dev = (x: number, y: number): [number, number] => [Math.round((m[0] * x + m[2] * y) * 16), Math.round((m[1] * x + m[3] * y) * 16)];
		const a = dev(150, 150);
		const b = dev(150 + c.dx, 150 + c.dy);
		const pulled = (a[0] & 15) === 0 && (a[1] & 15) === 0;
		if (pulled !== ((b[0] & 15) === 0 && (b[1] & 15) === 0)) continue;
		const key = `${c.deg}/${c.scale}/${c.w}`;
		let nib = nibs.get(key);
		if (!nib) {
			nib = { m, w: c.w, pulled, native: new Set() };
			nibs.set(key, nib);
		}
		const pts: number[][] = [];
		for (let i = 0; i < c.points.length; i += 3) pts.push([c.points[i], c.points[i + 1]]);
		const half = pts.length / 2;
		// The vertices of each cap between its two side points (which sit on the half-pixel grid).
		for (let h = 0; h < 2; h++) {
			const o = h === 0 ? a : b;
			for (let i = 1; i < half - 1; i++) nib.native.add(`${pts[h * half + i][0] - o[0]},${pts[h * half + i][1] - o[1]}`);
		}
	}
	let exact = 0;
	for (const nib of nibs.values()) {
		// A pen centred on a whole pixel is pulled one FIX inwards at every vertex.
		const ours = new Set(penPolygonMatrix(nib.w * 16, nib.m).map((p) => (nib.pulled ? `${p[0] - Math.sign(p[0])},${p[1] - Math.sign(p[1])}` : p.join(','))));
		if (ours.size === nib.native.size && [...ours].every((v) => nib.native.has(v))) exact++;
	}
	expect({ exact, total: nibs.size }).toEqual({ exact: 864, total: 864 });
});

it('matches every flat, round and square capped segment of the one-degree sweeps under the identity, two rotations and three mirrors (12,960 of 12,960)', () => {
	const matrices: Matrix[] = ([[1, 0, 0, 1], [0.8660254, 0.5, -0.5, 0.8660254], [0.7071068, 0.7071068, -0.7071068, 0.7071068], [1, 0, 0, -1], [-1, 0, 0, 1], [0.8660254, 0.5, 0.5, -0.8660254]] as const).map((r) => r.map(Math.fround) as Matrix);
	const caps: Record<number, 'flat' | 'round' | 'square'> = { 0x200: 'flat', 0: 'round', 0x100: 'square' };
	const exact: Record<string, number> = {};
	let total = 0;
	for (const c of read('rotated-pen-sweep.json.gz')) {
		if (c.deg < 0) continue;
		total++;
		const m = matrices[c.m];
		const dev = (x: number, y: number): [number, number] => [Math.round((m[0] * x + m[2] * y) * 16), Math.round((m[1] * x + m[3] * y) * 16)];
		const a = dev(150, 150);
		const b = dev(150 + c.dx, 150 + c.dy);
		const path = new GdiRasterPath();
		path.moveTo(a[0], a[1]);
		path.lineTo(b[0], b[1]);
		const got = widenPath(path, { width: c.w * 16, matrix: m, deviceNib: c.m !== 0, cutToLogicalUnits: c.m !== 0, cap: caps[c.cap], join: 'round', miterLimit: 10 })[0] ?? [];
		const native: number[] = [];
		for (let i = 0; i < c.points.length; i += 3) native.push(c.points[i], c.points[i + 1]);
		if (got.length === native.length && got.every((v, i) => v === native[i])) {
			const key = `${c.m}/${caps[c.cap]}`;
			exact[key] = (exact[key] ?? 0) + 1;
		}
	}
	const all = Object.values(exact).reduce((s, v) => s + v, 0);
	expect({ all, total, keys: Object.keys(exact).length }).toEqual({ all: 12960, total: 12960, keys: 18 });
});

function pixels(spans: SpanList): Set<number> {
	const set = new Set<number>();
	for (let k = 0; k < spans.length * 3; k += 3) for (let x = spans.data[k + 1]; x < spans.data[k + 2]; x++) set.add(spans.data[k] * 4096 + x);
	return set;
}

it('decides the miter limit of 3,360 native corners under rotations, a rotation with unequal scales and mirrors in logical units: all 3,360 pixel-identical, 3,220 vertex for vertex (137 corners and 7,112 pixels wrong of the first 1,920 with the device-pixel test)', () => {
	const matrices: Matrix[] = ([[0.8660254, 0.5, -0.5, 0.8660254], [0.7071068, 0.7071068, -0.7071068, 0.7071068], [0.9659258, -0.258819, 0.258819, 0.9659258], [1.7320508, 1, -0.5, 0.8660254], [1, 0, 0, -1], [-1, 0, 0, 1], [0.8660254, 0.5, 0.5, -0.8660254]] as const).map((r) => r.map(Math.fround) as Matrix);
	const cases = read('rotated-pen-miters.json.gz');
	let exactVertices = 0;
	let pixelDiff = 0;
	let mitred = 0;
	for (const c of cases) {
		const m = matrices[c.m];
		const path = new GdiRasterPath();
		for (let i = 0; i < 3; i++) {
			const x = c.p[2 * i];
			const y = c.p[2 * i + 1];
			const dx = Math.round((m[0] * x + m[2] * y) * 16);
			const dy = Math.round((m[1] * x + m[3] * y) * 16);
			if (i === 0) path.moveTo(dx, dy);
			else path.lineTo(dx, dy);
		}
		const got = widenPath(path, { width: c.w * 16, matrix: m, deviceNib: true, cap: 'flat', join: 'miter', miterLimit: c.limit, dashes: null });
		const native: number[][] = [];
		for (let i = 0; i < c.points.length; i += 3) {
			if (c.points[i + 2] === 6) native.push([]);
			native[native.length - 1].push(c.points[i], c.points[i + 1]);
		}
		if (JSON.stringify(got) === JSON.stringify(native)) exactVertices++;
		// The other 140 (corners of 160 to 175 degrees) repeat the inner vertex once in native, a zero-area spike.
		const a = pixels(fillPolygonSpans(got, true));
		const b = pixels(fillPolygonSpans(native, true));
		for (const v of a) if (!b.has(v)) pixelDiff++;
		for (const v of b) if (!a.has(v)) pixelDiff++;
		if (native[0].length === 12) mitred++;
	}
	expect({ total: cases.length, exactVertices, pixelDiff }).toEqual({ total: 3360, exactVertices: 3220, pixelDiff: 0 });
	expect(mitred).toBeGreaterThan(0);
});
