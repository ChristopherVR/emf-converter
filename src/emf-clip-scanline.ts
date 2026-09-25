/**
 * Exact scanline evaluation of clip-region boolean combinations.
 *
 * The even-odd tricks in `emf-clip-region.ts` express Exclude / Xor /
 * Complement as plain `ctx.clip()` intersections, but only while the operands
 * are single "parity" shapes. Once the tracked clip is an intersection of
 * several shapes (or an operand is an arbitrary nonzero path, such as a
 * self-overlapping EMR_SELECTCLIPPATH bracket), no stack of intersecting
 * clips can express Union, Xor, or Complement.
 *
 * This module resolves those cases exactly by rasterising the region
 * *membership* rather than the pixels:
 *
 * 1. Every {@link ClipShape} is flattened into straight edges (cubic Béziers,
 *    `arcTo` corners, and `ellipse` arcs are subdivided to within
 *    {@link FLATTEN_TOLERANCE} device pixels; every subpath is closed
 *    implicitly, exactly like a canvas fill).
 * 2. Each device pixel row `y` in the finite domain is sampled at its centre
 *    line `y + 0.5`: the edge crossings are sorted and walked with the shape's
 *    fill rule (nonzero or even-odd), yielding the half-open integer pixel
 *    spans whose centres `x + 0.5` lie inside.
 * 3. A region (an intersection list) is the AND of its shapes' span lists;
 *    the two operands are then merged with the requested boolean operator.
 * 4. Vertically identical adjacent rows are coalesced into y-banded, pairwise
 *    disjoint rectangles, the same shape GDI itself uses for regions
 *    (RGNDATA).
 *
 * GDI regions are integer pixel sets bounded by the device surface, so this
 * is a faithful model rather than an approximation: the result is exact at
 * device-pixel resolution inside the domain, and empty outside it. Runtime
 * is O(rows x (active edges + spans)) using an active-edge table.
 *
 * @module emf-clip-scanline
 */

import type { ClipCombineOp, ClipPathCmd, ClipRegion, ClipShape } from './emf-clip-region';

// ---------------------------------------------------------------------------
// Types and constants
// ---------------------------------------------------------------------------

/** An axis-aligned device-space rectangle (x/y/w/h, pixels). */
export interface ClipRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/**
 * The finite device-space area over which scanline results are evaluated,
 * normally the canvas (`{ x: 0, y: 0, w: canvasW, h: canvasH }`). Results are
 * exact inside the domain and empty outside it. Non-integer bounds are
 * rounded outwards to whole pixels.
 */
export type ClipDomain = ClipRect;

/** Maximum distance (device pixels) between a curve and its flattening. */
export const FLATTEN_TOLERANCE = 0.05;

/** Upper bound on segments per flattened curve (guards pathological input). */
const MAX_CURVE_SEGMENTS = 4096;

/**
 * Upper bound on rows or columns of a scanline domain. Callers pass the
 * canvas, whose dimensions are capped well below this; the bound only
 * matters for a domain derived from unbounded geometry.
 */
export const MAX_SCANLINE_DIMENSION = 1 << 15;

/**
 * Coordinates at or beyond this magnitude belong to the "covers everything"
 * rectangles used for inversion (`CLIP_HUGE`) and are ignored when deriving
 * a default domain from geometry.
 */
const FINITE_LIMIT = 1 << 23;

/** One straight, non-horizontal edge of a flattened shape. */
interface Edge {
	/** First pixel row (inclusive) whose centre line crosses the edge. */
	row0: number;
	/** Last pixel row (exclusive). */
	row1: number;
	/** x at the centre line of `row0`. */
	x: number;
	/** dx per row. */
	slope: number;
	/** +1 for downward edges, -1 for upward ones. */
	dir: number;
}

/**
 * A region's membership per row: `rows[i]` holds the flat, sorted list
 * `[a0, b0, a1, b1, ...]` of half-open pixel spans `[a, b)` for row
 * `domain.y + i`.
 */
type RowSpans = number[][];

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------

/** Number of line segments that keep a cubic within the flatten tolerance. */
function cubicSegments(
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	x3: number,
	y3: number,
): number {
	// Uniform subdivision error <= (1/8) * max|B''| / n^2, and
	// max|B''| <= 6 * max(|P0 - 2P1 + P2|, |P1 - 2P2 + P3|).
	const d1 = Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2);
	const d2 = Math.hypot(x1 - 2 * x2 + x3, y1 - 2 * y2 + y3);
	const n = Math.ceil(Math.sqrt((0.75 * Math.max(d1, d2)) / FLATTEN_TOLERANCE));
	return Math.min(MAX_CURVE_SEGMENTS, Math.max(1, n));
}

/** Number of line segments that keep an arc of `radius` within tolerance. */
function arcSegments(radius: number, sweep: number): number {
	if (!(radius > FLATTEN_TOLERANCE)) {
		return 1;
	}
	const step = 2 * Math.acos(1 - FLATTEN_TOLERANCE / radius);
	const n = Math.ceil(Math.abs(sweep) / step);
	return Math.min(MAX_CURVE_SEGMENTS, Math.max(1, n));
}

/** Positive remainder of `a` modulo `m`. */
function mod(a: number, m: number): number {
	const r = a % m;
	return r < 0 ? r + m : r;
}

/**
 * Flatten a shape's path commands into closed polygons (one point list per
 * subpath), following Canvas 2D path semantics: `rect()` adds its own closed
 * subpath and then starts a new one at `(x, y)`; `lineTo` / `bezierCurveTo`
 * / `arcTo` without a current point behave as an initial `moveTo`;
 * `ellipse()` joins its start point to the current point with a line.
 */
export function flattenClipCmds(cmds: ClipPathCmd[]): number[][] {
	const polys: number[][] = [];
	let cur: number[] = [];
	let hasPoint = false;
	let cx = 0;
	let cy = 0;

	const flush = () => {
		if (cur.length >= 6) {
			polys.push(cur);
		}
		cur = [];
	};
	const moveTo = (x: number, y: number) => {
		flush();
		cur = [x, y];
		hasPoint = true;
		cx = x;
		cy = y;
	};
	const lineTo = (x: number, y: number) => {
		if (!hasPoint) {
			moveTo(x, y);
			return;
		}
		cur.push(x, y);
		cx = x;
		cy = y;
	};

	for (const c of cmds) {
		switch (c.op) {
			case 'moveTo':
				moveTo(c.x, c.y);
				break;
			case 'lineTo':
				lineTo(c.x, c.y);
				break;
			case 'rect':
				moveTo(c.x, c.y);
				lineTo(c.x + c.w, c.y);
				lineTo(c.x + c.w, c.y + c.h);
				lineTo(c.x, c.y + c.h);
				moveTo(c.x, c.y);
				break;
			case 'closePath':
				if (hasPoint) {
					const sx = cur[0];
					const sy = cur[1];
					moveTo(sx, sy);
				}
				break;
			case 'bezierCurveTo': {
				if (!hasPoint) {
					moveTo(c.cp1x, c.cp1y);
				}
				const x0 = cx;
				const y0 = cy;
				const n = cubicSegments(x0, y0, c.cp1x, c.cp1y, c.cp2x, c.cp2y, c.x, c.y);
				for (let i = 1; i < n; i++) {
					const t = i / n;
					const u = 1 - t;
					const a = u * u * u;
					const b = 3 * u * u * t;
					const d = 3 * u * t * t;
					const e = t * t * t;
					lineTo(
						a * x0 + b * c.cp1x + d * c.cp2x + e * c.x,
						a * y0 + b * c.cp1y + d * c.cp2y + e * c.y,
					);
				}
				lineTo(c.x, c.y);
				break;
			}
			case 'arcTo': {
				if (!hasPoint) {
					moveTo(c.x1, c.y1);
					break;
				}
				const x0 = cx;
				const y0 = cy;
				const v1x = x0 - c.x1;
				const v1y = y0 - c.y1;
				const v2x = c.x2 - c.x1;
				const v2y = c.y2 - c.y1;
				const l1 = Math.hypot(v1x, v1y);
				const l2 = Math.hypot(v2x, v2y);
				const cross = v1x * v2y - v1y * v2x;
				if (c.radius <= 0 || l1 === 0 || l2 === 0 || Math.abs(cross) < 1e-9 * l1 * l2) {
					lineTo(c.x1, c.y1);
					break;
				}
				const u1x = v1x / l1;
				const u1y = v1y / l1;
				const u2x = v2x / l2;
				const u2y = v2y / l2;
				const cosT = Math.max(-1, Math.min(1, u1x * u2x + u1y * u2y));
				const half = Math.acos(cosT) / 2;
				const dist = c.radius / Math.tan(half);
				const t1x = c.x1 + u1x * dist;
				const t1y = c.y1 + u1y * dist;
				const t2x = c.x1 + u2x * dist;
				const t2y = c.y1 + u2y * dist;
				const bx = u1x + u2x;
				const by = u1y + u2y;
				const bl = Math.hypot(bx, by);
				const cd = c.radius / Math.sin(half);
				const ccx = c.x1 + (bx / bl) * cd;
				const ccy = c.y1 + (by / bl) * cd;
				const a0 = Math.atan2(t1y - ccy, t1x - ccx);
				let sweep = Math.atan2(t2y - ccy, t2x - ccx) - a0;
				// The corner arc always takes the short way round (< 180 degrees).
				if (sweep > Math.PI) {
					sweep -= 2 * Math.PI;
				} else if (sweep < -Math.PI) {
					sweep += 2 * Math.PI;
				}
				lineTo(t1x, t1y);
				const n = arcSegments(c.radius, sweep);
				for (let i = 1; i <= n; i++) {
					const a = a0 + (sweep * i) / n;
					lineTo(ccx + c.radius * Math.cos(a), ccy + c.radius * Math.sin(a));
				}
				break;
			}
			case 'ellipse': {
				const tau = 2 * Math.PI;
				let sweep: number;
				if (!c.ccw) {
					const d = c.endAngle - c.startAngle;
					sweep = d >= tau ? tau : mod(d, tau);
				} else {
					const d = c.startAngle - c.endAngle;
					sweep = -(d >= tau ? tau : mod(d, tau));
				}
				const cosR = Math.cos(c.rotation);
				const sinR = Math.sin(c.rotation);
				const pt = (a: number): [number, number] => {
					const ex = c.rx * Math.cos(a);
					const ey = c.ry * Math.sin(a);
					return [c.cx + ex * cosR - ey * sinR, c.cy + ex * sinR + ey * cosR];
				};
				const [sx, sy] = pt(c.startAngle);
				lineTo(sx, sy);
				const n = arcSegments(Math.max(Math.abs(c.rx), Math.abs(c.ry)), sweep);
				for (let i = 1; i <= n; i++) {
					const [px, py] = pt(c.startAngle + (sweep * i) / n);
					lineTo(px, py);
				}
				break;
			}
		}
	}
	flush();
	return polys;
}

// ---------------------------------------------------------------------------
// Domain handling
// ---------------------------------------------------------------------------

/** Round a domain outwards to whole pixels and cap its size. */
function normalizeDomain(d: ClipDomain): { x0: number; y0: number; x1: number; y1: number } {
	const x0 = Math.floor(d.x);
	const y0 = Math.floor(d.y);
	const x1 = Math.max(x0, Math.min(x0 + MAX_SCANLINE_DIMENSION, Math.ceil(d.x + d.w)));
	const y1 = Math.max(y0, Math.min(y0 + MAX_SCANLINE_DIMENSION, Math.ceil(d.y + d.h)));
	return { x0, y0, x1, y1 };
}

/**
 * Derive a default domain from the finite geometry of the given regions:
 * the pixel-aligned bounding box of every vertex / control point whose
 * coordinates are well inside the inversion rectangles. Returns an empty
 * domain when the regions carry no finite geometry at all.
 */
export function deriveClipDomain(...regions: ClipRegion[]): ClipDomain {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	const add = (x: number, y: number) => {
		if (Math.abs(x) < FINITE_LIMIT && Math.abs(y) < FINITE_LIMIT) {
			minX = Math.min(minX, x);
			minY = Math.min(minY, y);
			maxX = Math.max(maxX, x);
			maxY = Math.max(maxY, y);
		}
	};
	for (const region of regions) {
		for (const shape of region ?? []) {
			for (const poly of flattenClipCmds(shape.cmds)) {
				for (let i = 0; i < poly.length; i += 2) {
					add(poly[i], poly[i + 1]);
				}
			}
		}
	}
	if (!Number.isFinite(minX)) {
		return { x: 0, y: 0, w: 0, h: 0 };
	}
	const x = Math.floor(minX);
	const y = Math.floor(minY);
	return { x, y, w: Math.ceil(maxX) - x, h: Math.ceil(maxY) - y };
}

// ---------------------------------------------------------------------------
// Scan conversion
// ---------------------------------------------------------------------------

/** Build the active-edge list of a shape for rows `[y0, y1)`. */
function buildEdges(shape: ClipShape, y0: number, y1: number): Edge[] {
	const edges: Edge[] = [];
	for (const poly of flattenClipCmds(shape.cmds)) {
		const n = poly.length / 2;
		for (let i = 0; i < n; i++) {
			const ax = poly[2 * i];
			const ay = poly[2 * i + 1];
			const j = (i + 1) % n;
			const bx = poly[2 * j];
			const by = poly[2 * j + 1];
			if (ay === by || !Number.isFinite(ax + ay + bx + by)) {
				continue;
			}
			const dir = by > ay ? 1 : -1;
			const topX = dir > 0 ? ax : bx;
			const topY = dir > 0 ? ay : by;
			const botY = dir > 0 ? by : ay;
			const slope = (bx - ax) / (by - ay);
			// Rows whose centre line y + 0.5 lies in [topY, botY).
			const row0 = Math.max(y0, Math.ceil(topY - 0.5));
			const row1 = Math.min(y1, Math.ceil(botY - 0.5));
			if (row0 >= row1) {
				continue;
			}
			edges.push({ row0, row1, x: topX + (row0 + 0.5 - topY) * slope, slope, dir });
		}
	}
	edges.sort((a, b) => a.row0 - b.row0);
	return edges;
}

/** Scan-convert one shape into per-row pixel spans over the domain. */
function shapeRowSpans(
	shape: ClipShape,
	dom: { x0: number; y0: number; x1: number; y1: number },
): RowSpans {
	const rows: RowSpans = [];
	const edges = buildEdges(shape, dom.y0, dom.y1);
	const evenOdd = shape.fillRule === 'evenodd';
	let active: Edge[] = [];
	let next = 0;
	const xs: Array<{ x: number; dir: number }> = [];

	for (let row = dom.y0; row < dom.y1; row++) {
		while (next < edges.length && edges[next].row0 === row) {
			active.push(edges[next++]);
		}
		active = active.filter((e) => e.row1 > row);

		xs.length = 0;
		for (const e of active) {
			xs.push({ x: e.x + (row - e.row0) * e.slope, dir: e.dir });
		}
		xs.sort((a, b) => a.x - b.x);

		const spans: number[] = [];
		let winding = 0;
		let start = 0;
		for (const c of xs) {
			const wasInside = evenOdd ? (winding & 1) !== 0 : winding !== 0;
			winding += c.dir;
			const inside = evenOdd ? (winding & 1) !== 0 : winding !== 0;
			if (!wasInside && inside) {
				start = c.x;
			} else if (wasInside && !inside) {
				// Pixel i is inside when start <= i + 0.5 < end.
				const a = Math.max(dom.x0, Math.ceil(start - 0.5));
				const b = Math.min(dom.x1, Math.ceil(c.x - 0.5));
				if (a < b) {
					if (spans.length > 0 && spans[spans.length - 1] >= a) {
						spans[spans.length - 1] = Math.max(spans[spans.length - 1], b);
					} else {
						spans.push(a, b);
					}
				}
			}
		}
		rows.push(spans);
	}
	return rows;
}

/**
 * Merge two sorted span lists with a boolean membership function. `fn` must
 * map (false, false) to false.
 */
function mergeSpans(a: number[], b: number[], fn: (inA: boolean, inB: boolean) => boolean): number[] {
	const out: number[] = [];
	let i = 0;
	let j = 0;
	let inA = false;
	let inB = false;
	let state = false;
	while (i < a.length || j < b.length) {
		const x = Math.min(i < a.length ? a[i] : Infinity, j < b.length ? b[j] : Infinity);
		while (i < a.length && a[i] === x) {
			inA = !inA;
			i++;
		}
		while (j < b.length && b[j] === x) {
			inB = !inB;
			j++;
		}
		const v = fn(inA, inB);
		if (v !== state) {
			out.push(x);
			state = v;
		}
	}
	return out;
}

/** Per-row spans of a region (intersection of its shapes; null = domain). */
function regionRowSpans(
	region: ClipRegion,
	dom: { x0: number; y0: number; x1: number; y1: number },
): RowSpans {
	const full = dom.x1 > dom.x0 ? [dom.x0, dom.x1] : [];
	let rows: RowSpans = [];
	for (let r = dom.y0; r < dom.y1; r++) {
		rows.push(full);
	}
	for (const shape of region ?? []) {
		const s = shapeRowSpans(shape, dom);
		rows = rows.map((spans, i) => (spans.length === 0 ? spans : mergeSpans(spans, s[i], and)));
	}
	return rows;
}

const and = (p: boolean, q: boolean) => p && q;

/** Membership function of each combine operator (A = current, B = incoming). */
const OP_FNS: Record<ClipCombineOp, (inA: boolean, inB: boolean) => boolean> = {
	replace: (_p, q) => q,
	intersect: and,
	union: (p, q) => p || q,
	xor: (p, q) => p !== q,
	exclude: (p, q) => p && !q,
	complement: (p, q) => q && !p,
};

/** Equality of two flat span lists. */
function sameSpans(a: number[], b: number[]): boolean {
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false;
		}
	}
	return true;
}

/**
 * Coalesce per-row spans into y-banded disjoint rectangles: consecutive rows
 * with identical span lists share one band.
 */
function rowsToRects(rows: RowSpans, y0: number): ClipRect[] {
	const rects: ClipRect[] = [];
	let bandStart = 0;
	for (let r = 1; r <= rows.length; r++) {
		if (r < rows.length && sameSpans(rows[r], rows[bandStart])) {
			continue;
		}
		const spans = rows[bandStart];
		for (let k = 0; k < spans.length; k += 2) {
			rects.push({ x: spans[k], y: y0 + bandStart, w: spans[k + 1] - spans[k], h: r - bandStart });
		}
		bandStart = r;
	}
	return rects;
}

/**
 * Exactly combine two clip regions (each an intersection list of shapes, or
 * `null` for the infinite region) over a finite pixel domain, returning the
 * result as pairwise disjoint, pixel-aligned rectangles. Pixel `(x, y)` is in
 * the result when its centre `(x + 0.5, y + 0.5)` satisfies `op` with respect
 * to the operands' fill-rule membership.
 */
export function scanlineCombineRegions(
	current: ClipRegion,
	incoming: ClipRegion,
	op: ClipCombineOp,
	domain: ClipDomain,
): ClipRect[] {
	const dom = normalizeDomain(domain);
	if (dom.x1 <= dom.x0 || dom.y1 <= dom.y0) {
		return [];
	}
	const a = regionRowSpans(current, dom);
	const b = regionRowSpans(incoming, dom);
	const fn = OP_FNS[op];
	const rows = a.map((spans, i) => mergeSpans(spans, b[i], fn));
	return rowsToRects(rows, dom.y0);
}

/**
 * True when the domain derived from geometry had to be truncated to
 * {@link MAX_SCANLINE_DIMENSION}, i.e. a scanline result over it would not
 * cover all of the finite geometry.
 */
export function isDomainTruncated(domain: ClipDomain): boolean {
	return domain.w > MAX_SCANLINE_DIMENSION || domain.h > MAX_SCANLINE_DIMENSION;
}
