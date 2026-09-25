/**
 * EMF GDI polypolygon/polypolyline record helpers (32-bit and 16-bit).
 * Each sub-polygon is one figure of the shape, filled as a whole with the
 * current polygon fill mode (so overlapping or nested figures follow
 * ALTERNATE/WINDING exactly on the exact route) and outlined figure by
 * figure (the pen's dash pattern restarts at each figure, as in GDI).
 */

import { gmapPoint } from './emf-gdi-coord';
import { gdiPathRecorder } from './emf-gdi-path-record';
import { fixPoint } from './emf-gdi-raster-shapes';
import { paintGdiShape } from './emf-gdi-shape-paint';
import type { CanvasContext, EmfGdiReplayCtx } from './emf-types';
import { GdiRasterPath } from './gdi-raster';

/** Builds one or more polygon/polyline sub-paths from a PolyPolygon(16)/PolyPolyline record's counts/points. */
function buildPolyPolygonPath(
	target: CanvasContext,
	rCtx: EmfGdiReplayCtx,
	readPoint: (pIdx: number) => { x: number; y: number },
	countsOff: number,
	numPolys: number,
	totalPoints: number,
	close: boolean,
): void {
	const { view } = rCtx;
	let pIdx = 0;
	for (let p = 0; p < numPolys; p++) {
		const count = view.getUint32(countsOff + p * 4, true);
		for (let i = 0; i < count && pIdx < totalPoints; i++) {
			const pt = readPoint(pIdx);
			if (i === 0) {
				target.moveTo(pt.x, pt.y);
			} else {
				target.lineTo(pt.x, pt.y);
			}
			pIdx++;
		}
		if (close) {
			target.closePath();
		}
	}
}

/** The same figures as GDI device geometry (FIX). */
function buildPolyPolygonRaster(
	path: GdiRasterPath,
	rCtx: EmfGdiReplayCtx,
	readLogical: (pIdx: number) => [number, number],
	countsOff: number,
	numPolys: number,
	totalPoints: number,
	close: boolean,
): void {
	const { view } = rCtx;
	let pIdx = 0;
	for (let p = 0; p < numPolys; p++) {
		const count = view.getUint32(countsOff + p * 4, true);
		for (let i = 0; i < count && pIdx < totalPoints; i++) {
			const [lx, ly] = readLogical(pIdx);
			const [x, y] = fixPoint(rCtx, lx, ly);
			if (i === 0) {
				path.moveTo(x, y);
			} else {
				path.lineTo(x, y);
			}
			pIdx++;
		}
		if (close && count > 0) {
			path.closeFigure();
		}
	}
}

/** Shared body of the three record handlers. */
function handlePolyPoly(
	rCtx: EmfGdiReplayCtx,
	offset: number,
	dataOff: number,
	recSize: number,
	pointSize: 4 | 8,
	close: boolean,
): void {
	const { view, state, inPath } = rCtx;
	const numPolys = view.getUint32(dataOff + 16, true);
	const totalPoints = view.getUint32(dataOff + 20, true);
	if (numPolys === 0 || numPolys >= 10000 || totalPoints >= 100000) {
		return;
	}
	const countsOff = dataOff + 24;
	const ptOff = countsOff + numPolys * 4;
	if (ptOff + totalPoints * pointSize > offset + recSize) {
		return;
	}
	const readLogical = (pIdx: number): [number, number] =>
		pointSize === 8
			? [view.getInt32(ptOff + pIdx * 8, true), view.getInt32(ptOff + pIdx * 8 + 4, true)]
			: [view.getInt16(ptOff + pIdx * 4, true), view.getInt16(ptOff + pIdx * 4 + 2, true)];
	const readPoint = (pIdx: number) => {
		const [x, y] = readLogical(pIdx);
		return gmapPoint(rCtx, x, y);
	};
	const build = (target: CanvasContext) => {
		buildPolyPolygonPath(target, rCtx, readPoint, countsOff, numPolys, totalPoints, close);
	};
	if (inPath) {
		build(gdiPathRecorder(rCtx));
		rCtx.rasterPath ??= new GdiRasterPath();
		buildPolyPolygonRaster(rCtx.rasterPath, rCtx, readLogical, countsOff, numPolys, totalPoints, close);
		return;
	}
	rCtx.lineStyle = { pos: 0 };
	paintGdiShape(rCtx, {
		build: (target: CanvasContext) => {
			target.beginPath();
			build(target);
		},
		raster: () => {
			const path = new GdiRasterPath();
			buildPolyPolygonRaster(path, rCtx, readLogical, countsOff, numPolys, totalPoints, close);
			return path;
		},
		fill: close,
		stroke: true,
		fillRule: state.polyFillMode === 2 ? 'nonzero' : 'evenodd',
	});
}

export function handlePolyPolygon32(rCtx: EmfGdiReplayCtx, offset: number, dataOff: number, recSize: number): void {
	handlePolyPoly(rCtx, offset, dataOff, recSize, 8, true);
}

export function handlePolyPolyline32(rCtx: EmfGdiReplayCtx, offset: number, dataOff: number, recSize: number): void {
	handlePolyPoly(rCtx, offset, dataOff, recSize, 8, false);
}

export function handlePolyPolygon16(rCtx: EmfGdiReplayCtx, offset: number, dataOff: number, recSize: number): void {
	handlePolyPoly(rCtx, offset, dataOff, recSize, 4, true);
}
