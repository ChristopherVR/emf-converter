/**
 * The float32 matrix chain of a plain Bilinear `DrawImage(image, PointF[3], srcRect)` against native flip captures
 * (`gdiplus-image-points.ts`; `image-points-positions.json.gz`, `image-points-bisect-jpeg.json.gz` and its playback twin
 * `image-points-bisect-jpeg-playback.json.gz`, `ImagePointsBisectProbe.cs`).
 *
 * A flip is the first float32 origin at which a pixel's filtered red (green) changes; the model reproduces it when its
 * 11-bit quantised source coordinate gives different channel values at the origin before and at the native one.
 * Reproduced: all 887 vertical flips, 684 of 720 horizontal flips of `image-points-positions`, and 105 of the 124 flips
 * of the JPEG playbacks' geometry (the old fitted model: 5 and 2 of the latter). The playback capture, recorded into an
 * EMF+ metafile and played back, has the same 124 first-flip values as the direct draw: the metafile player adds no
 * perturbation, the term is in the points-form arithmetic itself.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { drawImagePointsDeviceMatrix, invertDown, spanPositions } from './gdiplus-image-points';

const read = (name: string): any[] => JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${name}`, import.meta.url))).toString('utf8'));
const f32 = new Float32Array(1);
const i32 = new Int32Array(f32.buffer);
const fromBits = (n: number): number => {
	i32[0] = n;
	return f32[0];
};
const fix = (v: number): number => Math.ceil(Math.round(v * 256 - 1e-6) / 16) / 16;

function channel(p: number): number {
	const i = Math.floor(p);
	const q = Math.round((p - i) * 2048);
	const t0 = ((i % 2) + 2) % 2;
	return ((2048 - q) * t0 + q * (1 - t0) + 1024) >> 11;
}

const IDENTITY = [1, 0, 0, 1, 0, 0];

/** Source coordinate along `axis` of device pixel `pixel` for the draw whose origin is (`ox`, `oy`). */
function position(points: number[], src: number[], axis: 0 | 1, row: number, column: number, last: number | null): number {
	const m = drawImagePointsDeviceMatrix(points, src, IDENTITY);
	if (!m) return NaN;
	const inv = invertDown(m)!;
	const first = Math.ceil(fix(points[0]) - 0.5);
	const end = last ?? Math.ceil(fix(points[2]) - 0.5) - 1;
	const n = end - first + 1;
	const us = new Float64Array(n);
	const vs = new Float64Array(n);
	spanPositions(inv, first, row, n, us, vs);
	return (axis === 0 ? us : vs)[column - first];
}

describe('native DrawImagePoints matrix chain, positions (image-points-positions.json.gz)', () => {
	const cases = read('image-points-positions.json.gz').filter((c) => c.points);
	const expected: Record<string, number> = { '0': 684, '1': 887 };
	for (const axis of [0, 1] as const) {
		it(`axis ${axis}`, () => {
			let exact = 0;
			let total = 0;
			for (const c of cases.filter((k) => k.axis === axis)) {
				const dw = Math.fround(c.dw);
				const dh = Math.fround(c.dh);
				const src = [0, 0, c.sw, c.sh];
				const middleRow = Math.floor(c.oy0 + c.dh / 2);
				const middleColumn = Math.floor(c.ox0 + c.dw / 2);
				const at = (t: number, pixel: number): number => {
					const ox = Math.fround(axis === 0 ? t : c.ox0);
					const oy = Math.fround(axis === 0 ? c.oy0 : t);
					const pts = [ox, oy, Math.fround(ox + dw), oy, ox, Math.fround(oy + dh)];
					return position(pts, src, axis, axis === 0 ? middleRow : pixel, axis === 0 ? pixel : middleColumn, null);
				};
				for (const [pixel, , , first] of c.queries as number[][]) {
					if (!first) continue;
					total++;
					const a = at(fromBits(first - 1), pixel);
					const b = at(fromBits(first), pixel);
					if (!Number.isNaN(a) && channel(a) !== channel(b)) exact++;
				}
			}
			expect(total).toBe(axis === 0 ? 720 : 887);
			expect(exact).toBeGreaterThanOrEqual(expected[String(axis)]);
		});
	}
});

describe('native DrawImagePoints matrix chain, JPEG playback geometry (image-points-bisect-jpeg*.json.gz)', () => {
	const run = (name: string): { exact: number; total: number; firsts: number[] } => {
		const d = read(name)[0];
		let exact = 0;
		let total = 0;
		const firsts: number[] = [];
		for (const [pixel, , , first] of d.queries as number[][]) {
			if (!first) continue;
			total++;
			firsts.push(first);
			const at = (t: number): number => {
				const pts = [t, Math.fround(d.y0), Math.fround(d.x1), Math.fround(d.y1), t, Math.fround(d.y2)];
				const start = Math.ceil(fix(t) - 0.5);
				const m = drawImagePointsDeviceMatrix(pts, [0, 0, d.srcW, d.srcH], IDENTITY)!;
				const n = d.last - start + 1;
				const us = new Float64Array(n);
				spanPositions(invertDown(m)!, start, d.row, n, us, new Float64Array(n));
				return us[pixel - start];
			};
			if (channel(at(fromBits(first - 1))) !== channel(at(fromBits(first)))) exact++;
		}
		return { exact, total, firsts };
	};

	it('reproduces 105 of 124 direct-draw flips', () => {
		const r = run('image-points-bisect-jpeg.json.gz');
		expect(r.total).toBe(124);
		expect(r.exact).toBeGreaterThanOrEqual(105);
	});

	it('the metafile playback has the direct draw\'s flips', () => {
		expect(run('image-points-bisect-jpeg-playback.json.gz').firsts).toEqual(run('image-points-bisect-jpeg.json.gz').firsts);
	});
});
