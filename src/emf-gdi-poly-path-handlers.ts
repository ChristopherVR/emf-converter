/**
 * EMF GDI polygon, polyline, and path-operation record handlers.
 *
 * Like the shape handlers (`emf-gdi-draw-shapes.ts`), every poly record is
 * described both as Canvas geometry and as GDI's own device geometry
 * (`GdiRasterPath`, points in 28.4 fixed point, Beziers flattened by GDI's
 * own flattener) and handed to `paintGdiShape`, which picks the
 * antialiased or the exact route. Inside a `BeginPath`/`EndPath` bracket
 * both are recorded (`rCtx.pathCmds`, `rCtx.rasterPath`) for
 * `EMR_FILLPATH`/`EMR_STROKEANDFILLPATH`/`EMR_STROKEPATH`.
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
import type { ClipShape } from './emf-clip-region';
import { gdiCombineClip, RGN_MODE_OPS } from './emf-gdi-clip-records';
import { gmapPoint } from './emf-gdi-coord';
import { gdiPathRecorder, replayGdiPathCmds } from './emf-gdi-path-record';
import { fixPoint } from './emf-gdi-raster-shapes';
import { paintGdiShape } from './emf-gdi-shape-paint';
import {
	handlePolyPolygon32,
	handlePolyPolyline32,
	handlePolyPolygon16,
} from './emf-gdi-polypolygon-helpers';
import { emfLog } from './emf-logging';
import type { CanvasContext, EmfGdiReplayCtx } from './emf-types';
import { GdiRasterPath } from './gdi-raster';

// ---------------------------------------------------------------------------
// Poly records (32- and 16-bit)
// ---------------------------------------------------------------------------

/**
 * Handles one Poly* record whose `count` logical points `readPt(i)`
 * returns. `*To` records start from (and move) the current position.
 */
function handlePoly(
	rCtx: EmfGdiReplayCtx,
	recType: number,
	count: number,
	readPt: (i: number) => [number, number],
	kinds: { polygon: boolean; bezier: boolean; to: boolean },
): void {
	const { state, inPath } = rCtx;
	const { polygon: isPolygon, bezier: isBezier, to: isTo } = kinds;
	const pt = (i: number) => {
		const [x, y] = readPt(i);
		return gmapPoint(rCtx, x, y);
	};

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

	const fx = (i: number) => {
		const [x, y] = readPt(i);
		return fixPoint(rCtx, x, y);
	};
	/** Appends the record's GDI geometry to `path`; `from` is the current position for a `*To` record. */
	const buildRaster = (path: GdiRasterPath, from: [number, number] | null) => {
		let i = 0;
		if (isTo) {
			if (from) {
				path.moveTo(from[0], from[1]);
			}
		} else {
			const p0 = fx(0);
			path.moveTo(p0[0], p0[1]);
			i = 1;
		}
		if (isBezier) {
			for (; i + 2 < count; i += 3) {
				const a = fx(i);
				const b = fx(i + 1);
				const c = fx(i + 2);
				path.bezierTo(a[0], a[1], b[0], b[1], c[0], c[1]);
			}
		} else {
			for (; i < count; i++) {
				const p = fx(i);
				path.lineTo(p[0], p[1]);
			}
		}
		if (isPolygon) {
			path.closeFigure();
		}
	};

	if (inPath) {
		build(gdiPathRecorder(rCtx));
		rCtx.rasterPath ??= new GdiRasterPath();
		buildRaster(rCtx.rasterPath, isTo && rCtx.rasterPath.figures.length === 0 ? fixPoint(rCtx, state.curX, state.curY) : null);
	} else {
		const from = isTo ? fixPoint(rCtx, state.curX, state.curY) : null;
		const start = isTo ? gmapPoint(rCtx, state.curX, state.curY) : null;
		rCtx.lineStyle = { pos: 0 };
		paintGdiShape(rCtx, {
			build: (target: CanvasContext) => {
				target.beginPath();
				if (start) {
					target.moveTo(start.x, start.y);
				}
				build(target);
			},
			raster: () => {
				const path = new GdiRasterPath();
				buildRaster(path, from);
				return path;
			},
			fill: isPolygon,
			stroke: true,
			fillRule: state.polyFillMode === 2 ? 'nonzero' : 'evenodd',
		});
	}

	if (count > 0) {
		const [x, y] = readPt(count - 1);
		state.curX = x;
		state.curY = y;
	}
}

function handlePoly32(
	rCtx: EmfGdiReplayCtx,
	recType: number,
	offset: number,
	dataOff: number,
	recSize: number,
): boolean {
	const { view } = rCtx;
	if (recSize < 28) {
		return true;
	}
	const count = view.getUint32(dataOff + 16, true);
	const ptOff = dataOff + 20;
	if (count === 0 || ptOff + count * 8 > offset + recSize) {
		return true;
	}
	handlePoly(rCtx, recType, count, (i) => [view.getInt32(ptOff + i * 8, true), view.getInt32(ptOff + i * 8 + 4, true)], {
		polygon: recType === EMR_POLYGON,
		bezier: recType === EMR_POLYBEZIER || recType === EMR_POLYBEZIERTO,
		to: recType === EMR_POLYBEZIERTO || recType === EMR_POLYLINETO,
	});
	return true;
}

function handlePoly16(
	rCtx: EmfGdiReplayCtx,
	recType: number,
	offset: number,
	dataOff: number,
	recSize: number,
): boolean {
	const { view } = rCtx;
	if (recSize < 28) {
		return true;
	}
	const count = view.getUint32(dataOff + 16, true);
	const ptOff = dataOff + 20;
	if (count === 0 || ptOff + count * 4 > offset + recSize) {
		return true;
	}
	handlePoly(rCtx, recType, count, (i) => [view.getInt16(ptOff + i * 4, true), view.getInt16(ptOff + i * 4 + 2, true)], {
		polygon: recType === EMR_POLYGON16,
		bezier: recType === EMR_POLYBEZIER16 || recType === EMR_POLYBEZIERTO16,
		to: recType === EMR_POLYBEZIERTO16 || recType === EMR_POLYLINETO16,
	});
	return true;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/** Fills and/or strokes the current bracket's path (`EMR_FILLPATH` and friends). */
function paintBracketPath(rCtx: EmfGdiReplayCtx, fill: boolean, stroke: boolean): void {
	const { state } = rCtx;
	// `build` replays the commands recorded during the preceding
	// BeginPath/EndPath bracket (`rCtx.pathCmds`); the exact route uses the
	// bracket's GDI geometry (`rCtx.rasterPath`).
	const buildPath = (target: CanvasContext) => {
		target.beginPath();
		replayGdiPathCmds(target, rCtx.pathCmds);
	};
	const raster = rCtx.rasterPath ?? new GdiRasterPath();
	paintGdiShape(rCtx, {
		build: buildPath,
		raster: () => raster,
		fill,
		stroke,
		fillRule: state.polyFillMode === 2 ? 'nonzero' : 'evenodd',
	});
}

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
			rCtx.rasterPath = new GdiRasterPath();
			ctx.beginPath();
			return true;
		case EMR_ENDPATH:
			rCtx.inPath = false;
			return true;
		case EMR_CLOSEFIGURE:
			ctx.closePath();
			if (rCtx.inPath) {
				rCtx.pathCmds.push({ op: 'closePath' });
				rCtx.rasterPath?.closeFigure();
			}
			return true;
		case EMR_FILLPATH:
			paintBracketPath(rCtx, true, false);
			return true;
		case EMR_STROKEANDFILLPATH:
			paintBracketPath(rCtx, true, true);
			return true;
		case EMR_STROKEPATH:
			paintBracketPath(rCtx, false, true);
			return true;

		case EMR_SELECTCLIPPATH: {
			// The bracketed path was recorded command by command into
			// `rCtx.pathCmds` (device space), so it becomes an ordinary tracked
			// clip shape and every RegionMode combines exactly (gdiCombineClip).
			// GDI converts the path to a region using the current polygon fill
			// mode (ALTERNATE = even-odd), which is what carves holes out of
			// multi-figure clip paths. The figures may overlap, so the shape is
			// not `simple`.
			const clipMode = recSize >= 12 ? rCtx.view.getUint32(dataOff, true) : 5;
			const op = RGN_MODE_OPS[clipMode];
			if (!op) {
				emfLog(`EMR_SELECTCLIPPATH: unknown RegionMode ${clipMode}: ignored`);
				return true;
			}
			const shape: ClipShape = {
				cmds: rCtx.pathCmds.slice(),
				fillRule: state.polyFillMode === 2 ? 'nonzero' : 'evenodd',
				simple: false,
			};
			gdiCombineClip(rCtx, shape, op);
			return true;
		}

		default:
			return false;
	}
}
