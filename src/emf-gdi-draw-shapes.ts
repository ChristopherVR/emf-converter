/**
 * EMF GDI shape record handlers: MoveTo, LineTo, Rectangle, RoundRect,
 * Ellipse, Arc, ArcTo, Chord, and Pie.
 *
 * Each immediate (non-path-bracketed) shape builds its path ONCE directly on
 * `rCtx.ctx` (a `build` closure), then fills and/or strokes it through
 * `fillShapeExactOrFast`/`strokeShapeExactOrFast` (`emf-gdi-shape-paint.ts`),
 * which reuse that already-built path in the common case and use the exact
 * bitwise ROP2 combine (replaying `build` on an isolated scratch canvas)
 * only when the active `SetROP2` mode needs it. Rectangle keeps its own
 * `fillRect`/`strokeRect` fast path when no rotation, pattern brush, or
 * exact-ROP2 combine applies, since that is measurably cheaper than a path
 * fill for the overwhelmingly common case.
 *
 * When the active world transform has a rotation/skew component
 * ({@link hasWorldRotation}), geometry is built via the full-affine
 * `gmapPoint`/`gdiEllipseParams` (`emf-gdi-coord.ts`) instead of the
 * scale-only `gmx`/`gmy`/`gmw`/`gmh`, so rotated/skewed rectangles, rounded
 * rectangles' straight edges, ellipses, and arcs render correctly. A rounded
 * rectangle's corner radius stays axis-aligned even under rotation/skew (a
 * smaller, documented residual: see the README's Limitations section).
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
import { fillShapeExactOrFast, strokeShapeExactOrFast } from './emf-gdi-shape-paint';
import { isExactRop2Bitwise } from './emf-rop2-exact';
import type { CanvasContext, EmfGdiReplayCtx } from './emf-types';

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

/** True when the active brush/ROP2 combination cannot use Rectangle's `fillRect`/`strokeRect` fast path. */
function needsPathBasedRectangle(rCtx: EmfGdiReplayCtx): boolean {
	const paint = rop2Paint(rCtx.state.rop2);
	const ropExact = !paint.exact && isExactRop2Bitwise(rCtx.state.rop2);
	return ropExact || realizeBrush(rCtx.state).kind === 'tile';
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
	const { ctx, view, state, inPath } = rCtx;
	if (recSize >= 16) {
		state.curX = view.getInt32(dataOff, true);
		state.curY = view.getInt32(dataOff + 4, true);
		if (inPath) {
			const p = hasWorldRotation(rCtx)
				? gmapPoint(rCtx, state.curX, state.curY)
				: { x: gmx(rCtx, state.curX), y: gmy(rCtx, state.curY) };
			ctx.moveTo(p.x, p.y);
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
			ctx.lineTo(to.x, to.y);
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
			const build = (c: CanvasContext) => {
				c.beginPath();
				c.moveTo(p1.x, p1.y);
				c.lineTo(p2.x, p2.y);
				c.lineTo(p3.x, p3.y);
				c.lineTo(p4.x, p4.y);
				c.closePath();
			};
			if (inPath) {
				build(ctx);
			} else {
				build(ctx);
				fillShapeExactOrFast(rCtx, build);
				strokeShapeExactOrFast(rCtx, build);
			}
			return true;
		}
		if (inPath) {
			ctx.rect(gmx(rCtx, l), gmy(rCtx, t), gmw(rCtx, r - l), gmh(rCtx, b - t));
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
				fillShapeExactOrFast(rCtx, build);
				strokeShapeExactOrFast(rCtx, build);
			} else {
				applyBrush(ctx, state);
				ctx.fillRect(x, y, w, h);
				applyPen(ctx, state);
				ctx.strokeRect(x, y, w, h);
			}
		}
	}
	return true;
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
		const rotated = hasWorldRotation(rCtx);
		const rw = Math.abs(rotated ? cornerW / 2 : gmw(rCtx, cornerW) / 2);
		const rh = Math.abs(rotated ? cornerH / 2 : gmh(rCtx, cornerH) / 2);
		const x1 = rotated ? l : gmx(rCtx, l);
		const y1 = rotated ? t : gmy(rCtx, t);
		const w = rotated ? r - l : gmw(rCtx, r - l);
		const h = rotated ? b - t : gmh(rCtx, b - t);
		const map = (x: number, y: number) => (rotated ? gmapPoint(rCtx, x, y) : { x, y });
		const drawRoundRect = (c: CanvasContext) => {
			const radius = Math.min(rw, rh, Math.abs(w) / 2, Math.abs(h) / 2);
			const start = map(x1 + radius, y1);
			c.moveTo(start.x, start.y);
			if (rotated) {
				// arcTo assumes a locally right-angled corner, which does not
				// survive a skew; approximate each rounded corner with its
				// straight tangent lines instead under rotation/skew (the
				// corner radius stays axis-aligned, a documented residual).
				const corners: Array<[number, number]> = [
					[x1 + w - radius, y1],
					[x1 + w, y1 + radius],
					[x1 + w, y1 + h - radius],
					[x1 + w - radius, y1 + h],
					[x1 + radius, y1 + h],
					[x1, y1 + h - radius],
					[x1, y1 + radius],
					[x1 + radius, y1],
				];
				for (const [px, py] of corners) {
					const q = map(px, py);
					c.lineTo(q.x, q.y);
				}
			} else {
				const corner2 = map(x1 + w - radius, y1);
				c.lineTo(corner2.x, corner2.y);
				const arc1a = map(x1 + w, y1);
				const arc1b = map(x1 + w, y1 + radius);
				c.arcTo(arc1a.x, arc1a.y, arc1b.x, arc1b.y, radius);
				const corner3 = map(x1 + w, y1 + h - radius);
				c.lineTo(corner3.x, corner3.y);
				const arc2a = map(x1 + w, y1 + h);
				const arc2b = map(x1 + w - radius, y1 + h);
				c.arcTo(arc2a.x, arc2a.y, arc2b.x, arc2b.y, radius);
				const corner4 = map(x1 + radius, y1 + h);
				c.lineTo(corner4.x, corner4.y);
				const arc3a = map(x1, y1 + h);
				const arc3b = map(x1, y1 + h - radius);
				c.arcTo(arc3a.x, arc3a.y, arc3b.x, arc3b.y, radius);
				const corner1 = map(x1, y1 + radius);
				c.lineTo(corner1.x, corner1.y);
				const arc4a = map(x1, y1);
				const arc4b = map(x1 + radius, y1);
				c.arcTo(arc4a.x, arc4a.y, arc4b.x, arc4b.y, radius);
			}
			c.closePath();
		};
		if (inPath) {
			drawRoundRect(ctx);
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
			ctx.ellipse(params.cx, params.cy, params.rx, params.ry, params.rotation, 0, Math.PI * 2);
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
		if (!inPath) {
			ctx.beginPath();
		}
		build(ctx);
		if (!inPath) {
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
