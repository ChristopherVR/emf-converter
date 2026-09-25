/**
 * EMF GDI shape record handlers: MoveTo, LineTo, Rectangle, RoundRect,
 * Ellipse, Arc, ArcTo, Chord, and Pie.
 *
 * Each immediate (non-path-bracketed) shape builds its path ONCE directly on
 * `rCtx.ctx` (a `build` closure), then fills and/or strokes it through
 * `fillShapeExactOrFast`/`strokeShapeExactOrFast` (`emf-gdi-shape-paint.ts`),
 * which reuse that already-built path in the common case, align strokes to
 * GDI's pixel grid, and run per pixel (replaying `build` on an isolated
 * scratch canvas) only when a pattern brush, a bitwise `SetROP2` mode, or
 * `gdiAntialias: false` needs it. Rectangle keeps its own
 * `fillRect`/`strokeRect` fast path when none of those applies and there is
 * no rotation, since that is measurably cheaper than a path fill for the
 * overwhelmingly common case.
 *
 * When the active world transform has a rotation/skew component
 * ({@link hasWorldRotation}), geometry is built via the full-affine
 * `gmapPoint`/`gdiEllipseParams` (`emf-gdi-coord.ts`) instead of the
 * scale-only `gmx`/`gmy`/`gmw`/`gmh`, so rotated/skewed rectangles, rounded
 * rectangles, ellipses, and arcs render correctly. A rounded rectangle is
 * built in LOGICAL space with its elliptical corners as cubic Beziers
 * ({@link appendRoundRectPath}) and every point, control points included,
 * mapped through the affine, which carries each corner to the exact
 * transformed quarter ellipse (an affine map preserves Beziers), so its
 * corners follow a rotation or skew instead of staying axis-aligned. The
 * same builder runs in device space when there is no rotation, where it
 * also honours unequal corner width and height (GDI's elliptical corners),
 * which the circular `arcTo` it replaces could not.
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
import { gmx, gmy, gmw, gmh, gmapPoint, gdiEllipseParams, hasWorldRotation } from './emf-gdi-coord';
import { gdiPathRecorder } from './emf-gdi-path-record';
import { fillShapeExactOrFast, gdiStrokeAlign, penLineWidth, strokeShapeExactOrFast } from './emf-gdi-shape-paint';
import { isExactRop2Bitwise } from './emf-rop2-exact';
import type { CanvasContext, DrawState, EmfGdiReplayCtx } from './emf-types';

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

/** True when the active brush/ROP2 combination cannot use Rectangle's `fillRect`/`strokeRect` fast path. */
function needsPathBasedRectangle(rCtx: EmfGdiReplayCtx): boolean {
	const paint = rop2Paint(rCtx.state.rop2);
	const ropExact = !paint.exact && isExactRop2Bitwise(rCtx.state.rop2);
	return ropExact || rCtx.gdiAntialias === false || realizeBrush(rCtx.state).kind === 'tile';
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
		if (inPath) {
			const p = hasWorldRotation(rCtx)
				? gmapPoint(rCtx, state.curX, state.curY)
				: { x: gmx(rCtx, state.curX), y: gmy(rCtx, state.curY) };
			gdiPathRecorder(rCtx).moveTo(p.x, p.y);
		}
	}
	return true;
}

function handleLineTo(rCtx: EmfGdiReplayCtx, dataOff: number, recSize: number): boolean {
	const { ctx, view, state, inPath } = rCtx;
	if (recSize >= 16) {
		const lx = view.getInt32(dataOff, true);
		const ly = view.getInt32(dataOff + 4, true);
		const rotated = hasWorldRotation(rCtx);
		const to = rotated ? gmapPoint(rCtx, lx, ly) : { x: gmx(rCtx, lx), y: gmy(rCtx, ly) };
		if (inPath) {
			gdiPathRecorder(rCtx).lineTo(to.x, to.y);
		} else {
			const from = rotated
				? gmapPoint(rCtx, state.curX, state.curY)
				: { x: gmx(rCtx, state.curX), y: gmy(rCtx, state.curY) };
			const build = (c: CanvasContext) => {
				c.beginPath();
				c.moveTo(from.x, from.y);
				c.lineTo(to.x, to.y);
			};
			build(ctx);
			strokeShapeExactOrFast(rCtx, build);
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
			} else {
				const build = (c: CanvasContext) => {
					c.beginPath();
					appendRect(c);
				};
				build(ctx);
				fillShapeExactOrFast(rCtx, build);
				strokeShapeExactOrFast(rCtx, build);
			}
			return true;
		}
		if (inPath) {
			gdiPathRecorder(rCtx).rect(gmx(rCtx, l), gmy(rCtx, t), gmw(rCtx, r - l), gmh(rCtx, b - t));
		} else {
			const x = gmx(rCtx, l);
			const y = gmy(rCtx, t);
			const w = gmw(rCtx, r - l);
			const h = gmh(rCtx, b - t);
			if (needsPathBasedRectangle(rCtx)) {
				const build = (c: CanvasContext) => {
					c.beginPath();
					c.rect(x, y, w, h);
				};
				build(ctx);
				fillShapeExactOrFast(rCtx, build, 'nonzero', rectangleInterior(state, x, y, w, h));
				strokeShapeExactOrFast(rCtx, build);
			} else {
				applyBrush(ctx, state);
				ctx.fillRect(x, y, w, h);
				applyPen(ctx, state);
				const align = gdiStrokeAlign(state);
				ctx.strokeRect(x + align, y + align, w, h);
			}
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
): ((c: CanvasContext) => void) | undefined {
	if (gdiStrokeAlign(state) === 0 || penLineWidth(state) !== 1) {
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
	const { ctx, view, inPath } = rCtx;
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
		if (inPath) {
			drawRoundRect(gdiPathRecorder(rCtx));
		} else {
			const build = (c: CanvasContext) => {
				c.beginPath();
				drawRoundRect(c);
			};
			build(ctx);
			fillShapeExactOrFast(rCtx, build);
			strokeShapeExactOrFast(rCtx, build);
		}
	}
	return true;
}

function handleEllipse(rCtx: EmfGdiReplayCtx, dataOff: number, recSize: number): boolean {
	const { ctx, view, inPath } = rCtx;
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
		} else {
			const build = (c: CanvasContext) => {
				c.beginPath();
				c.ellipse(params.cx, params.cy, params.rx, params.ry, params.rotation, 0, Math.PI * 2);
			};
			build(ctx);
			fillShapeExactOrFast(rCtx, build);
			strokeShapeExactOrFast(rCtx, build);
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
			c.ellipse(params.cx, params.cy, params.rx, params.ry, params.rotation, startAngle, endAngle, false);
			if (needsFill) {
				c.closePath();
			}
		};
		if (inPath) {
			build(gdiPathRecorder(rCtx));
		} else {
			ctx.beginPath();
			build(ctx);
			const buildWithPath = (c: CanvasContext) => {
				c.beginPath();
				build(c);
			};
			if (needsFill) {
				fillShapeExactOrFast(rCtx, buildWithPath);
			}
			strokeShapeExactOrFast(rCtx, buildWithPath);
		}
		if (isArcTo) {
			state.curX = endX;
			state.curY = endY;
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
