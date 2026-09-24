/**
 * EMF GDI polypolygon record helpers (32-bit and 16-bit).
 */

import { gmapPoint } from './emf-gdi-coord';
import { fillShapeExactOrFast, strokeShapeExactOrFast } from './emf-gdi-shape-paint';
import type { CanvasContext, EmfGdiReplayCtx } from './emf-types';

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

export function handlePolyPolygon32(
	rCtx: EmfGdiReplayCtx,
	offset: number,
	dataOff: number,
	recSize: number,
): void {
	const { ctx, view, state, inPath } = rCtx;
	const numPolys = view.getUint32(dataOff + 16, true);
	const totalPoints = view.getUint32(dataOff + 20, true);
	if (numPolys === 0 || numPolys >= 10000 || totalPoints >= 100000) {
		return;
	}
	const countsOff = dataOff + 24;
	const ptOff = countsOff + numPolys * 4;
	if (ptOff + totalPoints * 8 > offset + recSize) {
		return;
	}
	const readPoint = (pIdx: number) =>
		gmapPoint(rCtx, view.getInt32(ptOff + pIdx * 8, true), view.getInt32(ptOff + pIdx * 8 + 4, true));
	const build = (target: CanvasContext) => {
		buildPolyPolygonPath(target, rCtx, readPoint, countsOff, numPolys, totalPoints, true);
	};
	if (!inPath) {
		ctx.beginPath();
	}
	build(ctx);
	if (!inPath) {
		const buildWithPath = (target: CanvasContext) => {
			target.beginPath();
			build(target);
		};
		fillShapeExactOrFast(rCtx, buildWithPath, state.polyFillMode === 2 ? 'nonzero' : 'evenodd');
		strokeShapeExactOrFast(rCtx, buildWithPath);
	}
}

export function handlePolyPolyline32(
	rCtx: EmfGdiReplayCtx,
	offset: number,
	dataOff: number,
	recSize: number,
): void {
	const { ctx, view, inPath } = rCtx;
	const numPolys = view.getUint32(dataOff + 16, true);
	const totalPoints = view.getUint32(dataOff + 20, true);
	if (numPolys === 0 || numPolys >= 10000 || totalPoints >= 100000) {
		return;
	}
	const countsOff = dataOff + 24;
	const ptOff = countsOff + numPolys * 4;
	if (ptOff + totalPoints * 8 > offset + recSize) {
		return;
	}
	const readPoint = (pIdx: number) =>
		gmapPoint(rCtx, view.getInt32(ptOff + pIdx * 8, true), view.getInt32(ptOff + pIdx * 8 + 4, true));
	const build = (target: CanvasContext) => {
		buildPolyPolygonPath(target, rCtx, readPoint, countsOff, numPolys, totalPoints, false);
	};
	if (!inPath) {
		ctx.beginPath();
	}
	build(ctx);
	if (!inPath) {
		const buildWithPath = (target: CanvasContext) => {
			target.beginPath();
			build(target);
		};
		strokeShapeExactOrFast(rCtx, buildWithPath);
	}
}

export function handlePolyPolygon16(
	rCtx: EmfGdiReplayCtx,
	offset: number,
	dataOff: number,
	recSize: number,
): void {
	const { ctx, view, state, inPath } = rCtx;
	const numPolys = view.getUint32(dataOff + 16, true);
	const totalPoints = view.getUint32(dataOff + 20, true);
	if (numPolys === 0 || numPolys >= 10000 || totalPoints >= 100000) {
		return;
	}
	const countsOff = dataOff + 24;
	const ptOff = countsOff + numPolys * 4;
	if (ptOff + totalPoints * 4 > offset + recSize) {
		return;
	}
	const readPoint = (pIdx: number) =>
		gmapPoint(rCtx, view.getInt16(ptOff + pIdx * 4, true), view.getInt16(ptOff + pIdx * 4 + 2, true));
	const build = (target: CanvasContext) => {
		buildPolyPolygonPath(target, rCtx, readPoint, countsOff, numPolys, totalPoints, true);
	};
	if (!inPath) {
		ctx.beginPath();
	}
	build(ctx);
	if (!inPath) {
		const buildWithPath = (target: CanvasContext) => {
			target.beginPath();
			build(target);
		};
		fillShapeExactOrFast(rCtx, buildWithPath, state.polyFillMode === 2 ? 'nonzero' : 'evenodd');
		strokeShapeExactOrFast(rCtx, buildWithPath);
	}
}
