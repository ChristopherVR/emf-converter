/**
 * EMF+ shape fill/draw record handlers.
 *
 * Handles: FillRects, DrawRects, FillEllipse, DrawEllipse,
 * FillPie, DrawPie, DrawArc, DrawLines, FillPolygon.
 */

import {
	EMFPLUS_FILLRECTS,
	EMFPLUS_DRAWRECTS,
	EMFPLUS_FILLELLIPSE,
	EMFPLUS_DRAWELLIPSE,
	EMFPLUS_FILLPIE,
	EMFPLUS_DRAWPIE,
	EMFPLUS_DRAWARC,
	EMFPLUS_DRAWLINES,
	EMFPLUS_FILLPOLYGON,
} from './emf-constants';
import { tryFillPlusShapeExact } from './emf-plus-exact-fill';
import { PLUS_FLAG_RELATIVE, readPlusPoints, readRectFromView, readPointFromView } from './emf-plus-read-helpers';
import { resolveBrushPaint, applyPlusWorldTransform } from './emf-plus-state-handlers';
import { strokePlusGeometry } from './emf-plus-stroke';
import type { CanvasContext, EmfPlusPen, EmfPlusReplayCtx } from './emf-types';

/**
 * The parametric start angle and sweep (radians, for `ellipse()`) of a
 * GDI+ arc given in degrees. GDI+ measures an arc's angles as the
 * directions of rays from the centre (the point where the ray at angle
 * `a` meets the ellipse), not as the ellipse's parameter; read back from
 * `GraphicsPath.AddArc` (an arc of a 50 x 40 ellipse from 30 degrees starts
 * at the parameter 35.82 degrees). The sweep keeps its sign, a sweep of
 * 360 degrees or more is the whole ellipse. Pure.
 */
export function ellipseArcAngles(startDeg: number, sweepDeg: number, rx: number, ry: number): { start: number; sweep: number } {
	const param = (deg: number): number => {
		const a = (deg * Math.PI) / 180;
		return rx > 0 && ry > 0 ? Math.atan2(rx * Math.sin(a), ry * Math.cos(a)) : a;
	};
	const sweepClamped = Math.max(-360, Math.min(360, sweepDeg));
	const start = param(startDeg);
	if (Math.abs(sweepClamped) >= 360) {
		return { start, sweep: Math.sign(sweepClamped) * 2 * Math.PI };
	}
	let sweep = param(startDeg + sweepClamped) - start;
	if (sweepClamped > 0 && sweep < 0) {
		sweep += 2 * Math.PI;
	} else if (sweepClamped < 0 && sweep > 0) {
		sweep -= 2 * Math.PI;
	} else if (sweepClamped === 0) {
		sweep = 0;
	}
	return { start, sweep };
}

/**
 * A point-list record's points: relative (flag P) points decoded strictly
 * (`null` when the data runs out, a record GDI+ does not draw), absolute
 * ones read as far as the record's data goes.
 */
function readRecordPoints(
	view: DataView,
	offset: number,
	end: number,
	count: number,
	flags: number,
): Array<{ x: number; y: number }> | null {
	if (flags & PLUS_FLAG_RELATIVE) {
		return readPlusPoints(view, offset, end, count, flags);
	}
	const compressed = (flags & 0x4000) !== 0;
	const ptSize = compressed ? 4 : 8;
	const pts: Array<{ x: number; y: number }> = [];
	for (let i = 0, o = offset; i < count && o + ptSize <= end; i++, o += ptSize) {
		pts.push(readPointFromView(view, o, compressed));
	}
	return pts;
}

/** The pen object a draw record names, or `null`. */
function penOf(rCtx: EmfPlusReplayCtx, penId: number): EmfPlusPen | null {
	const pen = rCtx.objectTable.get(penId & 0xff);
	return pen && pen.kind === 'plus-pen' ? pen : null;
}

export function handleEmfPlusDrawRecord(
	rCtx: EmfPlusReplayCtx,
	recType: number,
	recFlags: number,
	dataOff: number,
	recDataSize: number,
): boolean {
	const { ctx, view, objectTable } = rCtx;

	switch (recType) {
		case EMFPLUS_FILLRECTS: {
			if (recDataSize >= 8) {
				const brushVal = view.getUint32(dataOff, true);
				const count = view.getUint32(dataOff + 4, true);
				const compressed = (recFlags & 0x4000) !== 0;
				const rectSize = compressed ? 8 : 16;
				const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
				let rOff = dataOff + 8;
				for (let i = 0; i < count && rOff + rectSize <= dataOff + recDataSize; i++) {
					rects.push(readRectFromView(view, rOff, compressed));
					rOff += rectSize;
				}
				const exact = tryFillPlusShapeExact(
					rCtx,
					recFlags,
					brushVal,
					(c) => {
						for (const r of rects) {
							c.rect(r.x, r.y, r.w, r.h);
						}
					},
					rects.flatMap((r) => [
						{ x: r.x, y: r.y },
						{ x: r.x + r.w, y: r.y },
						{ x: r.x, y: r.y + r.h },
						{ x: r.x + r.w, y: r.y + r.h },
					]),
				);
				if (!exact) {
					ctx.fillStyle = resolveBrushPaint(rCtx, recFlags, brushVal);
					applyPlusWorldTransform(rCtx);
					for (const r of rects) {
						ctx.fillRect(r.x, r.y, r.w, r.h);
					}
				}
			}
			return true;
		}

		case EMFPLUS_DRAWRECTS: {
			if (recDataSize >= 4) {
				const count = view.getUint32(dataOff, true);
				const compressed = (recFlags & 0x4000) !== 0;
				const rectSize = compressed ? 8 : 16;
				const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
				let rOff = dataOff + 4;
				for (let i = 0; i < count && rOff + rectSize <= dataOff + recDataSize; i++) {
					rects.push(readRectFromView(view, rOff, compressed));
					rOff += rectSize;
				}
				strokePlusGeometry(
					rCtx,
					penOf(rCtx, recFlags),
					(c) => {
						for (const r of rects) {
							c.rect(r.x, r.y, r.w, r.h);
						}
					},
					rects.flatMap((r) => [
						{ x: r.x, y: r.y },
						{ x: r.x + r.w, y: r.y + r.h },
					]),
					true,
				);
			}
			return true;
		}

		case EMFPLUS_FILLELLIPSE: {
			if (recDataSize >= 12) {
				const brushVal = view.getUint32(dataOff, true);
				const compressed = (recFlags & 0x4000) !== 0;
				let x: number, y: number, w: number, h: number;
				if (compressed) {
					x = view.getInt16(dataOff + 4, true);
					y = view.getInt16(dataOff + 6, true);
					w = view.getInt16(dataOff + 8, true);
					h = view.getInt16(dataOff + 10, true);
				} else {
					if (recDataSize < 20) {
						return true;
					}
					x = view.getFloat32(dataOff + 4, true);
					y = view.getFloat32(dataOff + 8, true);
					w = view.getFloat32(dataOff + 12, true);
					h = view.getFloat32(dataOff + 16, true);
				}
				const ellipse = (c: CanvasContext): void => {
					c.ellipse(x + w / 2, y + h / 2, Math.abs(w) / 2, Math.abs(h) / 2, 0, 0, Math.PI * 2);
				};
				// All four corners: under a rotated world transform the device
				// bounding box of two opposite corners does not contain the shape.
				const corners = [
					{ x, y },
					{ x: x + w, y },
					{ x, y: y + h },
					{ x: x + w, y: y + h },
				];
				if (!tryFillPlusShapeExact(rCtx, recFlags, brushVal, ellipse, corners)) {
					ctx.fillStyle = resolveBrushPaint(rCtx, recFlags, brushVal);
					applyPlusWorldTransform(rCtx);
					ctx.beginPath();
					ellipse(ctx);
					ctx.fill();
				}
			}
			return true;
		}

		case EMFPLUS_DRAWELLIPSE: {
			const penId = recFlags & 0xff;
			const pen = objectTable.get(penId);
			const compressed = (recFlags & 0x4000) !== 0;
			let x: number, y: number, w: number, h: number;
			if (compressed && recDataSize >= 8) {
				x = view.getInt16(dataOff, true);
				y = view.getInt16(dataOff + 2, true);
				w = view.getInt16(dataOff + 4, true);
				h = view.getInt16(dataOff + 6, true);
			} else if (!compressed && recDataSize >= 16) {
				x = view.getFloat32(dataOff, true);
				y = view.getFloat32(dataOff + 4, true);
				w = view.getFloat32(dataOff + 8, true);
				h = view.getFloat32(dataOff + 12, true);
			} else {
				return true;
			}
			strokePlusGeometry(
				rCtx,
				pen && pen.kind === 'plus-pen' ? pen : null,
				(c) => c.ellipse(x + w / 2, y + h / 2, Math.abs(w) / 2, Math.abs(h) / 2, 0, 0, Math.PI * 2),
				[
					{ x, y },
					{ x: x + w, y: y + h },
				],
				true,
			);
			return true;
		}

		case EMFPLUS_FILLPIE:
		case EMFPLUS_DRAWPIE:
		case EMFPLUS_DRAWARC: {
			const isFill = recType === EMFPLUS_FILLPIE;
			const minSize = isFill ? 12 : 8;
			if (recDataSize < minSize) {
				return true;
			}

			let aOff = dataOff;
			const brushVal = isFill ? view.getUint32(aOff, true) : 0;
			if (isFill) {
				aOff += 4;
			}
			const startDeg = view.getFloat32(aOff, true);
			const sweepDeg = view.getFloat32(aOff + 4, true);
			aOff += 8;

			const compressed = (recFlags & 0x4000) !== 0;
			let x: number, y: number, w: number, h: number;
			if (compressed && aOff + 8 <= dataOff + recDataSize) {
				x = view.getInt16(aOff, true);
				y = view.getInt16(aOff + 2, true);
				w = view.getInt16(aOff + 4, true);
				h = view.getInt16(aOff + 6, true);
			} else if (!compressed && aOff + 16 <= dataOff + recDataSize) {
				x = view.getFloat32(aOff, true);
				y = view.getFloat32(aOff + 4, true);
				w = view.getFloat32(aOff + 8, true);
				h = view.getFloat32(aOff + 12, true);
			} else {
				return true;
			}


			const cx = x + w / 2;
			const cy = y + h / 2;
			const rx = Math.abs(w) / 2;
			const ry = Math.abs(h) / 2;
			const { start: startAngle, sweep: sweepAngle } = ellipseArcAngles(startDeg, sweepDeg, rx, ry);
			if (isFill) {
				const pie = (c: CanvasContext): void => {
					c.moveTo(cx, cy);
					c.ellipse(cx, cy, rx, ry, 0, startAngle, startAngle + sweepAngle, sweepAngle < 0);
					c.closePath();
				};
				// All four corners: under a rotated world transform the device
				// bounding box of two opposite corners does not contain the shape.
				const corners = [
					{ x, y },
					{ x: x + w, y },
					{ x, y: y + h },
					{ x: x + w, y: y + h },
				];
				if (!tryFillPlusShapeExact(rCtx, recFlags, brushVal, pie, corners)) {
					ctx.fillStyle = resolveBrushPaint(rCtx, recFlags, brushVal);
					applyPlusWorldTransform(rCtx);
					ctx.beginPath();
					pie(ctx);
					ctx.fill();
				}
				return true;
			}
			// DrawPie outlines the whole wedge (arc and both radii); DrawArc only the arc.
			const isPie = recType === EMFPLUS_DRAWPIE;
			strokePlusGeometry(
				rCtx,
				penOf(rCtx, recFlags),
				(c) => {
					if (isPie) {
						c.moveTo(cx, cy);
					}
					c.ellipse(cx, cy, rx, ry, 0, startAngle, startAngle + sweepAngle, sweepAngle < 0);
					if (isPie) {
						c.closePath();
					}
				},
				[
					{ x, y },
					{ x: x + w, y: y + h },
				],
				isPie,
			);
			return true;
		}

		case EMFPLUS_DRAWLINES: {
			if (recDataSize >= 4) {
				const count = view.getUint32(dataOff, true);
				const pts = readRecordPoints(view, dataOff + 4, dataOff + recDataSize, count, recFlags);
				if (!pts) {
					return true;
				}
				const closed = (recFlags & 0x2000) !== 0;
				strokePlusGeometry(
					rCtx,
					penOf(rCtx, recFlags),
					(c) => {
						pts.forEach((pt, i) => (i === 0 ? c.moveTo(pt.x, pt.y) : c.lineTo(pt.x, pt.y)));
						if (closed) {
							c.closePath();
						}
					},
					pts,
					closed,
				);
			}
			return true;
		}

		case EMFPLUS_FILLPOLYGON: {
			if (recDataSize >= 8) {
				const brushVal = view.getUint32(dataOff, true);
				const count = view.getUint32(dataOff + 4, true);
				const pts = readRecordPoints(view, dataOff + 8, dataOff + recDataSize, count, recFlags);
				if (!pts) {
					return true;
				}
				const polygon = (c: CanvasContext): void => {
					pts.forEach((pt, i) => (i === 0 ? c.moveTo(pt.x, pt.y) : c.lineTo(pt.x, pt.y)));
					c.closePath();
				};
				if (!tryFillPlusShapeExact(rCtx, recFlags, brushVal, polygon, pts)) {
					ctx.fillStyle = resolveBrushPaint(rCtx, recFlags, brushVal);
					applyPlusWorldTransform(rCtx);
					ctx.beginPath();
					polygon(ctx);
					ctx.fill();
				}
			}
			return true;
		}

		default:
			return false;
	}
}
