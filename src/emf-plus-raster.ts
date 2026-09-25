/**
 * GDI+'s own fill rasteriser, reproduced exactly, for EMF+ shapes drawn
 * aliased (SmoothingMode None, Default, HighSpeed) or with GDI+'s
 * antialiasing (AntiAlias, HighQuality).
 *
 * Measured on single polygons, ellipses and Bezier paths drawn by GDI+
 * straight onto a bitmap (every edge pixel compared), GDI+:
 *
 * - converts every device-space vertex and Bezier control point to 28.4
 *   fixed point by rounding to 1/256 and then UP (see {@link toPlusFix};
 *   an ellipse at y = 5.7 has its top at 5.75, one at 56.5 stays at 56.5);
 * - flattens every Bezier (an ellipse is four quarter-turn Beziers) with
 *   the same fixed-point hybrid forward differencing GDI uses, with GDI+'s
 *   own error bounds (`flattenBezierGdiplus`, emf-plus-nominal-line.ts, read
 *   from gdiplus.dll): `GraphicsPath.Flatten` returns exactly those points,
 *   1/16-pixel values included;
 * - scan-converts the resulting polygon at sample points: one per pixel at
 *   the integer device point when aliased, an 8 x 4 grid at
 *   (x - 0.5 + i/8, y - 0.5 + j/4) when antialiased, the coverage being
 *   `round(n * 255 / 32)` of the n samples inside; both half a pixel later
 *   under PixelOffsetMode Half/HighQuality. A sample row meets an edge when
 *   the edge's top <= y < its bottom, and a sample is inside a span when
 *   left <= x < right: the usual top-left rule, evaluated exactly on the
 *   fixed-point vertices.
 *
 * With those three rules every probed shape (polygons, ellipses, Bezier
 * paths; aliased and antialiased) matched GDI+ on every pixel.
 *
 * @module emf-plus-raster
 */

import { arcBeziers } from './emf-plus-flatten';
import { flattenBezierGdiplus } from './emf-plus-nominal-line';
import type { CanvasContext, TransformMatrix } from './emf-types';

/** GDI+'s Bezier flattening tolerance as a fraction of GDI's (fitted: exact on every probed curve). */
export const GDIPLUS_HFD_TOLERANCE = 3 / 8;

/** A figure's vertices in 28.4 device fixed point, as flat `x, y` pairs. */
export type FixFigure = number[];

/**
 * GDI+'s float to 28.4 conversion: the coordinate is first rounded to the
 * nearest 1/256 pixel, then UP to the next 1/16 (so up to 1/32 pixel past
 * a step still rounds down). Fitted on 300 ellipses and Bezier curves read
 * back through `GraphicsPath.Flatten` (297 exact; plain rounding up, the
 * earlier model, got 248), and it keeps every earlier fill fixture exact
 * while fixing curve edges that rounding up moved by 1/16 pixel. A hair
 * below each 1/256 step still rounds down, so a coordinate GDI+ holds
 * exactly that double-precision transforms land just above stays put.
 */
export function toPlusFix(v: number): number {
	return Math.ceil(Math.round(v * 256 - 1e-6) / 16);
}

/** A coordinate in 28.4 rounded to the nearest sixteenth, halves up (see {@link aliasedRectFix}). */
function nearestFix(v: number): number {
	return Math.floor(v * 16 + 0.5 - 1e-4);
}

/**
 * The 28.4 vertices of an axis-aligned rectangle figure as GDI+'s aliased
 * fill holds them: rounded to the NEAREST sixteenth (halves up), not up.
 * Measured on rectangles offset by k/64 pixel: an edge at 10 + 1/64 still
 * paints column 10, one at 10 + 2/64 does not (a triangle's edge at
 * 10 + 1/64 already skips it, the general rounding up). `raw` holds the
 * figure's float device vertices; `null` when it is not such a rectangle.
 */
function aliasedRectFix(raw: ReadonlyArray<number>): FixFigure | null {
	let pts = raw.map(nearestFix);
	if (pts.length === 10 && pts[0] === pts[8] && pts[1] === pts[9]) {
		pts = pts.slice(0, 8);
	}
	if (pts.length !== 8) {
		return null;
	}
	const [x0, y0, x1, y1, x2, y2, x3, y3] = pts;
	const horizontalFirst = y0 === y1 && x1 === x2 && y2 === y3 && x3 === x0;
	const verticalFirst = x0 === x1 && y1 === y2 && x2 === x3 && y3 === y0;
	return horizontalFirst || verticalFirst ? pts : null;
}

/**
 * A figure of a recorded path in device pixels: `pts` as flat `x, y`
 * pairs (a straight vertex exactly where the transform puts it; a curve's
 * points already on GDI+'s 1/16 grid, from its flattening), `closed` when
 * `closePath` ended it, `curved` when any of it came from a curve.
 */
export interface DeviceFigure {
	pts: number[];
	closed: boolean;
	curved: boolean;
}

/**
 * Records the geometry `buildPath` issues (world coordinates, Canvas path
 * calls: `moveTo`, `lineTo`, `bezierCurveTo`, `rect`, `ellipse`,
 * `closePath`) as device-space figures (`device` maps world to device
 * pixels), every curve flattened as GDI+ flattens it: its control points
 * converted to 28.4 and the Bezier flattened by GDI+'s HFD. Throws for a
 * path call it does not model.
 */
export function recordDeviceFigures(buildPath: (c: CanvasContext) => void, device: TransformMatrix): DeviceFigure[] {
	const figures: DeviceFigure[] = [];
	let fig: DeviceFigure | null = null;
	let start: { x: number; y: number } | null = null;
	const dx = (x: number, y: number): number => device[0] * x + device[2] * y + device[4];
	const dy = (x: number, y: number): number => device[1] * x + device[3] * y + device[5];
	const moveTo = (x: number, y: number): void => {
		fig = { pts: [dx(x, y), dy(x, y)], closed: false, curved: false };
		figures.push(fig);
		start = { x, y };
	};
	const lineTo = (x: number, y: number): void => {
		if (!fig) {
			moveTo(x, y);
			return;
		}
		fig.pts.push(dx(x, y), dy(x, y));
	};
	const bezierTo = (c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void => {
		if (!fig) {
			moveTo(c1x, c1y);
		}
		const f = fig as DeviceFigure;
		f.curved = true;
		const n = f.pts.length;
		const fix = (v: number): number => toPlusFix(v);
		const p0x = fix(f.pts[n - 2]);
		const p0y = fix(f.pts[n - 1]);
		// The curve starts at its start point as GDI+ holds it.
		f.pts[n - 2] = p0x / 16;
		f.pts[n - 1] = p0y / 16;
		const out: number[] = [];
		const ctrl = [p0x, p0y, fix(dx(c1x, c1y)), fix(dy(c1x, c1y)), fix(dx(c2x, c2y)), fix(dy(c2x, c2y)), fix(dx(x, y)), fix(dy(x, y))];
		flattenBezierGdiplus(ctrl, out);
		for (const v of out) {
			f.pts.push(v / 16);
		}
	};
	const closePath = (): void => {
		if (fig && start) {
			fig.closed = true;
			// A new figure starts where the closed one began.
			const s: { x: number; y: number } = start;
			moveTo(s.x, s.y);
		}
	};
	const recorder = {
		beginPath(): void {
			fig = null;
			start = null;
		},
		moveTo,
		lineTo,
		closePath,
		rect(x: number, y: number, w: number, h: number): void {
			moveTo(x, y);
			lineTo(x + w, y);
			lineTo(x + w, y + h);
			lineTo(x, y + h);
			closePath();
		},
		bezierCurveTo: bezierTo,
		ellipse(cx: number, cy: number, rx: number, ry: number, rotation: number, a0: number, a1: number, ccw?: boolean): void {
			let sweep = a1 - a0;
			if (ccw) {
				sweep = sweep > 0 ? sweep - 2 * Math.PI * Math.ceil(sweep / (2 * Math.PI)) : sweep;
				sweep = Math.max(sweep, -2 * Math.PI);
			} else {
				sweep = sweep < 0 ? sweep + 2 * Math.PI * Math.ceil(-sweep / (2 * Math.PI)) : sweep;
				sweep = Math.min(sweep, 2 * Math.PI);
			}
			const cos = Math.cos(rotation);
			const sin = Math.sin(rotation);
			const rot = (p: { x: number; y: number }): { x: number; y: number } =>
				rotation === 0 ? p : { x: cx + (p.x - cx) * cos - (p.y - cy) * sin, y: cy + (p.x - cx) * sin + (p.y - cy) * cos };
			const segs = arcBeziers(cx, cy, rx, ry, a0, sweep);
			if (segs.length === 0) {
				return;
			}
			const p0 = rot(segs[0][0]);
			if (fig) {
				lineTo(p0.x, p0.y);
			} else {
				moveTo(p0.x, p0.y);
			}
			for (const seg of segs) {
				const [, q1, q2, q3] = seg.map(rot);
				bezierTo(q1.x, q1.y, q2.x, q2.y, q3.x, q3.y);
			}
		},
	};
	buildPath(recorder as unknown as CanvasContext);
	return figures.filter((f) => f.pts.length >= 4);
}

/**
 * Records the geometry `buildPath` issues as GDI+ holds it for filling:
 * figures of 28.4 device vertices (see {@link recordDeviceFigures}), every
 * figure implicitly closed. `aliased` applies the aliased fill's own
 * rounding of axis-aligned rectangles (see {@link aliasedRectFix}). Throws
 * for a path call it does not model.
 */
export function recordPlusFigures(
	buildPath: (c: CanvasContext) => void,
	device: TransformMatrix,
	aliased: boolean = false,
): FixFigure[] {
	return recordDeviceFigures(buildPath, device)
		.map((f) => (aliased && !f.curved ? aliasedRectFix(f.pts) : null) ?? f.pts.map(toPlusFix))
		.filter((f) => f.length >= 6);
}

/** Exact integer ceiling of `a / b` for integers with `b > 0` (products stay below 2^53). */
function ceilDiv(a: number, b: number): number {
	let q = Math.floor(a / b);
	while (q * b > a) {
		q--;
	}
	while ((q + 1) * b <= a) {
		q++;
	}
	return q * b === a ? q : q + 1;
}

/** Device box the figures cover (whole pixels, one pixel of margin), clamped to `size`. */
export function figuresBox(
	figures: ReadonlyArray<FixFigure>,
	size: { w: number; h: number },
): { x: number; y: number; w: number; h: number } | null {
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const f of figures) {
		for (let i = 0; i < f.length; i += 2) {
			x0 = Math.min(x0, f[i]);
			x1 = Math.max(x1, f[i]);
			y0 = Math.min(y0, f[i + 1]);
			y1 = Math.max(y1, f[i + 1]);
		}
	}
	if (!Number.isFinite(x0)) {
		return null;
	}
	const l = Math.max(0, Math.floor(x0 / 16) - 1);
	const t = Math.max(0, Math.floor(y0 / 16) - 1);
	const r = Math.min(size.w, Math.ceil(x1 / 16) + 2);
	const b = Math.min(size.h, Math.ceil(y1 / 16) + 2);
	return r > l && b > t ? { x: l, y: t, w: r - l, h: b - t } : null;
}

/**
 * Scan-converts `figures` (implicitly closed) over `box` the way GDI+ does
 * (see the module doc): per-pixel coverage 0..255, from one sample per
 * pixel (`antialias` false: 0 or 255) or GDI+'s 8 x 4 grid. `half` moves
 * the samples half a pixel right and down (PixelOffsetMode Half and
 * HighQuality). Pure.
 */
export function rasterizePlusFill(
	figures: ReadonlyArray<FixFigure>,
	evenOdd: boolean,
	antialias: boolean,
	half: boolean,
	box: { x: number; y: number; w: number; h: number },
): Uint8ClampedArray {
	const sx = antialias ? 8 : 1;
	const sy = antialias ? 4 : 1;
	const stepX = 16 / sx;
	const stepY = 16 / sy;
	const o = half ? 8 : 0;
	// Sample (k, r) sits at x = x0 + stepX k, y = y0 + stepY r (1/16 units).
	const x0 = 16 * box.x + o - (antialias ? 8 : 0);
	const y0 = 16 * box.y + o - (antialias ? 8 : 0);
	const cols = box.w * sx;
	interface Edge {
		ax: number;
		ay: number;
		bx: number;
		by: number;
		top: number;
		bottom: number;
		w: number;
	}
	const edges: Edge[] = [];
	for (const f of figures) {
		const n = f.length / 2;
		for (let i = 0; i < n; i++) {
			const j = (i + 1) % n;
			const ax = f[2 * i];
			const ay = f[2 * i + 1];
			const bx = f[2 * j];
			const by = f[2 * j + 1];
			if (ay === by) {
				continue;
			}
			edges.push({ ax, ay, bx, by, top: Math.min(ay, by), bottom: Math.max(ay, by), w: by > ay ? 1 : -1 });
		}
	}
	const coverage = new Uint8ClampedArray(box.w * box.h);
	const counts = new Int32Array(box.w);
	const diff = new Int32Array(cols + 1);
	const xs: Array<{ k: number; w: number }> = [];
	for (let py = 0; py < box.h; py++) {
		counts.fill(0);
		for (let r = 0; r < sy; r++) {
			const y = y0 + stepY * (py * sy + r);
			xs.length = 0;
			for (const e of edges) {
				if (y < e.top || y >= e.bottom) {
					continue;
				}
				// Crossing x = N / D exactly (D > 0); first sample with x0 + stepX k >= N / D.
				let D = e.by - e.ay;
				let N = e.ax * D + (e.bx - e.ax) * (y - e.ay);
				if (D < 0) {
					D = -D;
					N = -N;
				}
				const k = ceilDiv(N - x0 * D, stepX * D);
				xs.push({ k: Math.min(Math.max(k, 0), cols), w: e.w });
			}
			if (xs.length < 2) {
				continue;
			}
			xs.sort((a, b) => a.k - b.k);
			diff.fill(0);
			let wind = 0;
			for (let i = 0; i + 1 < xs.length; i++) {
				wind += xs[i].w;
				const inside = evenOdd ? (wind & 1) !== 0 : wind !== 0;
				if (inside && xs[i + 1].k > xs[i].k) {
					diff[xs[i].k]++;
					diff[xs[i + 1].k]--;
				}
			}
			let run = 0;
			for (let k = 0; k < cols; k++) {
				run += diff[k];
				if (run > 0) {
					counts[(k / sx) | 0]++;
				}
			}
		}
		const total = sx * sy;
		for (let px = 0; px < box.w; px++) {
			const c = counts[px];
			coverage[py * box.w + px] = c === 0 ? 0 : c >= total ? 255 : Math.round((c * 255) / total);
		}
	}
	return coverage;
}

/**
 * The device pixels GDI+ holds for a clip region made of `shapes` (each
 * issuing device-space geometry, the region their intersection), as
 * disjoint rectangles within `box`: every shape recorded and
 * scan-converted like an aliased fill (a pixel belongs when its sample
 * point is inside), its vertices rounded to the nearest sixteenth rather
 * than up (measured on a star-shaped clip path: exact on every pixel). `half` samples at pixel centres (PixelOffsetMode Half,
 * HighQuality). `null` when a shape uses a path call the recorder does not
 * model.
 */
export function clipPixelRects(
	shapes: ReadonlyArray<{ build: (c: CanvasContext) => void; evenOdd: boolean }>,
	box: { x: number; y: number; w: number; h: number },
	half: boolean,
): Array<{ x: number; y: number; w: number; h: number }> | null {
	const identity: TransformMatrix = [1, 0, 0, 1, 0, 0];
	let inside: Uint8ClampedArray | null = null;
	for (const shape of shapes) {
		let figs: FixFigure[];
		try {
			// A region's vertices round to the NEAREST sixteenth (measured on a
			// star clip: rounding up left four tip pixels out).
			figs = recordDeviceFigures(shape.build, identity).map((f) => f.pts.map(nearestFix));
		} catch {
			return null;
		}
		const cov = rasterizePlusFill(figs, shape.evenOdd, false, half, box);
		if (inside) {
			for (let i = 0; i < cov.length; i++) {
				inside[i] = inside[i] && cov[i];
			}
		} else {
			inside = cov;
		}
	}
	const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
	if (!inside) {
		return rects;
	}
	// Runs per row, merged downwards while a run repeats exactly.
	let open = new Map<string, { x: number; y: number; w: number; h: number }>();
	for (let y = 0; y < box.h; y++) {
		const next = new Map<string, { x: number; y: number; w: number; h: number }>();
		for (let x = 0; x < box.w; ) {
			if (!inside[y * box.w + x]) {
				x++;
				continue;
			}
			let e = x;
			while (e < box.w && inside[y * box.w + e]) {
				e++;
			}
			const key = x + ',' + e;
			const prev = open.get(key);
			if (prev) {
				prev.h++;
				next.set(key, prev);
				open.delete(key);
			} else {
				const r = { x: box.x + x, y: box.y + y, w: e - x, h: 1 };
				rects.push(r);
				next.set(key, r);
			}
			x = e;
		}
		open = next;
	}
	return rects;
}
