/**
 * GDI+ custom line caps (`EmfPlusCustomLineCap`, object type 9, carried
 * inside an `EmfPlusPen` as its PenDataCustomStartCap / PenDataCustomEndCap)
 * and the geometry GDI+ builds for them.
 *
 * Read from gdiplus.dll (`GpEndCapCreator`, `GpCustomLineCap`,
 * `GpAdjustableArrowCap`) and confirmed against `GraphicsPath.Widen` and
 * direct GDI+ drawing:
 *
 * - A cap's shape is a path in cap space: +y points out of the line along
 *   its direction, +x to the right of it (for a line heading east, cap
 *   +x is device north). A cap point (x, y) lands at
 *   `origin + s * (x * (dy, -dx) + y * (dx, dy))`, with `origin` the
 *   figure's original end point and (dx, dy) the cap direction.
 * - Its "length" (the fill length for a fill path, the stroke length for a
 *   line path) is the deepest crossing of the path's segments with the
 *   negative y axis (0 when none; a fill path without one is rejected by
 *   GDI+, a line path's 0 counts as 1).
 * - The direction comes from `ComputeCapGradient`: walking the flattened
 *   figure from its end, every point within `length * scale` of the end is
 *   dropped, except the last one, which moves to
 *   `I + (1 - t) * (end - I)`, where `I` is where that radius crosses the
 *   segment to the first point beyond it and `t = BaseInset / length`: so
 *   the line now stops `BaseInset * scale` short of the end, on the line
 *   from the end to `I`. The cap points along `end - I`, not along the
 *   last segment. When every point is within the radius the whole figure
 *   is dropped (only the caps remain).
 * - The scale is the pen width times the cap's WidthScale. A fill cap's
 *   gradient radius uses at least one device pixel of scale and its shape
 *   at least two (see {@link CapGeometryOptions.minFillScale}); a line cap
 *   is scaled as is but widened at least one pixel wide.
 * - A fill path is filled as it stands (its own figures, closed); a line
 *   path is widened with a pen of the line's width times WidthScale, the
 *   cap's StrokeStartCap, StrokeEndCap and StrokeJoin and a miter limit of
 *   10 (the cap's StrokeMiterLimit is not used), solid and uncompounded.
 * - The shortened line is widened with FLAT ends where a custom cap sits
 *   (the cap's BaseCap is not drawn), and the whole lot is one nonzero fill.
 * - AdjustableArrowCap builds its path from Width w, Height h and
 *   MiddleInset m: (w/2, -h), (0, 0), (-w/2, -h), then (0, m - h) when m is
 *   not 0 and the arrow is filled; filled arrows are fill paths (closed),
 *   unfilled ones line paths (open, without the middle point). Its
 *   BaseInset is h / w (0 when w is 0).
 * - The fill caps are applied before the stroke caps, the start cap before
 *   the end cap, all on the same (mutable) point list.
 *
 * @module emf-plus-custom-cap
 */

import { recordDeviceFigures, type DeviceFigure } from './emf-plus-raster';
import { widenFigures, type DevicePen } from './emf-plus-widen';
import { parseEmfPlusPath } from './emf-plus-path';
import type { CanvasContext, EmfPlusPath } from './emf-types';

/** A point in device (or cap) coordinates. */
interface Pt {
	x: number;
	y: number;
}

/** An EMF+ custom line cap (`EmfPlusCustomLineCap`), as {@link parseCustomLineCap} reads it. */
export interface EmfPlusCustomLineCap {
	kind: 'plus-customlinecap';
	/** `CustomLineCapDataType`: 0 a default custom cap, 1 an AdjustableArrowCap. */
	capType: 0 | 1;
	/** The LineCap the cap is based on (not drawn by GDI+ at a custom-capped end). */
	baseCap: number;
	/** How far the line stops short of its end, in multiples of the cap scale. */
	baseInset: number;
	/** Caps and join of the pen that widens a line-path cap. */
	strokeStartCap: number;
	strokeEndCap: number;
	strokeJoin: number;
	/** Recorded, but GDI+ widens a line-path cap with a miter limit of 10 regardless. */
	strokeMiterLimit: number;
	/** Scale of the cap relative to the pen width. */
	widthScale: number;
	/** The filled shape, in cap space, or `null`. */
	fillPath: EmfPlusPath | null;
	/** The outlined (widened) shape, in cap space, or `null`. */
	linePath: EmfPlusPath | null;
	/** Deepest crossing of the fill path with the negative y axis (see the module doc). */
	fillLength: number;
	/** Deepest crossing of the line path with the negative y axis (0 when none). */
	strokeLength: number;
	/** AdjustableArrowCap parameters, for `capType` 1. */
	arrow?: { width: number; height: number; middleInset: number; filled: boolean };
}

/** `CustomLineCapData` flags (MS-EMFPLUS 2.1.2.2). */
const CAP_DATA_FILL_PATH = 0x1;
const CAP_DATA_LINE_PATH = 0x2;

/** GDI+'s epsilon for a zero length (FLT_EPSILON). */
const FLT_EPS = 1.1920928955078125e-7;

const f32 = Math.fround;

/**
 * The deepest crossing of a path's segments with the negative y axis, as a
 * positive length (GDI+'s `SetFillPath`/`SetStrokePath` length): every
 * segment from one point to the next, starting (when the path's last point
 * carries the close flag) with the closing segment from the last point to
 * the first. 0 when no segment crosses below the origin. Pure.
 */
export function capPathLength(points: ReadonlyArray<Pt>, types: ArrayLike<number>): number {
	const n = points.length;
	if (n < 2) {
		return 0;
	}
	const closed = (types[n - 1] & 0x80) !== 0;
	let prev = closed ? points[n - 1] : points[0];
	let min = 0;
	for (let i = 0; i < n; i++) {
		const p = points[i];
		// intersect_line_yaxis(p, prev): the point where p -> prev meets x = 0.
		const dx = f32(prev.x - p.x);
		if (Math.abs(dx) >= FLT_EPS) {
			const t = f32(-p.x / dx);
			if (!(t < -FLT_EPS) && !(f32(t - 1) > FLT_EPS)) {
				const y = f32(f32(f32(prev.y - p.y) * t) + p.y);
				min = Math.min(min, y);
			}
		}
		prev = p;
	}
	return min < 0 ? -min : 0;
}

/** The AdjustableArrowCap path (`GpAdjustableArrowCap::GetPathData`), in cap space. */
export function arrowCapPath(width: number, height: number, middleInset: number, filled: boolean): EmfPlusPath {
	const h = f32(height);
	const w2 = f32(f32(width) * 0.5);
	const points: Pt[] = [
		{ x: w2, y: -h },
		{ x: 0, y: 0 },
		{ x: -w2, y: -h },
	];
	if (filled && middleInset !== 0) {
		points.push({ x: 0, y: f32(f32(middleInset) - h) });
	}
	const types = new Uint8Array(points.length);
	types.fill(1);
	types[0] = 0;
	if (filled) {
		types[points.length - 1] |= 0x80;
	}
	return { kind: 'plus-path', points, types, fillRule: 'nonzero' };
}

/**
 * Parses an `EmfPlusCustomLineCap` object at `off` (its Version field;
 * `size` bytes are available): a default cap with its optional fill and
 * line paths, or an AdjustableArrowCap, whose path is rebuilt as GDI+
 * builds it. Returns `null` for data that is short or of an unknown type.
 */
export function parseCustomLineCap(view: DataView, off: number, size: number): EmfPlusCustomLineCap | null {
	const end = off + size;
	if (size < 8 || end > view.byteLength) {
		return null;
	}
	const type = view.getInt32(off + 4, true);
	const d = off + 8;
	const f = (k: number): number => view.getFloat32(d + k, true);
	const u = (k: number): number => view.getUint32(d + k, true);
	if (type === 1) {
		if (d + 52 > end) {
			return null;
		}
		const width = f(0);
		const height = f(4);
		const middleInset = f(8);
		const filled = u(12) !== 0;
		const path = arrowCapPath(width, height, middleInset, filled);
		const length = capPathLength(path.points, path.types);
		return {
			kind: 'plus-customlinecap',
			capType: 1,
			baseCap: 0,
			baseInset: width !== 0 ? f32(height / width) : 0,
			strokeStartCap: u(16),
			strokeEndCap: u(20),
			strokeJoin: u(24),
			strokeMiterLimit: f(28),
			widthScale: f(32),
			fillPath: filled ? path : null,
			linePath: filled ? null : path,
			fillLength: filled ? length : 0,
			strokeLength: filled ? 0 : length,
			arrow: { width, height, middleInset, filled },
		};
	}
	if (type !== 0 || d + 48 > end) {
		return null;
	}
	const flags = u(0);
	let o = d + 48;
	const readPath = (): EmfPlusPath | null => {
		if (o + 4 > end) {
			return null;
		}
		const len = view.getInt32(o, true);
		o += 4;
		if (len <= 0 || o + len > end) {
			return null;
		}
		const path = parseEmfPlusPath(view, o, len);
		o += len;
		return path;
	};
	const fillPath = flags & CAP_DATA_FILL_PATH ? readPath() : null;
	const linePath = flags & CAP_DATA_LINE_PATH ? readPath() : null;
	return {
		kind: 'plus-customlinecap',
		capType: 0,
		baseCap: u(4),
		baseInset: f(8),
		strokeStartCap: u(12),
		strokeEndCap: u(16),
		strokeJoin: u(20),
		strokeMiterLimit: f(24),
		widthScale: f(28),
		fillPath,
		linePath,
		fillLength: fillPath ? capPathLength(fillPath.points, fillPath.types) : 0,
		strokeLength: linePath ? capPathLength(linePath.points, linePath.types) : 0,
	};
}

/**
 * Where a radius of `sqrt(r2)` about `c` first crosses the segment from `a`
 * (outside) towards `b` (GDI+'s `intersect_circle_line`), or `null`.
 */
function intersectCircleLine(c: Pt, r2: number, a: Pt, b: Pt): Pt | null {
	const vx = f32(b.x - a.x);
	const vy = f32(b.y - a.y);
	const len = Math.sqrt(f32(f32(vx * vx) + f32(vy * vy)));
	if (len < FLT_EPS) {
		return null;
	}
	const inv = f32(1 / len);
	const ux = f32(vx * inv);
	const uy = f32(vy * inv);
	const wx = f32(c.x - a.x);
	const wy = f32(c.y - a.y);
	const d2 = f32(f32(wy * wy) + f32(wx * wx));
	const proj = f32(f32(wy * uy) + f32(wx * ux));
	if (proj < FLT_EPS && d2 >= r2) {
		return null;
	}
	const disc = r2 - d2 + proj * proj;
	if (disc < FLT_EPS) {
		return null;
	}
	const s = Math.sqrt(disc);
	let t: number | null = null;
	if (d2 >= r2) {
		const t1 = proj - s;
		if (t1 > FLT_EPS && t1 >= 0) {
			t = t1;
		}
	}
	if (t === null) {
		const t2 = s + proj;
		if (t2 > FLT_EPS && t2 >= 0) {
			t = t2;
		}
	}
	if (t === null) {
		return null;
	}
	const tf = f32(t);
	return { x: f32(f32(tf * ux) + a.x), y: f32(f32(tf * uy) + a.y) };
}

/**
 * GDI+'s `ComputeCapGradient` on a figure's points (mutated in place):
 * walks from the start (`reverse` false) or the end, drops the points
 * within `sqrt(r2)` of the end point (setting `dropped`), keeps and moves
 * the last of them (see the module doc), and returns the unit vector from
 * the end point back into the line.
 */
function capGradient(pts: Pt[], dropped: boolean[], reverse: boolean, r2: number, t: number): Pt {
	const n = pts.length;
	const at = (k: number): number => (reverse ? n - 1 - k : k);
	const p0 = { ...pts[at(0)] };
	let k = 0;
	let found = false;
	let wasDropped = false;
	let outside = at(0);
	while (k < n) {
		const q = pts[at(k)];
		outside = at(k);
		const dx = f32(q.x - p0.x);
		const dy = f32(q.y - p0.y);
		if (f32(f32(dx * dx) + f32(dy * dy)) > r2) {
			found = true;
			break;
		}
		wasDropped = dropped[at(k)];
		dropped[at(k)] = true;
		k++;
	}
	const cur = at(Math.max(0, k - 1));
	if (found && !wasDropped) {
		dropped[cur] = false;
	}
	const inner = pts[cur];
	const hit = intersectCircleLine(p0, r2, pts[outside], inner) ?? { x: inner.x, y: inner.y };
	let gx = f32(hit.x - p0.x);
	let gy = f32(hit.y - p0.y);
	const len = Math.sqrt(gx * gx + gy * gy);
	if (len > FLT_EPS) {
		gx = f32(gx / len);
		gy = f32(gy / len);
	} else {
		gx = 0;
		gy = 0;
	}
	const k1 = f32(1 - t);
	pts[cur] = {
		x: f32(f32(f32(p0.x - hit.x) * k1) + hit.x),
		y: f32(f32(f32(p0.y - hit.y) * k1) + hit.y),
	};
	return { x: gx, y: gy };
}

/** A cap path's points placed at `origin` along direction `d` at scale `s` (GDI+'s `getTransformedPoints`). */
function placeCapPath(path: EmfPlusPath, origin: Pt, d: Pt, s: number): EmfPlusPath {
	const ax = f32(d.y * s);
	const ay = f32(-d.x * s);
	const bx = f32(d.x * s);
	const by = f32(d.y * s);
	const points = path.points.map((p) => ({
		x: f32(f32(f32(ax * p.x) + f32(bx * p.y)) + origin.x),
		y: f32(f32(f32(ay * p.x) + f32(by * p.y)) + origin.y),
	}));
	return { ...path, points };
}

/** A placed cap path's figures in device space, curves flattened as GDI+ flattens them. */
function capFigures(path: EmfPlusPath, closeAll: boolean): DeviceFigure[] {
	const figures = recordDeviceFigures((c: CanvasContext) => {
		const pts = path.points;
		const types = path.types;
		let i = 0;
		while (i < pts.length) {
			const t = types[i] & 0x07;
			if (t === 0 || i === 0) {
				c.moveTo(pts[i].x, pts[i].y);
				i++;
			} else if (t === 3 && i + 2 < pts.length) {
				c.bezierCurveTo(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, pts[i + 2].x, pts[i + 2].y);
				i += 3;
				if (types[i - 1] & 0x80) {
					c.closePath();
				}
				continue;
			} else {
				c.lineTo(pts[i].x, pts[i].y);
				i++;
			}
			if (types[i - 1] & 0x80) {
				c.closePath();
			}
		}
	}, [1, 0, 0, 1, 0, 0]);
	return closeAll ? figures.map((f) => ({ ...f, closed: true })) : figures;
}

/** Options of {@link customCapGeometry}. */
export interface CapGeometryOptions {
	/**
	 * Smallest scale of a FILL cap, in device pixels. GDI+ takes
	 * `max(pen width x WidthScale, k)` with k = 2 when a flag of the path
	 * being drawn is set, else 1; every measured DrawLines, DrawBezier and
	 * `GraphicsPath.Widen` used 2 (a 0.25, 1 and 1.5 pixel pen all drew a
	 * fill cap at scale 2). Default 2.
	 */
	minFillScale?: number;
	/**
	 * Maps a GDI+ LineJoin to the join `widenFigures` should be given for a
	 * line-path cap's outline. Identity by default.
	 */
	widenJoin?: (join: number) => number;
	/** The widener for line-path caps (default `widenFigures`). */
	widen?: (figures: ReadonlyArray<DeviceFigure>, pen: DevicePen) => Pt[][];
}

/** The result of {@link customCapGeometry}. */
export interface CapGeometry {
	/** The figures to widen with the pen (shortened, flat-ended where a custom cap sits). */
	figures: DeviceFigure[];
	/** Per figure: whether its start / end carries a custom cap (and so gets a flat end). */
	capped: Array<{ start: boolean; end: boolean }>;
	/** Extra device polygons (fill caps, widened line caps), filled nonzero with the widened line. */
	polygons: Pt[][];
}

/**
 * The geometry GDI+ strokes for `figures` (device space, curves flattened)
 * drawn with a pen of full device width `width` whose ends carry the custom
 * caps `start` and `end` (either may be `null`): the figures shortened and
 * pruned as GDI+'s end-cap creator leaves them, and the caps' device
 * polygons (see the module doc). Closed figures are returned unchanged and
 * get no caps. Pure (the input figures are not mutated).
 */
export function customCapGeometry(
	figures: ReadonlyArray<DeviceFigure>,
	width: number,
	start: EmfPlusCustomLineCap | null,
	end: EmfPlusCustomLineCap | null,
	options: CapGeometryOptions = {},
): CapGeometry {
	const out: DeviceFigure[] = [];
	const capped: Array<{ start: boolean; end: boolean }> = [];
	const polygons: Pt[][] = [];
	const minFill = options.minFillScale ?? 2;
	for (const fig of figures) {
		if (fig.closed || (!start && !end)) {
			out.push(fig);
			capped.push({ start: false, end: false });
			continue;
		}
		const pts: Pt[] = [];
		for (let i = 0; i + 1 < fig.pts.length; i += 2) {
			pts.push({ x: fig.pts[i], y: fig.pts[i + 1] });
		}
		if (pts.length < 2) {
			out.push(fig);
			capped.push({ start: false, end: false });
			continue;
		}
		const dropped = new Array<boolean>(pts.length).fill(false);
		const first = { ...pts[0] };
		const last = { ...pts[pts.length - 1] };
		const apply = (cap: EmfPlusCustomLineCap, atEnd: boolean, fill: boolean): void => {
			const path = fill ? cap.fillPath : cap.linePath;
			if (!path || path.points.length === 0) {
				return;
			}
			const ws = f32(cap.widthScale * width);
			let length: number;
			let scale: number;
			if (fill) {
				length = cap.fillLength;
				scale = Math.max(ws, 1);
			} else {
				length = Math.abs(cap.strokeLength) < FLT_EPS ? 1 : cap.strokeLength;
				scale = ws;
			}
			const t = fill && Math.abs(length) < FLT_EPS ? 0 : f32(cap.baseInset / length);
			const r = f32(length * scale);
			const g = capGradient(pts, dropped, atEnd, f32(r * r), t);
			const dir = { x: -g.x, y: -g.y };
			const origin = atEnd ? last : first;
			if (fill) {
				const placed = placeCapPath(path, origin, dir, Math.max(scale, minFill));
				for (const f of capFigures(placed, true)) {
					const poly: Pt[] = [];
					for (let i = 0; i + 1 < f.pts.length; i += 2) {
						poly.push({ x: f.pts[i], y: f.pts[i + 1] });
					}
					polygons.push(poly);
				}
			} else {
				const placed = placeCapPath(path, origin, dir, scale);
				const pen: DevicePen = {
					// GDI+'s widener never makes an outline thinner than one device pixel.
					half: Math.max(ws, 1) / 2,
					join: (options.widenJoin ?? ((j: number) => j))(cap.strokeJoin),
					miterLimit: 10,
					startCap: cap.strokeStartCap,
					endCap: cap.strokeEndCap,
					dashCap: 0,
					dash: null,
					dashOffset: 0,
					compound: null,
					inset: false,
				};
				polygons.push(...(options.widen ?? widenFigures)(capFigures(placed, false), pen).map((q) => q.reverse()));
			}
		};
		// GpEndCapCreator::GetCapsForSubpath: fill caps (start, end), then stroke caps.
		if (start) {
			apply(start, false, true);
		}
		if (end) {
			apply(end, true, true);
		}
		if (start) {
			apply(start, false, false);
		}
		if (end) {
			apply(end, true, false);
		}
		const kept: number[] = [];
		pts.forEach((p, i) => {
			if (!dropped[i]) {
				kept.push(p.x, p.y);
			}
		});
		if (kept.length >= 4) {
			out.push({ pts: kept, closed: false, curved: fig.curved });
			capped.push({ start: !!start, end: !!end });
		}
	}
	return { figures: out, capped, polygons };
}
