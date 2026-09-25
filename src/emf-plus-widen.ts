/**
 * GDI+'s pen widening: the outline polygons GDI+ fills for a stroke, so an
 * EMF+ stroke is rasterised by GDI+'s own fill rules (emf-plus-raster.ts)
 * instead of Canvas's `stroke()`.
 *
 * Measured with `GraphicsPath.Widen` and `DrawPath` on the same pen:
 *
 * - every figure is flattened first (curves by GDI+'s HFD, see
 *   `recordDeviceFigures`), then offset by half the pen width on each side
 *   in float, and the outline's vertices converted to 28.4 like any fill;
 *   an open polyline stroked so matched GDI+ on every pixel, aliased and
 *   antialiased;
 * - on the outside of a turn the join is the miter point (a bevel beyond
 *   the miter limit, a clipped miter for MiterClipped, an arc for Round),
 *   on the inside simply both segments' offset end points: the outline
 *   overlaps itself there and the nonzero fill covers it;
 * - an open figure is one outline (left side forward, end cap, right side
 *   back, start cap); a closed figure two loops, one per side;
 * - a compound pen strokes each band of its compound array as its own
 *   outline (exact on the probed pens); an Inset pen on a closed figure
 *   puts the whole width inside it;
 * - a dashed pen widens every dash as its own open figure, capped with the
 *   pen's DashCap, the line's own start and end caps kept for the ends of
 *   the whole line.
 *
 * What is not exact: closed figures and capped ends differ from GDI+ by
 * one antialiasing sample along some edges (GDI+'s internal outline
 * vertices round differently from the ones `Widen` reports), and GDI+'s
 * anchor caps are drawn as their base shape.
 *
 * @module emf-plus-widen
 */

import { arcBeziers } from './emf-plus-flatten';
import { GDIPLUS_HFD_TOLERANCE, toPlusFix, type DeviceFigure } from './emf-plus-raster';
import { flattenBezier } from './gdi-raster';

/** Pen geometry in device pixels, as {@link widenFigures} applies it. */
export interface DevicePen {
	/** Half the pen width. */
	half: number;
	/** GDI+ `LineJoin`: 0 Miter, 1 Bevel, 2 Round, 3 MiterClipped. */
	join: number;
	/** Miter limit, as a multiple of the half width (GDI+'s MiterLimit, default 10). */
	miterLimit: number;
	/** GDI+ `LineCap` at the start and end of each open figure. */
	startCap: number;
	endCap: number;
	/** GDI+ `DashCap` on each dash's inner ends. */
	dashCap: number;
	/** Dash pattern (on, off, ...) in device pixels, or `null` for a solid pen. */
	dash: number[] | null;
	/** Dash offset in device pixels. */
	dashOffset: number;
	/** Compound array (pairs of fractions of the width, ascending), or `null`. */
	compound: number[] | null;
	/** PenAlignment Inset: a closed figure's stroke lies wholly inside it. */
	inset: boolean;
}

type Pt = { x: number; y: number };

/** Flattened points of the arc of radius `r` about `c` from angle `a0` sweeping `sweep` (device, GDI+ flattening). */
function arcPoints(c: Pt, r: number, a0: number, sweep: number): Pt[] {
	const out: Pt[] = [];
	if (!(r > 0) || sweep === 0) {
		return out;
	}
	for (const [p0, p1, p2, p3] of arcBeziers(c.x, c.y, r, r, a0, sweep)) {
		const flat: number[] = [];
		flattenBezier(
			toPlusFix(p0.x),
			toPlusFix(p0.y),
			toPlusFix(p1.x),
			toPlusFix(p1.y),
			toPlusFix(p2.x),
			toPlusFix(p2.y),
			toPlusFix(p3.x),
			toPlusFix(p3.y),
			flat,
			GDIPLUS_HFD_TOLERANCE,
		);
		for (let i = 0; i + 1 < flat.length; i += 2) {
			out.push({ x: flat[i] / 16, y: flat[i + 1] / 16 });
		}
	}
	return out;
}

/** The figure's points without consecutive duplicates (and without a closing duplicate of the first). */
function cleanPoints(pts: ReadonlyArray<number>, closed: boolean): Pt[] {
	const out: Pt[] = [];
	for (let i = 0; i + 1 < pts.length; i += 2) {
		const p = { x: pts[i], y: pts[i + 1] };
		const last = out[out.length - 1];
		if (!last || Math.abs(last.x - p.x) > 1e-9 || Math.abs(last.y - p.y) > 1e-9) {
			out.push(p);
		}
	}
	if (closed && out.length > 1) {
		const a = out[0];
		const b = out[out.length - 1];
		if (Math.abs(a.x - b.x) <= 1e-9 && Math.abs(a.y - b.y) <= 1e-9) {
			out.pop();
		}
	}
	return out;
}

/** Unit direction and left normal (-dy, dx) of segment a->b. */
function frame(a: Pt, b: Pt): { ux: number; uy: number; nx: number; ny: number } {
	const len = Math.hypot(b.x - a.x, b.y - a.y);
	const ux = (b.x - a.x) / len;
	const uy = (b.y - a.y) / len;
	return { ux, uy, nx: -uy, ny: ux };
}

/**
 * The join at vertex `p` between segments with frames `f1` (incoming) and
 * `f2` (outgoing), on the side at signed offset `o` along the left normal.
 */
function joinPoints(p: Pt, f1: ReturnType<typeof frame>, f2: ReturnType<typeof frame>, o: number, pen: DevicePen): Pt[] {
	const a = { x: p.x + f1.nx * o, y: p.y + f1.ny * o };
	const b = { x: p.x + f2.nx * o, y: p.y + f2.ny * o };
	if (o === 0) {
		return [p];
	}
	const cross = f1.ux * f2.uy - f1.uy * f2.ux;
	if (Math.abs(cross) < 1e-12 && f1.ux * f2.ux + f1.uy * f2.uy > 0) {
		return [b]; // Straight on.
	}
	const outer = cross * o < 0;
	if (!outer) {
		return [a, b];
	}
	if (pen.join === 2) {
		const a0 = Math.atan2(a.y - p.y, a.x - p.x);
		let sweep = Math.atan2(b.y - p.y, b.x - p.x) - a0;
		// The short way round, on the outside of the turn.
		while (sweep > Math.PI) {
			sweep -= 2 * Math.PI;
		}
		while (sweep < -Math.PI) {
			sweep += 2 * Math.PI;
		}
		return [a, ...arcPoints(p, Math.abs(o), a0, sweep), b];
	}
	if (pen.join === 1) {
		return [a, b];
	}
	// Miter: where the two offset lines meet.
	const den = f1.ux * f2.uy - f1.uy * f2.ux;
	const t = ((b.x - a.x) * f2.uy - (b.y - a.y) * f2.ux) / den;
	const m = { x: a.x + f1.ux * t, y: a.y + f1.uy * t };
	const len = Math.hypot(m.x - p.x, m.y - p.y);
	const limit = pen.miterLimit * pen.half;
	if (len <= limit) {
		return [m];
	}
	if (pen.join === 3) {
		// Clipped at the limit, square to the miter direction.
		const dx = (m.x - p.x) / len;
		const dy = (m.y - p.y) / len;
		const along = (q: Pt, r: Pt): Pt => {
			// Point on segment q->r at distance `limit` along (dx, dy) from p.
			const dq = (q.x - p.x) * dx + (q.y - p.y) * dy;
			const dr = (r.x - p.x) * dx + (r.y - p.y) * dy;
			const s = dr === dq ? 0 : (limit - dq) / (dr - dq);
			return { x: q.x + (r.x - q.x) * s, y: q.y + (r.y - q.y) * s };
		};
		return [a, along(a, m), along(b, m), b];
	}
	return [a, b];
}

/**
 * The cap at end point `p` of an open figure whose last segment runs along
 * `f` (pointing away from the line for the end, into it negated for the
 * start: callers pass the outward direction), spanning offsets `o1` to
 * `o2` along the left normal of `f`. Points run from the `o2` side to the
 * `o1` side.
 */
function capPoints(p: Pt, f: ReturnType<typeof frame>, o1: number, o2: number, cap: number, half: number): Pt[] {
	const at = (o: number, ext: number): Pt => ({ x: p.x + f.nx * o + f.ux * ext, y: p.y + f.ny * o + f.uy * ext });
	const base = cap & 0x0f;
	// Anchor caps (0x10 + n) are drawn as their base shape; NoAnchor and Custom as flat.
	const kind = cap === 0x11 ? 1 : cap === 0x12 ? 2 : cap === 0x13 || cap === 0x14 ? 3 : cap >= 0x10 ? 0 : base;
	switch (kind) {
		case 1:
			return [at(o2, 0), at(o2, half), at(o1, half), at(o1, 0)];
		case 2: {
			if (Math.abs(o1 + o2) > 1e-9) {
				return [at(o2, 0), at(o1, 0)];
			}
			const a0 = Math.atan2(f.ny, f.nx) + (o2 < 0 ? Math.PI : 0);
			// From the o2 side, round the front (along +u), to the o1 side.
			const sweep = o2 > 0 ? -Math.PI : Math.PI;
			return [at(o2, 0), ...arcPoints(p, Math.abs(o2), a0, sweep), at(o1, 0)];
		}
		case 3:
			return [at(o2, 0), at((o1 + o2) / 2, half), at(o1, 0)];
		default:
			return [at(o2, 0), at(o1, 0)];
	}
}

/** One side of a figure at signed offset `o`: offset points with joins, in order. */
function sidePoints(pts: Pt[], closed: boolean, o: number, pen: DevicePen): Pt[] {
	const n = pts.length;
	const out: Pt[] = [];
	const segs = closed ? n : n - 1;
	const frames = Array.from({ length: segs }, (_, i) => frame(pts[i], pts[(i + 1) % n]));
	for (let i = 0; i < n; i++) {
		const inIdx = i - 1 >= 0 ? i - 1 : closed ? segs - 1 : -1;
		const outIdx = i < segs ? i : -1;
		if (inIdx >= 0 && outIdx >= 0) {
			out.push(...joinPoints(pts[i], frames[inIdx], frames[outIdx], o, pen));
		} else {
			const f = frames[outIdx >= 0 ? outIdx : inIdx];
			out.push({ x: pts[i].x + f.nx * o, y: pts[i].y + f.ny * o });
		}
	}
	return out;
}

/** Splits a figure into its dashes (open polylines) with flags for which ends are the figure's own. */
function dashFigure(pts: Pt[], closed: boolean, pen: DevicePen): Array<{ pts: Pt[]; first: boolean; last: boolean }> {
	// With a Round or Triangle DashCap GDI+ keeps each dash's start and ends
	// its straight part a full pen width early, the caps then reaching half
	// a width beyond both ends (measured with GraphicsPath.Widen: a 12-pixel
	// dash of a 4-pixel pen is straight for 8, a 4-pixel dot for none).
	const shorten = pen.dashCap !== 0 ? 2 * pen.half : 0;
	const dash = (pen.dash as number[]).map((v, i, all) => {
		if (i % 2 === 0) {
			return Math.max(v - shorten, MIN_DASH);
		}
		const on = all[i - 1];
		return v + on - Math.max(on - shorten, MIN_DASH);
	});
	const total = dash.reduce((s, v) => s + v, 0);
	const out: Array<{ pts: Pt[]; first: boolean; last: boolean }> = [];
	if (!(total > 0)) {
		return out;
	}
	// A closed figure is dashed from its last vertex, along the closing
	// segment first (measured: a dashed rectangle's pattern starts at its
	// fourth corner).
	const path = closed ? [pts[pts.length - 1], ...pts] : pts;
	// Phase: where in the pattern the figure starts.
	let phase = ((pen.dashOffset % total) + total) % total;
	let idx = 0;
	while (phase >= dash[idx]) {
		phase -= dash[idx];
		idx = (idx + 1) % dash.length;
	}
	let remaining = dash[idx] - phase;
	let on = idx % 2 === 0;
	let cur: Pt[] | null = on ? [path[0]] : null;
	let curFirst = on;
	for (let i = 0; i + 1 < path.length; i++) {
		const a = path[i];
		const b = path[i + 1];
		let segLen = Math.hypot(b.x - a.x, b.y - a.y);
		let t0 = 0;
		while (segLen - t0 > remaining + 1e-9) {
			t0 += remaining;
			const q = { x: a.x + ((b.x - a.x) * t0) / segLen, y: a.y + ((b.y - a.y) * t0) / segLen };
			if (on && cur) {
				cur.push(q);
				out.push({ pts: cur, first: curFirst, last: false });
				cur = null;
			} else {
				cur = [q];
				curFirst = false;
			}
			on = !on;
			idx = (idx + 1) % dash.length;
			remaining = dash[idx];
		}
		remaining -= segLen - t0;
		if (on && cur) {
			cur.push(b);
		}
		segLen = 0;
	}
	if (on && cur && cur.length > 1) {
		out.push({ pts: cur, first: curFirst, last: true });
	}
	return out.filter((d) => d.pts.length > 1);
}

/** Shortest straight part of a dash (GDI+ keeps a zero-length dash's direction for its caps). */
const MIN_DASH = 1 / 256;

/** Signed area (y down: positive when the figure turns clockwise on screen). */
function signedArea(pts: Pt[]): number {
	let a = 0;
	for (let i = 0; i < pts.length; i++) {
		const p = pts[i];
		const q = pts[(i + 1) % pts.length];
		a += p.x * q.y - q.x * p.y;
	}
	return a / 2;
}

/**
 * The outline polygons (device pixels, filled nonzero) GDI+ fills for
 * stroking `figures` with `pen` (see the module doc). Pure.
 */
export function widenFigures(figures: ReadonlyArray<DeviceFigure>, pen: DevicePen): Pt[][] {
	const polys: Pt[][] = [];
	const h = pen.half;
	for (const fig of figures) {
		const pts = cleanPoints(fig.pts, fig.closed);
		if (pts.length < 2) {
			continue;
		}
		const closed = fig.closed && pts.length > 2;
		// Band edges along the left normal: [lo, hi] per compound band.
		let lo = -h;
		let hi = h;
		if (pen.inset && closed) {
			if (signedArea(pts) > 0) {
				lo = 0;
				hi = 2 * h;
			} else {
				lo = -2 * h;
				hi = 0;
			}
		}
		const bands: Array<[number, number]> = [];
		const c = pen.compound;
		if (c && c.length >= 2) {
			for (let i = 0; i + 1 < c.length; i += 2) {
				bands.push([lo + (hi - lo) * c[i], lo + (hi - lo) * c[i + 1]]);
			}
		} else {
			bands.push([lo, hi]);
		}
		// An Inset pen on a closed figure takes its dash offset in twice its
		// width (measured: offset 0.5 of an 8-pixel inset pen shifts the
		// pattern 8 pixels; the dash lengths stay in the pen's own width).
		const dashPen = pen.inset && closed ? { ...pen, dashOffset: pen.dashOffset * 2 } : pen;
		const pieces = pen.dash ? dashFigure(pts, closed, dashPen) : [{ pts, first: true, last: true }];
		const pieceClosed = !pen.dash && closed;
		for (const piece of pieces) {
			const pp = cleanPoints(
				piece.pts.flatMap((p) => [p.x, p.y]),
				false,
			);
			if (pp.length < 2) {
				continue;
			}
			for (const [o1, o2] of bands) {
				if (pieceClosed) {
					polys.push(sidePoints(pp, true, o2, pen));
					polys.push(sidePoints(pp, true, o1, pen).reverse());
					continue;
				}
				const left = sidePoints(pp, false, o2, pen);
				const right = sidePoints(pp, false, o1, pen).reverse();
				const fEnd = frame(pp[pp.length - 2], pp[pp.length - 1]);
				const f0 = frame(pp[1], pp[0]); // outward at the start (reversed direction)
				const endCap = piece.last && !(pen.dash && closed) ? pen.endCap : pen.dashCap;
				const startCap = piece.first && !(pen.dash && closed) ? pen.startCap : pen.dashCap;
				const capEnd = capPoints(pp[pp.length - 1], fEnd, o1, o2, endCap, h);
				// At the start the outward frame is reversed, so its left normal is the
				// line's right: the band runs from -o1 (the line's o1 side) to -o2.
				const capStart = capPoints(pp[0], f0, -o2, -o1, startCap, h);
				polys.push([...left.slice(0, -1), ...capEnd, ...right.slice(1, -1), ...capStart]);
			}
		}
	}
	return polys;
}
