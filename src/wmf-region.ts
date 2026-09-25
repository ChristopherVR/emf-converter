/**
 * WMF clipping and region records: `META_INTERSECTCLIPRECT`,
 * `META_EXCLUDECLIPRECT`, `META_OFFSETCLIPRGN`, `META_SELECTCLIPREGION`
 * (and `META_SELECTOBJECT` of a region, which GDI treats the same), and
 * the region painters `META_FILLREGION`, `META_PAINTREGION`,
 * `META_INVERTREGION` and `META_FRAMEREGION`.
 *
 * Coordinates follow GDI: a clip rectangle and a clip offset are logical
 * (mapped to device pixels, each corner rounded to the nearest pixel, the
 * right and bottom edges exclusive); a region selected as the clip is in
 * DEVICE pixels, untouched by the mapping; a region painted by
 * `FillRgn`/`PaintRgn`/`InvertRgn`/`FrameRgn` is logical, every rectangle
 * mapped like a clip rectangle. Painting goes through the exact span
 * painter the GDI rasteriser uses (`paintSpansDeferred`), so the brush
 * pattern, the brush origin and the `SetROP2` mode apply per pixel as in
 * GDI; `InvertRgn` inverts the destination. `FrameRgn` paints the region
 * minus the region shrunk by the frame width and height (the region's
 * intersection with itself moved left, right, up and down by them).
 *
 * @module wmf-region
 */

import { rectsClipShape, reapplyClipRegion, translateClipRegion, emptyClipShape, type ClipCombineOp } from './emf-clip-region';
import { gdiCombineClip } from './emf-gdi-clip-records';
import { gdiDeviceMatrix } from './emf-gdi-coord';
import { paintSpansDeferred } from './emf-gdi-raster-paint';
import { flushRasterLayer } from './emf-gdi-raster-layer';
import { brushPaint } from './emf-gdi-raster-shapes';
import { SpanList } from './gdi-raster';
import { selectBrush } from './wmf-objects';
import type { WmfPlayer, WmfRegion } from './wmf-player';

/** A device rectangle `[left, top, right, bottom)`. */
type Rect = [number, number, number, number];

/** Maps a logical point to the nearest device pixel corner. */
function devicePoint(p: WmfPlayer, x: number, y: number): [number, number] {
	const m = gdiDeviceMatrix(p.rCtx);
	// The matrix maps to canvas pixels; device pixels are canvas / k.
	const fx = Math.round((m[0] * x + m[2] * y) * 16) + Math.round(m[4] * 16);
	const fy = Math.round((m[1] * x + m[3] * y) * 16) + Math.round(m[5] * 16);
	return [Math.floor((fx / p.kx + 8) / 16), Math.floor((fy / p.ky + 8) / 16)];
}

/** A logical rectangle mapped to an ordered device rectangle. */
export function deviceRect(p: WmfPlayer, l: number, t: number, r: number, b: number): Rect {
	const a = devicePoint(p, l, t);
	const c = devicePoint(p, r, b);
	return [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[0], c[0]), Math.max(a[1], c[1])];
}

/** Device rectangles as canvas-space clip rectangles. */
function canvasRects(p: WmfPlayer, rects: Rect[]): Array<{ x: number; y: number; w: number; h: number }> {
	return rects.map(([l, t, r, b]) => ({ x: l * p.kx, y: t * p.ky, w: (r - l) * p.kx, h: (b - t) * p.ky }));
}

/** Combines the clip with device rectangles `rects` by `op`. */
function combineDeviceRects(p: WmfPlayer, rects: Rect[], op: ClipCombineOp): void {
	flushRasterLayer(p.rCtx);
	const shape = rects.length > 0 ? rectsClipShape(canvasRects(p, rects)) : emptyClipShape();
	gdiCombineClip(p.rCtx, shape, op);
}

/** `META_INTERSECTCLIPRECT`. */
export function wmfIntersectClipRect(p: WmfPlayer, l: number, t: number, r: number, b: number): void {
	combineDeviceRects(p, [deviceRect(p, l, t, r, b)], 'intersect');
}

/** `META_EXCLUDECLIPRECT`. */
export function wmfExcludeClipRect(p: WmfPlayer, l: number, t: number, r: number, b: number): void {
	combineDeviceRects(p, [deviceRect(p, l, t, r, b)], 'exclude');
}

/** `META_OFFSETCLIPRGN`: a logical offset, mapped to whole device pixels. */
export function wmfOffsetClipRgn(p: WmfPlayer, x: number, y: number): void {
	const { rCtx } = p;
	if (!rCtx.clipRegion) {
		return;
	}
	flushRasterLayer(rCtx);
	const m = gdiDeviceMatrix(rCtx);
	const dx = Math.round((m[0] * x) / p.kx) * p.kx;
	const dy = Math.round((m[3] * y) / p.ky) * p.ky;
	rCtx.clipRegion = translateClipRegion(rCtx.clipRegion, dx, dy);
	reapplyClipRegion(rCtx, rCtx.clipRegion);
}

/** `META_SELECTCLIPREGION`: the region (device pixels) becomes the clip; a non-region slot resets it. */
export function wmfSelectClipRegion(p: WmfPlayer, slot: number): void {
	const obj = p.objects[slot];
	if (obj?.kind !== 'region') {
		flushRasterLayer(p.rCtx);
		p.rCtx.clipRegion = null;
		reapplyClipRegion(p.rCtx, null);
		return;
	}
	combineDeviceRects(p, obj.rects, 'replace');
}

/** A region's rectangles mapped from logical to device pixels. */
function mappedRects(p: WmfPlayer, region: WmfRegion): Rect[] {
	return region.rects.map(([l, t, r, b]) => deviceRect(p, l, t, r, b)).filter(([l, t, r, b]) => r > l && b > t);
}

/** Canvas-pixel spans covering device rectangles `rects` (each pixel once). */
function spansOf(p: WmfPlayer, rects: Rect[]): SpanList {
	const spans = new SpanList();
	const rows = new Map<number, Array<[number, number]>>();
	for (const [l, t, r, b] of rects) {
		const x0 = Math.round(l * p.kx);
		const x1 = Math.round(r * p.kx);
		for (let y = Math.round(t * p.ky); y < Math.round(b * p.ky); y++) {
			let row = rows.get(y);
			if (!row) {
				row = [];
				rows.set(y, row);
			}
			row.push([x0, x1]);
		}
	}
	for (const y of [...rows.keys()].sort((a, b) => a - b)) {
		const row = rows.get(y)!.sort((a, b) => a[0] - b[0]);
		let [s0, s1] = row[0];
		for (let i = 1; i < row.length; i++) {
			if (row[i][0] <= s1) {
				s1 = Math.max(s1, row[i][1]);
			} else {
				spans.add(y, s0, s1);
				[s0, s1] = row[i];
			}
		}
		spans.add(y, s0, s1);
	}
	return spans;
}

/** Paints device rectangles with the selected brush (or `brushSlot`'s) under the DC's ROP2 mode. */
function paintRects(p: WmfPlayer, rects: Rect[], brushSlot: number | null): void {
	const saved = p.brush;
	if (brushSlot !== null) {
		const b = p.objects[brushSlot];
		if (b?.kind !== 'brush') {
			return;
		}
		selectBrush(p, b);
	}
	const paint = brushPaint(p.rCtx);
	if (paint) {
		paintSpansDeferred(p.rCtx, spansOf(p, rects), paint, p.rCtx.state.rop2);
	}
	if (brushSlot !== null) {
		selectBrush(p, saved);
	}
}

/** The region in slot `slot`, if it is one. */
function regionAt(p: WmfPlayer, slot: number): WmfRegion | null {
	const obj = p.objects[slot];
	return obj?.kind === 'region' ? obj : null;
}

/** `META_FILLREGION`: the region with the brush in `brushSlot`. */
export function wmfFillRegion(p: WmfPlayer, regionSlot: number, brushSlot: number): void {
	const region = regionAt(p, regionSlot);
	if (region) {
		paintRects(p, mappedRects(p, region), brushSlot);
	}
}

/** `META_PAINTREGION`: the region with the selected brush. */
export function wmfPaintRegion(p: WmfPlayer, regionSlot: number): void {
	const region = regionAt(p, regionSlot);
	if (region) {
		paintRects(p, mappedRects(p, region), null);
	}
}

/** `META_INVERTREGION`: inverts the destination under the region. */
export function wmfInvertRegion(p: WmfPlayer, regionSlot: number): void {
	const region = regionAt(p, regionSlot);
	if (region) {
		paintSpansDeferred(p.rCtx, spansOf(p, mappedRects(p, region)), { kind: 'solid', rgb: 0 }, 6);
	}
}

/** Rasterises device rectangles into a mask over their bounding box. */
function maskOf(rects: Rect[]): { x0: number; y0: number; w: number; h: number; m: Uint8Array } | null {
	if (rects.length === 0) {
		return null;
	}
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const [l, t, r, b] of rects) {
		x0 = Math.min(x0, l);
		y0 = Math.min(y0, t);
		x1 = Math.max(x1, r);
		y1 = Math.max(y1, b);
	}
	const w = x1 - x0;
	const h = y1 - y0;
	if (w <= 0 || h <= 0 || w * h > 64 * 1024 * 1024) {
		return null;
	}
	const m = new Uint8Array(w * h);
	for (const [l, t, r, b] of rects) {
		for (let y = t; y < b; y++) {
			m.fill(1, (y - y0) * w + (l - x0), (y - y0) * w + (r - x0));
		}
	}
	return { x0, y0, w, h, m };
}

/**
 * `META_FRAMEREGION`: the region's frame, `fw` x `fh` logical units wide
 * (device widths rounded), painted with the brush in `brushSlot`.
 */
export function wmfFrameRegion(p: WmfPlayer, regionSlot: number, brushSlot: number, fh: number, fw: number): void {
	const region = regionAt(p, regionSlot);
	if (!region) {
		return;
	}
	const m = gdiDeviceMatrix(p.rCtx);
	const dw = Math.abs(Math.round((m[0] * fw) / p.kx));
	const dh = Math.abs(Math.round((m[3] * fh) / p.ky));
	const mask = maskOf(mappedRects(p, region));
	if (!mask) {
		return;
	}
	const { x0, y0, w, h } = mask;
	const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? mask.m[y * w + x] : 0);
	const frame: Rect[] = [];
	for (let y = 0; y < h; y++) {
		let run = -1;
		for (let x = 0; x <= w; x++) {
			const inside = x < w && at(x, y) === 1;
			const inner =
				inside &&
				at(x - dw, y) === 1 &&
				at(x + dw, y) === 1 &&
				at(x, y - dh) === 1 &&
				at(x, y + dh) === 1 &&
				at(x - dw, y - dh) === 1 &&
				at(x + dw, y - dh) === 1 &&
				at(x - dw, y + dh) === 1 &&
				at(x + dw, y + dh) === 1;
			const onFrame = inside && !inner;
			if (onFrame && run < 0) {
				run = x;
			} else if (!onFrame && run >= 0) {
				frame.push([x0 + run, y0 + y, x0 + x, y0 + y + 1]);
				run = -1;
			}
		}
	}
	paintRects(p, frame, brushSlot);
}
