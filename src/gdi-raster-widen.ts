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
 *   being its reflection through the centre, and whose two half axes are
 *   equal (`penPolygon`; measured over fractional widths too).
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
 * - Geometric dash patterns cut the figure into pieces by arc length, each
 *   segment measured from its vector cut down to whole pixels (when one
 *   logical unit is one pixel: `wholePixelDashVectors`), the cut points
 *   rounded to 28.4 at the same fraction of the real segment; each piece is
 *   widened as an open figure with the directions of the path segments it
 *   lies on, and a square cap's extension is scaled like the segment under
 *   the cut (real over measured length). With round or
 *   square caps the stock styles shorten every dash by the pen width.
 * - The first and last flattened segment of a Bezier take their draw
 *   vertices from the curve's end tangents (`GdiFigure.tangents`).
 * - The segments that come from a flattened curve (`GdiFigure.curveSegs`)
 *   behave as a smooth curve whatever the pen's cap and join: their sides
 *   rest on the pen's draw vertices, joins between two of them are always
 *   round and drop the pen loop on the inner side, and a curve end's
 *   perpendicular and square-cap extension follow its end tangent.
 *   Between two cubics the longer end tangent is used for both.
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
 * rounding of the perpendicular for 8 px pens (now a closed rule, `oddEdgeAdjustment`).
 *
 * @module gdi-raster-widen
 */

import { flattenBezierPath, ellipseBeziers, GdiRasterPath, type GdiFigure } from './gdi-raster';

/** Cap style (`PS_ENDCAP_*`). */
export type CapStyle = 'round' | 'square' | 'flat';
/** Join style (`PS_JOIN_*`). */
export type JoinStyle = 'round' | 'bevel' | 'miter';

/** Options for {@link widenPath}. */
export interface WidenOptions {
	/** Pen width in device FIX (1/16 pixel). */
	width: number;
	/** Device FIX height for an axis-aligned elliptical nib; defaults to width. */
	height?: number;
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
	/**
	 * Measure each path segment from its vector cut down to whole device
	 * pixels (GDI's rule when one logical unit is one device pixel; measured at
	 * that scale only, other scales stay exact): the dash pattern lays out
	 * along it, and a square cap's extension (half the width) is the segment's
	 * vector over the length of that cut vector.
	 */
	wholePixelDashVectors?: boolean;
	/**
	 * Unequal axis scales (device per logical unit along x and y): `dashes` are then in logical FIX and each segment is
	 * measured by its logical length (native WidenPath lays the pattern out in logical space).
	 */
	dashMetric?: [number, number];
	/**
	 * A rotated or sheared device matrix `[a, b, c, d]` (`x' = a x + c y`, `y' = b x + d y`): native WidenPath's pen is a
	 * circle in logical space (`width` and `dashes` are then in logical FIX). With `deviceNib` and round joins the path is
	 * widened in device space with the matrix's nib (`penPolygonMatrix`); otherwise it is mapped back through the inverse,
	 * widened in logical space and the outline mapped forward, which does not reproduce the device-space rounding rules.
	 */
	matrix?: [number, number, number, number];
	/** With `matrix`: widen in device space with the matrix's nib (`penPolygonMatrix`) instead of in logical space. */
	deviceNib?: boolean;
	/** Native Ellipse curve sides; retain the selected pen's inner triangle rule. */
	roundCurveJoins?: boolean;
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
 * Half-FIX offset GDI's perpendicular of a flattened pen carries on top of
 * the generic half-unit bias, per pen-edge channel. Measured by sweeping
 * the direction of a single flat-capped segment against native
 * `WidenPath` (whole-pixel end points, 600-80,000 directions per width) at
 * integer, fractional and wider-than-100-px widths: the interpolated
 * perpendicular is the point of a pen edge `D -> B` (support vertex to its
 * interpolation partner), and a channel whose edge extent `|B - D|` is odd
 * lands half a unit lower than the exact point (half a unit higher on the
 * pen's first edge, the one that ends at its start vertex). Even extents
 * need no adjustment. The earlier per-width table of fitted biases for
 * 7-100 px pens is this rule (it reproduced the table's entries wherever a
 * native direction could tell them apart), now valid for any width.
 */
function oddEdgeAdjustment(odd: boolean, firstEdge: boolean): number {
	return odd ? (firstEdge ? 0.5 : -0.5) : 0;
}

/** `floor(a / b)` for `b > 0`, exact beyond 2^53 where the operands need it. */
function floorDivision(a: number, b: number): number {
	if (Number.isSafeInteger(a) && Number.isSafeInteger(b)) {
		return Math.floor(a / b);
	}
	const A = BigInt(Math.round(a)), B = BigInt(Math.round(b));
	let q = A / B;
	if (A % B !== 0n && (A < 0n) !== (B < 0n)) {
		q -= 1n;
	}
	return Number(q);
}

const penCache = new Map<string, Pt[]>();

/**
 * GDI's pen polygon for a pen `width` FIX wide (see the module doc), in
 * pen order (counter-clockwise on screen, the second half the reflection of
 * the first).
 */
export function penPolygon(width: number, height = width): Pt[] {
	const key = `${width},${height}`;
	const cached = penCache.get(key);
	if (cached) {
		return cached;
	}
	let pen: Pt[];
	if (width === height && width < HOBBY_LIMIT) {
		const n = Math.min(6, Math.max(1, Math.floor(width / 16 + 0.5)));
		pen = HOBBY[n - 1];
	} else {
		const rx = Math.ceil(width / 2);
		const ry = Math.ceil(height / 2);
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
	penCache.set(key, pen);
	return pen;
}

const matrixPenCache = new Map<string, Pt[]>();

type Matrix = [number, number, number, number];

/**
 * The pen polygon for a pen `width` logical FIX wide under the device matrix `m` (native WidenPath, nib probe): GDI's
 * logical circle, its Bezier points mapped to device FIX and rounded, then flattened; the second half is the reflection of
 * the first. A matrix that flips orientation mirrors the logical circle so the pen still runs counter-clockwise.
 */
export function penPolygonMatrix(width: number, m: Matrix): Pt[] {
	const key = `${width},${m.join(',')}`;
	const cached = matrixPenCache.get(key);
	if (cached) {
		return cached;
	}
	const r = Math.ceil(width / 2);
	const mirror = m[0] * m[3] - m[1] * m[2] < 0 ? -1 : 1;
	const bez = ellipseBeziers(-r, -r, r, r);
	const dev: number[] = [];
	for (let i = 0; i < 14; i += 2) {
		const x = bez[i];
		const y = bez[i + 1] * mirror;
		dev.push(Math.round(m[0] * x + m[2] * y), Math.round(m[1] * x + m[3] * y));
	}
	const f = flattenBezierPath(dev);
	const half: Pt[] = [];
	for (let i = 0; i + 1 < f.length; i += 2) {
		half.push([f[i], f[i + 1]]);
	}
	half.pop();
	const pen = [...half, ...half.map((p): Pt => [0 - p[0] || 0, 0 - p[1] || 0])];
	matrixPenCache.set(key, pen);
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
export function drawVertices(pen: readonly Pt[], dx: number, dy: number, width = 1, height = width, matrix?: Matrix): [number, number] {
	const n = pen.length;
	const axisVertex = pen.some((q) => q[1] === 0);
	// Elliptical pens resolve parallel-edge ties in logical direction: the
	// 45-degree boundary becomes height/width in device coordinates.
	// Circular digital pens retain their measured 2:1 boundary.
	let yMagnitude = Math.abs(dy) * (width === height ? 1 : width);
	let xMagnitude = Math.abs(dx) * (width === height ? 2 : height);
	if (matrix) {
		// A general matrix: the 45-degree boundary is that of the logical direction.
		const det = matrix[0] * matrix[3] - matrix[1] * matrix[2];
		xMagnitude = Math.abs((matrix[3] * dx - matrix[2] * dy) / det);
		yMagnitude = Math.abs((-matrix[1] * dx + matrix[0] * dy) / det);
	}
	const steep = yMagnitude > xMagnitude || (yMagnitude === xMagnitude && axisVertex);
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
	return perpendicularVectors(width, dx0, dy0).v;
}

/** Rounded stroke sides and the unrounded tangent point used to select pen arcs. */
function perpendicularVectors(width: number, dx0: number, dy0: number, height = width, matrixPen?: readonly Pt[]): { v: Pt; ray: Pt } {
	let dx = dx0;
	let dy = dy0;
	const flip = dx < 0 || (dx === 0 && dy < 0);
	if (flip) {
		dx = -dx;
		dy = -dy;
	}
	const pen = matrixPen ?? penPolygon(width, height);
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
	if (flip && best === 0 && nx * pen[n - 1][0] + ny * pen[n - 1][1] === bh) {
		// A reversed segment parallel to the edge that closes the pen takes that edge's first vertex as the support.
		best = n - 1;
	}
	const P = pen[(best + n - 1) % n];
	const N = pen[(best + 1) % n];
	const D = pen[best];
	const hP = nx * P[0] + ny * P[1];
	const hN = nx * N[0] + ny * N[1];
	const [B, hB, hS] = hP >= hN ? [P, hP, hN] : [N, hN, hP];
	const den = 2 * (bh - hB + (bh - hS));
	const w = den === 0 ? 0 : (hB - hS) / den;
	const x = D[0] + (B[0] - D[0]) * w, y = D[1] + (B[1] - D[1]) * w;
	const signs = [dx === 0 ? 0 : Math.sign(dy), Math.sign(dx)];
	const firstEdge = best === 0 && hP >= hN;
	const num = hB - hS;
	const rounded = [0, 1].map((c) => {
		// floor((x + bias + 4) / 8) * 8 with x = D + (B - D) * num / den, exactly.
		const bias2 = signs[c] + 2 * oddEdgeAdjustment(Math.abs(B[c] - D[c]) % 2 === 1, firstEdge);
		if (den === 0) {
			return 8 * (c === 1 && dy < 0 ? Math.ceil((D[c] + bias2 / 2 + 4) / 8) - 1 : Math.floor((D[c] + bias2 / 2 + 4) / 8));
		}
		const top = D[c] * den + (B[c] - D[c]) * num;
		// A value exactly on a rounding boundary rounds up, except in y for a segment running upward on screen.
		return 8 * floorDivision(2 * top + den * (bias2 + 8) - (c === 1 && dy < 0 ? 1 : 0), 16 * den);
	});
	const vx = rounded[0], vy = rounded[1];
	return { v: flip ? [-vx, -vy] : [vx, vy], ray: flip ? [-x, -y] : [x, y] };
}

/** GDI's square-cap extension for a segment running (`dx`, `dy`): half the width along it, rounded to FIX. */
export function squareExtension(width: number, dx: number, dy: number, scale = 1, height = width, matrix?: Matrix, wholePixelNorm = false, symmetric = wholePixelNorm): Pt {
	if (matrix) {
		// Half the width along the logical direction, mapped to device.
		const det = matrix[0] * matrix[3] - matrix[1] * matrix[2];
		const lx = (matrix[3] * dx - matrix[2] * dy) / det;
		const ly = (-matrix[1] * dx + matrix[0] * dy) / det;
		const l = Math.hypot(lx, ly);
		const q = ((width / 2) * scale) / l;
		return [Math.floor((matrix[0] * lx + matrix[2] * ly) * q + 0.5), Math.floor((matrix[1] * lx + matrix[3] * ly) * q + 0.5)];
	}
	let len = width === height ? Math.hypot(dx, dy) : Math.hypot(dx, dy * width / height);
	if (wholePixelNorm && width === height) {
		// A curve end normalises its vector cut down to whole pixels (arithmetic shift of the components), as dashes measure segments.
		const whole = Math.hypot(Math.floor(dx / 16), Math.floor(dy / 16)) * 16;
		// A vector of less than a pixel (both components in 0..15) normalises to nothing: no extension.
		if (whole === 0) return [0, 0];
		len = whole;
	}
	const r = (width / 2) * scale;
	// Ties on a whole-pixel vector round away from zero.
	const round = symmetric ? (v: number) => Math.sign(v) * Math.floor(Math.abs(v) + 0.5) : (v: number) => Math.floor(v + 0.5);
	return [round((dx / len) * r), round((dy / len) * r)];
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
	/** Unrounded pen boundary point, before the stroke-side rounding bias. */
	vRaw: Pt;
	/** Square-cap extension. */
	e: Pt;
	/** The vector the extension and perpendicular follow. */
	pe: Pt;
	curveEnd: boolean;
	/** Which end of its cubic the tangent belongs to: 1 start, 2 end, 3 both. */
	role: number;
	/** Squared length of the curve end tangent (0 without one): a short tangent from rounded control points is unreliable. */
	tangentLength: number;
	/** The segment is a piece of a flattened curve (the pen then rests on its support vertices). */
	curve: boolean;
}

/** Builds one pen's outlines; `out` collects finished figures. */
class Outliner {
	private readonly pen: Pt[];
	private readonly n: number;
	private readonly rr: boolean;
	private readonly originalRoundJoinSides: boolean;
	private readonly maxX: number;
	private pts: Pt[] = [];

	constructor(
		private readonly opts: WidenOptions,
		private readonly out: number[][],
	) {
		this.pen = opts.matrix && opts.deviceNib ? penPolygonMatrix(opts.width, opts.matrix) : penPolygon(opts.width, opts.height);
		this.n = this.pen.length;
		this.rr = opts.cap === 'round' && opts.join === 'round';
		this.originalRoundJoinSides = opts.join === 'round' && opts.cap !== 'flat';
		this.maxX = Math.max(...this.pen.map((q) => Math.abs(q[0])));
	}

	/**
	 * Segment `a`..`b`. `dir` (a dash's path segment) replaces its direction;
	 * `drawDir` (a curve's end tangent) only picks the draw vertices, the
	 * perpendicular following the chord (measured on Bezier ends).
	 */
	private seg(a: Pt, b: Pt, dir?: Pt, drawDir?: Pt, curve = false): Seg {
		const dx = dir ? dir[0] : b[0] - a[0];
		const dy = dir ? dir[1] : b[1] - a[1];
		const d = drawDir ?? [dx, dy];
		const nibMatrix = this.opts.deviceNib ? this.opts.matrix : undefined;
		const [L, R] = drawVertices(this.pen, d[0], d[1], this.opts.width, this.opts.height, nibMatrix);
		// A curve's end segments take their perpendicular and square-cap extension from the end tangent.
		const perpendicular = curve && drawDir ? drawDir : [dx, dy];
		const vectors = perpendicularVectors(this.opts.width, perpendicular[0], perpendicular[1], this.opts.height, nibMatrix ? this.pen : undefined);
		return { dx, dy, L, R, v: vectors.v, vRaw: vectors.ray, e: squareExtension(this.opts.width, perpendicular[0], perpendicular[1], 1, this.opts.height, nibMatrix, !!this.opts.wholePixelDashVectors), pe: [perpendicular[0], perpendicular[1]], curveEnd: !!drawDir, role: (drawDir as number[] | undefined)?.[2] ?? 3, tangentLength: drawDir ? drawDir[0] * drawDir[0] + drawDir[1] * drawDir[1] : 0, curve };
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
	private wedge(p: Pt, A: Pt, B: Pt, startIncl: boolean, endIncl: boolean, tail = -1): void {
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
		if (tail >= 0 && !list.some(([, k]) => k === tail)) {
			list.push([Infinity, tail]);
		}
		for (const [, k] of list) {
			this.penAt(p, k);
		}
	}

	/** The pen's extreme-x vertex `k` that a steep segment `s` rests on, or -1 when the rule does not apply. */
	private extremeTail(applies: boolean, k: number, s: Seg): number {
		const q = this.pen[k];
		return applies && Math.abs(s.dy) > Math.abs(s.dx) && Math.abs(q[0]) === this.maxX && q[1] === 0 ? k : -1;
	}

	/** Side offset of segment `s` at a join. */
	private joinSide(s: Seg, side: 'L' | 'R'): Pt {
		if (this.originalRoundJoinSides || s.curve) {
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
	private cap(p: Pt, s: Seg, start: boolean, scale = 1): void {
		const from: 'L' | 'R' = start ? 'L' : 'R';
		const to: 'L' | 'R' = start ? 'R' : 'L';
		const { cap } = this.opts;
		if (cap === 'round') {
			this.push(p, this.capSide(s, from));
			if (this.rr) {
				this.walk(p, s[from], s[to], false, false);
			} else {
				// Choose arc vertices before rounding the perpendicular onto the
				// half-pixel grid; rounding can move a boundary past a pen vertex.
				const A: Pt = from === 'R' ? s.vRaw : [-s.vRaw[0], -s.vRaw[1]];
				this.wedge(p, A, [-A[0], -A[1]], true, false);
			}
			this.push(p, this.capSide(s, to));
			return;
		}
		const sv = this.capSide(s, from);
		const ev = this.capSide(s, to);
		if (cap === 'square') {
			const e0: Pt = scale === 1 || s.curveEnd ? s.e : squareExtension(this.opts.width, s.pe[0], s.pe[1], scale, this.opts.height, this.opts.deviceNib ? this.opts.matrix : undefined, false, !!this.opts.wholePixelDashVectors);
			const e: Pt = start ? [-e0[0], -e0[1]] : e0;
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
		const { cap, width, miterLimit } = this.opts;
		const curveJoin = a.curve && b.curve;
		const join = curveJoin ? 'round' : this.opts.join;
		const roundSides = this.originalRoundJoinSides || curveJoin;
		let sa = this.joinSide(a, side);
		let sb = this.joinSide(b, side);
		const rayA: Pt = side === 'R' ? a.vRaw : [-a.vRaw[0], -a.vRaw[1]];
		const rayB: Pt = side === 'R' ? b.vRaw : [-b.vRaw[0], -b.vRaw[1]];
		if (curveJoin && !this.originalRoundJoinSides && a.curveEnd && b.curveEnd && ((side === 'R' ? a : b).role & 2) !== 0 && ((side === 'R' ? b : a).role & 1) !== 0) {
			// At the boundary of two ellipse cubics, these styles use the
			// true tangent's perpendicular rather than a pen support vertex.
			// Both cubics describe the same tangent: the one with the longer arm is the reliable one.
			const t = a.tangentLength >= b.tangentLength ? a : b;
			sa = sb = side === 'R' ? t.v : [-t.v[0], -t.v[1]];
		}
		if (!curveJoin && !this.originalRoundJoinSides) {
			// A line meeting the end of a curve: the curve side takes the perpendicular of its end tangent.
			if (a.curve && a.curveEnd) sa = side === 'R' ? a.v : [-a.v[0], -a.v[1]];
			if (b.curve && b.curveEnd) sb = side === 'R' ? b.v : [-b.v[0], -b.v[1]];
		}
		const Da = side === 'R' ? a.R : a.L;
		const Db = side === 'R' ? b.R : b.L;
		if (roundSides &&(Da === Db || (curveJoin && sa[0] === sb[0] && sa[1] === sb[1]))) {
			this.push(p, sa);
			return;
		}
		this.push(p, sa);
		if (outer) {
			if (join === 'round') {
				if (roundSides) {
					// The left side (walked backwards) keeps the pen's extreme
					// vertex after a steep segment (measured).
					const q = this.pen[Db];
					const steep = Math.abs(b.dy) > Math.abs(b.dx);
					const incl = side === 'L' && steep && Math.abs(q[0]) === this.maxX && q[0] * q[1] <= 0;
					this.walk(p, Da, Db, false, incl);
				} else {
					const anti = sa[0] === -sb[0] && sa[1] === -sb[1];
					if (Da !== Db || anti) {
						// A vertex exactly on the second ray is left out, and the left side keeps a steep segment's extreme-x vertex.
						this.wedge(p, rayA, rayB, !anti, false, this.extremeTail(side === 'L' && !anti, Db, b));
					}
				}
			} else if (join === 'miter') {
				const m = miterPoint(sa, [a.dx, a.dy], sb, [b.dx, b.dy], width, miterLimit, side, this.opts.height);
				if (m) {
					this.push(p, m);
				}
			}
		} else {
			this.pts.push([p[0], p[1]]);
			if (curveJoin && !this.originalRoundJoinSides) {
				// Native WidenPath repeats this inner triangle. Filling hides
				// the repetition; stroking the widened outline exposes it.
				this.push(p, sb);
				this.push(p, sa);
				this.pts.push([p[0], p[1]]);
			}
			if (join === 'round' && cap === 'flat' && !curveJoin) {
				// Flat-capped round joins loop round the pen on the inner side too.
				this.push(p, sb);
				if (Da !== Db) {
					// Two sides resting on the same pen vertex enclose no other vertex.
					this.wedge(p, rayB, rayA, false, false, this.extremeTail(side === 'L', Da, a));
				}
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
	open(P: Pt[], dirs?: (Pt | undefined)[], draws?: (Pt | undefined)[], curves?: boolean[], startScale = 1, endScale = 1): void {
		if (P.length < 2 && !dirs?.[0]) {
			this.dot(P[0]);
			return;
		}
		const segs: Seg[] = [];
		for (let i = 0; i + 1 < P.length; i++) {
			segs.push(this.seg(P[i], P[i + 1], dirs?.[i], draws?.[i], curves?.[i]));
		}
		if (segs.length === 0) {
			const s = this.seg(P[0], P[0], dirs?.[0] as Pt, draws?.[0], curves?.[0]);
			this.cap(P[0], s, true, startScale);
			this.cap(P[0], s, false, endScale);
			this.flush();
			return;
		}
		this.cap(P[0], segs[0], true, startScale);
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
		this.cap(P[P.length - 1], segs[segs.length - 1], false, endScale);
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
	closed(P: Pt[], draws?: (Pt | undefined)[], curves?: boolean[]): void {
		const m = P.length;
		const segs: Seg[] = [];
		for (let i = 0; i < m; i++) {
			segs.push(this.seg(P[i], P[(i + 1) % m], undefined, draws?.[i], curves?.[i]));
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
	/** Per piece segment, whether it comes from a flattened curve. */
	curves: boolean[];
	/**
	 * How much longer the real segment under the piece's start/end is than the
	 * length GDI measured for it: a square cap's extension is laid out in
	 * measured length too.
	 */
	startScale: number;
	endScale: number;
}

/**
 * Cuts a polyline into dash pieces of `dashes` (on, off, ...) FIX lengths
 * by exact arc length, the cut points rounded to 28.4. With round or
 * square caps (`shorten`, the pen width) GDI shortens every dash by the
 * pen width so the caps end where the dash does; a dash no longer than the
 * width becomes a single capped point.
 */
function dashPieces(
	P: Pt[],
	tangents: (Pt | undefined)[],
	curveFlags: boolean[],
	pattern: number[],
	shorten: number,
	wholePixelVectors: boolean,
	metric?: [number, number],
	matrix?: Matrix,
): DashPiece[] {
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
	let cur: DashPiece | null = { pts: [P[0]], dirs: [], draws: [], curves: [], startScale: 1, endScale: 1 };
	for (let i = 0; i + 1 < P.length; i++) {
		const [x0, y0] = P[i];
		const [x1, y1] = P[i + 1];
		const dir: Pt = [x1 - x0, y1 - y0];
		const det = matrix ? matrix[0] * matrix[3] - matrix[1] * matrix[2] : 1;
		const real = matrix
			? Math.hypot((matrix[3] * dir[0] - matrix[2] * dir[1]) / det, (-matrix[1] * dir[0] + matrix[0] * dir[1]) / det)
			: metric
				? Math.hypot(dir[0] / metric[0], dir[1] / metric[1])
				: Math.hypot(dir[0], dir[1]);
		// GDI measures a segment from its vector cut down to whole pixels (an
		// arithmetic shift of the FIX components, so it rounds toward minus
		// infinity), then places the cut at the same fraction of the real
		// segment. Lines on whole pixels lose nothing; the odd-FIX segments of a
		// flattened curve come out up to a pixel short or long.
		const len = metric || matrix ? real : wholePixelVectors ? Math.hypot(Math.floor(dir[0] / 16), Math.floor(dir[1] / 16)) * 16 : Math.hypot(dir[0], dir[1]);
		if (len === 0) {
			if (on && cur) {
				cur.pts.push(P[i + 1]);
				cur.dirs.push(dir);
				cur.draws.push(tangents[i]);
				cur.curves.push(curveFlags[i]);
			}
			continue;
		}
		let t = 0;
		while (len - t > left || (left === 0 && on)) {
			t += left;
			const q: Pt = [Math.floor(x0 + (dir[0] * t) / len + 0.5), Math.floor(y0 + (dir[1] * t) / len + 0.5)];
			if (on && cur) {
				cur.pts.push(q);
				cur.dirs.push(dir);
				cur.draws.push(tangents[i]);
				cur.curves.push(curveFlags[i]);
				// A dash that is a point at the start of the path is not scaled.
				cur.endScale = cur.pts[0] === P[0] && q[0] === P[0][0] && q[1] === P[0][1] ? 1 : real / len;
				out.push(cur);
				cur = null;
			} else {
				cur = { pts: [q], dirs: [], draws: [], curves: [], startScale: real / len, endScale: 1 };
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
			cur.curves.push(curveFlags[i]);
			cur.endScale = real / len;
		}
	}
	if (on && cur && cur.dirs.length > 0) {
		cur.endScale = 1;
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

/** {@link widenPath} for a general device matrix: widen in logical space, then map the outline to device FIX. */
function widenInLogicalSpace(path: GdiRasterPath, opts: WidenOptions, m: [number, number, number, number]): number[][] {
	const [a, b, c, d] = m;
	const det = a * d - b * c;
	const inverse = (x: number, y: number): Pt => [(d * x - c * y) / det, (-b * x + a * y) / det];
	const logical = new GdiRasterPath();
	for (const fig of path.figures) {
		const pts: number[] = [];
		for (let i = 0; i + 1 < fig.pts.length; i += 2) {
			pts.push(...inverse(fig.pts[i], fig.pts[i + 1]));
		}
		const copy: GdiFigure = { pts, closed: fig.closed, roundWiden: fig.roundWiden, curveSegs: fig.curveSegs, tangentRoles: fig.tangentRoles };
		if (fig.tangents) {
			copy.tangents = new Map([...fig.tangents].map(([k, v]) => [k, inverse(v[0], v[1])]));
		}
		logical.figures.push(copy);
	}
	const outline = widenPath(logical, { ...opts, matrix: undefined, height: undefined });
	return outline.map((poly) => {
		const out: number[] = [];
		for (let i = 0; i + 1 < poly.length; i += 2) {
			out.push(Math.round(a * poly[i] + c * poly[i + 1]), Math.round(b * poly[i] + d * poly[i + 1]));
		}
		return out;
	});
}

/**
 * The outline figures (flat FIX pairs) whose WINDING fill is the stroke of
 * `path` with a wide pen, as GDI builds them (see the module doc).
 */
export function widenPath(path: GdiRasterPath, opts: WidenOptions): number[][] {
	if (opts.matrix && !(opts.deviceNib && opts.join === 'round')) {
		return widenInLogicalSpace(path, opts, opts.matrix);
	}
	const out: number[][] = [];
	const dashed = !!opts.dashes && opts.dashes.length > 0;
	for (const fig of path.figures) {
		const outliner = new Outliner(opts, out);
		// Distinct points, and per remaining segment the curve tangent GDI
		// widens it with (when it is a flattened Bezier's first or last).
		let P: Pt[] = [];
		const dirs: (Pt | undefined)[] = [];
		const curves: boolean[] = [];
		for (let i = 0; i + 1 < fig.pts.length; i += 2) {
			const q: Pt = [fig.pts[i], fig.pts[i + 1]];
			const last = P[P.length - 1];
			if (last && last[0] === q[0] && last[1] === q[1]) {
				continue;
			}
			if (last) {
				{
					const t = fig.tangents?.get(i / 2 - 1);
					dirs.push(t && ([t[0], t[1], (fig.roundWiden ? 3 : fig.tangentRoles?.get(i / 2 - 1)) ?? 3] as unknown as Pt));
				}
				curves.push(!!fig.roundWiden || !!fig.curveSegs?.has(i / 2 - 1));
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
			const shorten = opts.cap === 'flat' || opts.shortenDashes === false ? 0 : opts.dashMetric ? opts.width / opts.dashMetric[0] : opts.width;
			const runTangents = closed ? [...dirs, undefined] : dirs;
			const runCurves = closed ? [...curves, !!fig.roundWiden] : curves;
			for (const piece of dashPieces(run, runTangents, runCurves, opts.dashes as number[], shorten, !!opts.wholePixelDashVectors, opts.dashMetric, opts.deviceNib ? opts.matrix : undefined)) {
				// Drop repeated points, keeping each remaining segment's direction.
				const pts: Pt[] = [piece.pts[0]];
				const pdirs: Pt[] = [];
				const pdraws: (Pt | undefined)[] = [];
				const pcurves: boolean[] = [];
				for (let i = 1; i < piece.pts.length; i++) {
					const q = piece.pts[i];
					const last = pts[pts.length - 1];
					if (q[0] !== last[0] || q[1] !== last[1]) {
						pts.push(q);
						pdirs.push(piece.dirs[i - 1]);
						pdraws.push(piece.draws[i - 1]);
						pcurves.push(piece.curves[i - 1]);
					}
				}
				outliner.open(pts, pdirs.length > 0 ? pdirs : [piece.dirs[0]], pdirs.length > 0 ? pdraws : [piece.draws[0]], pdirs.length > 0 ? pcurves : [piece.curves[0]], piece.startScale, piece.endScale);
			}
		} else if (closed && P.length >= 3) {
			outliner.closed(P, dirs, curves);
		} else if (closed && P.length === 2) {
			outliner.open([P[0], P[1], P[0]]);
		} else {
			outliner.open(P, undefined, dirs, curves);
		}
	}
	return out;
}

/**
 * The miter point (FIX offset from the join, rounded) where the side lines
 * `sa + t * da` and `sb + u * db` meet, or `null` when the miter would be
 * longer than `limit` half widths (GDI then bevels).
 */
function miterPoint(sa: Pt, da: Pt, sb: Pt, db: Pt, width: number, limit: number, side: 'L' | 'R', height = width): Pt | null {
	const den = da[0] * db[1] - da[1] * db[0];
	if (den === 0) {
		return null;
	}
	const wx = sb[0] - sa[0];
	const wy = sb[1] - sa[1];
	const t = (wx * db[1] - wy * db[0]) / den;
	const mx = sa[0] + da[0] * t;
	const my = sa[1] + da[1] * t;
	const x = Math.sign(mx) * Math.floor(Math.abs(mx) + 0.5);
	const y = Math.sign(my) * Math.floor(Math.abs(my) + 0.5);
	// GDI tests its left-side miter in whole device pixels, rounding the FIX
	// components upward. The right side tests the negated vector, which
	// rounds its components downward. Emitted vertices retain FIX precision.
	const pixel = side === 'L' ? Math.ceil : Math.floor;
	const yDistance = height === width ? pixel(y / 16) : pixel(y / 16) * width / height;
	if (Math.hypot(pixel(x / 16), yDistance) > (limit * width) / 32) {
		return null;
	}
	return [x, y];
}
