/**
 * EMF GDI polygon, polyline, and path-operation record handlers.
 */

import {
	EMR_POLYLINE,
	EMR_POLYGON,
	EMR_POLYBEZIER,
	EMR_POLYBEZIERTO,
	EMR_POLYLINETO,
	EMR_POLYPOLYLINE,
	EMR_POLYLINE16,
	EMR_POLYGON16,
	EMR_POLYBEZIER16,
	EMR_POLYBEZIERTO16,
	EMR_POLYLINETO16,
	EMR_POLYPOLYGON,
	EMR_POLYPOLYGON16,
	EMR_BEGINPATH,
	EMR_ENDPATH,
	EMR_CLOSEFIGURE,
	EMR_FILLPATH,
	EMR_STROKEANDFILLPATH,
	EMR_STROKEPATH,
	EMR_SELECTCLIPPATH,
} from './emf-constants';
import { gmapPoint } from './emf-gdi-coord';
import { gdiPathRecorder, replayGdiPathCmds } from './emf-gdi-path-record';
import { fillShapeExactOrFast, strokeShapeExactOrFast } from './emf-gdi-shape-paint';
import {
	handlePolyPolygon32,
	handlePolyPolyline32,
	handlePolyPolygon16,
} from './emf-gdi-polypolygon-helpers';
import type { CanvasContext, EmfGdiReplayCtx } from './emf-types';

// ---------------------------------------------------------------------------
// 32-bit poly helper
// ---------------------------------------------------------------------------

function handlePoly32(
	rCtx: EmfGdiReplayCtx,
	recType: number,
	offset: number,
	dataOff: number,
	recSize: number,
): boolean {
	const { ctx, view, state, inPath } = rCtx;
	if (recSize < 28) {
		return true;
	}

	const count = view.getUint32(dataOff + 16, true);
	const ptOff = dataOff + 20;
	if (count === 0 || ptOff + count * 8 > offset + recSize) {
		return true;
	}

	const isPolygon = recType === EMR_POLYGON;
	const isBezier = recType === EMR_POLYBEZIER || recType === EMR_POLYBEZIERTO;
	const isTo = recType === EMR_POLYBEZIERTO || recType === EMR_POLYLINETO;
	const pt = (i: number) => gmapPoint(rCtx, view.getInt32(ptOff + i * 8, true), view.getInt32(ptOff + i * 8 + 4, true));

	const build = (target: CanvasContext) => {
		if (!isTo) {
			const p0 = pt(0);
			target.moveTo(p0.x, p0.y);
		}
		let i = isTo ? 0 : 1;
		if (isBezier) {
			while (i + 2 < count) {
				const p1 = pt(i);
				const p2 = pt(i + 1);
				const p3 = pt(i + 2);
				target.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
				i += 3;
			}
		} else {
			for (; i < count; i++) {
				const p = pt(i);
				target.lineTo(p.x, p.y);
			}
		}
		if (isPolygon) {
			target.closePath();
		}
	};

	if (inPath) {
		build(gdiPathRecorder(rCtx));
	} else {
		ctx.beginPath();
		build(ctx);
		const buildWithPath = (target: CanvasContext) => {
			target.beginPath();
			build(target);
		};
		if (isPolygon) {
			fillShapeExactOrFast(rCtx, buildWithPath, state.polyFillMode === 2 ? 'nonzero' : 'evenodd');
		}
		strokeShapeExactOrFast(rCtx, buildWithPath);
	}

	if (count > 0) {
		const last = count - 1;
		state.curX = view.getInt32(ptOff + last * 8, true);
		state.curY = view.getInt32(ptOff + last * 8 + 4, true);
	}
	return true;
}

// ---------------------------------------------------------------------------
// 16-bit poly helper
// ---------------------------------------------------------------------------

function handlePoly16(
	rCtx: EmfGdiReplayCtx,
	recType: number,
	offset: number,
	dataOff: number,
	recSize: number,
): boolean {
	const { ctx, view, state, inPath } = rCtx;
	if (recSize < 28) {
		return true;
	}

	const count = view.getUint32(dataOff + 16, true);
	const ptOff = dataOff + 20;
	if (count === 0 || ptOff + count * 4 > offset + recSize) {
		return true;
	}

	const isPolygon = recType === EMR_POLYGON16;
	const isBezier = recType === EMR_POLYBEZIER16 || recType === EMR_POLYBEZIERTO16;
	const isTo = recType === EMR_POLYBEZIERTO16 || recType === EMR_POLYLINETO16;
	const pt = (i: number) => gmapPoint(rCtx, view.getInt16(ptOff + i * 4, true), view.getInt16(ptOff + i * 4 + 2, true));

	const build = (target: CanvasContext) => {
		if (!isTo) {
			const p0 = pt(0);
			target.moveTo(p0.x, p0.y);
		}
		let i = isTo ? 0 : 1;
		if (isBezier) {
			while (i + 2 < count) {
				const p1 = pt(i);
				const p2 = pt(i + 1);
				const p3 = pt(i + 2);
				target.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
				i += 3;
			}
		} else {
			for (; i < count; i++) {
				const p = pt(i);
				target.lineTo(p.x, p.y);
			}
		}
		if (isPolygon) {
			target.closePath();
		}
	};

	if (inPath) {
		build(gdiPathRecorder(rCtx));
	} else {
		ctx.beginPath();
		build(ctx);
		const buildWithPath = (target: CanvasContext) => {
			target.beginPath();
			build(target);
		};
		if (isPolygon) {
			fillShapeExactOrFast(rCtx, buildWithPath, state.polyFillMode === 2 ? 'nonzero' : 'evenodd');
		}
		strokeShapeExactOrFast(rCtx, buildWithPath);
	}

	if (count > 0) {
		const last = count - 1;
		state.curX = view.getInt16(ptOff + last * 4, true);
		state.curY = view.getInt16(ptOff + last * 4 + 2, true);
	}
	return true;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export function handleEmfGdiPolyPathRecord(
	rCtx: EmfGdiReplayCtx,
	recType: number,
	offset: number,
	dataOff: number,
	recSize: number,
): boolean {
	const { ctx, state } = rCtx;

	switch (recType) {
		// ---- 32-bit polys ----
		case EMR_POLYLINE:
		case EMR_POLYGON:
		case EMR_POLYBEZIER:
		case EMR_POLYBEZIERTO:
		case EMR_POLYLINETO:
			return handlePoly32(rCtx, recType, offset, dataOff, recSize);

		// ---- 16-bit polys ----
		case EMR_POLYLINE16:
		case EMR_POLYGON16:
		case EMR_POLYBEZIER16:
		case EMR_POLYBEZIERTO16:
		case EMR_POLYLINETO16:
			return handlePoly16(rCtx, recType, offset, dataOff, recSize);

		// ---- polypolyline / polypolygon ----
		case EMR_POLYPOLYLINE:
			if (recSize >= 28) {
				handlePolyPolyline32(rCtx, offset, dataOff, recSize);
			}
			return true;
		case EMR_POLYPOLYGON:
			if (recSize >= 28) {
				handlePolyPolygon32(rCtx, offset, dataOff, recSize);
			}
			return true;
		case EMR_POLYPOLYGON16:
			if (recSize >= 28) {
				handlePolyPolygon16(rCtx, offset, dataOff, recSize);
			}
			return true;

		// ---- path operations ----
		case EMR_BEGINPATH:
			rCtx.inPath = true;
			rCtx.pathCmds = [];
			ctx.beginPath();
			return true;
		case EMR_ENDPATH:
			rCtx.inPath = false;
			return true;
		case EMR_CLOSEFIGURE:
			ctx.closePath();
			if (rCtx.inPath) {
				rCtx.pathCmds.push({ op: 'closePath' });
			}
			return true;
		case EMR_FILLPATH: {
			// `buildPath` replays the commands recorded during the preceding
			// BeginPath/EndPath bracket (`rCtx.pathCmds`), so the exact bitwise
			// ROP2 combine (`emf-rop2-exact.ts`) can run on a scratch canvas the
			// same way it already does for an immediate (non-bracketed) shape;
			// the fast/pattern branches inside `fillShapeExactOrFast` act on
			// `ctx`'s own current path (already built live while the bracket's
			// MoveTo/LineTo/etc. records ran), so `buildPath` is only actually
			// invoked for the exact-ROP2 case.
			const buildPath = (target: CanvasContext) => {
				target.beginPath();
				replayGdiPathCmds(target, rCtx.pathCmds);
			};
			fillShapeExactOrFast(rCtx, buildPath, state.polyFillMode === 2 ? 'nonzero' : 'evenodd');
			return true;
		}
		case EMR_STROKEANDFILLPATH: {
			const buildPath = (target: CanvasContext) => {
				target.beginPath();
				replayGdiPathCmds(target, rCtx.pathCmds);
			};
			fillShapeExactOrFast(rCtx, buildPath, state.polyFillMode === 2 ? 'nonzero' : 'evenodd');
			strokeShapeExactOrFast(rCtx, buildPath);
			return true;
		}
		case EMR_STROKEPATH: {
			const buildPath = (target: CanvasContext) => {
				target.beginPath();
				replayGdiPathCmds(target, rCtx.pathCmds);
			};
			strokeShapeExactOrFast(rCtx, buildPath);
			return true;
		}

		case EMR_SELECTCLIPPATH: {
			// The bracketed path lives only in the canvas' current path, so it
			// cannot be recorded into the tracked clip region. Mark the clip as
			// untracked; ops that need an exact region fall back conservatively
			// (see gdiCombineClip). RGN_COPY (5) replaces the clip, every other
			// mode is approximated by intersecting with the path.
			const clipMode = recSize >= 12 ? rCtx.view.getUint32(dataOff, true) : 5;
			try {
				if (clipMode === 5) {
					while (rCtx.clipSaveDepth > 0) {
						ctx.restore();
						rCtx.clipSaveDepth--;
					}
				}
				ctx.save();
				rCtx.clipSaveDepth++;
				// GDI converts the path to a region using the current polygon fill
				// mode (ALTERNATE = even-odd), which is what carves holes out of
				// multi-figure clip paths.
				ctx.clip(state.polyFillMode === 2 ? 'nonzero' : 'evenodd');
				rCtx.clipRegion = null;
				rCtx.clipUntracked = true;
			} catch {
				/* ignore clip errors */
			}
			return true;
		}

		default:
			return false;
	}
}
