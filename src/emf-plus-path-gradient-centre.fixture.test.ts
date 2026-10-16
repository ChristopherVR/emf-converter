import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pathGradientSampler } from './emf-plus-exact-fill';
import { centreColorAt, down, edgeValue, toward0 } from './__fixtures__/path-gradient-vertices-centre';
import { prepareVertexGradient, vertexGradientColorAt } from './emf-plus-path-gradient-vertices';
import { flattenBezierGdiplus, gdiplusFix } from './emf-plus-bezier';
import type { EmfPlusGradientWrapMode, TransformMatrix } from './emf-types';

/**
 * Per-vertex path gradients measured from the centre colour (round 9, workstream W5).
 *
 * `PathGradientSpanProbe.cs` (`RunGrid`, `RunGridColors`, `RunEdges`, `RunEdgesX`, `RunEdgesMid`) isolates the two stages of the
 * Gouraud fan that the round 8 span capture left open:
 *
 * - the span, with the span length `n` and the exact half-level colour swept independently of each other (`path-gradient-flat-grid*.json.gz`:
 *   fans whose colour is `64 + (y - 50) / 4` on every row, so both ends of a scanline are the same exact colour, and the same
 *   falling from 192). A flat span is a tie at x.5 for every row 52 + 4 k; whether its pixels round up depends on the odd part `m` of `n`
 *   and on the offset of the colour from the centre colour `C`: pixel `j >= 1` is x + 1 when `m` divides `2 (v - C)`, x otherwise
 *   (a rising offset), which is what `C + qa (n - j) + qb j` gives with `qa = qb = (v - C) / n` rounded toward zero in single
 *   precision. The weighted ends of round 8 could not give that.
 * - the three kinds of edge (`path-gradient-edge-stage*.json.gz`): the first pixel of a span is its left edge's colour, read on vertical and
 *   x-major edges with `S = 2 |b - a|` steps so that every odd row is a half-level tie.
 */

interface GridRecord { x0: number; xr: number; w: number; ra: string }
const gridPos: GridRecord[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/path-gradient-flat-grid.json.gz', import.meta.url))).toString());
const gridNeg: GridRecord[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/path-gradient-flat-grid-neg.json.gz', import.meta.url))).toString());

interface Pixel { n: number; j: number; v: number; up: boolean }
/** Every pixel of the flat spans (rows 52 + 4 k) that is a x.5 tie, with the centre at 64 (rising) or 192 (falling); sweeps wider than 256 columns have x-major edges and are left out. */
function gridPixels(records: GridRecord[], rising: boolean): Pixel[] {
	const pixels: Pixel[] = [];
	const seen = new Set<string>();
	for (const r of records) {
		if (r.xr - 20.25 > 250) continue;
		const ra = Buffer.from(r.ra, 'base64');
		for (let k = 0; k < 64; k++) {
			const y = 52 + 4 * k;
			const crossing = 20.25 + ((y - 50) / 256) * (Math.ceil(r.xr * 16 - 1e-9) / 16 - 20.25);
			const first = 21;
			const last = Math.ceil(crossing - 1e-9) - 1;
			if (last < first) continue;
			const n = last - first + 1;
			if (seen.has(`${n},${k}`)) continue;
			seen.add(`${n},${k}`);
			const lo = rising ? 64 + k : 191 - k;
			for (let j = 0; j < n; j++) pixels.push({ n, j, v: lo + 0.5, up: ra[(k * r.w + first + j) * 2] === lo + 1 });
		}
	}
	return pixels;
}
const oddPart = (n: number): number => { while (n % 2 === 0) n /= 2; return n; };
const positive = gridPixels(gridPos, true);
const negative = gridPixels(gridNeg, false);

/** The model of the span: pixel j >= 1 of a flat span of n pixels, `C + qa (n - j) + qb j`, in single precision. */
function flatModelUp(p: Pixel, centre: number): boolean {
	const q = toward0((p.v - centre) / p.n);
	const g = down(toward0(q * (p.n - p.j)) + toward0(q * p.j));
	return Math.floor(down(centre + g) + 0.5) === Math.floor(p.v) + 1;
}

describe('span measured from the centre colour (flat fans, native)', () => {
	it('swept span lengths and half-level colours are independent', () => {
		expect(positive).toHaveLength(667306);
		expect(new Set(positive.map((p) => p.n)).size).toBeGreaterThan(200);
		expect(positive.filter((p) => p.j === 0 && !p.up)).toHaveLength(0);
	});

	it('a rising flat span rounds up when the odd part of n divides 2 (v - 64), and nowhere else', () => {
		const later = positive.filter((p) => p.j > 0);
		expect(later).toHaveLength(659630);
		expect(later.filter((p) => p.up !== ((2 * (p.v - 64)) % oddPart(p.n) === 0))).toHaveLength(0);
		expect(later.filter((p) => p.up)).toHaveLength(29566);
	});

	it('the single precision span C + qa (n - j) + qb j (toward zero, sum rounded down) is every one of those pixels', () => {
		expect(positive.filter((p) => p.j > 0 && flatModelUp(p, 64) !== p.up)).toHaveLength(0);
	});

	it('a falling flat span rounds up almost everywhere, and the same arithmetic reproduces it', () => {
		const later = negative.filter((p) => p.j > 0);
		expect(negative.filter((p) => p.j === 0 && !p.up)).toHaveLength(0);
		expect(later.filter((p) => p.up).length).toBeGreaterThan(0.95 * later.length);
		// Not reproduced exactly (see docs/outstanding-work.md, round 9, W5): toward zero the arithmetic is above the exact value in every
		// pixel, and native is below it in 29,224 of 659,630.
		const wrong = later.filter((p) => flatModelUp(p, 192) !== p.up);
		expect(wrong).toHaveLength(29224);
		expect(wrong.every((p) => flatModelUp(p, 192) && !p.up)).toBe(true);
	});
});

interface EdgeRow { kind: number; a: number; b: number; S: number; k: number; v: number }

function loadEdgeRows(file: string, parse: (name: string) => { kind: number; a: number; b: number }, wanted: (leftEdge: number, kind: number) => boolean, vertical: boolean): EdgeRow[] {
	const captures: { name: string; w: number; h: number; points: [number, number][]; center: [number, number]; ra: string }[] = JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${file}`, import.meta.url))).toString());
	const rows: EdgeRow[] = [];
	for (const c of captures) {
		const { kind, a, b } = parse(c.name);
		const ra = Buffer.from(c.ra, 'base64');
		if (vertical) {
			const S = 2 * Math.abs(b - a);
			for (let k = 1; k < S; k++) {
				const index = ((50 + k) * c.w + 30) * 2;
				if (ra[index + 1]) rows.push({ kind, a, b, S, k, v: ra[index] });
			}
			continue;
		}
		const tx = [c.center[0], c.points[0][0], c.points[1][0]];
		const ty = [c.center[1], c.points[0][1], c.points[1][1]];
		for (let y = 0; y < c.h; y++) {
			let left = -1;
			let xl = Infinity;
			for (let i = 0; i < 3; i++) {
				const j = (i + 1) % 3;
				if (!((ty[i] <= y && ty[j] > y) || (ty[j] <= y && ty[i] > y))) continue;
				const x = tx[i] + ((y - ty[i]) / (ty[j] - ty[i])) * (tx[j] - tx[i]);
				if (x < xl) { xl = x; left = i; }
			}
			if (!wanted(left, kind)) continue;
			const xs = Math.ceil(xl - 1e-9);
			const e2 = (left + 1) % 3;
			const dx = tx[e2] - tx[left];
			const dy = ty[e2] - ty[left];
			const xMajor = Math.abs(dx) > Math.abs(dy);
			const S = Math.trunc(Math.abs(xMajor ? dx : dy));
			const k = xMajor ? Math.abs(xs - Math.floor(tx[left])) : Math.abs(y - Math.floor(ty[left]));
			if (k < 1 || k >= S) continue;
			const index = (y * c.w + xs) * 2;
			if (ra[index + 1]) rows.push({ kind, a, b, S, k, v: ra[index] });
		}
	}
	return rows;
}

describe('edges measured from the centre colour (native, first pixel of a span)', () => {
	const modelOf = (row: EdgeRow, centre: number, edge: number): number => {
		// the left edge of a fan (centre, vertex, vertex): the same arithmetic as `edgeValue`, on a vertical or x-major edge
		const steps = row.S;
		const k = row.k;
		// `edgeValue` takes coordinates; reproduce a y-major edge of `steps` rows starting at row 0 and an x-major one of `steps` columns
		return edgeValue(false, edge, centre, 0, 0, 0, steps, row.a, row.b, 0, k);
	};

	it('vertical edges that start at the centre or end there (49,464 rows)', () => {
		const rows = loadEdgeRows('path-gradient-edge-stage.json.gz', (name) => {
			const m = /edge(\d)_(\d+)_(\d+)/.exec(name)!;
			return { kind: +m[1], a: +m[2], b: +m[3] };
		}, () => true, true);
		expect(rows).toHaveLength(49464);
		let wrong = 0;
		for (const r of rows) {
			// edge 0 runs from the centre (colour a) to the vertex (b); edge 2 from the vertex (a) to the centre (b)
			const value = modelOf(r, r.kind === 0 ? r.a : r.b, r.kind);
			if (Math.floor(value + 0.5) !== r.v) wrong++;
		}
		expect(wrong).toBe(0);
	});

	it('x-major edges that start at the centre or end there (7,336 rows)', () => {
		const rows = loadEdgeRows('path-gradient-edge-stage-x.json.gz', (name) => {
			const m = /edgex(\d)_(\d+)_(\d+)/.exec(name)!;
			return { kind: +m[1], a: +m[2], b: +m[3] };
		}, (left, kind) => left === kind, false);
		expect(rows).toHaveLength(7336);
		let wrong = 0;
		for (const r of rows) {
			const value = modelOf(r, r.kind === 0 ? r.a : r.b, r.kind);
			if (Math.floor(value + 0.5) !== r.v) wrong++;
		}
		expect(wrong).toBe(0);
	});

	it('edges between two surround vertices, vertical and x-major (12,584 rows)', () => {
		const rows = loadEdgeRows('path-gradient-edge-stage-mid.json.gz', (name) => {
			const m = /mid(.)_(\d+)_(\d+)/.exec(name)!;
			return { kind: 1, a: +m[2], b: +m[3] };
		}, (left) => left === 1, false);
		expect(rows).toHaveLength(12584);
		let wrong = 0;
		for (const r of rows) {
			// the centre colour of these captures is 128
			const value = modelOf(r, 128, 1);
			if (Math.floor(value + 0.5) !== r.v) wrong++;
		}
		expect(wrong).toBe(0);
	});
});

interface Capture { name: string; w: number; h: number; world: number; rotate: number; focus: [number, number]; center: [number, number]; centerArgb: number; points: [number, number][]; colors: number[]; bgra: string }
const IDENTITY: TransformMatrix = [1, 0, 0, 1, 0, 0];

describe('the candidate against native (320 captures, 240 alpha controls)', () => {
	it('is exact on more of the per-vertex captures than the production module, with no pixel beyond one level', () => {
		const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/path-gradient-vertices.json.gz', import.meta.url))).toString());
		let native = 0;
		let exact = 0;
		let beyond = 0;
		let productionBeyond = 0;
		let productionExact = 0;
		for (const c of captures) {
			const rad = (c.rotate * Math.PI) / 180;
			const cs = Math.cos(rad);
			const sn = Math.sin(rad);
			const m: TransformMatrix = [cs * c.world, sn * c.world, -sn * c.world, cs * c.world, c.w / 2 - (cs * c.w) / 2 + (sn * c.h) / 2, c.h / 2 - (sn * c.w) / 2 - (cs * c.h) / 2];
			const g = prepareVertexGradient({
				boundary: c.points.map(([x, y]) => ({ x, y })), center: { x: c.center[0], y: c.center[1] }, centerArgb: c.centerArgb, boundaryArgb: c.colors,
				focus: null, blend: null, preset: null, transform: null,
			} as never, m)!;
			const bgra = Buffer.from(c.bgra, 'base64');
			for (let y = 0; y < c.h; y++) {
				for (let x = 0; x < c.w; x++) {
					const k = (y * c.w + x) * 4;
					if (bgra[k + 3] === 0) continue;
					native++;
					const difference = (color: number | null): number => {
						if (color === null) return 255;
						const a = color >>> 24;
						let d = Math.abs(a - bgra[k + 3]);
						for (let q = 0; q < 3; q++) d = Math.max(d, Math.abs(Math.round((((color >>> ((2 - q) * 8)) & 255) * a) / 255) - bgra[k + 2 - q]));
						return d;
					};
					const d = difference(centreColorAt(g, x, y));
					const dProduction = difference(vertexGradientColorAt(g, x, y));
					if (d === 0) exact++;
					if (d > 1) beyond++;
					if (dProduction === 0) productionExact++;
					if (dProduction > 1) productionBeyond++;
				}
			}
		}
		expect(native).toBe(174084);
		expect(productionExact).toBe(171194);
		expect(exact).toBeGreaterThanOrEqual(172969);
		expect(beyond).toBeLessThanOrEqual(productionBeyond);
	});

	it('keeps all but one of the alpha controls within their ceilings and tightens most of the others', () => {
		const bounds: Record<string, number[][]> = JSON.parse(readFileSync(new URL('./__fixtures__/gdi/path-gradient-color-bounds.json', import.meta.url), 'utf8'));
		const controls: { points: [number, number][]; types: string; center: [number, number]; a: number; b?: number; boundaryArgb?: number[]; wrap?: number; bgra: string }[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/path-gradient-alpha.json.gz', import.meta.url))).toString());
		const wraps: EmfPlusGradientWrapMode[] = ['tile', 'tile-flip-x', 'tile-flip-y', 'tile-flip-xy', 'clamp'];
		void wraps;
		void flattenBezierGdiplus;
		void gdiplusFix;
		void pathGradientSampler;
		let exceeding: string[] = [];
		let tighter = 0;
		let total = 0;
		controls.forEach((c, index) => {
			const boundary = c.points.map(([x, y]) => ({ x, y }));
			const g = prepareVertexGradient({
				boundary, center: { x: c.center[0], y: c.center[1] }, centerArgb: c.a, boundaryArgb: c.boundaryArgb ?? boundary.map(() => c.b!),
				focus: null, blend: null, preset: null, transform: null,
			} as never, IDENTITY);
			if (!g) { total += bounds.alpha[index][0]; return; }
			const bgra = Buffer.from(c.bgra, 'base64');
			let count = 0;
			let overOne = 0;
			let sum = 0;
			let max = 0;
			for (let p = 0; p < 8000; p++) {
				const x = p % 100;
				const y = Math.floor(p / 100);
				const color = centreColorAt(g, x, y);
				const a = color === null ? 0 : color >>> 24;
				const k = p * 4;
				let d = Math.abs(a - bgra[k + 3]);
				for (let q = 0; q < 3; q++) {
					const channel = color === null ? 0 : Math.round(((((color >>> ((2 - q) * 8)) & 255)) * a) / 255);
					d = Math.max(d, Math.abs(channel - bgra[k + 2 - q]));
				}
				if (d) count++;
				if (d > 1) overOne++;
				sum += d;
				max = Math.max(max, d);
			}
			total += count;
			const b = bounds.alpha[index];
			if (count > b[0] || sum > b[1] || max > b[2] || overOne > b[3]) exceeding.push(`#${index}`);
			if (count < b[0]) tighter++;
		});
		expect(exceeding).toEqual(['#137']);
		expect(tighter).toBeGreaterThanOrEqual(55);
		expect(total).toBeLessThanOrEqual(613);
	});
});
