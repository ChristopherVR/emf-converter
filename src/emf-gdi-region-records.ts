/**
 * EMF region painting records: EMR_FILLRGN, EMR_FRAMERGN, EMR_INVERTRGN and
 * EMR_PAINTRGN.
 *
 * Each carries a RGNDATA region: disjoint rectangles in LOGICAL units
 * (measured: a viewport offset or an anisotropic mapping mode moves and
 * scales them like any other logical coordinates), each mapped to device
 * pixels with its corners rounded to whole pixels. Under a rotating world
 * transform a rectangle becomes the parallelogram of its mapped corners,
 * scan converted like a polygon. The region is then painted exactly
 * through the GDI rasteriser's span painter (`emf-gdi-raster-paint.ts`), so
 * the active clip, the SetROP2 mode and pattern-brush alignment follow GDI:
 *
 *   - FillRgn paints the region with the brush the record names (a stock
 *     brush included), PaintRgn with the DC's selected brush.
 *   - FrameRgn paints the region's border with the named brush: the region
 *     minus its erosion by a box of (2 width + 1) x (2 height + 1) pixels,
 *     i.e. every pixel with a pixel outside the region within the frame
 *     width horizontally and the frame height vertically (inside corners
 *     get the full width x height square; measured, all six frames of
 *     `emfrec-framergn` exact).
 *   - InvertRgn inverts the destination under the region.
 *
 * @module emf-gdi-region-records
 */

import { getStockObject } from './emf-canvas-helpers';
import { EMR_FILLRGN, EMR_FRAMERGN, EMR_INVERTRGN, EMR_PAINTRGN, STOCK_OBJECT_BASE } from './emf-constants';
import { gmh, gmw, gmx, gmy, hasWorldRotation } from './emf-gdi-coord';
import { resolveColorRef } from './emf-gdi-palette';
import { paintSpansDeferred } from './emf-gdi-raster-paint';
import { brushPaint, fixPoint } from './emf-gdi-raster-shapes';
import type { EmfGdiReplayCtx, GdiBrush } from './emf-types';
import { fillPolygonSpans, SpanList } from './gdi-raster';

/** `R2_NOT`: inverts the destination. */
const R2_NOT = 6;

/**
 * Reads the RGNDATA at `rgnOff` (`cbRgnData` bytes: a 32-byte header, then
 * `nCount` RECTLs) as logical rectangles `[left, top, right, bottom]`.
 */
export function readRegionRects(view: DataView, rgnOff: number, cbRgnData: number): Array<[number, number, number, number]> {
	const rects: Array<[number, number, number, number]> = [];
	if (cbRgnData < 32 || rgnOff + 32 > view.byteLength) {
		return rects;
	}
	const count = view.getUint32(rgnOff + 8, true);
	const end = Math.min(view.byteLength, rgnOff + cbRgnData);
	for (let i = 0; i < count; i++) {
		const o = rgnOff + 32 + i * 16;
		if (o + 16 > end) {
			break;
		}
		rects.push([view.getInt32(o, true), view.getInt32(o + 4, true), view.getInt32(o + 8, true), view.getInt32(o + 12, true)]);
	}
	return rects;
}

/** The device pixels of a logical region, as spans (see the module doc). */
export function regionSpans(rCtx: EmfGdiReplayCtx, rects: ReadonlyArray<[number, number, number, number]>): SpanList {
	const spans = new SpanList();
	if (hasWorldRotation(rCtx)) {
		const polys = rects.map(([l, t, r, b]) => [...fixPoint(rCtx, l, t), ...fixPoint(rCtx, r, t), ...fixPoint(rCtx, r, b), ...fixPoint(rCtx, l, b)]);
		// Rectangles are disjoint: ALTERNATE never cancels an overlap.
		return fillPolygonSpans(polys, true, spans);
	}
	for (const [l, t, r, b] of rects) {
		const x0 = Math.round(gmx(rCtx, l));
		const x1 = Math.round(gmx(rCtx, r));
		const y0 = Math.round(gmy(rCtx, t));
		const y1 = Math.round(gmy(rCtx, b));
		const left = Math.min(x0, x1);
		const right = Math.max(x0, x1);
		for (let y = Math.min(y0, y1); y < Math.max(y0, y1); y++) {
			spans.add(y, left, right);
		}
	}
	return spans;
}

/**
 * The border of the region `spans` covers: its pixels with a pixel outside
 * the region at most `w` columns and `h` rows away (the region minus its
 * erosion by a (2w + 1) x (2h + 1) box).
 */
export function frameSpans(spans: SpanList, w: number, h: number): SpanList {
	const out = new SpanList();
	const b = spans.bounds();
	if (!b) {
		return out;
	}
	const W = b.x1 - b.x0;
	const H = b.y1 - b.y0;
	const mask = new Uint8Array(W * H);
	const d = spans.data;
	for (let i = 0; i < spans.length * 3; i += 3) {
		mask.fill(1, (d[i] - b.y0) * W + d[i + 1] - b.x0, (d[i] - b.y0) * W + d[i + 2] - b.x0);
	}
	// Erode by the (2w + 1) x (2h + 1) box, one axis at a time: a pixel
	// survives when every pixel within w columns and h rows is inside.
	const horiz = new Uint8Array(W * H);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			let all = 1;
			for (let k = -w; k <= w && all; k++) {
				const xx = x + k;
				all = xx >= 0 && xx < W ? mask[y * W + xx] : 0;
			}
			horiz[y * W + x] = all;
		}
	}
	const kept = (x: number, y: number): boolean => {
		for (let k = -h; k <= h; k++) {
			const yy = y + k;
			if (yy < 0 || yy >= H || !horiz[yy * W + x]) {
				return false;
			}
		}
		return true;
	};
	for (let y = 0; y < H; y++) {
		let run = -1;
		for (let x = 0; x <= W; x++) {
			const edge = x < W && mask[y * W + x] === 1 && !kept(x, y);
			if (edge && run < 0) {
				run = x;
			} else if (!edge && run >= 0) {
				out.add(y + b.y0, run + b.x0, x + b.x0);
				run = -1;
			}
		}
	}
	return out;
}

/** The brush object `ihBrush` names (a stock brush included), or `null`. */
function brushObject(rCtx: EmfGdiReplayCtx, ihBrush: number): GdiBrush | null {
	const obj = ihBrush >= STOCK_OBJECT_BASE ? getStockObject(ihBrush - STOCK_OBJECT_BASE) : (rCtx.objectTable.get(ihBrush) ?? null);
	return obj && obj.kind === 'brush' ? obj : null;
}

/** Paints `spans` with `brush` (or the selected brush when `null`) through the DC's ROP2 mode. */
function paintWithBrush(rCtx: EmfGdiReplayCtx, spans: SpanList, brush: GdiBrush | null): void {
	const { state } = rCtx;
	const saved = { style: state.brushStyle, color: state.brushColor, pattern: state.brushPattern };
	if (brush) {
		state.brushStyle = brush.style;
		state.brushColor = brush.colorRef !== undefined ? resolveColorRef(state, brush.colorRef) : brush.color;
		state.brushPattern = brush.pattern ?? null;
	}
	try {
		const paint = brushPaint(rCtx);
		if (paint) {
			paintSpansDeferred(rCtx, spans, paint, state.rop2);
		}
	} finally {
		state.brushStyle = saved.style;
		state.brushColor = saved.color;
		state.brushPattern = saved.pattern;
	}
}

/** Handles the region records; returns false for any other record type. */
export function handleEmfGdiRegionRecord(rCtx: EmfGdiReplayCtx, recType: number, dataOff: number, recSize: number): boolean {
	const { view } = rCtx;
	switch (recType) {
		case EMR_FILLRGN: {
			// Bounds, cbRgnData, ihBrush, RgnData.
			if (recSize >= 32) {
				const cb = view.getUint32(dataOff + 16, true);
				const brush = brushObject(rCtx, view.getUint32(dataOff + 20, true));
				if (brush) {
					paintWithBrush(rCtx, regionSpans(rCtx, readRegionRects(view, dataOff + 24, cb)), brush);
				}
			}
			return true;
		}
		case EMR_FRAMERGN: {
			// Bounds, cbRgnData, ihBrush, Width, Height, RgnData.
			if (recSize >= 40) {
				const cb = view.getUint32(dataOff + 16, true);
				const brush = brushObject(rCtx, view.getUint32(dataOff + 20, true));
				const w = Math.round(Math.abs(gmw(rCtx, view.getInt32(dataOff + 24, true))));
				const h = Math.round(Math.abs(gmh(rCtx, view.getInt32(dataOff + 28, true))));
				if (brush) {
					const spans = regionSpans(rCtx, readRegionRects(view, dataOff + 32, cb));
					paintWithBrush(rCtx, frameSpans(spans, w, h), brush);
				}
			}
			return true;
		}
		case EMR_INVERTRGN:
		case EMR_PAINTRGN: {
			// Bounds, cbRgnData, RgnData.
			if (recSize >= 24) {
				const cb = view.getUint32(dataOff + 16, true);
				const spans = regionSpans(rCtx, readRegionRects(view, dataOff + 20, cb));
				if (recType === EMR_INVERTRGN) {
					paintSpansDeferred(rCtx, spans, { kind: 'solid', rgb: 0 }, R2_NOT);
				} else {
					paintWithBrush(rCtx, spans, null);
				}
			}
			return true;
		}
		default:
			return false;
	}
}
