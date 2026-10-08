/**
 * Native nibs of a geometric pen at every whole degree of a pure rotation (`nib-matrix-pen-probe`, `nib-angle-sweep.json.gz`: a zero-length
 * polyline widened under `SetWorldTransform` of 0 to 359 degrees, widths 12, 24 and 40, 1,080 outlines; round 5). Round 4 left the nib
 * of a rotation wider than 6.5 pixels exact for 57 of 128 interior-vertex sets and named this sweep as the data that separates a
 * vertex-index rule from an angle-dependent rounding. What the sweep fixes:
 *
 *  - the nib is centrally symmetric about `round(M * p)` (the pen's point through the matrix, linear part rounded once) at all 1,080 angles and widths, so only
 *    half of its vertices are free, as in `penPolygonMatrix`;
 *  - its vertices sit at the logical angles k * 22.5 degrees, as many as the unrotated pen (16 at width 24), so the topology is ours;
 *  - no logical vertex rotated and rounded fits: for each of the 16 vertices of the width 24 nib, no real logical position within 3 FIX of the
 *    exact circle point rounds to the native vertex at more than 89 to 274 of the 356 angles that are not multiples of 90 degrees, so the vertex-index rule
 *    (a fixed vertex, however rounded) is rejected, and the rounding of the rotated vertex depends on the angle;
 *  - the nib at multiples of 90 degrees is a different construction (x extent one FIX shorter than y at the identity: 191 against 192 for width 24), the
 *    cap of a zero-length segment rather than the pen polygon.
 *
 * Pinned below: the converter's nib (`penPolygonMatrix`) is exact at 3 of 360 angles for width 12, 1 for width 24, none for width 40, and
 * the per-vertex counts of the constructions tried (rotated plain pen vertices rounded: 2,124 of 5,696 at width 24; the converter's: 1,958; a
 * matrix quantised to 6 to 20 bits never improves on it).
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { penPolygon, penPolygonMatrix } from './gdi-raster-widen';

interface Nib {
	w: number;
	deg: number;
	a: number;
	b: number;
	points: number[];
}
const nibs: Nib[] = JSON.parse(gunzipSync(readFileSync(fixturePath('nib-angle-sweep.json.gz'))).toString());

function relative(c: Nib): Set<string> {
	const cx = Math.round((c.a * 20 - c.b * 20) * 16);
	const cy = Math.round((c.b * 20 + c.a * 20) * 16);
	const set = new Set<string>();
	for (let i = 0; i < c.points.length; i += 3) set.add(`${c.points[i] - cx},${c.points[i + 1] - cy}`);
	return set;
}

it('is centrally symmetric about the rounded image of the pen point at all 1,080 angles and widths', () => {
	expect(nibs).toHaveLength(1080);
	for (const c of nibs) {
		const set = relative(c);
		for (const key of set) {
			const [x, y] = key.split(',').map(Number);
			expect(set.has(`${-x},${-y}`), `w ${c.w} deg ${c.deg} vertex ${key}`).toBe(true);
		}
	}
});

it('keeps the converter exact at 3, 1 and 0 of 360 angles for widths 12, 24 and 40', () => {
	const exact: Record<number, number> = { 12: 0, 24: 0, 40: 0 };
	for (const c of nibs) {
		const native = relative(c);
		const ours = new Set(penPolygonMatrix(c.w * 16, [c.a, c.b, -c.b, c.a]).map((p) => p.join(',')));
		if (native.size === ours.size && [...native].every((v) => ours.has(v))) exact[c.w]++;
	}
	expect(exact).toEqual({ 12: 3, 24: 1, 40: 0 });
});

it('fits no construction of a fixed logical vertex: 2,124 and 1,958 of 5,696 width 24 vertices (rotated plain pen vertices rounded; converter)', () => {
	const plain = penPolygon(24 * 16);
	let rotated = 0;
	let mine = 0;
	let total = 0;
	for (const c of nibs) {
		if (c.w !== 24 || c.deg % 90 === 0) continue;
		const native = relative(c);
		const ours = penPolygonMatrix(c.w * 16, [c.a, c.b, -c.b, c.a]);
		for (const p of plain) {
			total++;
			if (native.has(`${Math.round(c.a * p[0] - c.b * p[1])},${Math.round(c.b * p[0] + c.a * p[1])}`)) rotated++;
		}
		for (const p of ours) if (native.has(p.join(','))) mine++;
	}
	expect({ rotated, mine, total }).toEqual({ rotated: 2124, mine: 1958, total: 5696 });
});
