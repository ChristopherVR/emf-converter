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
	EMR_POLYPOLYLINE16,
	EMR_POLYDRAW,
	EMR_POLYDRAW16,
	EMR_FLATTENPATH,
	EMR_WIDENPATH,
	EMR_ABORTPATH,
	EMR_BEGINPATH,
	EMR_ENDPATH,
	EMR_CLOSEFIGURE,
	EMR_FILLPATH,
	EMR_STROKEANDFILLPATH,
	EMR_STROKEPATH,
	EMR_SELECTCLIPPATH,
} from './emf-constants';
import { emptyClipShape, rectsClipShape, type ClipShape } from './emf-clip-region';
import { gdiCombineClip, RGN_MODE_OPS } from './emf-gdi-clip-records';
import { gmapPoint } from './emf-gdi-coord';
import { gdiPathRecorder, replayGdiPathCmds, type GdiPathCmd } from './emf-gdi-path-record';
import { currentFix } from './emf-gdi-draw-shapes';
import { fixPoint, penIsCosmetic, penWidenOptions } from './emf-gdi-raster-shapes';
import { paintGdiShape } from './emf-gdi-shape-paint';
import {
	handlePolyPolygon32,
	handlePolyPolyline32,
	handlePolyPolygon16,
	handlePolyPolyline16,
} from './emf-gdi-polypolygon-helpers';
import { emfLog } from './emf-logging';
import type { CanvasContext, EmfGdiReplayCtx } from './emf-types';
import { fillPathSpans, GdiRasterPath } from './gdi-raster';
import { spanRects } from './emf-gdi-raster-paint';
import { widenPath } from './gdi-raster-widen';

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
		buildRaster(rCtx.rasterPath, isTo && rCtx.rasterPath.figures.length === 0 ? currentFix(rCtx) : null);
	} else {
		const from = isTo ? currentFix(rCtx) : null;
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
// PolyDraw (32- and 16-bit)
// ---------------------------------------------------------------------------

/** PolyDraw point types. */
const PT_CLOSEFIGURE = 0x01;
const PT_LINETO = 0x02;
const PT_BEZIERTO = 0x04;
const PT_MOVETO = 0x06;

/**
 * EMR_POLYDRAW (56) / EMR_POLYDRAW16 (92): a run of `PT_MOVETO`,
 * `PT_LINETO` and `PT_BEZIERTO` (three points per curve) points, any of the
 * drawing ones flagged `PT_CLOSEFIGURE` to close its figure back to the
 * figure's first point. A run that does not start with a move continues
 * from the current position. Drawn as ONE stroked path (every figure with
 * the pen, never filled), or appended to the open path bracket; the current
 * position ends at the last point.
 */
function handlePolyDraw(rCtx: EmfGdiReplayCtx, offset: number, dataOff: number, recSize: number, pointSize: 4 | 8): void {
	const { view, state, inPath } = rCtx;
	if (recSize < 28) {
		return;
	}
	const count = view.getUint32(dataOff + 16, true);
	const ptOff = dataOff + 20;
	const typeOff = ptOff + count * pointSize;
	if (count === 0 || count > 1_000_000 || typeOff + count > offset + recSize) {
		return;
	}
	const readPt = (i: number): [number, number] =>
		pointSize === 8
			? [view.getInt32(ptOff + i * 8, true), view.getInt32(ptOff + i * 8 + 4, true)]
			: [view.getInt16(ptOff + i * 4, true), view.getInt16(ptOff + i * 4 + 2, true)];
	const typeAt = (i: number): number => view.getUint8(typeOff + i);

	/** Walks the points, emitting canvas geometry (device px) and/or GDI geometry (FIX). */
	const walk = (canvas: CanvasContext | null, raster: GdiRasterPath | null, from: [number, number] | null, fromPx: { x: number; y: number } | null): void => {
		let open = false;
		const ensureOpen = () => {
			if (!open) {
				if (fromPx) {
					canvas?.moveTo(fromPx.x, fromPx.y);
				}
				if (from) {
					raster?.moveTo(from[0], from[1]);
				}
				open = true;
			}
		};
		for (let i = 0; i < count; i++) {
			const t = typeAt(i);
			const kind = t & ~PT_CLOSEFIGURE;
			if (kind === PT_MOVETO) {
				const [x, y] = readPt(i);
				const p = gmapPoint(rCtx, x, y);
				const f = fixPoint(rCtx, x, y);
				canvas?.moveTo(p.x, p.y);
				raster?.moveTo(f[0], f[1]);
				open = true;
				continue;
			}
			if (kind === PT_LINETO) {
				ensureOpen();
				const [x, y] = readPt(i);
				const p = gmapPoint(rCtx, x, y);
				const f = fixPoint(rCtx, x, y);
				canvas?.lineTo(p.x, p.y);
				raster?.lineTo(f[0], f[1]);
			} else if (kind === PT_BEZIERTO && i + 2 < count) {
				ensureOpen();
				const pts = [0, 1, 2].map((k) => readPt(i + k));
				const dev = pts.map(([x, y]) => gmapPoint(rCtx, x, y));
				const fix = pts.map(([x, y]) => fixPoint(rCtx, x, y));
				canvas?.bezierCurveTo(dev[0].x, dev[0].y, dev[1].x, dev[1].y, dev[2].x, dev[2].y);
				raster?.bezierTo(fix[0][0], fix[0][1], fix[1][0], fix[1][1], fix[2][0], fix[2][1]);
				i += 2;
			} else {
				continue;
			}
			if (typeAt(i) & PT_CLOSEFIGURE) {
				canvas?.closePath();
				raster?.closeFigure();
			}
		}
	};

	const startsWithMove = (typeAt(0) & ~PT_CLOSEFIGURE) === PT_MOVETO;
	if (inPath) {
		rCtx.rasterPath ??= new GdiRasterPath();
		const fresh = rCtx.rasterPath.figures.length === 0;
		walk(gdiPathRecorder(rCtx), rCtx.rasterPath, !startsWithMove && fresh ? currentFix(rCtx) : null, null);
	} else {
		const from = startsWithMove ? null : currentFix(rCtx);
		const fromPx = startsWithMove ? null : gmapPoint(rCtx, state.curX, state.curY);
		rCtx.lineStyle = { pos: 0 };
		paintGdiShape(rCtx, {
			build: (target: CanvasContext) => {
				target.beginPath();
				walk(target, null, null, fromPx);
			},
			raster: () => {
				const path = new GdiRasterPath();
				walk(null, path, from, null);
				return path;
			},
			fill: false,
			stroke: true,
		});
	}
	const [lx, ly] = readPt(count - 1);
	state.curX = lx;
	state.curY = ly;
	rCtx.curFix = undefined;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * `cmds` with every figure closed: a `closePath` before each later `moveTo`
 * and one at the end (closing an already closed figure is a no-op).
 */
function closeAllFigures(cmds: readonly GdiPathCmd[]): GdiPathCmd[] {
	const out: GdiPathCmd[] = [];
	for (const c of cmds) {
		if (c.op === 'moveTo' && out.length > 0) {
			out.push({ op: 'closePath' });
		}
		out.push(c);
	}
	if (out.length > 0) {
		out.push({ op: 'closePath' });
	}
	return out;
}

/** Fills and/or strokes the current bracket's path (`EMR_FILLPATH` and friends). */
function paintBracketPath(rCtx: EmfGdiReplayCtx, fill: boolean, stroke: boolean): void {
	const { state } = rCtx;
	// `build` replays the commands recorded during the preceding
	// BeginPath/EndPath bracket (`rCtx.pathCmds`); the exact route uses the
	// bracket's GDI geometry (`rCtx.rasterPath`).
	// StrokeAndFillPath closes every open figure before stroking it (the
	// closing edges are drawn), StrokePath leaves them open.
	const close = fill && stroke;
	const cmds = close ? closeAllFigures(rCtx.pathCmds) : rCtx.pathCmds;
	const buildPath = (target: CanvasContext) => {
		target.beginPath();
		replayGdiPathCmds(target, cmds);
	};
	let raster = rCtx.rasterPath ?? new GdiRasterPath();
	if (close) {
		const closed = new GdiRasterPath();
		closed.append(raster);
		for (const f of closed.figures) {
			f.closed = true;
		}
		raster = closed;
	}
	paintGdiShape(rCtx, {
		build: buildPath,
		raster: () => raster,
		fill,
		stroke,
		fillRule: state.polyFillMode === 2 ? 'nonzero' : 'evenodd',
	});
}

/**
 * Discards the path bracket: filling, stroking or clipping to a path uses
 * it up, and EMR_ABORTPATH throws it away, so a later path record without a
 * new bracket has no path to work on (GDI fails it).
 */
function discardPath(rCtx: EmfGdiReplayCtx): void {
	rCtx.pathCmds = [];
	rCtx.rasterPath = new GdiRasterPath();
}

/** Rebuilds the bracket's Canvas geometry from its GDI geometry (device FIX). */
function syncPathCmds(rCtx: EmfGdiReplayCtx): void {
	const cmds: GdiPathCmd[] = [];
	for (const f of rCtx.rasterPath?.figures ?? []) {
		for (let i = 0; i + 1 < f.pts.length; i += 2) {
			cmds.push({ op: i === 0 ? 'moveTo' : 'lineTo', x: f.pts[i] / 16, y: f.pts[i + 1] / 16 });
		}
		if (f.closed) {
			cmds.push({ op: 'closePath' });
		}
	}
	rCtx.pathCmds = cmds;
}

/**
 * EMR_FLATTENPATH (65): every curve of the closed path becomes the line
 * segments GDI flattens it to. The GDI geometry is already flattened by
 * GDI's own flattener as it is recorded, so this only drops the curve
 * tangents a wide pen would otherwise use at a curve's ends and turns the
 * Canvas geometry into those same lines.
 */
function flattenBracketPath(rCtx: EmfGdiReplayCtx): void {
	if (rCtx.inPath || !rCtx.rasterPath) {
		return;
	}
	for (const f of rCtx.rasterPath.figures) {
		delete f.tangents;
	}
	syncPathCmds(rCtx);
}

/**
 * EMR_WIDENPATH (66): the closed path becomes the outline the current pen
 * would paint when stroking it (`widenPath`, `gdi-raster-widen.ts`), each
 * outline a closed figure, so a later fill, stroke or clip uses the
 * widened shape. A cosmetic (one-pixel) pen widens to a one-pixel round
 * pen's outline (measured: a filled result is the one-pixel frame); a null
 * pen leaves the path as it was.
 */
function widenBracketPath(rCtx: EmfGdiReplayCtx): void {
	const { state } = rCtx;
	if (rCtx.inPath || !rCtx.rasterPath || (state.penStyle & 0x0f) === 5) {
		return;
	}
	const options = penIsCosmetic(rCtx)
		? { width: 16, cap: 'round' as const, join: 'round' as const, miterLimit: state.miterLimit ?? 10 }
		: penWidenOptions(rCtx);
	const polys = widenPath(rCtx.rasterPath, options);
	const path = new GdiRasterPath();
	for (const poly of polys) {
		if (poly.length < 4) {
			continue;
		}
		path.moveTo(poly[0], poly[1]);
		for (let i = 2; i + 1 < poly.length; i += 2) {
			path.lineTo(poly[i], poly[i + 1]);
		}
		path.closeFigure();
	}
	rCtx.rasterPath = path;
	syncPathCmds(rCtx);
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
		case EMR_POLYDRAW:
			handlePolyDraw(rCtx, offset, dataOff, recSize, 8);
			return true;
		case EMR_POLYDRAW16:
			handlePolyDraw(rCtx, offset, dataOff, recSize, 4);
			return true;
		case EMR_POLYPOLYLINE16:
			if (recSize >= 28) {
				handlePolyPolyline16(rCtx, offset, dataOff, recSize);
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
			discardPath(rCtx);
			return true;
		case EMR_STROKEANDFILLPATH:
			paintBracketPath(rCtx, true, true);
			discardPath(rCtx);
			return true;
		case EMR_STROKEPATH:
			paintBracketPath(rCtx, false, true);
			discardPath(rCtx);
			return true;
		case EMR_FLATTENPATH:
			flattenBracketPath(rCtx);
			return true;
		case EMR_WIDENPATH:
			widenBracketPath(rCtx);
			return true;
		case EMR_ABORTPATH:
			rCtx.inPath = false;
			discardPath(rCtx);
			ctx.beginPath();
			return true;

		case EMR_SELECTCLIPPATH: {
			// GDI converts the path to a region with the current polygon fill
			// mode (ALTERNATE = even-odd, which is what carves holes out of
			// multi-figure clip paths) and its own scan conversion: exactly the
			// pixels FillPath would paint (`fillPathSpans` on the bracket's GDI
			// geometry), held as disjoint whole-pixel rectangles like a GDI
			// region, so every RegionMode then combines exactly
			// (gdiCombineClip).
			const clipMode = recSize >= 12 ? rCtx.view.getUint32(dataOff, true) : 5;
			const op = RGN_MODE_OPS[clipMode];
			if (rCtx.inPath || !rCtx.rasterPath || rCtx.rasterPath.figures.length === 0) {
				// No closed path (none, still open, or discarded): SelectClipPath fails.
				return true;
			}
			if (!op) {
				emfLog(`EMR_SELECTCLIPPATH: unknown RegionMode ${clipMode}: ignored`);
				return true;
			}
			const rects = spanRects(fillPathSpans(rCtx.rasterPath, state.polyFillMode === 2));
			const shape: ClipShape = rects.length > 0 ? rectsClipShape(rects) : emptyClipShape();
			gdiCombineClip(rCtx, shape, op);
			discardPath(rCtx);
			return true;
		}

		default:
			return false;
	}
}
