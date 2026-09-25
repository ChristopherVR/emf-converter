/**
 * A software rasteriser that reproduces what Windows GDI paints for its
 * vector primitives, pixel for pixel, fitted against real GDI output (see
 * `scripts/gdi-fixtures/GdiFixtures.cs`, category `gdi-raster`).
 *
 * Everything works in GDI's own device precision: 28.4 fixed point
 * ("FIX", 1/16 of a pixel, stored here as plain integers), with pixel `x`
 * CENTRED on device coordinate `x` (so FIX `16 * x`). The pieces:
 *
 *   - {@link fillPolygonSpans}: polygon fill, ALTERNATE (even-odd) or
 *     WINDING (non-zero). A pixel is inside when its centre is, with GDI's
 *     half-open convention: an edge is active on a scanline from its top
 *     (inclusive) to its bottom (exclusive), and a span covers pixels from
 *     its left crossing (inclusive) to its right crossing (exclusive). That
 *     is what drops the right column and bottom row of an integer
 *     rectangle. Crossings are computed exactly (rational arithmetic on the
 *     FIX coordinates), never by stepping a rounded DDA.
 *   - {@link cosmeticLine}: GDI's one-pixel line, Grid Intersect
 *     Quantisation (GIQ): a pixel is lit when the line passes through the
 *     diamond `|dx| + |dy| <= 1/2` around its centre and leaves it again
 *     (the diamond holding the end point is not lit, so a polyline never
 *     paints a joint twice). Diamonds are half open: their bottom and right
 *     corners belong to them, their edges do not, except for exact
 *     diagonals, where GDI's octant normalisation shows through (see
 *     `diamondRule`). For integer end points this is Bresenham with ties
 *     rounded towards the smaller minor coordinate.
 *   - {@link flattenBezier}: GDI's fixed-point hybrid forward differencing
 *     (HFD) Bezier flattener, bit exact: an 18.14 set-up with lazy step
 *     halving, then a 15.17 adaptive stepper that halves the step when the
 *     second differences exceed 64 FIX and doubles it back when they would
 *     stay under 16.
 *   - {@link ellipseBeziers}: the four Beziers GDI builds for an ellipse
 *     from its inclusive bounding box, with GDI's own per-point rounding
 *     (the control distance is `4/3 (sqrt 2 - 1)` of the half axis; the
 *     vertical controls and the left/top mid points round down, the
 *     horizontal controls and the right/bottom mid points up).
 *
 * Output is a list of horizontal pixel spans ({@link SpanList}); painting
 * them onto a canvas (with the active ROP2 and clip) is the caller's job
 * (`emf-gdi-raster-paint.ts`).
 *
 * @module gdi-raster
 */

/** Horizontal pixel spans: triplets `(y, x0, x1)` with `x1` exclusive, in the order they were produced. */
export class SpanList {
	/** Packed `(y, x0, x1)` triplets; only the first `length * 3` entries are valid. */
	data: Int32Array = new Int32Array(96);
	/** Number of spans. */
	length = 0;

	/** Appends the span `x0 <= x < x1` on row `y` (ignored when empty). */
	add(y: number, x0: number, x1: number): void {
		if (x1 <= x0) {
			return;
		}
		const n = this.length * 3;
		// Extend the previous span when this one continues it (a stroke adds
		// its pixels one at a time).
		if (n > 0 && this.data[n - 3] === y && this.data[n - 1] === x0) {
			this.data[n - 1] = x1;
			return;
		}
		if (n + 3 > this.data.length) {
			const grown = new Int32Array(this.data.length * 2);
			grown.set(this.data);
			this.data = grown;
		}
		this.data[n] = y;
		this.data[n + 1] = x0;
		this.data[n + 2] = x1;
		this.length++;
	}

	/** Appends every span of `other`. */
	append(other: SpanList): void {
		for (let i = 0; i < other.length * 3; i += 3) {
			this.add(other.data[i], other.data[i + 1], other.data[i + 2]);
		}
	}

	/** The bounding box of all spans, or `null` when empty. `x1`/`y1` exclusive. */
	bounds(): { x0: number; y0: number; x1: number; y1: number } | null {
		if (this.length === 0) {
			return null;
		}
		let x0 = Infinity;
		let y0 = Infinity;
		let x1 = -Infinity;
		let y1 = -Infinity;
		const d = this.data;
		for (let i = 0; i < this.length * 3; i += 3) {
			if (d[i] < y0) y0 = d[i];
			if (d[i] + 1 > y1) y1 = d[i] + 1;
			if (d[i + 1] < x0) x0 = d[i + 1];
			if (d[i + 2] > x1) x1 = d[i + 2];
		}
		return { x0, y0, x1, y1 };
	}
}

/** Rounds a device coordinate (in pixels) to GDI's 28.4 fixed point. */
export function toFix(v: number): number {
	return Math.round(v * 16);
}

/** `Math.floor(a / b)` for integers with `b > 0`, exact for |a| < 2^53. */
function floorDiv(a: number, b: number): number {
	return Math.floor(a / b);
}

/** `ceil(a / b)` for integers with `b > 0`. */
function ceilDiv(a: number, b: number): number {
	return -Math.floor(-a / b);
}

// ---------------------------------------------------------------------------
// Polygon fill
// ---------------------------------------------------------------------------

/**
 * Scan converts closed polygons (each a flat `[x0, y0, x1, y1, ...]` array
 * of FIX coordinates; the closing edge is implied) with GDI's fill rule
 * and pixel-inclusion convention (see the module doc). `winding` selects
 * WINDING (non-zero) over ALTERNATE (even-odd). Spans are clipped to rows
 * `clipY0 <= y < clipY1`.
 */
export function fillPolygonSpans(
	polys: ArrayLike<number>[],
	winding: boolean,
	out: SpanList = new SpanList(),
	clipY0 = -Infinity,
	clipY1 = Infinity,
): SpanList {
	// Edge table: [yTop, yBot, xTop, yTopExact, dx, dy, dir] per edge, where
	// the edge runs from (xa, ya) to (xb, yb) with ya < yb.
	const edges: number[][] = [];
	let minY = Infinity;
	let maxY = -Infinity;
	for (const p of polys) {
		const n = p.length >> 1;
		if (n < 2) {
			continue;
		}
		for (let i = 0; i < n; i++) {
			const j = i + 1 === n ? 0 : i + 1;
			const xa = p[i * 2];
			const ya = p[i * 2 + 1];
			const xb = p[j * 2];
			const yb = p[j * 2 + 1];
			if (ya === yb) {
				continue;
			}
			const dir = yb > ya ? 1 : -1;
			const x0 = dir > 0 ? xa : xb;
			const y0 = dir > 0 ? ya : yb;
			const x1 = dir > 0 ? xb : xa;
			const y1 = dir > 0 ? yb : ya;
			// Rows whose centre (FIX 16 * y) satisfies y0 <= 16y < y1.
			const rTop = ceilDiv(y0, 16);
			const rBot = ceilDiv(y1, 16); // exclusive
			if (rBot <= rTop) {
				continue;
			}
			edges.push([rTop, rBot, x0, y0, x1 - x0, y1 - y0, dir]);
			if (rTop < minY) minY = rTop;
			if (rBot > maxY) maxY = rBot;
		}
	}
	if (edges.length === 0) {
		return out;
	}
	edges.sort((a, b) => a[0] - b[0]);
	const yStart = Math.max(minY, Math.ceil(clipY0));
	const yEnd = Math.min(maxY, Math.floor(clipY1));
	const active: number[][] = [];
	let next = 0;
	const xs: number[] = [];
	const dirs: number[] = [];
	while (next < edges.length && edges[next][1] <= yStart) {
		next++;
	}
	for (let y = yStart; y < yEnd; y++) {
		while (next < edges.length && edges[next][0] <= y) {
			if (edges[next][1] > y) {
				active.push(edges[next]);
			}
			next++;
		}
		// Drop finished edges.
		for (let i = active.length - 1; i >= 0; i--) {
			if (active[i][1] <= y || active[i][0] > y) {
				if (active[i][1] <= y) {
					active.splice(i, 1);
				}
			}
		}
		xs.length = 0;
		dirs.length = 0;
		const fy = y * 16;
		for (const e of active) {
			if (e[0] > y) {
				continue;
			}
			// First pixel column whose centre is at or right of the crossing:
			// crossing x = x0 + (fy - y0) * dx / dy (FIX); column = ceil(x / 16).
			const num = e[2] * e[5] + (fy - e[3]) * e[4];
			xs.push(ceilDiv(num, e[5] * 16));
			dirs.push(e[6]);
		}
		const n = xs.length;
		if (n < 2) {
			continue;
		}
		// Insertion sort (active lists are short), carrying directions.
		for (let i = 1; i < n; i++) {
			const x = xs[i];
			const d = dirs[i];
			let j = i - 1;
			while (j >= 0 && xs[j] > x) {
				xs[j + 1] = xs[j];
				dirs[j + 1] = dirs[j];
				j--;
			}
			xs[j + 1] = x;
			dirs[j + 1] = d;
		}
		if (!winding) {
			for (let i = 0; i + 1 < n; i += 2) {
				out.add(y, xs[i], xs[i + 1]);
			}
		} else {
			let w = 0;
			let start = 0;
			for (let i = 0; i < n; i++) {
				const before = w;
				w += dirs[i];
				if (before === 0 && w !== 0) {
					start = xs[i];
				} else if (before !== 0 && w === 0) {
					out.add(y, start, xs[i]);
				}
			}
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Cosmetic (one pixel) lines: GIQ
// ---------------------------------------------------------------------------

/** Diamond boundary parts, relative to the pixel centre (y grows downwards). */
const enum Part {
	T = 1,
	B = 2,
	L = 4,
	R = 8,
	TL = 16,
	TR = 32,
	BL = 64,
	BR = 128,
}

/**
 * Which boundary parts of a pixel's diamond belong to it, for a line of
 * direction (`dx`, `dy`). Fitted against real GDI output: the bottom and
 * right corners for every non-diagonal line; an exact 45 degree line runs
 * along diamond edges, where GDI's octant-normalised stepping includes a
 * direction-dependent set.
 */
function diamondRule(dx: number, dy: number): number {
	if (Math.abs(dx) !== Math.abs(dy)) {
		return Part.B | Part.R;
	}
	if (dy > 0) {
		return Part.B;
	}
	return dx > 0 ? Part.R | Part.BR : Part.L | Part.BL;
}

/**
 * Whether the point (`u`/`den`, `v`/`den`) FIX, relative to a pixel centre,
 * lies in that pixel's half-open diamond (`|u| + |v| <= 8`, boundary per
 * `rule`). `den > 0`.
 */
function inDiamond(u: number, v: number, den: number, rule: number): boolean {
	const s = Math.abs(u) + Math.abs(v);
	const lim = 8 * den;
	if (s < lim) {
		return true;
	}
	if (s > lim) {
		return false;
	}
	let part: number;
	if (u === 0) {
		part = v < 0 ? Part.T : Part.B;
	} else if (v === 0) {
		part = u < 0 ? Part.L : Part.R;
	} else if (u < 0) {
		part = v < 0 ? Part.TL : Part.BL;
	} else {
		part = v < 0 ? Part.TR : Part.BR;
	}
	return (rule & part) !== 0;
}

/**
 * Rasterises GDI's cosmetic line from (`x0`, `y0`) to (`x1`, `y1`) (FIX),
 * calling `plot(x, y)` for every lit pixel in drawing order. The pixel whose
 * diamond holds the end point is not lit (see the module doc).
 */
export function cosmeticLine(
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	plot: (x: number, y: number) => void,
): void {
	const dx = x1 - x0;
	const dy = y1 - y0;
	if (dx === 0 && dy === 0) {
		return;
	}
	const rule = diamondRule(dx, dy);
	const xMajor = Math.abs(dx) >= Math.abs(dy);
	// Work along the major axis `a`, minor `b`; `real` maps (a, b) offsets
	// back to (x, y) for the diamond test.
	const a0 = xMajor ? x0 : y0;
	const b0 = xMajor ? y0 : x0;
	const a1 = xMajor ? x1 : y1;
	const b1 = xMajor ? y1 : x1;
	const sa = a1 > a0 ? 1 : -1;
	const D = Math.abs(a1 - a0); // denominator: b(a) = b0 + (a - a0) * db / da
	const dbs = (b1 - b0) * sa; // numerator step per unit a (times sa), over D
	const diagonal = Math.abs(dx) === Math.abs(dy);
	const aMin = Math.min(a0, a1);
	const aMax = Math.max(a0, a1);
	// Diamond test for an offset along the major (`u`) and minor (`v`) axes.
	const test = (u: number, v: number, den: number) =>
		xMajor ? inDiamond(u, v, den, rule) : inDiamond(v, u, den, rule);
	// Candidate major coordinates, in drawing order.
	const first = sa > 0 ? floorDiv(aMin, 16) - 1 : ceilDiv(aMax, 16) + 1;
	const last = sa > 0 ? ceilDiv(aMax, 16) + 1 : floorDiv(aMin, 16) - 1;
	for (let A = first; sa > 0 ? A <= last : A >= last; A += sa) {
		const ca = A * 16;
		// b at a = ca, times D: bN / D.
		const bN = b0 * D + (ca - a0) * dbs;
		const approx = bN / D / 16;
		const Bmid = Math.round(approx);
		for (let Bc = Bmid - 1; Bc <= Bmid + 1; Bc++) {
			const cb = Bc * 16;
			// Offset of the line from the centre along b at a = ca, times D.
			const dN = bN - cb * D;
			// Segment's a-range relative to ca.
			const umin = aMin - ca;
			const umax = aMax - ca;
			let hit: boolean;
			if (!diagonal) {
				// |slope| < 1: |u| + |d + m u| has its single minimum at the
				// point of the segment nearest u = 0; the segment meets the
				// diamond exactly when that point is in it.
				const us = Math.max(umin, Math.min(0, umax));
				hit = test(us * D, dN + us * dbs, D);
			} else {
				// |slope| = 1: d is an integer and the minimum is flat between
				// u = 0 and u = -d / m; test both ends and the middle (scaled
				// by 2, as the middle may be a half integer).
				const m = dbs / D;
				const d = dN / D;
				const ua = Math.max(umin, Math.min(0, umax));
				const ub = Math.max(umin, Math.min(-d / m, umax));
				hit = test(2 * ua, 2 * (d + m * ua), 2) || test(2 * ub, 2 * (d + m * ub), 2) || test(ua + ub, 2 * d + m * (ua + ub), 2);
			}
			if (!hit) {
				continue;
			}
			// The pixel is not lit when the end point lies in its diamond.
			if (test(a1 - ca, b1 - cb, 1)) {
				continue;
			}
			if (xMajor) {
				plot(A, Bc);
			} else {
				plot(Bc, A);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Bezier flattening (GDI's fixed-point HFD)
// ---------------------------------------------------------------------------

const HFD_INITIAL_SHIFT = 10;
const HFD_ADDITIONAL_SHIFT = 3;
const HFD_TEST_INITIAL = 6 * 0x2aa0;
const HFD_TEST_NORMAL = HFD_TEST_INITIAL * 8;

/** Arithmetic shift right that is exact beyond 32 bits. */
function sar(v: number, n: number): number {
	return Math.floor(v / 2 ** n);
}

/** One coordinate's HFD basis. */
class HfdBasis {
	e0: number;
	e1: number;
	e2: number;
	e3: number;

	constructor(p0: number, p1: number, p2: number, p3: number) {
		const s = 2 ** HFD_INITIAL_SHIFT;
		this.e0 = p0 * s;
		this.e1 = (p3 - p0) * s;
		this.e2 = 6 * (p1 - p2 - p2 + p3) * s;
		this.e3 = 6 * (p0 - p1 - p1 + p2) * s;
	}

	lazyHalve(cShift: number): void {
		this.e2 = sar(this.e2 + this.e3, 1);
		this.e1 = sar(this.e1 - sar(this.e2, cShift), 1);
	}

	steadyState(cShift: number): void {
		const k = 2 ** HFD_ADDITIONAL_SHIFT;
		this.e0 *= k;
		this.e1 *= k;
		const l = cShift - HFD_ADDITIONAL_SHIFT;
		if (l < 0) {
			this.e2 *= 2 ** -l;
			this.e3 *= 2 ** -l;
		} else {
			this.e2 = sar(this.e2, l);
			this.e3 = sar(this.e3, l);
		}
	}

	halve(): void {
		this.e2 = sar(this.e2 + this.e3, 3);
		this.e1 = sar(this.e1 - this.e2, 1);
		this.e3 = sar(this.e3, 2);
	}

	double(): void {
		this.e1 += this.e1 + this.e2;
		this.e3 *= 4;
		this.e2 = this.e2 * 8 - this.e3;
	}

	step(): void {
		this.e0 += this.e1;
		const t = this.e2;
		this.e1 += t;
		this.e2 += t - this.e3;
		this.e3 = t;
	}

	error(): number {
		return Math.max(Math.abs(this.e2), Math.abs(this.e3));
	}

	parentErrorDividedBy4(): number {
		return Math.max(Math.abs(this.e3), Math.abs(this.e2 + this.e2 - this.e3));
	}

	value(): number {
		const total = HFD_INITIAL_SHIFT + HFD_ADDITIONAL_SHIFT;
		return sar(this.e0 + 2 ** (total - 1), total);
	}
}

/**
 * Flattens the cubic Bezier `p0..p3` (FIX) exactly as GDI does, appending
 * the resulting points AFTER `p0` (the start point is the caller's current
 * point) to `out` as flat `x, y` pairs. `tolerance` scales both HFD error
 * tests: 1 is GDI's; GDI+ flattens with the same fixed-point HFD at 3/8 of
 * it (see `GDIPLUS_HFD_TOLERANCE`, emf-plus-raster.ts).
 */
export function flattenBezier(
	p0x: number,
	p0y: number,
	p1x: number,
	p1y: number,
	p2x: number,
	p2y: number,
	p3x: number,
	p3y: number,
	out: number[],
	tolerance: number = 1,
): void {
	const testInitial = HFD_TEST_INITIAL * tolerance;
	const testNormal = HFD_TEST_NORMAL * tolerance;
	const x = new HfdBasis(p0x, p1x, p2x, p3x);
	const y = new HfdBasis(p0y, p1y, p2y, p3y);
	let cSteps = 1;
	let cShift = 0;
	while (
		cShift < 40 &&
		(x.error() > testInitial * 2 ** cShift || y.error() > testInitial * 2 ** cShift)
	) {
		cShift += 2;
		x.lazyHalve(cShift);
		y.lazyHalve(cShift);
		cSteps *= 2;
	}
	x.steadyState(cShift);
	y.steadyState(cShift);
	for (let guard = 0; cSteps > 0 && guard < 1 << 20; guard++) {
		if (Math.max(x.error(), y.error()) > testNormal) {
			x.halve();
			y.halve();
			cSteps *= 2;
		}
		while (
			cSteps % 2 === 0 &&
			x.parentErrorDividedBy4() <= testNormal / 4 &&
			y.parentErrorDividedBy4() <= testNormal / 4
		) {
			x.double();
			y.double();
			cSteps /= 2;
		}
		cSteps--;
		x.step();
		y.step();
		out.push(x.value(), y.value());
	}
}

// ---------------------------------------------------------------------------
// Ellipse geometry
// ---------------------------------------------------------------------------

/** 4/3 (sqrt 2 - 1): the Bezier control distance of a quarter circle. */
const KAPPA = 0.5522847498307936;

/**
 * A box in device FIX as GDI holds it: the corner `A` that the logical
 * (left, top) maps to, plus the edge vectors `ex` (towards logical right)
 * and `ey` (towards logical bottom). An axis-aligned box `l..r` x `t..b` is
 * `A = (l, t)`, `ex = (r - l, 0)`, `ey = (0, b - t)`; under a rotated or
 * skewed world transform it is the parallelogram GDI transforms the box
 * into (`A`, `B = A + ex` and `D = A + ey` mapped individually, the fourth
 * corner implied).
 */
export interface FixBox {
	ax: number;
	ay: number;
	exx: number;
	exy: number;
	eyx: number;
	eyy: number;
}

/** The axis-aligned {@link FixBox} for the inclusive box `l..r` x `t..b` (FIX). */
export function axisBox(l: number, t: number, r: number, b: number): FixBox {
	return { ax: l, ay: t, exx: r - l, exy: 0, eyx: 0, eyy: b - t };
}

/**
 * The 13 points (`[x0, y0, ..., x12, y12]`, four cubic Beziers, the last
 * point equal to the first) of the path GDI builds for the ellipse inscribed
 * in `box`: starting at the (logical) right mid point and running towards
 * the top first, counter-clockwise on screen for an unmirrored box. Each
 * point is `A + f(ex) + g(ey)`, where `f` and `g` apply GDI's own rounding
 * to each vector component separately (fitted against `GetPath` output for
 * 1500 random axis-aligned boxes and 200 rotated/skewed ones, all exact):
 * the control distance is `KAPPA` of the half axis, the vertical-type
 * controls and the left/top mid points round down, the horizontal-type
 * controls and the right/bottom mid points up, and the second half of the
 * ellipse is the first half reflected through the centre.
 */
export function ellipseBeziersBox(box: FixBox): number[] {
	const half = (v: number, up: boolean) => (up ? Math.ceil(v / 2) : Math.floor(v / 2));
	// Offsets along a component of ex (horizontal type) and ey (vertical type).
	const hMidLo = (v: number) => half(v, false); // top mid
	const hMidHi = (v: number) => half(v, true); // bottom mid
	const hCtl = (v: number) => Math.floor(v / 2) + Math.ceil(KAPPA * Math.ceil(v / 2)); // right control
	const hCtl2 = (v: number) => Math.ceil(v / 2) - Math.ceil(KAPPA * Math.ceil(v / 2)); // left control
	const vMidLo = (v: number) => half(v, false); // left mid
	const vMidHi = (v: number) => half(v, true); // right mid
	const vCtl = (v: number) => Math.floor(v / 2) - Math.floor(KAPPA * Math.floor(v / 2)); // upper control
	const vCtlR = (v: number) => v - vCtl(v); // lower control
	const zero = () => 0;
	const full = (v: number) => v;
	const { ax, ay, exx, exy, eyx, eyy } = box;
	const out: number[] = [];
	const P = (gx: (v: number) => number, gy: (v: number) => number) => {
		out.push(ax + gx(exx) + gy(eyx), ay + gx(exy) + gy(eyy));
	};
	P(full, vMidHi);
	P(full, vCtl);
	P(hCtl, zero);
	P(hMidLo, zero);
	P(hCtl2, zero);
	P(zero, vCtl);
	P(zero, vMidLo);
	P(zero, vCtlR);
	P(hCtl2, full);
	P(hMidHi, full);
	P(hCtl, full);
	P(full, vCtlR);
	P(full, vMidHi);
	return out;
}

/** {@link ellipseBeziersBox} for the axis-aligned inclusive box `l..r` x `t..b` (FIX). */
export function ellipseBeziers(l: number, t: number, r: number, b: number): number[] {
	return ellipseBeziersBox(axisBox(l, t, r, b));
}

/**
 * Flattens a run of Beziers (`1 + 3n` points, flat pairs) into a polyline
 * (flat pairs, first point included). Each Bezier is flattened from its own
 * stored start point, as GDI flattens a path.
 */
export function flattenBezierPath(pts: ArrayLike<number>): number[] {
	const out: number[] = [pts[0], pts[1]];
	for (let i = 2; i + 5 < pts.length; i += 6) {
		flattenBezier(pts[i - 2], pts[i - 1], pts[i], pts[i + 1], pts[i + 2], pts[i + 3], pts[i + 4], pts[i + 5], out);
	}
	return out;
}

/**
 * The rounded rectangle GDI builds for the inclusive box `l..r` x `t..b`
 * with corner ellipse `cw` x `ch` (all FIX, `l <= r`, `t <= b`, corners
 * non-negative), as a closed figure of four corner Beziers joined by
 * straight edges: flat `[x, y, ...]` points where each corner contributes
 * `start, c1, c2, end` and the edges are the implied lines between corners.
 * The top-right corner is computed and the other three are its mirror
 * images; the corner size is clamped to the box. Fitted against `GetPath`
 * output (595 of 600 random fractional boxes exact; the rest differ by one
 * FIX, 1/16 pixel, in a corner end point, which never occurs for integer
 * device coordinates).
 */
export function roundRectCorners(l: number, t: number, r: number, b: number, cw: number, ch: number): number[] {
	const w = r - l;
	const h = b - t;
	const ew = Math.min(Math.abs(cw), w);
	const eh = Math.min(Math.abs(ch), h);
	const hy = Math.floor(h / 2) - Math.floor((h - eh) / 2);
	const topX = Math.floor(r - ew / 2);
	const hx = r - topX;
	const q = [r, t + hy, r, t + hy - Math.floor(KAPPA * hy), r - hx + Math.ceil(KAPPA * hx), t, topX, t];
	const mx = (x: number) => l + r - x;
	const my = (y: number) => t + b - y;
	return [
		// top right: right edge -> top edge
		q[0], q[1], q[2], q[3], q[4], q[5], q[6], q[7],
		// top left: top edge -> left edge
		mx(q[6]), q[7], mx(q[4]), q[5], mx(q[2]), q[3], mx(q[0]), q[1],
		// bottom left: left edge -> bottom edge
		mx(q[0]), my(q[1]), mx(q[2]), my(q[3]), mx(q[4]), my(q[5]), mx(q[6]), my(q[7]),
		// bottom right: bottom edge -> right edge
		q[6], my(q[7]), q[4], my(q[5]), q[2], my(q[3]), q[0], my(q[1]),
	];
}

// ---------------------------------------------------------------------------
// Arcs
// ---------------------------------------------------------------------------

/** GDI's arc trigonometry step: a 128-entry table per turn. */
const TRIG_STEP = (2 * Math.PI) / 128;

/**
 * `cos`/`sin` the way GDI evaluates them for arcs: linear interpolation in a
 * 128-entry table per turn (so points sit slightly inside the true ellipse,
 * by up to 1 - cos(pi / 128) of the radius). Fitted against `GetPath`: arc
 * start points match GDI 793 of 800 times (767 with exact trigonometry),
 * the rest within 0.02 FIX of a rounding tie.
 */
function tableTrig(fn: (a: number) => number): (a: number) => number {
	return (a: number) => {
		let b = a % (2 * Math.PI);
		if (b < 0) {
			b += 2 * Math.PI;
		}
		const i = Math.floor(b / TRIG_STEP);
		const f = b / TRIG_STEP - i;
		return fn(i * TRIG_STEP) * (1 - f) + fn((i + 1) * TRIG_STEP) * f;
	};
}

/** GDI's table cosine (see {@link tableTrig}). */
export const tableCos = tableTrig(Math.cos);
/** GDI's table sine (see {@link tableTrig}). */
export const tableSin = tableTrig(Math.sin);

/**
 * The Bezier pieces GDI builds for `AngleArc` (measured against `GetPath`),
 * as angle pairs in degrees (counter-clockwise, y up) in travel order, from
 * `startDeg` sweeping `sweepDeg` (counter-clockwise when positive):
 *
 *   - a sweep of a full turn or more is drawn as the remainder
 *     `R = sweep mod 360` (same sign) first, then for each full turn the
 *     arc from the remainder's end back round to the start angle and on
 *     again to the remainder's end;
 *   - each such arc is cut at the multiples of 90 degrees strictly inside
 *     it, into `floor(hi / 90) - floor(lo / 90) + 1` pieces: an arc whose
 *     upper end is itself a multiple of 90 degrees ends with a zero-length
 *     piece;
 *   - `first` marks each arc's first piece, which GDI always builds with
 *     the circular-arc formula ({@link circularArcBezier}); a later piece
 *     spanning a whole quadrant reuses the full ellipse's own Bezier for
 *     that quadrant instead.
 */
export function angleArcPieces(startDeg: number, sweepDeg: number): Array<{ from: number; to: number; first: boolean }> {
	const out: Array<{ from: number; to: number; first: boolean }> = [];
	const arc = (from: number, to: number): void => {
		const lo = Math.min(from, to);
		const hi = Math.max(from, to);
		const pieces = Math.floor(hi / 90) - Math.floor(lo / 90) + 1;
		const cuts: number[] = [];
		for (let q = Math.floor(lo / 90) + 1; q * 90 < hi; q++) {
			cuts.push(q * 90);
		}
		if (to < from) {
			cuts.reverse();
		}
		const stops = [from, ...cuts, to];
		while (stops.length - 1 < pieces) {
			stops.push(to);
		}
		for (let i = 0; i + 1 < stops.length; i++) {
			out.push({ from: stops[i], to: stops[i + 1], first: i === 0 });
		}
	};
	const sign = sweepDeg < 0 ? -1 : 1;
	const turns = Math.min(8, Math.trunc(Math.abs(sweepDeg) / 360));
	const end = startDeg + sweepDeg - sign * turns * 360;
	arc(startDeg, end);
	for (let t = 1; t <= turns; t++) {
		arc(end + sign * 360 * (t - 1), startDeg + sign * 360 * t);
		arc(startDeg + sign * 360 * t, end + sign * 360 * t);
	}
	return out;
}

/**
 * The standard circular-arc Bezier from `fromDeg` to `toDeg` (at most a
 * quadrant) on the ellipse about (`cx`, `cy`) with radii `rx`, `ry` (y down),
 * with GDI's table sine and cosine: `[c1x, c1y, c2x, c2y, x, y]`, unrounded.
 */
export function circularArcBezier(cx: number, cy: number, rx: number, ry: number, fromDeg: number, toDeg: number): number[] {
	const a = (fromDeg * Math.PI) / 180;
	const b = (toDeg * Math.PI) / 180;
	const k = (4 / 3) * Math.tan((b - a) / 4);
	const ax = cx + rx * tableCos(a);
	const ay = cy - ry * tableSin(a);
	const bx = cx + rx * tableCos(b);
	const by = cy - ry * tableSin(b);
	return [ax - k * rx * tableSin(a), ay - k * ry * tableCos(a), bx + k * rx * tableSin(b), by + k * ry * tableCos(b), bx, by];
}

/**
 * GDI's `AngleArc` Beziers in device FIX for the axis-aligned circle box
 * `box` (the logical circle's bounding box, mapped): the start point, then
 * one Bezier per {@link angleArcPieces} piece. A whole-quadrant piece other
 * than an arc's first takes the full ellipse's Bezier for that quadrant
 * ({@link ellipseBeziersBox}; a clockwise one with its vertical control
 * distances rounded up, as for `Arc`), every other piece the circular-arc
 * formula on the box's exact centre and radii, each point rounded to FIX.
 */
export function angleArcFix(box: FixBox, startDeg: number, sweepDeg: number): number[] {
	const l = Math.min(box.ax, box.ax + box.exx);
	const t = Math.min(box.ay, box.ay + box.eyy);
	const w = Math.abs(box.exx);
	const h = Math.abs(box.eyy);
	const cx = l + w / 2;
	const cy = t + h / 2;
	const E = ellipseBeziers(l, t, l + w, t + h);
	const Ecw = E.slice();
	const d = Math.ceil(KAPPA * Math.floor(h / 2));
	Ecw[3] = Ecw[1] - d;
	Ecw[11] = Ecw[13] - d;
	Ecw[15] = Ecw[13] + d;
	Ecw[23] = Ecw[1] + d;
	const start = (startDeg * Math.PI) / 180;
	const out: number[] = [Math.round(cx + (w / 2) * tableCos(start)), Math.round(cy - (h / 2) * tableSin(start))];
	for (const p of angleArcPieces(startDeg, sweepDeg)) {
		const span = p.to - p.from;
		if (!p.first && Math.abs(span) === 90 && p.from % 90 === 0) {
			const q = Math.min(p.from, p.to) / 90;
			const qi = (((q % 4) + 4) % 4) * 6;
			if (span > 0) {
				out.push(E[qi + 2], E[qi + 3], E[qi + 4], E[qi + 5], E[qi + 6], E[qi + 7]);
			} else {
				out.push(Ecw[qi + 4], Ecw[qi + 5], Ecw[qi + 2], Ecw[qi + 3], Ecw[qi], Ecw[qi + 1]);
			}
			continue;
		}
		for (const v of circularArcBezier(cx, cy, w / 2, h / 2, p.from, p.to)) {
			out.push(Math.round(v));
		}
	}
	return out;
}

/**
 * The open run of Beziers (`1 + 3n` points, flat FIX pairs) GDI builds for
 * `Arc`/`ArcTo`/`Chord`/`Pie` on the inclusive box `l..r` x `t..b` (FIX)
 * from the radial through (`xs`, `ys`) to the radial through (`xe`, `ye`)
 * (FIX, any distance from the centre), counter-clockwise on screen when
 * `clockwise` is false (`AD_COUNTERCLOCKWISE`, GDI's default).
 *
 * Structure (fitted against `GetPath` output): the arc is split at the
 * ellipse's quadrant boundaries; a whole quadrant reuses the full ellipse's
 * own Bezier ({@link ellipseBeziers}); a partial quadrant is the standard
 * arc Bezier (control distance `4/3 tan(delta / 4)` of the tangent) on an
 * ellipse centred at `(l + ceil(w / 2), t + ceil(h / 2))` with horizontal
 * radius `ceil(w / 2)` and vertical radius `floor(h / 2)` (`ceil` for a
 * clockwise arc), each point rounded to the nearest FIX. The radials'
 * angles are measured against the true centre and half axes. This matches
 * GDI's path exactly for about two arcs in three and otherwise differs by
 * one FIX (1/16 pixel) in a partial quadrant's control or end point.
 */
export function arcBeziers(
	l: number,
	t: number,
	r: number,
	b: number,
	xs: number,
	ys: number,
	xe: number,
	ye: number,
	clockwise: boolean,
): number[] {
	const w = r - l;
	const h = b - t;
	const Q = Math.PI / 2;
	const rx = Math.ceil(w / 2);
	const ry = clockwise ? Math.ceil(h / 2) : Math.floor(h / 2);
	const cx = l + Math.ceil(w / 2);
	const cy = t + Math.ceil(h / 2);
	const tcx = (l + r) / 2;
	const tcy = (t + b) / 2;
	const angle = (x: number, y: number) => Math.atan2(-(y - tcy) / (h / 2 || 1), (x - tcx) / (w / 2 || 1));
	const a0 = angle(xs, ys);
	let a1 = angle(xe, ye);
	const s = clockwise ? -1 : 1;
	if (s > 0) {
		while (a1 <= a0) a1 += 2 * Math.PI;
	} else {
		while (a1 >= a0) a1 -= 2 * Math.PI;
	}
	const px = (a: number) => cx + rx * tableCos(a);
	const py = (a: number) => cy - ry * tableSin(a);
	const E = ellipseBeziers(l, t, r, b);
	if (clockwise) {
		// A clockwise arc's whole quadrants round their vertical control
		// distances up (measured: 449 of 452 quadrants), the mirror image of
		// the counter-clockwise ellipse's rounding down.
		const fh = Math.floor((b - t) / 2);
		const d = Math.ceil(KAPPA * fh);
		E[3] = E[1] - d; // right, upper control
		E[11] = E[13] - d; // left, upper control
		E[15] = E[13] + d; // left, lower control
		E[23] = E[1] + d; // right, lower control
	}
	const out: number[] = [Math.round(px(a0)), Math.round(py(a0))];
	let a = a0;
	for (let guard = 0; guard < 8 && (s > 0 ? a < a1 - 1e-12 : a > a1 + 1e-12); guard++) {
		const next = s > 0 ? Math.floor(a / Q + 1e-9) * Q + Q : Math.ceil(a / Q - 1e-9) * Q - Q;
		const onBoundary = Math.abs(a / Q - Math.round(a / Q)) < 1e-9;
		if (onBoundary && (s > 0 ? next <= a1 + 1e-12 : next >= a1 - 1e-12)) {
			const qi = (((Math.round(Math.min(a, next) / Q) % 4) + 4) % 4) * 6;
			if (s > 0) {
				out.push(E[qi + 2], E[qi + 3], E[qi + 4], E[qi + 5], E[qi + 6], E[qi + 7]);
			} else {
				out.push(E[qi + 4], E[qi + 5], E[qi + 2], E[qi + 3], E[qi], E[qi + 1]);
			}
			a = next;
			continue;
		}
		const e = s > 0 ? Math.min(next, a1) : Math.max(next, a1);
		const k = (4 / 3) * Math.tan((e - a) / 4);
		out.push(
			Math.round(px(a) - k * rx * tableSin(a)),
			Math.round(py(a) - k * ry * tableCos(a)),
			Math.round(px(e) + k * rx * tableSin(e)),
			Math.round(py(e) + k * ry * tableCos(e)),
			Math.round(px(e)),
			Math.round(py(e)),
		);
		a = e;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** One figure of a {@link GdiRasterPath}: a flattened polyline in FIX, optionally closed. */
export interface GdiFigure {
	pts: number[];
	closed: boolean;
	/**
	 * Directions a wide pen uses instead of a flattened segment's own, keyed
	 * by the segment's first point index: the first and last segment of a
	 * flattened Bezier take its end tangents (GDI widens a curve with the
	 * tangents at its ends; measured on ellipse outlines).
	 */
	tangents?: Map<number, [number, number]>;
}

/**
 * A GDI path in device FIX, already flattened (Beziers go through
 * {@link flattenBezier} as they are added, which is exactly what GDI does
 * when it later fills or strokes the path).
 */
export class GdiRasterPath {
	figures: GdiFigure[] = [];
	private current: GdiFigure | null = null;

	/** Starts a new figure at (`x`, `y`). */
	moveTo(x: number, y: number): void {
		this.current = { pts: [x, y], closed: false };
		this.figures.push(this.current);
	}

	/** Adds a line to (`x`, `y`), starting a figure there when none is open. */
	lineTo(x: number, y: number): void {
		if (!this.current) {
			const last = this.lastPoint();
			this.moveTo(last ? last[0] : x, last ? last[1] : y);
		}
		this.current!.pts.push(x, y);
	}

	/** Adds a cubic Bezier from the current point. */
	bezierTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
		if (!this.current) {
			const last = this.lastPoint();
			this.moveTo(last ? last[0] : c1x, last ? last[1] : c1y);
		}
		const p = this.current!.pts;
		this.flattenInto(p[p.length - 2], p[p.length - 1], c1x, c1y, c2x, c2y, x, y);
	}

	/** Flattens one Bezier onto the open figure, recording its end tangents. */
	private flattenInto(x0: number, y0: number, c1x: number, c1y: number, c2x: number, c2y: number, x3: number, y3: number): void {
		const f = this.current!;
		const first = f.pts.length / 2 - 1;
		flattenBezier(x0, y0, c1x, c1y, c2x, c2y, x3, y3, f.pts);
		const last = f.pts.length / 2 - 2;
		if (last <= first) {
			return;
		}
		const tangent = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): [number, number] | null => {
			if (bx !== ax || by !== ay) return [bx - ax, by - ay];
			if (cx !== ax || cy !== ay) return [cx - ax, cy - ay];
			if (dx !== ax || dy !== ay) return [dx - ax, dy - ay];
			return null;
		};
		const t0 = tangent(x0, y0, c1x, c1y, c2x, c2y, x3, y3);
		const t1 = tangent(c2x, c2y, x3, y3, x3, y3, x3, y3) ?? tangent(c1x, c1y, x3, y3, x3, y3, x3, y3) ?? tangent(x0, y0, x3, y3, x3, y3, x3, y3);
		f.tangents ??= new Map();
		if (t0) f.tangents.set(first, t0);
		if (t1) f.tangents.set(last, t1);
	}

	/**
	 * Appends Beziers given as `1 + 3n` flat points; the first point is
	 * joined with a line (or starts the figure when `move`).
	 */
	addBeziers(pts: ArrayLike<number>, move: boolean): void {
		if (move) {
			this.moveTo(pts[0], pts[1]);
		} else {
			this.lineTo(pts[0], pts[1]);
		}
		for (let i = 2; i + 5 < pts.length; i += 6) {
			this.flattenInto(pts[i - 2], pts[i - 1], pts[i], pts[i + 1], pts[i + 2], pts[i + 3], pts[i + 4], pts[i + 5]);
		}
	}

	/** Closes the open figure (the next drawing call starts a new one). */
	closeFigure(): void {
		if (this.current) {
			this.current.closed = true;
			this.current = null;
		}
	}

	/** Appends every figure of `other`. */
	append(other: GdiRasterPath): void {
		for (const f of other.figures) {
			this.figures.push({ pts: f.pts.slice(), closed: f.closed, tangents: f.tangents && new Map(f.tangents) });
		}
		this.current = null;
	}

	private lastPoint(): [number, number] | null {
		const f = this.figures[this.figures.length - 1];
		if (!f) {
			return null;
		}
		return f.closed ? [f.pts[0], f.pts[1]] : [f.pts[f.pts.length - 2], f.pts[f.pts.length - 1]];
	}
}

/** Fills every figure of `path` (each implicitly closed). */
export function fillPathSpans(path: GdiRasterPath, winding: boolean, out?: SpanList): SpanList {
	return fillPolygonSpans(
		path.figures.map((f) => f.pts),
		winding,
		out,
	);
}

// ---------------------------------------------------------------------------
// Cosmetic strokes and styles
// ---------------------------------------------------------------------------

/**
 * The on/off run lengths, in pixels, of GDI's cosmetic pen styles (measured
 * against real GDI: the pattern advances one step per lit pixel, restarts
 * at every figure and `MoveTo`, and carries on across consecutive `LineTo`
 * calls). `null` for a solid style.
 */
export function cosmeticStyle(style: number, userStyle?: number[]): number[] | null {
	switch (style & 0x0f) {
		case 1:
			return [18, 6];
		case 2:
			return [3, 3];
		case 3:
			return [9, 6, 3, 6];
		case 4:
			return [9, 3, 3, 3, 3, 3];
		case 7:
			// PS_USERSTYLE: GDI's cosmetic style unit is three pixels.
			return userStyle && userStyle.length > 0 && userStyle.some((v) => v > 0)
				? userStyle.map((v) => Math.max(0, v) * 3)
				: null;
		case 8:
			return [1, 1];
		default:
			return null;
	}
}

/**
 * The dash/gap lengths, in device pixels along the line, GDI uses for a
 * GEOMETRIC (wide) pen of style `flags` and device width `width` (measured
 * against real GDI): the stock styles are their cosmetic patterns' shapes
 * in units of the pen width (`PS_DASH` 3:1, `PS_DOT` 1:1, `PS_DASHDOT`
 * 3:1:1:1, `PS_DASHDOTDOT` 3:1:1:1:1:1), a `PS_USERSTYLE` array is in
 * logical units (`userScale` converts them), and anything else is solid
 * (`null`), `PS_ALTERNATE` included.
 */
export function geometricStyle(flags: number, width: number, userStyle?: number[], userScale = 1): number[] | null {
	const w = Math.max(width, 1);
	switch (flags & 0x0f) {
		case 1:
			return [3 * w, w];
		case 2:
			return [w, w];
		case 3:
			return [3 * w, w, w, w];
		case 4:
			return [3 * w, w, w, w, w, w];
		case 7:
			return userStyle && userStyle.some((v) => v > 0) ? userStyle.map((v) => Math.max(0, v) * userScale) : null;
		default:
			return null;
	}
}

/**
 * Whether the gaps of a styled cosmetic pen are painted with the background
 * colour when the background mode is `OPAQUE`: true for the stock dashed
 * styles, false for `PS_ALTERNATE` and `PS_USERSTYLE`, whose gaps GDI
 * leaves untouched.
 */
export function styleGapsUseBackground(style: number): boolean {
	const s = style & 0x0f;
	return s >= 1 && s <= 4;
}

/** A dash-pattern cursor that survives across calls (consecutive `LineTo`s share one). */
export interface StyleState {
	/** Pixels already drawn along the current figure's pattern. */
	pos: number;
}

/**
 * Rasterises the cosmetic outline of `path`: every figure's segments with
 * {@link cosmeticLine}, closed figures back to their start. With `pattern`
 * (see {@link cosmeticStyle}) the lit pixels alternate between `on`
 * (dashes) and `off` (gaps); `style.pos` is the pattern position to start
 * from and is advanced, and is reset to 0 at each figure after the first
 * when `resetPerFigure`.
 */
export function strokeCosmetic(
	path: GdiRasterPath,
	on: SpanList,
	off: SpanList | null,
	pattern: number[] | null,
	style: StyleState = { pos: 0 },
	resetPerFigure = true,
): void {
	let period = 0;
	if (pattern) {
		for (const v of pattern) {
			period += v;
		}
	}
	const plot = (x: number, y: number) => {
		if (!pattern || period === 0) {
			on.add(y, x, x + 1);
			return;
		}
		let p = style.pos % period;
		style.pos++;
		for (let i = 0; i < pattern.length; i++) {
			if (p < pattern[i]) {
				if (i % 2 === 0) {
					on.add(y, x, x + 1);
				} else if (off) {
					off.add(y, x, x + 1);
				}
				return;
			}
			p -= pattern[i];
		}
	};
	path.figures.forEach((f, fi) => {
		if (fi > 0 && resetPerFigure) {
			style.pos = 0;
		}
		const p = f.pts;
		for (let i = 0; i + 3 < p.length; i += 2) {
			cosmeticLine(p[i], p[i + 1], p[i + 2], p[i + 3], plot);
		}
		if (f.closed && p.length >= 4) {
			const n = p.length;
			if (p[n - 2] !== p[0] || p[n - 1] !== p[1]) {
				cosmeticLine(p[n - 2], p[n - 1], p[0], p[1], plot);
			}
		}
	});
}
