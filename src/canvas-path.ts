/**
 * Canvas 2D path construction shared by the SVG recorder (`svg-context.ts`)
 * and the pure-JavaScript rasteriser (`software-raster.ts`).
 *
 * Canvas maps every point through the transform current WHEN IT IS ADDED,
 * so a path is naturally stored in device space: {@link PathBuilder} does
 * exactly that, turning arcs and ellipses into cubic Beziers (at most a
 * quarter turn each, which affine maps carry exactly). Both consumers build
 * their paths through this one class, so the geometry the software shadow
 * rasterises is, segment for segment, the geometry the SVG describes.
 *
 * {@link flattenPath} turns a built path into polylines for rasterisation,
 * hit testing and stroking, subdividing each Bezier finely enough that no
 * chord strays more than `tolerance` device pixels from the curve.
 *
 * @module canvas-path
 */

/** A 2D affine matrix `[a, b, c, d, e, f]`, as in Canvas `setTransform`. */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY_MATRIX: Readonly<Matrix> = [1, 0, 0, 1, 0, 0];

/** `m` then `n` applied first: the matrix Canvas `transform(n)` leaves after `m`. */
export function multiplyMatrix(m: Readonly<Matrix>, n: Readonly<Matrix>): Matrix {
	return [
		m[0] * n[0] + m[2] * n[1],
		m[1] * n[0] + m[3] * n[1],
		m[0] * n[2] + m[2] * n[3],
		m[1] * n[2] + m[3] * n[3],
		m[0] * n[4] + m[2] * n[5] + m[4],
		m[1] * n[4] + m[3] * n[5] + m[5],
	];
}

/** The inverse of `m`, or `null` when it is singular or not finite. */
export function invertMatrix(m: Readonly<Matrix>): Matrix | null {
	const det = m[0] * m[3] - m[1] * m[2];
	if (!det || !Number.isFinite(det)) {
		return null;
	}
	return [
		m[3] / det,
		-m[1] / det,
		-m[2] / det,
		m[0] / det,
		(m[2] * m[5] - m[3] * m[4]) / det,
		(m[1] * m[4] - m[0] * m[5]) / det,
	];
}

/** One device-space path segment. */
export type PathSeg =
	| { t: 'M'; x: number; y: number }
	| { t: 'L'; x: number; y: number }
	| { t: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
	| { t: 'Z' };

interface Point {
	x: number;
	y: number;
}

/**
 * Accumulates a Canvas path in device space. Every method takes the
 * transform to map its user-space arguments through (the context's current
 * transform), mirroring the Canvas API method of the same name, including
 * its handling of non-finite arguments (ignored) and negative radii
 * (`RangeError`).
 */
export class PathBuilder {
	/** The segments, in device space. */
	segs: PathSeg[] = [];
	/** Current point and subpath start, in device space. */
	cur: Point | null = null;
	start: Point | null = null;

	reset(): void {
		this.segs = [];
		this.cur = null;
		this.start = null;
	}

	private moveDevice(p: Point): void {
		this.segs.push({ t: 'M', x: p.x, y: p.y });
		this.cur = p;
		this.start = p;
	}

	private lineDevice(p: Point): void {
		if (!this.cur) {
			this.moveDevice(p);
			return;
		}
		this.segs.push({ t: 'L', x: p.x, y: p.y });
		this.cur = p;
	}

	private static map(m: Readonly<Matrix>, x: number, y: number): Point {
		return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
	}

	moveTo(m: Readonly<Matrix>, x: number, y: number): void {
		if (Number.isFinite(x) && Number.isFinite(y)) {
			this.moveDevice(PathBuilder.map(m, x, y));
		}
	}

	lineTo(m: Readonly<Matrix>, x: number, y: number): void {
		if (Number.isFinite(x) && Number.isFinite(y)) {
			this.lineDevice(PathBuilder.map(m, x, y));
		}
	}

	private curveUser(m: Readonly<Matrix>, x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
		const p1 = PathBuilder.map(m, x1, y1);
		const p2 = PathBuilder.map(m, x2, y2);
		const p = PathBuilder.map(m, x, y);
		if (!this.cur) {
			this.moveDevice(p1);
		}
		this.segs.push({ t: 'C', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x: p.x, y: p.y });
		this.cur = p;
	}

	bezierCurveTo(m: Readonly<Matrix>, x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
		if ([x1, y1, x2, y2, x, y].every(Number.isFinite)) {
			this.curveUser(m, x1, y1, x2, y2, x, y);
		}
	}

	quadraticCurveTo(m: Readonly<Matrix>, cx: number, cy: number, x: number, y: number): void {
		if (![cx, cy, x, y].every(Number.isFinite)) {
			return;
		}
		const i = invertMatrix(m);
		const p0 =
			this.cur && i
				? { x: i[0] * this.cur.x + i[2] * this.cur.y + i[4], y: i[1] * this.cur.x + i[3] * this.cur.y + i[5] }
				: { x: cx, y: cy };
		this.curveUser(
			m,
			p0.x + (2 / 3) * (cx - p0.x),
			p0.y + (2 / 3) * (cy - p0.y),
			x + (2 / 3) * (cx - x),
			y + (2 / 3) * (cy - y),
			x,
			y,
		);
	}

	closePath(): void {
		if (this.cur) {
			this.segs.push({ t: 'Z' });
			this.cur = this.start;
		}
	}

	rect(m: Readonly<Matrix>, x: number, y: number, w: number, h: number): void {
		if ([x, y, w, h].every(Number.isFinite)) {
			this.moveDevice(PathBuilder.map(m, x, y));
			this.lineDevice(PathBuilder.map(m, x + w, y));
			this.lineDevice(PathBuilder.map(m, x + w, y + h));
			this.lineDevice(PathBuilder.map(m, x, y + h));
			this.segs.push({ t: 'Z' });
			this.moveDevice(PathBuilder.map(m, x, y));
		}
	}

	/** Appends an elliptical arc as cubic Beziers (user space, then mapped). */
	private ellipseUser(
		m: Readonly<Matrix>,
		cx: number,
		cy: number,
		rx: number,
		ry: number,
		rotation: number,
		startAngle: number,
		endAngle: number,
		ccw: boolean,
	): void {
		const TAU = Math.PI * 2;
		let sweep = endAngle - startAngle;
		if (!ccw) {
			sweep = sweep >= TAU ? TAU : ((sweep % TAU) + TAU) % TAU;
		} else {
			sweep = -sweep >= TAU ? -TAU : -((((-sweep) % TAU) + TAU) % TAU);
		}
		const cosR = Math.cos(rotation);
		const sinR = Math.sin(rotation);
		const pt = (t: number): Point => {
			const ex = rx * Math.cos(t);
			const ey = ry * Math.sin(t);
			return { x: cx + ex * cosR - ey * sinR, y: cy + ex * sinR + ey * cosR };
		};
		const deriv = (t: number): Point => {
			const ex = -rx * Math.sin(t);
			const ey = ry * Math.cos(t);
			return { x: ex * cosR - ey * sinR, y: ex * sinR + ey * cosR };
		};
		const s = pt(startAngle);
		this.lineDevice(PathBuilder.map(m, s.x, s.y));
		if (sweep === 0) {
			return;
		}
		const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
		const step = sweep / n;
		const k = (4 / 3) * Math.tan(step / 4);
		for (let i = 0; i < n; i++) {
			const t0 = startAngle + i * step;
			const t1 = t0 + step;
			const p0 = pt(t0);
			const p1 = pt(t1);
			const d0 = deriv(t0);
			const d1 = deriv(t1);
			this.curveUser(m, p0.x + k * d0.x, p0.y + k * d0.y, p1.x - k * d1.x, p1.y - k * d1.y, p1.x, p1.y);
		}
	}

	ellipse(
		m: Readonly<Matrix>,
		x: number,
		y: number,
		rx: number,
		ry: number,
		rotation: number,
		startAngle: number,
		endAngle: number,
		counterclockwise = false,
	): void {
		if (rx < 0 || ry < 0) {
			throw new RangeError('The radii provided are negative');
		}
		if ([x, y, rx, ry, rotation, startAngle, endAngle].every(Number.isFinite)) {
			this.ellipseUser(m, x, y, rx, ry, rotation, startAngle, endAngle, counterclockwise);
		}
	}

	arc(
		m: Readonly<Matrix>,
		x: number,
		y: number,
		r: number,
		startAngle: number,
		endAngle: number,
		counterclockwise = false,
	): void {
		if (r < 0) {
			throw new RangeError('The radius provided is negative');
		}
		if ([x, y, r, startAngle, endAngle].every(Number.isFinite)) {
			this.ellipseUser(m, x, y, r, r, 0, startAngle, endAngle, counterclockwise);
		}
	}

	arcTo(m: Readonly<Matrix>, x1: number, y1: number, x2: number, y2: number, r: number): void {
		if (![x1, y1, x2, y2, r].every(Number.isFinite) || r < 0) {
			return;
		}
		if (!this.cur) {
			this.moveDevice(PathBuilder.map(m, x1, y1));
			return;
		}
		const i = invertMatrix(m);
		if (!i) {
			return;
		}
		const x0 = i[0] * this.cur.x + i[2] * this.cur.y + i[4];
		const y0 = i[1] * this.cur.x + i[3] * this.cur.y + i[5];
		const v1x = x0 - x1;
		const v1y = y0 - y1;
		const v2x = x2 - x1;
		const v2y = y2 - y1;
		const l1 = Math.hypot(v1x, v1y);
		const l2 = Math.hypot(v2x, v2y);
		const cross = v1x * v2y - v1y * v2x;
		if (r === 0 || l1 === 0 || l2 === 0 || Math.abs(cross) < 1e-12 * l1 * l2) {
			this.lineDevice(PathBuilder.map(m, x1, y1));
			return;
		}
		const u1x = v1x / l1;
		const u1y = v1y / l1;
		const u2x = v2x / l2;
		const u2y = v2y / l2;
		const theta = Math.acos(Math.max(-1, Math.min(1, u1x * u2x + u1y * u2y)));
		const dist = r / Math.tan(theta / 2);
		const t1 = { x: x1 + u1x * dist, y: y1 + u1y * dist };
		const t2 = { x: x1 + u2x * dist, y: y1 + u2y * dist };
		const bx = u1x + u2x;
		const by = u1y + u2y;
		const bl = Math.hypot(bx, by);
		const cd = r / Math.sin(theta / 2);
		const c = { x: x1 + (bx / bl) * cd, y: y1 + (by / bl) * cd };
		const a1 = Math.atan2(t1.y - c.y, t1.x - c.x);
		const a2 = Math.atan2(t2.y - c.y, t2.x - c.x);
		let delta = a2 - a1;
		while (delta > Math.PI) {
			delta -= 2 * Math.PI;
		}
		while (delta <= -Math.PI) {
			delta += 2 * Math.PI;
		}
		this.ellipseUser(m, c.x, c.y, r, r, 0, a1, a1 + delta, delta < 0);
	}
}

/**
 * One flattened subpath: `pts` holds `x0, y0, x1, y1, ...` in device space.
 * `smooth[i]` marks vertex `i` as an interior point of a subdivided curve
 * (a stroker joins there without a visible corner), and `closed` records a
 * `closePath()`.
 */
export interface Polyline {
	pts: number[];
	smooth: boolean[];
	closed: boolean;
}

/**
 * Flattens device-space segments into polylines, subdividing each cubic
 * into `n` uniform steps where `n` bounds the chord error by `tolerance`
 * (the standard second-difference estimate), or as `cubicSegments` decides
 * when given (a renderer's own subdivision rule). A segment after a `Z` without
 * an intervening `M` starts a new subpath at the closed subpath's start, as
 * in Canvas and SVG.
 */
export function flattenPath(
	segs: ReadonlyArray<PathSeg>,
	tolerance: number,
	cubicSegments?: (x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => number,
): Polyline[] {
	const out: Polyline[] = [];
	let cur: Polyline | null = null;
	let sx = 0;
	let sy = 0;
	let lx = 0;
	let ly = 0;
	const begin = (x: number, y: number): Polyline => {
		const p: Polyline = { pts: [x, y], smooth: [false], closed: false };
		out.push(p);
		return p;
	};
	for (const s of segs) {
		switch (s.t) {
			case 'M':
				cur = begin(s.x, s.y);
				sx = lx = s.x;
				sy = ly = s.y;
				break;
			case 'L':
				if (!cur) {
					cur = begin(sx, sy);
				}
				cur.pts.push(s.x, s.y);
				cur.smooth.push(false);
				lx = s.x;
				ly = s.y;
				break;
			case 'C': {
				if (!cur) {
					cur = begin(sx, sy);
				}
				const ddx = Math.max(Math.abs(lx - 2 * s.x1 + s.x2), Math.abs(s.x1 - 2 * s.x2 + s.x));
				const ddy = Math.max(Math.abs(ly - 2 * s.y1 + s.y2), Math.abs(s.y1 - 2 * s.y2 + s.y));
				const dd = Math.hypot(ddx, ddy);
				const n = cubicSegments
					? cubicSegments(lx, ly, s.x1, s.y1, s.x2, s.y2, s.x, s.y)
					: Math.max(1, Math.min(1000, Math.ceil(Math.sqrt((0.75 * dd) / tolerance))));
				for (let i = 1; i <= n; i++) {
					const t = i / n;
					const u = 1 - t;
					const a = u * u * u;
					const b = 3 * u * u * t;
					const c = 3 * u * t * t;
					const d = t * t * t;
					cur.pts.push(a * lx + b * s.x1 + c * s.x2 + d * s.x, a * ly + b * s.y1 + c * s.y2 + d * s.y);
					cur.smooth.push(i < n);
				}
				lx = s.x;
				ly = s.y;
				break;
			}
			case 'Z':
				if (cur) {
					cur.closed = true;
					cur = null;
					lx = sx;
					ly = sy;
				}
				break;
		}
	}
	return out;
}

/**
 * Point-in-path test over flattened polylines (each implicitly closed), by
 * ray casting towards +x with the given fill rule, in device space.
 */
export function pointInPolylines(polys: ReadonlyArray<Polyline>, x: number, y: number, rule: CanvasFillRule): boolean {
	let winding = 0;
	let crossings = 0;
	for (const poly of polys) {
		const p = poly.pts;
		const n = p.length / 2;
		if (n < 2) {
			continue;
		}
		for (let i = 0; i < n; i++) {
			const x0 = p[i * 2];
			const y0 = p[i * 2 + 1];
			const j = i + 1 < n ? i + 1 : 0;
			const x1 = p[j * 2];
			const y1 = p[j * 2 + 1];
			if (y0 <= y ? y1 > y : y1 <= y) {
				const xi = x0 + ((y - y0) * (x1 - x0)) / (y1 - y0);
				if (xi > x) {
					crossings++;
					winding += y1 > y0 ? 1 : -1;
				}
			}
		}
	}
	return rule === 'evenodd' ? (crossings & 1) === 1 : winding !== 0;
}
