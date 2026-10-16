import { describe, expect, it } from 'vitest';
import { rasterizeMono, type Outline } from './ttf-raster';

const polygon = (...contours: [number, number][][]): Outline => {
	const xs: number[] = [], ys: number[] = [], endPts: number[] = [];
	for (const c of contours) {
		for (const [x, y] of c) { xs.push(x); ys.push(y); }
		endPts.push(xs.length - 1);
	}
	return { xs, ys, onCurve: xs.map(() => 1), endPts };
};
/** Rows (bottom row = 0) of the bitmap's column `col` that are on. */
const column = (b: ReturnType<typeof rasterizeMono>, col: number): number[] => {
	const rows: number[] = [];
	for (let r = 0; r < b!.height; r++) if (b!.data[(b!.height - 1 - r) * b!.width + col]) rows.push(r + b!.top - b!.height);
	return rows.sort((p, q) => p - q);
};

describe('dropout stubs by the specification squares', () => {
	// Tahoma's "i" at 10 px (hinted outline, 26.6): a stem 0.73 px wide that no pixel centre of its column falls in, and its
	// dot. Native GetGlyphOutline(GGO_BITMAP) keeps the two middle rows of the stem and the dot, and drops the stem's
	// first and last row: each of those dropouts has no contour crossing the square on its outer side.
	const i = polygon([[34, 0], [34, 279], [81, 279], [81, 0]], [[32, 326], [32, 375], [85, 375], [85, 326]]);
	it('drops the end rows of a stem narrower than a pixel and keeps the middle ones (SCANTYPE 5)', () => {
		expect(column(rasterizeMono(i, 5, undefined, true, false, false, false, false, false, true), 0)).toEqual([1, 2, 5]);
	});
	it('the profile rule kept the end rows', () => {
		expect(column(rasterizeMono(i, 5, undefined, true), 0)).toEqual([0, 1, 2, 3, 5]);
	});
});

describe('scan lines that lie exactly on a horizontal edge', () => {
	// An E-like outline: a stem and a bar whose underside lies on the centre of row 4 (y = 288 = 32 + 4 * 64).
	const e = polygon([[0, 0], [0, 320], [640, 320], [640, 288], [160, 288], [160, 0]]);
	it('inks the whole row when closedTies is set', () => {
		const b = rasterizeMono(e, 2, undefined, true, false, false, false, false, true)!;
		const row = (r: number): number[] => Array.from({ length: b.width }, (_, c) => b.data[(b.height - 1 - r) * b.width + c]);
		expect(row(4)).toEqual(Array(10).fill(1));
		expect(row(3)).toEqual([1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
	});
	it('leaves the bar out of that row otherwise (the sweep merges the two descending edges)', () => {
		const b = rasterizeMono(e, 2)!;
		expect(Array.from({ length: b.width }, (_, c) => b.data[(b.height - 1 - 4) * b.width + c])).toEqual([1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
	});
});
