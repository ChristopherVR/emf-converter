/**
 * EMF GDI shape record handlers: MoveTo, LineTo, Rectangle, RoundRect,
 * Ellipse, Arc, ArcTo, Chord, and Pie.
 *
 * Every shape is described twice and handed to `paintGdiShape`
 * (`emf-gdi-shape-paint.ts`), which picks the route:
 *   - `build`: Canvas geometry (`beginPath()` + path calls on whichever
 *     context it is given), for the default antialiased route;
 *   - `raster`: GDI's own device geometry in 28.4 fixed point, built the
 *     way GDI builds it (`emf-gdi-raster-shapes.ts`, `gdi-raster.ts`), for
 *     the exact route (`gdiAntialias: false`, pattern brushes, bitwise
 *     `SetROP2` modes).
 * Inside a `BeginPath`/`EndPath` bracket both are recorded instead: the
 * Canvas geometry into `rCtx.pathCmds` (through `gdiPathRecorder`) and the
 * GDI geometry into `rCtx.rasterPath`, for `EMR_FILLPATH` and friends.
 * Rectangle keeps its own `fillRect`/`strokeRect` fast path for the common
 * plain case (solid brush, solid or null one-pixel pen, no rotation, a
 * ROP2 mode Canvas composites exactly).
 *
 * When the active world transform has a rotation/skew component
 * ({@link hasWorldRotation}), the Canvas geometry is built via the
 * full-affine `gmapPoint`/`gdiEllipseParams` (`emf-gdi-coord.ts`) instead of
 * the scale-only `gmx`/`gmy`/`gmw`/`gmh`. A rounded rectangle's Canvas
 * geometry is built in LOGICAL space with its elliptical corners as cubic
 * Beziers ({@link appendRoundRectPath}) mapped through the affine, which
 * carries each corner to the exact transformed quarter ellipse.
 *
 * Arcs run counter-clockwise on screen by default (`AD_COUNTERCLOCKWISE`)
 * and clockwise after `EMR_SETARCDIRECTION` `AD_CLOCKWISE`; both routes
 * honour it.
 */

import { applyPen, applyBrush, rop2Paint } from './emf-canvas-helpers';
import { readColorRef } from './emf-color-helpers';
import {
	EMR_MOVETOEX,
	EMR_LINETO,
	EMR_SETPIXELV,
	EMR_RECTANGLE,
	EMR_ROUNDRECT,
	EMR_ELLIPSE,
	EMR_ARC,
	EMR_ARCTO,
	EMR_CHORD,
	EMR_PIE,
} from './emf-constants';
import { realizeBrush } from './emf-gdi-brush-pattern';
import {
	gmx,
	gmy,
	gmw,
	gmh,
	gmapPoint,
	gdiDeviceMatrix,
	gdiEllipseParams,
	hasWorldRotation,
} from './emf-gdi-coord';
import { gdiPathRecorder } from './emf-gdi-path-record';
import {
	arcRasterPath,
	ellipseRasterPath,
	fixBox,
	fixPoint,
	isAxisBox,
	penIsCosmetic,
	rectRasterPath,
	roundRectRasterPath,
	type ArcKind,
} from './emf-gdi-raster-shapes';
import { gdiStrokeAlign, paintGdiShape, penLineWidth, penScale } from './emf-gdi-shape-paint';
import { invertAffine } from './emf-plus-exact-fill';
import { isExactRop2Bitwise } from './emf-rop2-exact';
import type { CanvasContext, DrawState, EmfGdiReplayCtx } from './emf-types';
import { GdiRasterPath, type FixBox } from './gdi-raster';

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

/**
 * True when Rectangle's `fillRect`/`strokeRect` fast path would not paint
 * what GDI paints: a pattern brush, a bitwise ROP2 mode, `gdiAntialias:
 * false`, or a pen that is styled or wider than one pixel.
 */
function needsPathBasedRectangle(rCtx: EmfGdiReplayCtx): boolean {
	const { state } = rCtx;
	const paint = rop2Paint(state.rop2);
	const ropExact = !paint.exact && isExactRop2Bitwise(state.rop2);
	const penPlain = state.penStyle === 5 || ((state.penStyle === 0 || state.penStyle === 6) && penIsCosmetic(rCtx));
	return ropExact || rCtx.gdiAntialias === false || realizeBrush(state).kind === 'tile' || !penPlain;
}

/** The bracket's GDI geometry, created on first use. */
function rasterPathOf(rCtx: EmfGdiReplayCtx): GdiRasterPath {
	rCtx.rasterPath ??= new GdiRasterPath();
	return rCtx.rasterPath;
}

/** The pen's dash-pattern cursor shared by consecutive `LineTo` records. */
function lineStyleOf(rCtx: EmfGdiReplayCtx): { pos: number } {
	rCtx.lineStyle ??= { pos: 0 };
	return rCtx.lineStyle;
}

/** Ends a run of `LineTo` records: the next one starts the dash pattern afresh. */
function resetLineStyle(rCtx: EmfGdiReplayCtx): void {
	rCtx.lineStyle = { pos: 0 };
}

/**
 * The current position in device FIX: the exact arc end an ArcTo left
 * (GDI keeps it at 28.4 precision) while the logical current position is
 * still the one it set, otherwise the mapped logical point.
 */
export function currentFix(rCtx: EmfGdiReplayCtx): [number, number] {
	const c = rCtx.curFix;
	const { state } = rCtx;
	if (c && c.lx === state.curX && c.ly === state.curY) {
		return [c.x, c.y];
	}
	return fixPoint(rCtx, state.curX, state.curY);
}

/** A logical extent `v` along the device x (`axis` 0) or y (`axis` 1) direction, in device FIX. */
function fixExtent(rCtx: EmfGdiReplayCtx, v: number, axis: 0 | 1): number {
	const m = gdiDeviceMatrix(rCtx);
	const k = axis === 0 ? Math.hypot(m[0], m[1]) : Math.hypot(m[2], m[3]);
	return Math.round(Math.abs(v) * k * 16);
}

// ---------------------------------------------------------------------------
// Individual shape handlers
// ---------------------------------------------------------------------------

function handleSetPixelV(rCtx: EmfGdiReplayCtx, dataOff: number, recSize: number): boolean {
	const { ctx, view } = rCtx;
	if (recSize >= 20) {
		const x = view.getInt32(dataOff, true);
		const y = view.getInt32(dataOff + 4, true);
		const color = readColorRef(view, dataOff + 8);
		const p = hasWorldRotation(rCtx) ? gmapPoint(rCtx, x, y) : { x: gmx(rCtx, x), y: gmy(rCtx, y) };
		ctx.fillStyle = color;
		ctx.fillRect(p.x, p.y, 1, 1);
	}
	return true;
}

function handleMoveToEx(rCtx: EmfGdiReplayCtx, dataOff: number, recSize: number): boolean {
	const { view, state, inPath } = rCtx;
	if (recSize >= 16) {
		state.curX = view.getInt32(dataOff, true);
		state.curY = view.getInt32(dataOff + 4, true);
		resetLineStyle(rCtx);
		rCtx.curFix = undefined;
		if (inPath) {
			const p = hasWorldRotation(rCtx)
				? gmapPoint(rCtx, state.curX, state.curY)
				: { x: gmx(rCtx, state.curX), y: gmy(rCtx, state.curY) };
			gdiPathRecorder(rCtx).moveTo(p.x, p.y);
			const f = fixPoint(rCtx, state.curX, state.curY);
			rasterPathOf(rCtx).moveTo(f[0], f[1]);
		}
	}
	return true;
}

function handleLineTo(rCtx: EmfGdiReplayCtx, dataOff: number, recSize: number): boolean {
	const { view, state, inPath } = rCtx;
	if (recSize >= 16) {
		const lx = view.getInt32(dataOff, true);
		const ly = view.getInt32(dataOff + 4, true);
		const rotated = hasWorldRotation(rCtx);
		const to = rotated ? gmapPoint(rCtx, lx, ly) : { x: gmx(rCtx, lx), y: gmy(rCtx, ly) };
		const fixTo = fixPoint(rCtx, lx, ly);
		if (inPath) {
			gdiPathRecorder(rCtx).lineTo(to.x, to.y);
			rasterPathOf(rCtx).lineTo(fixTo[0], fixTo[1]);
		} else {
			const from = rotated
				? gmapPoint(rCtx, state.curX, state.curY)
				: { x: gmx(rCtx, state.curX), y: gmy(rCtx, state.curY) };
			const fixFrom = currentFix(rCtx);
			paintGdiShape(rCtx, {
				build: (c: CanvasContext) => {
					c.beginPath();
					c.moveTo(from.x, from.y);
					c.lineTo(to.x, to.y);
				},
				raster: () => {
					const path = new GdiRasterPath();
					path.moveTo(fixFrom[0], fixFrom[1]);
					path.lineTo(fixTo[0], fixTo[1]);
					return path;
				},
				fill: false,
				stroke: true,
				style: lineStyleOf(rCtx),
			});
		}
		state.curX = lx;
		state.curY = ly;
	}
	return true;
}

function handleRectangle(rCtx: EmfGdiReplayCtx, dataOff: number, recSize: number): boolean {
	const { ctx, view, state, inPath } = rCtx;
	if (recSize >= 24) {
		const l = view.getInt32(dataOff, true);
		const t = view.getInt32(dataOff + 4, true);
		const r = view.getInt32(dataOff + 8, true);
		const b = view.getInt32(dataOff + 12, true);
		const box = fixBox(rCtx, l, t, r, b);
		if (!inPath) {
			resetLineStyle(rCtx);
		}
		const rotated = hasWorldRotation(rCtx);
		if (rotated) {
			const p1 = gmapPoint(rCtx, l, t);
			const p2 = gmapPoint(rCtx, r, t);
			const p3 = gmapPoint(rCtx, r, b);
			const p4 = gmapPoint(rCtx, l, b);
			// Appends the rectangle's outline to whatever path is already open;
			// the caller decides whether that is a fresh path (immediate shape)
			// or the CURRENT BeginPath/EndPath bracket (inPath), which must NOT
			// be reset here.
			const appendRect = (c: CanvasContext) => {
				c.moveTo(p1.x, p1.y);
				c.lineTo(p2.x, p2.y);
				c.lineTo(p3.x, p3.y);
				c.lineTo(p4.x, p4.y);
				c.closePath();
			};
			if (inPath) {
				appendRect(gdiPathRecorder(rCtx));
				rasterPathOf(rCtx).append(rectRasterPath(box));
			} else {
				paintGdiShape(rCtx, {
					build: (c: CanvasContext) => {
						c.beginPath();
						appendRect(c);
					},
					raster: () => rectRasterPath(box),
					rectangle: true,
					fill: true,
					stroke: true,
					axisRect: isAxisBox(box) ? {} : undefined,
				});
			}
			return true;
		}
		const x = gmx(rCtx, l);
		const y = gmy(rCtx, t);
		const w = gmw(rCtx, r - l);
		const h = gmh(rCtx, b - t);
		if (inPath) {
			gdiPathRecorder(rCtx).rect(x, y, w, h);
			rasterPathOf(rCtx).append(rectRasterPath(box));
		} else if (needsPathBasedRectangle(rCtx)) {
			paintGdiShape(rCtx, {
				build: (c: CanvasContext) => {
					c.beginPath();
					c.rect(x, y, w, h);
				},
				raster: () => rectRasterPath(box),
				rectangle: true,
				fill: true,
				stroke: true,
				axisRect: { interior: rectangleInterior(state, x, y, w, h, penScale(rCtx)) },
			});
		} else {
			applyBrush(ctx, state);
			ctx.fillRect(x, y, w, h);
			applyPen(ctx, state);
			// The fast path only takes one-pixel (cosmetic) pens.
			ctx.lineWidth = 1;
			const align = gdiStrokeAlign(state, penScale(rCtx));
			ctx.strokeRect(x + align, y + align, w, h);
		}
	}
	return true;
}

/**
 * The part of an axis-aligned, pen-bordered Rectangle that GDI fills with
 * the brush: the inclusive box minus its 1px border. GDI paints the border
 * pixels with the pen ONLY, never brush-then-pen, which is visible under a
 * `SetROP2` mode where combining twice differs from combining once (an XOR
 * brush under an XOR pen, say; confirmed by `rop2-bitwise-grid`). The
 * right/bottom border already lies outside the canvas rectangle `x..x+w`
 * (its pixels are columns `x..x+w-1`, the pen's are `x+w`), so only the
 * left/top edge moves in. `undefined` (fill the whole rectangle) for a null
 * or wider pen, or a rectangle too small to have an interior.
 */
function rectangleInterior(
	state: DrawState,
	x: number,
	y: number,
	w: number,
	h: number,
	scale = 1,
): ((c: CanvasContext) => void) | undefined {
	if (gdiStrokeAlign(state, scale) === 0 || penLineWidth(state, scale) !== 1) {
		return undefined;
	}
	const x0 = Math.min(x, x + w);
	const y0 = Math.min(y, y + h);
	const iw = Math.abs(w) - 1;
	const ih = Math.abs(h) - 1;
	if (iw <= 0 || ih <= 0) {
		return undefined;
	}
	return (c: CanvasContext) => {
		c.beginPath();
		c.rect(x0 + 1, y0 + 1, iw, ih);
	};
}

/** Bezier control-point factor that best fits a quarter ellipse (4/3 * (sqrt(2) - 1)). */
const KAPPA = 0.5522847498307936;

/**
 * Appends a rounded rectangle's outline to `c`'s current path: the box
 * `x0..x1` x `y0..y1` (any orientation) with elliptical corners of radii
 * `rx`, `ry` (each clamped to half the box), in a source space that `map`
 * carries to device space. With `map` null the box is already in device
 * space and each corner is an exact axis-aligned `ellipse()` quarter.
 * Otherwise each corner is the standard four-arc cubic
 * Bezier quarter ellipse (control points `KAPPA` times the radius along the
 * tangents), built in the source space; `map` is affine (the world
 * transform composed with the device mapping), and an affine map carries a
 * Bezier's control points to exactly the mapped curve, so the corners stay
 * exact quarter ellipses under rotation, skew, and anisotropic scale, where
 * `arcTo`'s circular, locally right-angled corners cannot follow.
 */
function appendRoundRectPath(
	c: CanvasContext,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	rx: number,
	ry: number,
	map: ((x: number, y: number) => { x: number; y: number }) | null,
): void {
	const left = Math.min(x0, x1);
	const right = Math.max(x0, x1);
	const top = Math.min(y0, y1);
	const bottom = Math.max(y0, y1);
	const ex = Math.min(Math.abs(rx), (right - left) / 2);
	const ey = Math.min(Math.abs(ry), (bottom - top) / 2);
	if (!map) {
		if (ex <= 0 || ey <= 0) {
			c.rect(left, top, right - left, bottom - top);
			return;
		}
		const q = Math.PI / 2;
		c.moveTo(left + ex, top);
		c.lineTo(right - ex, top);
		c.ellipse(right - ex, top + ey, ex, ey, 0, -q, 0);
		c.lineTo(right, bottom - ey);
		c.ellipse(right - ex, bottom - ey, ex, ey, 0, 0, q);
		c.lineTo(left + ex, bottom);
		c.ellipse(left + ex, bottom - ey, ex, ey, 0, q, 2 * q);
		c.lineTo(left, top + ey);
		c.ellipse(left + ex, top + ey, ex, ey, 0, 2 * q, 3 * q);
		c.closePath();
		return;
	}
	const move = (x: number, y: number) => {
		const p = map(x, y);
		c.moveTo(p.x, p.y);
	};
	const line = (x: number, y: number) => {
		const p = map(x, y);
		c.lineTo(p.x, p.y);
	};
	const curve = (ax: number, ay: number, bx: number, by: number, x: number, y: number) => {
		const p1 = map(ax, ay);
		const p2 = map(bx, by);
		const p3 = map(x, y);
		c.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
	};
	if (ex <= 0 || ey <= 0) {
		move(left, top);
		line(right, top);
		line(right, bottom);
		line(left, bottom);
		c.closePath();
		return;
	}
	const kx = ex * KAPPA;
	const ky = ey * KAPPA;
	move(left + ex, top);
	line(right - ex, top);
	curve(right - ex + kx, top, right, top + ey - ky, right, top + ey);
	line(right, bottom - ey);
	curve(right, bottom - ey + ky, right - ex + kx, bottom, right - ex, bottom);
	line(left + ex, bottom);
	curve(left + ex - kx, bottom, left, bottom - ey + ky, left, bottom - ey);
	line(left, top + ey);
	curve(left, top + ey - ky, left + ex - kx, top, left + ex, top);
	c.closePath();
}

function handleRoundRect(rCtx: EmfGdiReplayCtx, dataOff: number, recSize: number): boolean {
	const { view, inPath } = rCtx;
	if (recSize >= 32) {
		const l = view.getInt32(dataOff, true);
		const t = view.getInt32(dataOff + 4, true);
		const r = view.getInt32(dataOff + 8, true);
		const b = view.getInt32(dataOff + 12, true);
		const cornerW = view.getInt32(dataOff + 16, true);
		const cornerH = view.getInt32(dataOff + 20, true);
		// Rotated/skewed: build in LOGICAL space and map every point (Bezier
		// control points included) through the full affine. Otherwise the
		// device mapping is a plain per-axis scale + offset, so build directly
		// in device space.
		const drawRoundRect: (c: CanvasContext) => void = hasWorldRotation(rCtx)
			? (c) => appendRoundRectPath(c, l, t, r, b, cornerW / 2, cornerH / 2, (x, y) => gmapPoint(rCtx, x, y))
			: (c) =>
					appendRoundRectPath(
						c,
						gmx(rCtx, l),
						gmy(rCtx, t),
						gmx(rCtx, r),
						gmy(rCtx, b),
						gmw(rCtx, cornerW) / 2,
						gmh(rCtx, cornerH) / 2,
						null,
					);
		const raster = (box = fixBox(rCtx, l, t, r, b)) => roundRectRasterPath(box, fixExtent(rCtx, cornerW, 0), fixExtent(rCtx, cornerH, 1));
		if (inPath) {
			drawRoundRect(gdiPathRecorder(rCtx));
			rasterPathOf(rCtx).append(raster());
		} else {
			resetLineStyle(rCtx);
			paintGdiShape(rCtx, {
				build: (c: CanvasContext) => {
					c.beginPath();
					drawRoundRect(c);
				},
				raster: () => raster(curvedFixBox(rCtx, l, t, r, b)),
				roundPen: true,
				fill: true,
				stroke: true,
			});
		}
	}
	return true;
}

/**
 * GDI's device box for a curved shape (Ellipse, RoundRect, Chord, Pie). With
 * a null pen and a one-to-one logical-to-device mapping GDI grows the box
 * by a quarter pixel (4 FIX) on every side before building the path, so the
 * filled area reaches the inclusive box's right and bottom edges; under any
 * other scale or a rotation it does not (measured: 200 of 200 null-pen
 * ellipses at identity need exactly the quarter pixel, 150 of 150 under
 * random scales need none).
 */
function curvedFixBox(rCtx: EmfGdiReplayCtx, l: number, t: number, r: number, b: number): FixBox {
	const box = fixBox(rCtx, l, t, r, b);
	if (rCtx.state.penStyle !== 5) {
		return box;
	}
	const m = gdiDeviceMatrix(rCtx);
	if (Math.abs(m[0]) !== 1 || Math.abs(m[3]) !== 1 || m[1] !== 0 || m[2] !== 0) {
		return box;
	}
	const sx = box.exx < 0 ? -1 : 1;
	const sy = box.eyy < 0 ? -1 : 1;
	return {
		ax: box.ax - 4 * sx,
		ay: box.ay - 4 * sy,
		exx: box.exx + 8 * sx,
		exy: 0,
		eyx: 0,
		eyy: box.eyy + 8 * sy,
	};
}

function handleEllipse(rCtx: EmfGdiReplayCtx, dataOff: number, recSize: number): boolean {
	const { view, inPath } = rCtx;
	if (recSize >= 24) {
		const l = view.getInt32(dataOff, true);
		const t = view.getInt32(dataOff + 4, true);
		const r = view.getInt32(dataOff + 8, true);
		const b = view.getInt32(dataOff + 12, true);
		const params = hasWorldRotation(rCtx)
			? gdiEllipseParams(rCtx, (l + r) / 2, (t + b) / 2, Math.abs(r - l) / 2, Math.abs(b - t) / 2)
			: {
					cx: gmx(rCtx, (l + r) / 2),
					cy: gmy(rCtx, (t + b) / 2),
					rx: Math.abs(gmw(rCtx, r - l)) / 2,
					ry: Math.abs(gmh(rCtx, b - t)) / 2,
					rotation: 0,
				};
		if (inPath) {
			gdiPathRecorder(rCtx).ellipse(params.cx, params.cy, params.rx, params.ry, params.rotation, 0, Math.PI * 2);
			rasterPathOf(rCtx).append(ellipseRasterPath(fixBox(rCtx, l, t, r, b)));
		} else {
			resetLineStyle(rCtx);
			paintGdiShape(rCtx, {
				build: (c: CanvasContext) => {
					c.beginPath();
					c.ellipse(params.cx, params.cy, params.rx, params.ry, params.rotation, 0, Math.PI * 2);
				},
				raster: () => ellipseRasterPath(curvedFixBox(rCtx, l, t, r, b)),
				roundPen: true,
				fill: true,
				stroke: true,
			});
		}
	}
	return true;
}

function handleArcFamily(rCtx: EmfGdiReplayCtx, recType: number, dataOff: number, recSize: number): boolean {
	const { ctx, view, state, inPath } = rCtx;
	if (recSize >= 40) {
		const l = view.getInt32(dataOff, true);
		const t = view.getInt32(dataOff + 4, true);
		const r = view.getInt32(dataOff + 8, true);
		const b = view.getInt32(dataOff + 12, true);
		const startX = view.getInt32(dataOff + 16, true);
		const startY = view.getInt32(dataOff + 20, true);
		const endX = view.getInt32(dataOff + 24, true);
		const endY = view.getInt32(dataOff + 28, true);
		const cxA = (l + r) / 2;
		const cyA = (t + b) / 2;
		const rx = Math.abs(r - l) / 2;
		const ry = Math.abs(b - t) / 2;
		// LOCAL angle parameter along the (pre-rotation) ellipse; unaffected by
		// the device mapping, rotated or not (see gdiEllipseParams's doc comment).
		const startAngle = Math.atan2((startY - cyA) / (ry || 1), (startX - cxA) / (rx || 1));
		const endAngle = Math.atan2((endY - cyA) / (ry || 1), (endX - cxA) / (rx || 1));
		const rotated = hasWorldRotation(rCtx);
		const params = rotated
			? gdiEllipseParams(rCtx, cxA, cyA, rx, ry)
			: {
					cx: gmx(rCtx, cxA),
					cy: gmy(rCtx, cyA),
					rx: Math.abs(gmw(rCtx, rx)),
					ry: Math.abs(gmh(rCtx, ry)),
					rotation: 0,
				};
		const isArcTo = recType === EMR_ARCTO;
		const needsFill = recType === EMR_PIE || recType === EMR_CHORD;
		// AD_COUNTERCLOCKWISE (GDI's default) runs counter-clockwise on screen,
		// i.e. towards decreasing Canvas angles (y grows downwards).
		const clockwise = state.arcDirection === 2;
		const startPoint = rotated
			? gmapPoint(rCtx, cxA + rx * Math.cos(startAngle), cyA + ry * Math.sin(startAngle))
			: { x: params.cx + params.rx * Math.cos(startAngle), y: params.cy + params.ry * Math.sin(startAngle) };
		const build = (c: CanvasContext) => {
			if (recType === EMR_PIE) {
				c.moveTo(params.cx, params.cy);
			}
			if (isArcTo) {
				c.lineTo(startPoint.x, startPoint.y);
			}
			c.ellipse(params.cx, params.cy, params.rx, params.ry, params.rotation, startAngle, endAngle, !clockwise);
			if (needsFill) {
				c.closePath();
			}
		};
		const kind: ArcKind = isArcTo ? 'arcto' : recType === EMR_PIE ? 'pie' : recType === EMR_CHORD ? 'chord' : 'arc';
		const rasterArgs = (immediate = false) => ({
			box: immediate && needsFill ? curvedFixBox(rCtx, l, t, r, b) : fixBox(rCtx, l, t, r, b),
			s: fixPoint(rCtx, startX, startY),
			e: fixPoint(rCtx, endX, endY),
			from: currentFix(rCtx),
		});
		if (inPath) {
			build(gdiPathRecorder(rCtx));
			const a = rasterArgs();
			arcRasterPath(a.box, a.s, a.e, clockwise, kind, a.from, rasterPathOf(rCtx));
			if (needsFill) {
				rasterPathOf(rCtx).closeFigure();
			}
		} else {
			resetLineStyle(rCtx);
			ctx.beginPath();
			paintGdiShape(rCtx, {
				build: (c: CanvasContext) => {
					c.beginPath();
					build(c);
				},
				raster: () => {
					const a = rasterArgs(true);
					return arcRasterPath(a.box, a.s, a.e, clockwise, kind, a.from).path;
				},
				fill: needsFill,
				stroke: true,
			});
		}
		if (isArcTo) {
			// GDI leaves the current position at the arc's end point truncated
			// to its device pixel (the 28.4 end point floored to whole pixels,
			// measured with GetCurrentPositionEx under a 1/16 world scale), and
			// the next LineTo starts exactly there (inside a path the next segment
			// continues from the unrounded end point).
			const a = rasterArgs();
			const end = arcRasterPath(a.box, a.s, a.e, clockwise, 'arc').end;
			const dx = Math.floor(end[0] / 16);
			const dy = Math.floor(end[1] / 16);
			const inv = invertAffine(gdiDeviceMatrix(rCtx));
			if (inv) {
				state.curX = Math.round(inv[0] * dx + inv[2] * dy + inv[4]);
				state.curY = Math.round(inv[1] * dx + inv[3] * dy + inv[5]);
			} else {
				state.curX = Math.round(cxA + rx * Math.cos(endAngle));
				state.curY = Math.round(cyA + ry * Math.sin(endAngle));
			}
			rCtx.curFix = inPath
				? { x: end[0], y: end[1], lx: state.curX, ly: state.curY }
				: { x: dx * 16, y: dy * 16, lx: state.curX, ly: state.curY };
		}
	}
	return true;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export function handleEmfGdiShapeRecord(
	rCtx: EmfGdiReplayCtx,
	recType: number,
	dataOff: number,
	recSize: number,
): boolean {
	switch (recType) {
		case EMR_SETPIXELV:
			return handleSetPixelV(rCtx, dataOff, recSize);
		case EMR_MOVETOEX:
			return handleMoveToEx(rCtx, dataOff, recSize);
		case EMR_LINETO:
			return handleLineTo(rCtx, dataOff, recSize);
		case EMR_RECTANGLE:
			return handleRectangle(rCtx, dataOff, recSize);
		case EMR_ROUNDRECT:
			return handleRoundRect(rCtx, dataOff, recSize);
		case EMR_ELLIPSE:
			return handleEllipse(rCtx, dataOff, recSize);
		case EMR_ARC:
		case EMR_ARCTO:
		case EMR_CHORD:
		case EMR_PIE:
			return handleArcFamily(rCtx, recType, dataOff, recSize);
		default:
			return false;
	}
}
