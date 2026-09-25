/**
 * Wide (geometric) pens for the GDI rasteriser: turns a {@link GdiRasterPath}
 * into the polygons GDI fills for a pen wider than one pixel.
 *
 * What is known exactly (measured against real GDI, `WidenPath` +
 * `GetPath` at 28.4 precision): a wide stroke is the WINDING fill of the
 * widened outline (240 of 240 random polylines, every cap and join, fill
 * exactly what GDI paints), and a round cap or join is traced with a pen
 * "nib" polygon that GDI keeps in a normalised octant frame and flips or
 * transposes into each segment's octant (`nibFrame`). For pens of one to six
 * pixels the nib is a fixed pixel-shaped polygon, reproduced here as
 * measured (`SMALL_NIBS`). GDI adjusts a few nib vertices further by the
 * exact slope of each segment and builds larger nibs octant by octant; those
 * refinements are not reproduced (the larger nib here is a polygon through
 * the same extreme points), and neither is GDI's exact vertex placement for
 * flat/square caps and miter/bevel joins, which are built from the exact
 * offset geometry rounded to 28.4. See the `gdi-raster` fixtures for the
 * measured residual.
 *
 * The outline is assembled as a union of convex pieces (each segment's
 * body, each join, each cap), all oriented the same way so a WINDING fill
 * paints their union.
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
}

/**
 * GDI's nibs for pens one to six pixels wide, in the normalised octant
 * frame (x-major, both deltas non-negative), as `[x, y, ...]` FIX offsets
 * (measured with `WidenPath`; identical for every segment slope of those
 * widths except for the rare exact-diagonal adjustments).
 */
const SMALL_NIBS: number[][] = [
	[0, -8, -7, 0, 0, 8, 7, 0],
	[8, -16, -7, -15, -15, 0, -8, 16, 7, 15, 15, 0],
	[8, -24, -7, -23, -23, -7, -23, 7, -8, 24, 7, 23, 23, 7, 23, -7],
	[8, -32, -7, -31, -23, -23, -31, -7, -31, 7, -23, 23, -8, 32, 7, 31, 23, 23, 31, 7, 31, -7, 23, -23],
	[8, -40, -7, -39, -23, -31, -31, -23, -39, -7, -39, 7, -31, 23, -23, 31, -8, 40, 7, 39, 23, 31, 31, 23, 39, 7, 39, -7, 31, -23, 23, -31],
	[8, -48, -7, -47, -23, -39, -39, -23, -47, -7, -47, 7, -39, 23, -23, 39, -8, 48, 7, 47, 23, 39, 39, 23, 47, 7, 47, -7, 39, -23, 23, -39],
];

/**
 * The nib polygon for a pen `width` FIX wide, in the normalised octant
 * frame: GDI's own table up to six pixels (a width rounds to its nearest
 * whole pixel count there), otherwise a flattened ellipse spanning GDI's
 * measured extremes (horizontal half-width `floor((w - 1) / 2)`, vertical
 * half-height snapped to whole pixels, `8 * floor((w + 9) / 16)`).
 */
export function penNib(width: number): number[] {
	const n = Math.floor(width / 16 + 0.5);
	if (n >= 1 && n <= 6 && width < 104) {
		return SMALL_NIBS[n - 1];
	}
	const hx = Math.floor((width - 1) / 2);
	const hy = 8 * Math.floor((width + 9) / 16);
	const f = flattenBezierPath(ellipseBeziers(-hx, -hy, hx, hy));
	return f.slice(0, f.length - 2);
}

/** A segment's octant frame: `real = swap ? (sx * v, sy * u) : (sx * u, sy * v)`. */
interface Frame {
	sx: number;
	sy: number;
	swap: boolean;
}

/** GDI's octant normalisation of a segment direction (measured: a zero dx counts as negative, a zero dy as positive, an exact diagonal is y-major when it runs downwards). */
function nibFrame(dx: number, dy: number): Frame {
	const ax = Math.abs(dx);
	const ay = Math.abs(dy);
	return { sx: dx > 0 ? 1 : -1, sy: dy >= 0 ? 1 : -1, swap: ay > ax || (ay === ax && dy > 0) };
}

/** `nib` carried into `frame` (flat pairs). */
function orientNib(nib: number[], frame: Frame): number[] {
	const out = new Array<number>(nib.length);
	for (let i = 0; i < nib.length; i += 2) {
		const u = nib[i];
		const v = nib[i + 1];
		if (frame.swap) {
			out[i] = frame.sx * v;
			out[i + 1] = frame.sy * u;
		} else {
			out[i] = frame.sx * u;
			out[i + 1] = frame.sy * v;
		}
	}
	return out;
}

/** Convex hull (monotone chain) of flat points, counter-clockwise in y-down coordinates' math sense, as flat pairs. */
function convexHull(pts: number[]): number[] {
	const p: Array<[number, number]> = [];
	for (let i = 0; i < pts.length; i += 2) {
		p.push([pts[i], pts[i + 1]]);
	}
	p.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	if (p.length < 3) {
		return p.flat();
	}
	const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
	const lower: Array<[number, number]> = [];
	for (const q of p) {
		while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) {
			lower.pop();
		}
		lower.push(q);
	}
	const upper: Array<[number, number]> = [];
	for (let i = p.length - 1; i >= 0; i--) {
		const q = p[i];
		while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) {
			upper.pop();
		}
		upper.push(q);
	}
	lower.pop();
	upper.pop();
	return [...lower, ...upper].flat();
}

/** Signed area sign of a flat polygon (positive = counter-clockwise in the math sense). */
function orientation(poly: number[]): number {
	let a = 0;
	for (let i = 0; i < poly.length; i += 2) {
		const j = (i + 2) % poly.length;
		a += poly[i] * poly[j + 1] - poly[j] * poly[i + 1];
	}
	return Math.sign(a);
}

/** `poly` oriented positively (reversed if needed), so WINDING fills of many pieces union. */
function positive(poly: number[]): number[] {
	if (orientation(poly) >= 0) {
		return poly;
	}
	const out: number[] = [];
	for (let i = poly.length - 2; i >= 0; i -= 2) {
		out.push(poly[i], poly[i + 1]);
	}
	return out;
}

/** Splits a polyline (flat pairs) into dash pieces of `dashes` (on, off, ...) FIX lengths. */
function dashPolyline(pts: number[], dashes: number[], closed: boolean): number[][] {
	const seq = closed ? [...pts, pts[0], pts[1]] : pts;
	const period = dashes.reduce((a, b) => a + b, 0);
	if (period <= 0) {
		return [seq];
	}
	const out: number[][] = [];
	let idx = 0;
	let left = dashes[0];
	let on = true;
	let cur: number[] | null = [seq[0], seq[1]];
	for (let i = 0; i + 3 < seq.length; i += 2) {
		let x0 = seq[i];
		let y0 = seq[i + 1];
		const x1 = seq[i + 2];
		const y1 = seq[i + 3];
		let len = Math.hypot(x1 - x0, y1 - y0);
		while (len > 0) {
			if (left >= len) {
				left -= len;
				if (on && cur) {
					cur.push(x1, y1);
				}
				len = 0;
			} else {
				const t = left / len;
				const mx = Math.round(x0 + (x1 - x0) * t);
				const my = Math.round(y0 + (y1 - y0) * t);
				if (on && cur) {
					cur.push(mx, my);
					out.push(cur);
					cur = null;
				} else {
					cur = [mx, my];
				}
				on = !on;
				idx = (idx + 1) % dashes.length;
				left = dashes[idx];
				len -= Math.hypot(mx - x0, my - y0);
				x0 = mx;
				y0 = my;
				if (left <= 0 && dashes.every((d) => d <= 0)) {
					return out;
				}
			}
		}
	}
	if (on && cur && cur.length >= 4) {
		out.push(cur);
	}
	return out;
}

/**
 * The polygons (flat FIX pairs, each positively oriented) whose WINDING
 * union is the widened outline of `path` for a wide pen (see the module
 * doc for which parts match GDI exactly).
 */
export function widenPath(path: GdiRasterPath, opts: WidenOptions): number[][] {
	const out: number[][] = [];
	const nib = penNib(opts.width);
	const half = opts.width / 2;
	for (const fig of path.figures) {
		const raw = fig.pts;
		// Drop repeated points.
		const pts: number[] = [];
		for (let i = 0; i < raw.length; i += 2) {
			if (pts.length === 0 || pts[pts.length - 2] !== raw[i] || pts[pts.length - 1] !== raw[i + 1]) {
				pts.push(raw[i], raw[i + 1]);
			}
		}
		if (fig.closed && pts.length >= 4 && pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1]) {
			pts.length -= 2;
		}
		if (pts.length === 2) {
			// A single point: GDI paints the nib (round) or a pen-sized square.
			if (opts.cap === 'round') {
				const n = orientNib(nib, nibFrame(1, 0));
				out.push(positive(convexHull(n.map((v, i) => v + pts[i % 2]))));
			}
			continue;
		}
		const pieces = opts.dashes && opts.dashes.length > 0 ? dashPolyline(pts, opts.dashes, fig.closed) : [fig.closed ? [...pts, pts[0], pts[1]] : pts];
		const closedWhole = fig.closed && !(opts.dashes && opts.dashes.length > 0);
		for (const piece of pieces) {
			widenPolyline(piece, closedWhole, opts, nib, half, out);
		}
	}
	return out;
}

/** Widens one polyline (flat pairs; `closed` means its last point equals its first and the ends join). */
function widenPolyline(pts: number[], closed: boolean, opts: WidenOptions, nib: number[], half: number, out: number[][]): void {
	const n = pts.length / 2;
	if (n < 2) {
		return;
	}
	const roundAll = opts.cap === 'round' && opts.join === 'round';
	for (let i = 0; i + 1 < n; i++) {
		const x0 = pts[i * 2];
		const y0 = pts[i * 2 + 1];
		const x1 = pts[i * 2 + 2];
		const y1 = pts[i * 2 + 3];
		const dx = x1 - x0;
		const dy = y1 - y0;
		const len = Math.hypot(dx, dy);
		if (len === 0) {
			continue;
		}
		if (roundAll) {
			const nb = orientNib(nib, nibFrame(dx, dy));
			const hullPts: number[] = [];
			for (let k = 0; k < nb.length; k += 2) {
				hullPts.push(x0 + nb[k], y0 + nb[k + 1], x1 + nb[k], y1 + nb[k + 1]);
			}
			out.push(positive(convexHull(hullPts)));
			continue;
		}
		// Body: the segment offset by half the width either side, extended for
		// a square cap at an open end.
		const ux = dx / len;
		const uy = dy / len;
		const nx = -uy * half;
		const ny = ux * half;
		const first = i === 0 && !closed;
		const last = i + 2 === n && !closed;
		const ext0 = first && opts.cap === 'square' ? half : 0;
		const ext1 = last && opts.cap === 'square' ? half : 0;
		const ax = x0 - ux * ext0;
		const ay = y0 - uy * ext0;
		const bx = x1 + ux * ext1;
		const by = y1 + uy * ext1;
		out.push(
			positive([ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny].map((v) => Math.round(v))),
		);
		if (first && opts.cap === 'round') {
			out.push(roundDot(x0, y0, dx, dy, nib));
		}
		if (last && opts.cap === 'round') {
			out.push(roundDot(x1, y1, dx, dy, nib));
		}
	}
	if (roundAll) {
		return;
	}
	// Joins at interior vertices (and the closing vertex of a closed figure).
	const count = closed ? n - 1 : n - 2;
	for (let j = 0; j < count; j++) {
		const vi = closed ? (j + 1) % (n - 1) : j + 1;
		const pi = vi === 0 ? n - 2 : vi - 1;
		const ni = vi + 1;
		const vx = pts[vi * 2];
		const vy = pts[vi * 2 + 1];
		const d0x = vx - pts[pi * 2];
		const d0y = vy - pts[pi * 2 + 1];
		const d1x = pts[ni * 2] - vx;
		const d1y = pts[ni * 2 + 1] - vy;
		const l0 = Math.hypot(d0x, d0y);
		const l1 = Math.hypot(d1x, d1y);
		if (l0 === 0 || l1 === 0) {
			continue;
		}
		if (opts.join === 'round') {
			out.push(roundDot(vx, vy, d1x, d1y, nib));
			continue;
		}
		const turn = d0x * d1y - d0y * d1x;
		if (turn === 0) {
			continue;
		}
		// Outer side offsets of the two segments at the vertex.
		const s = turn > 0 ? -1 : 1;
		const o0x = (s * -d0y * half) / l0;
		const o0y = (s * d0x * half) / l0;
		const o1x = (s * -d1y * half) / l1;
		const o1y = (s * d1x * half) / l1;
		const piece = [vx, vy, vx + o0x, vy + o0y];
		if (opts.join === 'miter') {
			// Miter point: intersection of the two offset lines.
			const denom = d0x * d1y - d0y * d1x;
			const t = ((o1x - o0x) * d1y - (o1y - o0y) * d1x) / denom;
			const mx = vx + o0x + d0x * t;
			const my = vy + o0y + d0y * t;
			const miterLen = Math.hypot(mx - vx, my - vy) / half;
			if (miterLen <= opts.miterLimit) {
				piece.push(mx, my);
			}
		}
		piece.push(vx + o1x, vy + o1y);
		out.push(positive(piece.map((v) => Math.round(v))));
	}
}

/** The nib, oriented for direction (`dx`, `dy`), placed at (`x`, `y`). */
function roundDot(x: number, y: number, dx: number, dy: number, nib: number[]): number[] {
	const nb = orientNib(nib, nibFrame(dx, dy));
	const p: number[] = [];
	for (let k = 0; k < nb.length; k += 2) {
		p.push(x + nb[k], y + nb[k + 1]);
	}
	return positive(convexHull(p));
}
