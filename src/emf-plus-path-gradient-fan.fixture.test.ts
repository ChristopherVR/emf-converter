import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { FanTriangle, fanCoordinate, packPremultiplied, premultipliedColor } from './emf-plus-path-gradient-fan';
import { transformPoint } from './gdiplus-float';

/**
 * The Gouraud scan converter of gdiplus.dll (`emf-plus-path-gradient-fan.ts`) against every native capture of a per-vertex path
 * gradient taken so far. The model is the one the system library executes (read from `DpTriangleData` and
 * `DpOutputPathGradientSpan`), so each dataset must be reproduced to the byte:
 *
 * - `path-gradient-vertices.json.gz` (333 captures: library triangles, quads and pentagons, random polygons on a 1/16 grid,
 *   translucent, focused, scaled and rotated ones; premultiplied BGRA);
 * - `path-gradient-span.json.gz` (108 fans whose edge colours are exact in any arithmetic, the span alone is inexact);
 * - `path-gradient-edge-stage*.json.gz` (the three kinds of edge, vertical and x-major, with the centre colour swept);
 * - `path-gradient-flat-grid*.json.gz` (1,200 flat fans, rows 52 + 4 k: the span length and the half-level colour swept).
 */
const load = <T>(name: string): T[] => JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${name}`, import.meta.url))).toString());

interface RedCapture { name: string; w: number; h: number; center: [number, number]; centerArgb: number; points: [number, number][]; colors: number[]; ra: string }

/** The fan's premultiplied ARGB bytes of row `y` into `out` (four bytes a pixel, zero where no triangle paints). */
function paintRow(triangles: FanTriangle[], w: number, y: number, out: Uint8Array): void {
	out.fill(0);
	for (const t of triangles) {
		const row = t.row(y, 0, w);
		if (!row) continue;
		for (let k = 0; k < row.n; k++) {
			const x = row.xl + k;
			if (x >= 0 && x < w) out.set(row.argb.subarray(k * 4, k * 4 + 4), x * 4);
		}
	}
}

function fanOf(points: [number, number][], center: [number, number], centerArgb: number, colors: number[], matrix: number[] = [1, 0, 0, 1, 0, 0]): FanTriangle[] {
	const n = points.length;
	const c = transformPoint(matrix, center[0], center[1]);
	const device = points.map(([x, y]) => transformPoint(matrix, x, y));
	const triangles: FanTriangle[] = [];
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		if (points[i][0] === points[j][0] && points[i][1] === points[j][1]) continue;
		triangles.push(new FanTriangle([c[0], c[1], device[i][0], device[i][1], device[j][0], device[j][1]], [premultipliedColor(centerArgb), premultipliedColor(colors[i]), premultipliedColor(colors[j])]));
	}
	return triangles;
}

/** Wrong red/alpha bytes among the pixels of the rows `rows` of a capture. */
function wrongRedAlpha(c: RedCapture, rows: number[]): { wrong: number; painted: number } {
	const ra = Buffer.from(c.ra, 'base64');
	const triangles = fanOf(c.points, c.center, c.centerArgb, c.colors);
	const row = new Uint8Array(c.w * 4);
	let wrong = 0;
	let painted = 0;
	for (const y of rows) {
		paintRow(triangles, c.w, y, row);
		for (let x = 0; x < c.w; x++) {
			if (ra[(y * c.w + x) * 2 + 1]) painted++;
			if (row[x * 4 + 1] !== ra[(y * c.w + x) * 2] || row[x * 4] !== ra[(y * c.w + x) * 2 + 1]) wrong++;
		}
	}
	return { wrong, painted };
}

const allRows = (h: number): number[] => Array.from({ length: h }, (_, y) => y);

describe('premultiplied native bytes of the converter', () => {
	it('packs half-way channels up and clamps the colour to the alpha', () => {
		const out = new Uint8Array(4);
		packPremultiplied([200, 255, 100.5, 0], out, 0);
		expect([...out]).toEqual([200, 200, 101, 0]);
		packPremultiplied([0, 5, 5, 5], out, 0);
		expect([...out]).toEqual([0, 0, 0, 0]);
	});

	it('takes a 28.4 coordinate as ceil(round(v 256) / 16)', () => {
		expect([0, 0.0625, 0.03, 0.0300001, 10.5, 1 / 512, 3 / 512].map(fanCoordinate)).toEqual([0, 1, 1, 1, 168, 1, 1]);
		expect(fanCoordinate(-0.03)).toBe(0);
		expect(fanCoordinate(-0.07)).toBe(-1);
	});
});

describe('the fan against the vertex captures (premultiplied BGRA)', () => {
	interface Capture extends RedCapture { world: number; rotate: number; bgra: string }
	const captures = load<Capture>('path-gradient-vertices.json.gz');

	it('is exact on every pixel of the 333 captures', () => {
		let pixels = 0;
		let painted = 0;
		const wrong: string[] = [];
		for (const c of captures) {
			const rad = (c.rotate * Math.PI) / 180;
			const cs = Math.cos(rad);
			const sn = Math.sin(rad);
			const matrix = [cs * c.world, sn * c.world, -sn * c.world, cs * c.world, c.w / 2 - (cs * c.w) / 2 + (sn * c.h) / 2, c.h / 2 - (sn * c.w) / 2 - (cs * c.h) / 2];
			const triangles = fanOf(c.points, c.center, c.centerArgb, c.colors, matrix);
			const native = Buffer.from(c.bgra, 'base64');
			const row = new Uint8Array(c.w * 4);
			let bad = 0;
			for (let y = 0; y < c.h; y++) {
				paintRow(triangles, c.w, y, row);
				for (let x = 0; x < c.w; x++) {
					const k = (y * c.w + x) * 4;
					pixels++;
					if (native[k + 3]) painted++;
					if (row[x * 4] !== native[k + 3] || row[x * 4 + 1] !== native[k + 2] || row[x * 4 + 2] !== native[k + 1] || row[x * 4 + 3] !== native[k]) bad++;
				}
			}
			if (bad) wrong.push(`${c.name}: ${bad}`);
		}
		expect(captures).toHaveLength(333);
		expect(painted).toBe(174084);
		expect(pixels).toBeGreaterThan(painted);
		expect(wrong).toEqual([]);
	});
});

describe('the fan against the isolating probes (red and alpha)', () => {
	it('reproduces the 108 fans whose edge colours are exact (span)', () => {
		const spans = load<RedCapture>('path-gradient-span.json.gz');
		expect(spans).toHaveLength(108);
		let wrong = 0;
		let painted = 0;
		for (const c of spans) {
			const r = wrongRedAlpha(c, allRows(c.h));
			wrong += r.wrong;
			painted += r.painted;
		}
		expect(painted).toBeGreaterThan(2_600_000);
		expect(wrong).toBe(0);
	});

	for (const [file, count] of [
		['path-gradient-edge-stage.json.gz', 0],
		['path-gradient-edge-stage-x.json.gz', 0],
		['path-gradient-edge-stage-mid.json.gz', 0],
		['path-gradient-edge-stage-mid-centre.json.gz', 0],
	] as const) {
		it(`reproduces every pixel of ${file}`, () => {
			const captures = load<RedCapture>(file);
			expect(captures.length).toBeGreaterThan(count);
			let wrong = 0;
			for (const c of captures) wrong += wrongRedAlpha(c, allRows(c.h)).wrong;
			expect(wrong).toBe(0);
		});
	}

	for (const [file, centre, p0, p1, p2] of [
		['path-gradient-flat-grid.json.gz', 64, 192, 128, 0],
		['path-gradient-flat-grid-neg.json.gz', 192, 64, 128, 255],
	] as const) {
		it(`reproduces rows 52 + 4 k of the 600 flat fans of ${file}`, () => {
			const records = load<{ x0: number; xr: number; w: number; ra: string }>(file);
			expect(records).toHaveLength(600);
			let wrong = 0;
			const rows = Array.from({ length: 64 }, (_, k) => 52 + 4 * k);
			const red = (v: number): number => (0xff000000 | (v << 16)) >>> 0;
			for (const r of records) {
				const ra = Buffer.from(r.ra, 'base64');
				const triangles = fanOf([[r.x0, 562], [r.xr, 306], [r.x0 - 1, 10]], [r.x0, 50], red(centre), [red(p0), red(p1), red(p2)]);
				const row = new Uint8Array(r.w * 4);
				rows.forEach((y, k) => {
					paintRow(triangles, r.w, y, row);
					for (let x = 0; x < r.w; x++) {
						if (row[x * 4 + 1] !== ra[(k * r.w + x) * 2] || row[x * 4] !== ra[(k * r.w + x) * 2 + 1]) wrong++;
					}
				});
			}
			expect(wrong).toBe(0);
		});
	}
});
