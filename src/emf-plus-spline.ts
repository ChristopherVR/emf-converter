/**
 * GDI+ cardinal splines as the Bezier curves GDI+ turns them into.
 *
 * `DrawCurve`, `DrawClosedCurve` and `FillClosedCurve` (and
 * `GraphicsPath.AddCurve`/`AddClosedCurve`) do not rasterise a spline
 * directly: GDI+ first converts it to cubic Bezier segments, one per pair
 * of consecutive points, and draws those like any path. Read back through
 * `GraphicsPath.PathPoints` on 200 random splines (2 to 6 points, tensions
 * 0.25 to 2.5, open and closed), the conversion is:
 *
 * - the tangent at point i is `k * (P[i+1] - P[i-1])` with `k = tension / 3`;
 * - an open spline's end points use their one neighbour instead:
 *   `k * (P[1] - P[0])` at the start and `k * (P[n-1] - P[n-2])` at the end;
 * - a closed spline wraps around (the neighbours of P[0] are P[n-1] and
 *   P[1]) and gets one more segment, from P[n-1] back to P[0];
 * - segment i runs P[i], P[i] + T[i], P[i+1] - T[i+1], P[i+1].
 *
 * GDI+ evaluates this in single precision, so its control points can sit
 * one float ulp from the exact values computed here; that never moves a
 * vertex across GDI+'s 1/16-pixel grid (see `toPlusFix`), so the rasterised
 * curve is unchanged. `DrawCurve`'s Offset and NumberOfSegments select a
 * run of the full open spline's segments, whose tangents still come from
 * all the points (a partial curve is exactly that part of the whole one).
 *
 * @module emf-plus-spline
 */

/** A point in world coordinates. */
export interface SplinePoint {
	x: number;
	y: number;
}

/**
 * Converts a cardinal spline through `pts` with `tension` into Bezier
 * points: the start point, then three points (two controls and the end
 * point) per segment. `closed` wraps the spline round to its first point
 * (a closed curve, `n` segments); otherwise it is open (`n - 1` segments),
 * of which `offset` and `segments` select a run (the whole curve by
 * default). Returns an empty array when fewer than two points (three for a
 * closed curve) or no segment remain. Pure.
 */
export function cardinalSplineBeziers(
	pts: ReadonlyArray<SplinePoint>,
	tension: number,
	closed: boolean,
	offset: number = 0,
	segments?: number,
): SplinePoint[] {
	const n = pts.length;
	if (n < (closed ? 3 : 2)) {
		return [];
	}
	const k = (Number.isFinite(tension) ? tension : 0) / 3;
	const tangent = (i: number): SplinePoint => {
		let a: SplinePoint;
		let b: SplinePoint;
		if (closed) {
			a = pts[(i - 1 + n) % n];
			b = pts[(i + 1) % n];
		} else {
			a = pts[Math.max(0, i - 1)];
			b = pts[Math.min(n - 1, i + 1)];
		}
		return { x: k * (b.x - a.x), y: k * (b.y - a.y) };
	};
	const total = closed ? n : n - 1;
	const first = closed ? 0 : Math.max(0, Math.floor(offset));
	const count = closed ? total : Math.min(total - first, segments === undefined ? total : Math.floor(segments));
	if (!(count > 0)) {
		return [];
	}
	const out: SplinePoint[] = [{ x: pts[first].x, y: pts[first].y }];
	for (let s = first; s < first + count; s++) {
		const p = pts[s];
		const q = pts[(s + 1) % n];
		const tp = tangent(s);
		const tq = tangent((s + 1) % n);
		out.push({ x: p.x + tp.x, y: p.y + tp.y }, { x: q.x - tq.x, y: q.y - tq.y }, { x: q.x, y: q.y });
	}
	return out;
}
