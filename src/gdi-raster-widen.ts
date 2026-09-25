/**
 * Wide (geometric) pens for the GDI rasteriser: turns a {@link GdiRasterPath}
 * into the outline figures GDI fills for a pen wider than one pixel.
 *
 * Everything here was fitted against real GDI (`WidenPath` + `GetPath`
 * under a 1/16 world scale, which reads the widened outline back at 28.4
 * precision; the WINDING fill of that outline is exactly what GDI paints
 * when it strokes directly):
 *
 * - The pen is a polygon. Up to six pixels (a width under 6.5 px) it is
 *   one of Hobby's digital pens (`HOBBY`, vertices on the half-pixel grid);
 *   wider, it is GDI's flattened ellipse of the pen box, of which only the
 *   first half (right, then over the top) is flattened, the second half
 *   being its reflection through the centre, and whose vertical half axis
 *   snaps to whole pixels (`penPolygon`).
 * - A segment's draw vertices are the pen vertices furthest to its left
 *   and right (`drawVertices`, with GDI's tie-break for segments parallel
 *   to a pen edge).
 * - Round caps and round joins trace the pen vertices between two side
 *   points; a vertex is pulled one 28.4 unit towards the pen centre when
 *   the point it is placed around lies exactly on a pixel.
 * - A pen with round caps and round joins (every `CreatePen` pen) runs its
 *   sides through the draw vertices rounded to the half-pixel grid. Other
 *   pens run their sides through the "perpendicular" (`flatVector`): the
 *   pen boundary point where the tangent is parallel to the segment,
 *   interpolated parabolically between the draw vertex and its neighbour,
 *   rounded to the half-pixel grid with a bias that depends on the
 *   segment's direction. Square caps extend by the half width along the
 *   segment (`squareExtension`), miter joins meet at the rounded
 *   intersection of the two side lines.
 * - An open figure becomes one outline: start cap, right side forward
 *   (with a join at each vertex), end cap, left side backward. A closed
 *   figure becomes two: the right side forward and the left side backward,
 *   each with a join at every vertex. The inner side of a join passes
 *   through the vertex itself.
 * - Geometric dash patterns cut the figure into pieces by exact arc length,
 *   the cut points rounded to 28.4; each piece is widened as an open figure
 *   with the directions of the path segments it lies on. With round or
 *   square caps the stock styles shorten every dash by the pen width.
 * - The first and last flattened segment of a Bezier take their draw
 *   vertices from the curve's end tangents (`GdiFigure.tangents`).
 *
 * Callers apply two record-level rules measured on direct drawing: a
 * `Rectangle` stroked with a wide `CreatePen` pen uses miter joins, and an
 * `Ellipse` or `RoundRect` is stroked with round caps and joins whatever
 * the pen's style (`paintRasterPath`).
 *
 * Measured against 15,000 random two-segment polylines (widths 2 to 12 px,
 * endpoints on whole pixels), the share that fills exactly GDI's pixels:
 * round caps and joins (every `CreatePen` pen) 3,000 of 3,000; square caps
 * with round joins, and flat or square caps with bevel or miter joins,
 * 99.3% to 99.5%; round caps with bevel or miter joins 97.5%; flat caps
 * with round joins 97.2%; 299 of 300 random dashed polylines. The residual
 * is GDI's inclusion of a pen vertex exactly at the end of a join or cap
 * arc (mostly for the flattened pens of 7 px and more), and the half-pixel
 * rounding of the perpendicular for 8 px pens.
 *
 * @module gdi-raster-widen
 */

import { flattenBezierPath, ellipseBeziers, type GdiRasterPath } from './gdi-raster';

/** Cap style (`PS_ENDCAP_*`). */
export type CapStyle = 'round' | 'square' | 'flat';
/** Join style (`PS_JOIN_*`). */
export type JoinStyle = 'round' | 'bevel' | 'miter';

/** Options for {@link widenPath}. */
export interface WidenOptions {
	/** Pen width in device FIX (1/16 pixel). */
	width: number;
	cap: CapStyle;
	join: JoinStyle;
	/** Miter limit (ratio of miter length to half the pen width); GDI's default is 10. */
	miterLimit: number;
	/**
	 * Dash/gap lengths in device FIX along the path (geometric pen styles),
	 * or `null` for a solid pen. Each dash is widened as its own open figure,
	 * with caps.
	 */
	dashes?: number[] | null;
	/**
	 * Whether each dash is shortened by the pen width so its round or square
	 * caps end where the dash does: true for the stock styles (`PS_DASH` to
	 * `PS_DASHDOTDOT`), false for `PS_USERSTYLE` (measured).
	 */
	shortenDashes?: boolean;
}

type Pt = [number, number];

/**
 * Hobby's digital pens for widths of one to six pixels, as GDI holds them
 * (FIX, centred on the pen position, counter-clockwise on screen starting
 * at the top right). Measured with `WidenPath`: the front of a round cap
 * shows these vertices exactly.
 */
const HOBBY: Pt[][] = [
	[[0, -8], [-8, 0], [0, 8], [8, 0]],
	[[8, -16], [-8, -16], [-16, 0], [-8, 16], [8, 16], [16, 0]],
	[[8, -24], [-8, -24], [-24, -8], [-24, 8], [-8, 24], [8, 24], [24, 8], [24, -8]],
	[[8, -32], [-8, -32], [-24, -24], [-32, -8], [-32, 8], [-24, 24], [-8, 32], [8, 32], [24, 24], [32, 8], [32, -8], [24, -24]],
	[[8, -40], [-8, -40], [-24, -32], [-32, -24], [-40, -8], [-40, 8], [-32, 24], [-24, 32], [-8, 40], [8, 40], [24, 32], [32, 24], [40, 8], [40, -8], [32, -24], [24, -32]],
	[[8, -48], [-8, -48], [-24, -40], [-40, -24], [-48, -8], [-48, 8], [-40, 24], [-24, 40], [-8, 48], [8, 48], [24, 40], [40, 24], [48, 8], [48, -8], [40, -24], [24, -40]],
];

/** Widths (FIX) below this use a Hobby pen. */
const HOBBY_LIMIT = 104;

/**
 * Half-pixel offsets GDI adds to the perpendicular of a flattened pen of
 * this many whole pixels, per half of the pen (`+` for a draw vertex in the
 * flattened first half, `-` in the reflected half). Measured; widths not
 * listed use none.
 */
const FLAT_VECTOR_OFFSET: Record<number, Pt> = { 7: [0, 0.5], 8: [0, 0.5], 9: [0.5, 0.5], 10: [0.5, 0] };

const penCache = new Map<number, Pt[]>();

/**
 * GDI's pen polygon for a pen `width` FIX wide (see the module doc), in
 * pen order (counter-clockwise on screen, the second half the reflection of
 * the first).
 */
export function penPolygon(width: number): Pt[] {
	const cached = penCache.get(width);
	if (cached) {
		return cached;
	}
	let pen: Pt[];
	if (width < HOBBY_LIMIT) {
		const n = Math.min(6, Math.max(1, Math.floor(width / 16 + 0.5)));
		pen = HOBBY[n - 1];
	} else {
		const rx = Math.ceil(width / 2);
		const ry = 8 * Math.floor((width + 9) / 16);
		const f = flattenBezierPath(ellipseBeziers(-rx, -ry, rx, ry));
		// The flattened first half runs from (rx, 0) over the top to (-rx, 0).
		const half: Pt[] = [];
		for (let i = 0; i + 1 < f.length; i += 2) {
			half.push([f[i], f[i + 1]]);
			if (i > 0 && f[i + 1] === 0) {
				break;
			}
		}
		half.pop();
		pen = [...half, ...half.map((p): Pt => [0 - p[0] || 0, 0 - p[1] || 0])];
	}
	penCache.set(width, pen);
	return pen;
}

/**
 * The pen's draw vertices for a segment running (`dx`, `dy`): the indices
 * of the vertex furthest to the left of the segment (in screen terms, the
 * side the path's left edge runs along) and of its reflection, furthest
 * right. A segment parallel to a pen edge touches two vertices: GDI takes
 * the one further along the segment's direction normalised to point
 * rightwards (or downwards when steeper than 2:1).
 */
export function drawVertices(pen: readonly Pt[], dx: number, dy: number): [number, number] {
	const n = pen.length;
	const axisVertex = pen.some((q) => q[1] === 0);
	const steep = Math.abs(dy) > 2 * Math.abs(dx) || (Math.abs(dy) === 2 * Math.abs(dx) && axisVertex);
	const s = (steep ? dy < 0 : dx < 0 || (dx === 0 && dy < 0)) ? -1 : 1;
	let best = 0;
	let bestH = -Infinity;
	let bestAlong = 0;
	for (let i = 0; i < n; i++) {
		const h = dy * pen[i][0] - dx * pen[i][1];
		const along = s * (dx * pen[i][0] + dy * pen[i][1]);
		if (h > bestH || (h === bestH && along > bestAlong)) {
			bestH = h;
			best = i;
			bestAlong = along;
		}
	}
	return [best, (best + n / 2) % n];
}

/** `v` rounded to the half-pixel (8 FIX) grid, halves away from zero. */
function halfPixel(v: number): number {
	return Math.sign(v) * 8 * Math.floor((Math.abs(v) + 4) / 8);
}

/**
 * GDI's perpendicular for a segment running (`dx`, `dy`) with a pen
 * `width` FIX wide: the offset (FIX, on the half-pixel grid) of the right
 * side of a flat-, square- or bevel/miter-joined stroke; the left side is
 * its negation. The pen boundary point whose tangent is parallel to the
 * segment is found by parabolic interpolation of the pen's support around
 * the draw vertex, then rounded to the half-pixel grid after a half-unit
 * bias along the segment's (normalised) direction.
 */
export function flatVector(width: number, dx0: number, dy0: number): Pt {
	let dx = dx0;
	let dy = dy0;
	const flip = dx < 0 || (dx === 0 && dy < 0);
	if (flip) {
		dx = -dx;
		dy = -dy;
	}
	const pen = penPolygon(width);
	const n = pen.length;
	const nx = -dy;
	const ny = dx;
	let best = 0;
	let bh = -Infinity;
	for (let i = 0; i < n; i++) {
		const h = nx * pen[i][0] + ny * pen[i][1];
		if (h > bh) {
			bh = h;
			best = i;
		}
	}
	const P = pen[(best + n - 1) % n];
	const N = pen[(best + 1) % n];
	const D = pen[best];
	const hP = nx * P[0] + ny * P[1];
	const hN = nx * N[0] + ny * N[1];
	const [B, hB, hS] = hP >= hN ? [P, hP, hN] : [N, hN, hP];
	const den = 2 * (bh - hB + (bh - hS));
	const w = den === 0 ? 0 : (hB - hS) / den;
	const off = width % 16 === 0 && width >= HOBBY_LIMIT ? FLAT_VECTOR_OFFSET[width / 16] : undefined;
	const sgn = best < n / 2 ? 1 : -1;
	const ox = off ? sgn * off[0] : 0;
	const oy = off ? sgn * off[1] : 0;
	const r = (v: number) => 8 * Math.floor((v + 4) / 8);
	const vx = r(D[0] + (B[0] - D[0]) * w + 0.5 * Math.sign(dy) + ox);
	const vy = r(D[1] + (B[1] - D[1]) * w + 0.5 * Math.sign(dx) + oy);
	return flip ? [-vx, -vy] : [vx, vy];
}

/** GDI's square-cap extension for a segment running (`dx`, `dy`): half the width along it, rounded to FIX. */
export function squareExtension(width: number, dx: number, dy: number): Pt {
	const len = Math.hypot(dx, dy);
	const r = width / 2;
	return [Math.floor((dx / len) * r + 0.5), Math.floor((dy / len) * r + 0.5)];
}

/** Turn sign at a join: `cross(a, b)`, and for an exact reversal the side GDI treats as outer. */
function turnSign(ax: number, ay: number, bx: number, by: number): number {
	const c = ax * by - ay * bx;
	if (c !== 0) {
		return c;
	}
	if (ax * bx + ay * by >= 0) {
		return 0;
	}
	const sx = ax >= 0 ? 1 : -1;
	const sy = ay >= 0 ? 1 : -1;
	const swap = Math.abs(ay) > Math.abs(ax) || (Math.abs(ay) === Math.abs(ax) && ay > 0);
	return sx * sy < 0 !== swap ? -1 : 1;
}

interface Seg {
	dx: number;
	dy: number;
	/** Left and right draw vertex indices. */
	L: number;
	R: number;
	/** Right perpendicular (`flatVector`). */
	v: Pt;
	/** Square-cap extension. */
	e: Pt;
}

/** Builds one pen's outlines; `out` collects finished figures. */
class Outliner {
	private readonly pen: Pt[];
	private readonly n: number;
	private readonly rr: boolean;
	private readonly roundJoinSides: boolean;
	private readonly maxX: number;
	private pts: Pt[] = [];

	constructor(
		private readonly opts: WidenOptions,
		private readonly out: number[][],
	) {
		this.pen = penPolygon(opts.width);
		this.n = this.pen.length;
		this.rr = opts.cap === 'round' && opts.join === 'round';
		this.roundJoinSides = opts.join === 'round' && opts.cap !== 'flat';
		this.maxX = Math.max(...this.pen.map((q) => Math.abs(q[0])));
	}

	/**
	 * Segment `a`..`b`. `dir` (a dash's path segment) replaces its direction;
	 * `drawDir` (a curve's end tangent) only picks the draw vertices, the
	 * perpendicular following the chord (measured on Bezier ends).
	 */
	private seg(a: Pt, b: Pt, dir?: Pt, drawDir?: Pt): Seg {
		const dx = dir ? dir[0] : b[0] - a[0];
		const dy = dir ? dir[1] : b[1] - a[1];
		const d = drawDir ?? [dx, dy];
		const [L, R] = drawVertices(this.pen, d[0], d[1]);
		return { dx, dy, L, R, v: flatVector(this.opts.width, dx, dy), e: squareExtension(this.opts.width, dx, dy) };
	}

	private push(p: Pt, v: Pt): void {
		this.pts.push([p[0] + v[0], p[1] + v[1]]);
	}

	/** Pen vertex `k` placed around `p` (pulled one unit inwards when `p` is on a pixel). */
	private penAt(p: Pt, k: number): void {
		const q = this.pen[k];
		if ((p[0] & 15) === 0 && (p[1] & 15) === 0) {
			this.push(p, [q[0] - Math.sign(q[0]), q[1] - Math.sign(q[1])]);
		} else {
			this.push(p, q);
		}
	}

	/** Pen vertices from index `a` to index `b` in pen order, ends included on request. */
	private walk(p: Pt, a: number, b: number, inclA: boolean, inclB: boolean): void {
		if (inclA) {
			this.penAt(p, a);
		}
		if (a === b) {
			return;
		}
		for (let k = (a + 1) % this.n; k !== b; k = (k + 1) % this.n) {
			this.penAt(p, k);
		}
		if (inclB) {
			this.penAt(p, b);
		}
	}

	/**
	 * Pen vertices angularly inside the wedge from side offset `A` to side
	 * offset `B` (pen order, decreasing screen angle), in that order. A
	 * vertex exactly on `A`'s ray is included when `startIncl`, one on `B`'s
	 * ray when `endIncl`.
	 */
	private wedge(p: Pt, A: Pt, B: Pt, startIncl: boolean, endIncl: boolean): void {
		const TWO = Math.PI * 2;
		const aA = Math.atan2(A[1], A[0]);
		const angleOf = (Q: Pt) => {
			let v = (aA - Math.atan2(Q[1], Q[0])) % TWO;
			if (v < 0) {
				v += TWO;
			}
			return v;
		};
		const onRay = (R: Pt, Q: Pt) => R[0] * Q[1] - R[1] * Q[0] === 0 && R[0] * Q[0] + R[1] * Q[1] > 0;
		const W = onRay(A, B) ? TWO : angleOf(B);
		const list: [number, number][] = [];
		for (let k = 0; k < this.n; k++) {
			const Q = this.pen[k];
			if (onRay(A, Q)) {
				if (startIncl) {
					list.push([0, k]);
				}
			} else if (onRay(B, Q)) {
				if (endIncl) {
					list.push([W, k]);
				}
			} else {
				const a = angleOf(Q);
				if (a < W) {
					list.push([a, k]);
				}
			}
		}
		list.sort((x, y) => x[0] - y[0]);
		for (const [, k] of list) {
			this.penAt(p, k);
		}
	}

	/** Side offset of segment `s` at a join. */
	private joinSide(s: Seg, side: 'L' | 'R'): Pt {
		if (this.roundJoinSides) {
			const q = this.pen[side === 'L' ? s.L : s.R];
			return [halfPixel(q[0]), halfPixel(q[1])];
		}
		return side === 'R' ? s.v : [-s.v[0], -s.v[1]];
	}

	/** Side offset of segment `s` at a cap. */
	private capSide(s: Seg, side: 'L' | 'R'): Pt {
		if (this.rr) {
			const q = this.pen[side === 'L' ? s.L : s.R];
			return [halfPixel(q[0]), halfPixel(q[1])];
		}
		return side === 'R' ? s.v : [-s.v[0], -s.v[1]];
	}

	/** A cap at `p` from the `from` side of `s` round to the other side (`start`: around the back). */
	private cap(p: Pt, s: Seg, start: boolean): void {
		const from: 'L' | 'R' = start ? 'L' : 'R';
		const to: 'L' | 'R' = start ? 'R' : 'L';
		const { cap } = this.opts;
		if (cap === 'round') {
			this.push(p, this.capSide(s, from));
			if (this.rr) {
				this.walk(p, s[from], s[to], false, false);
			} else {
				const A = this.capSide(s, from);
				this.wedge(p, A, [-A[0], -A[1]], true, false);
			}
			this.push(p, this.capSide(s, to));
			return;
		}
		const sv = this.capSide(s, from);
		const ev = this.capSide(s, to);
		if (cap === 'square') {
			const e: Pt = start ? [-s.e[0], -s.e[1]] : s.e;
			this.push(p, [sv[0] + e[0], sv[1] + e[1]]);
			this.push(p, [ev[0] + e[0], ev[1] + e[1]]);
		} else {
			this.push(p, sv);
			this.push(p, ev);
		}
	}

	/**
	 * The join at `p` on `side`, coming along `a` and leaving along `b` in
	 * outline order (for the left side, walked backwards, `a` is the later
	 * segment).
	 */
	private join(p: Pt, a: Seg, b: Seg, side: 'L' | 'R', outer: boolean): void {
		const { join, cap, width, miterLimit } = this.opts;
		const sa = this.joinSide(a, side);
		const sb = this.joinSide(b, side);
		const Da = side === 'R' ? a.R : a.L;
		const Db = side === 'R' ? b.R : b.L;
		if (this.roundJoinSides && Da === Db) {
			this.push(p, sa);
			return;
		}
		this.push(p, sa);
		if (outer) {
			if (join === 'round') {
				if (this.roundJoinSides) {
					// The left side (walked backwards) keeps the pen's extreme
					// vertex after a steep segment (measured).
					const q = this.pen[Db];
					const steep = Math.abs(b.dy) > Math.abs(b.dx);
					const incl = side === 'L' && steep && Math.abs(q[0]) === this.maxX && q[0] * q[1] <= 0;
					this.walk(p, Da, Db, false, incl);
				} else {
					const anti = sa[0] === -sb[0] && sa[1] === -sb[1];
					this.wedge(p, sa, sb, !anti, !anti);
				}
			} else if (join === 'miter') {
				const m = miterPoint(sa, [a.dx, a.dy], sb, [b.dx, b.dy], width, miterLimit);
				if (m) {
					this.push(p, m);
				}
			}
		} else {
			this.pts.push([p[0], p[1]]);
			if (join === 'round' && cap === 'flat') {
				// Flat-capped round joins loop round the pen on the inner side too.
				this.push(p, sb);
				this.wedge(p, sb, sa, false, false);
				this.push(p, sa);
				this.pts.push([p[0], p[1]]);
			}
		}
		this.push(p, sb);
	}

	/** Emits the current figure. */
	private flush(): void {
		const out: number[] = [];
		let lx = NaN;
		let ly = NaN;
		for (const [x, y] of this.pts) {
			if (x !== lx || y !== ly) {
				out.push(x, y);
				lx = x;
				ly = y;
			}
		}
		while (out.length >= 4 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) {
			out.length -= 2;
		}
		if (out.length >= 6) {
			this.out.push(out);
		}
		this.pts = [];
	}

	/**
	 * Outlines an open polyline (distinct consecutive points). `dirs` (a
	 * dash's segment directions) replaces each segment's own direction, and
	 * lets a single point stand for a zero-length dash along `dirs[0]`;
	 * `draws` (curve end tangents) picks draw vertices only.
	 */
	open(P: Pt[], dirs?: (Pt | undefined)[], draws?: (Pt | undefined)[]): void {
		if (P.length < 2 && !dirs?.[0]) {
			this.dot(P[0]);
			return;
		}
		const segs: Seg[] = [];
		for (let i = 0; i + 1 < P.length; i++) {
			segs.push(this.seg(P[i], P[i + 1], dirs?.[i], draws?.[i]));
		}
		if (segs.length === 0) {
			const s = this.seg(P[0], P[0], dirs?.[0] as Pt, draws?.[0]);
			this.cap(P[0], s, true);
			this.cap(P[0], s, false);
			this.flush();
			return;
		}
		this.cap(P[0], segs[0], true);
		for (let i = 0; i + 1 < segs.length; i++) {
			const s = segs[i];
			const t = segs[i + 1];
			const tr = turnSign(s.dx, s.dy, t.dx, t.dy);
			if (tr === 0) {
				this.push(P[i + 1], this.joinSide(s, 'R'));
			} else {
				this.join(P[i + 1], s, t, 'R', tr < 0);
			}
		}
		this.cap(P[P.length - 1], segs[segs.length - 1], false);
		for (let i = segs.length - 1; i > 0; i--) {
			const s = segs[i];
			const t = segs[i - 1];
			const tr = turnSign(t.dx, t.dy, s.dx, s.dy);
			if (tr === 0) {
				this.push(P[i], this.joinSide(s, 'L'));
			} else {
				this.join(P[i], s, t, 'L', tr > 0);
			}
		}
		this.flush();
	}

	/** Outlines a closed polygon (distinct consecutive points, not repeating the first). */
	closed(P: Pt[], draws?: (Pt | undefined)[]): void {
		const m = P.length;
		const segs: Seg[] = [];
		for (let i = 0; i < m; i++) {
			segs.push(this.seg(P[i], P[(i + 1) % m], undefined, draws?.[i]));
		}
		// Right side forward, starting at the second vertex.
		for (let j = 1; j <= m; j++) {
			const i = j % m;
			const s = segs[(i + m - 1) % m];
			const t = segs[i];
			const tr = turnSign(s.dx, s.dy, t.dx, t.dy);
			if (tr === 0) {
				this.push(P[i], this.joinSide(s, 'R'));
			} else {
				this.join(P[i], s, t, 'R', tr < 0);
			}
		}
		this.flush();
		// Left side backward, starting at the first vertex.
		for (let j = 0; j < m; j++) {
			const i = (m - j) % m;
			const s = segs[i];
			const t = segs[(i + m - 1) % m];
			const tr = turnSign(t.dx, t.dy, s.dx, s.dy);
			if (tr === 0) {
				this.push(P[i], this.joinSide(s, 'L'));
			} else {
				this.join(P[i], s, t, 'L', tr > 0);
			}
		}
		this.flush();
	}

	/** A zero-length figure: the whole pen for a round cap, nothing otherwise. */
	private dot(p: Pt): void {
		if (this.opts.cap !== 'round') {
			return;
		}
		for (let k = 0; k < this.n; k++) {
			this.push(p, this.pen[k]);
		}
		this.flush();
	}
}

/** A dash: its points and, per piece segment, the direction of the path segment it lies on. */
interface DashPiece {
	pts: Pt[];
	dirs: Pt[];
	/** Curve end tangents (draw vertices only) per piece segment. */
	draws: (Pt | undefined)[];
}

/**
 * Cuts a polyline into dash pieces of `dashes` (on, off, ...) FIX lengths
 * by exact arc length, the cut points rounded to 28.4. With round or
 * square caps (`shorten`, the pen width) GDI shortens every dash by the
 * pen width so the caps end where the dash does; a dash no longer than the
 * width becomes a single capped point.
 */
function dashPieces(P: Pt[], tangents: (Pt | undefined)[], pattern: number[], shorten: number): DashPiece[] {
	const out: DashPiece[] = [];
	const dashes: number[] = [];
	for (let i = 0; i < pattern.length; i += 2) {
		const on = pattern[i];
		const off = pattern[i + 1] ?? 0;
		const s = Math.min(on, shorten);
		dashes.push(on - s, off + s);
	}
	if (dashes.reduce((a, b) => a + b, 0) <= 0) {
		return [];
	}
	let idx = 0;
	let left = dashes[0];
	let on = true;
	let cur: DashPiece | null = { pts: [P[0]], dirs: [], draws: [] };
	for (let i = 0; i + 1 < P.length; i++) {
		const [x0, y0] = P[i];
		const [x1, y1] = P[i + 1];
		const dir: Pt = [x1 - x0, y1 - y0];
		const len = Math.hypot(dir[0], dir[1]);
		let t = 0;
		while (len - t > left || (left === 0 && on)) {
			t += left;
			const q: Pt = [Math.floor(x0 + (dir[0] * t) / len + 0.5), Math.floor(y0 + (dir[1] * t) / len + 0.5)];
			if (on && cur) {
				cur.pts.push(q);
				cur.dirs.push(dir);
				cur.draws.push(tangents[i]);
				out.push(cur);
				cur = null;
			} else {
				cur = { pts: [q], dirs: [], draws: [] };
			}
			on = !on;
			idx = (idx + 1) % dashes.length;
			left = dashes[idx];
		}
		left -= len - t;
		if (on && cur) {
			cur.pts.push(P[i + 1]);
			cur.dirs.push(dir);
			cur.draws.push(tangents[i]);
		}
	}
	if (on && cur && cur.dirs.length > 0) {
		out.push(cur);
	}
	return out;
}

/** `pts` (flat pairs) as points without consecutive duplicates. */
function distinct(pts: readonly number[]): Pt[] {
	const out: Pt[] = [];
	for (let i = 0; i + 1 < pts.length; i += 2) {
		const q: Pt = [pts[i], pts[i + 1]];
		const last = out[out.length - 1];
		if (!last || last[0] !== q[0] || last[1] !== q[1]) {
			out.push(q);
		}
	}
	return out;
}

/**
 * The outline figures (flat FIX pairs) whose WINDING fill is the stroke of
 * `path` with a wide pen, as GDI builds them (see the module doc).
 */
export function widenPath(path: GdiRasterPath, opts: WidenOptions): number[][] {
	const out: number[][] = [];
	const outliner = new Outliner(opts, out);
	const dashed = !!opts.dashes && opts.dashes.length > 0;
	for (const fig of path.figures) {
		// Distinct points, and per remaining segment the curve tangent GDI
		// widens it with (when it is a flattened Bezier's first or last).
		let P: Pt[] = [];
		const dirs: (Pt | undefined)[] = [];
		for (let i = 0; i + 1 < fig.pts.length; i += 2) {
			const q: Pt = [fig.pts[i], fig.pts[i + 1]];
			const last = P[P.length - 1];
			if (last && last[0] === q[0] && last[1] === q[1]) {
				continue;
			}
			if (last) {
				dirs.push(fig.tangents?.get(i / 2 - 1));
			}
			P.push(q);
		}
		if (P.length === 0) {
			continue;
		}
		const closed = fig.closed && P.length >= 2;
		if (closed && P.length >= 2 && P[0][0] === P[P.length - 1][0] && P[0][1] === P[P.length - 1][1]) {
			// The last segment becomes the closing one and keeps its direction.
			P = P.slice(0, -1);
		}
		if (dashed) {
			const run = closed ? [...P, P[0]] : P;
			const shorten = opts.cap === 'flat' || opts.shortenDashes === false ? 0 : opts.width;
			for (const piece of dashPieces(run, closed ? [...dirs, undefined] : dirs, opts.dashes as number[], shorten)) {
				// Drop repeated points, keeping each remaining segment's direction.
				const pts: Pt[] = [piece.pts[0]];
				const pdirs: Pt[] = [];
				const pdraws: (Pt | undefined)[] = [];
				for (let i = 1; i < piece.pts.length; i++) {
					const q = piece.pts[i];
					const last = pts[pts.length - 1];
					if (q[0] !== last[0] || q[1] !== last[1]) {
						pts.push(q);
						pdirs.push(piece.dirs[i - 1]);
						pdraws.push(piece.draws[i - 1]);
					}
				}
				outliner.open(pts, pdirs.length > 0 ? pdirs : [piece.dirs[0]], pdirs.length > 0 ? pdraws : [piece.draws[0]]);
			}
		} else if (closed && P.length >= 3) {
			outliner.closed(P, dirs);
		} else if (closed && P.length === 2) {
			outliner.open([P[0], P[1], P[0]]);
		} else {
			outliner.open(P, undefined, dirs);
		}
	}
	return out;
}

/**
 * The miter point (FIX offset from the join, rounded) where the side lines
 * `sa + t * da` and `sb + u * db` meet, or `null` when the miter would be
 * longer than `limit` half widths (GDI then bevels).
 */
function miterPoint(sa: Pt, da: Pt, sb: Pt, db: Pt, width: number, limit: number): Pt | null {
	const den = da[0] * db[1] - da[1] * db[0];
	if (den === 0) {
		return null;
	}
	const wx = sb[0] - sa[0];
	const wy = sb[1] - sa[1];
	const t = (wx * db[1] - wy * db[0]) / den;
	const mx = sa[0] + da[0] * t;
	const my = sa[1] + da[1] * t;
	if (Math.hypot(mx, my) > (limit * width) / 2) {
		return null;
	}
	return [Math.floor(mx + 0.5), Math.floor(my + 0.5)];
}
