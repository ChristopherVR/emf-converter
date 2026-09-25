/**
 * EMR_EXTFLOODFILL: GDI's flood fill, evaluated against the actual
 * destination pixels.
 *
 * Starting at the device pixel under the logical start point, the fill
 * spreads through 4-connected neighbours (left, right, up, down: a
 * one-pixel diagonal line holds it) that are
 *
 *   - `FLOODFILLBORDER` (0): any colour but the border colour, or
 *   - `FLOODFILLSURFACE` (1): exactly the surface colour,
 *
 * and inside the clip region (a fill never spreads through clipped-away
 * pixels, and one starting outside the clip paints nothing). A start pixel
 * that does not qualify paints nothing. The filled pixels are painted with
 * the selected brush through the GDI span painter, so pattern brushes stay
 * aligned to the brush origin and the SetROP2 mode applies.
 *
 * The destination is read back from the canvas (from the raster mirror in
 * SVG output, where the filled pixels become an exact vector fill of
 * whole-pixel rectangles or an image patch); without read-back (SVG with
 * `exactRasterOps: false`) the record is skipped with a warning.
 *
 * @module emf-gdi-floodfill
 */

import { canvasGetImageData } from './emf-canvas-helpers';
import { scanlineCombineRegions } from './emf-clip-scanline';
import { EMR_EXTFLOODFILL } from './emf-constants';
import { paletteEntries, resolveColorRefRgb } from './emf-gdi-palette';
import { paintSpansDeferred } from './emf-gdi-raster-paint';
import { brushPaint, fixPoint } from './emf-gdi-raster-shapes';
import { emfWarn } from './emf-logging';
import type { EmfGdiReplayCtx } from './emf-types';
import { SpanList } from './gdi-raster';
import { canReadBack } from './svg-context';

/** `FLOODFILLSURFACE`. */
const FLOODFILLSURFACE = 1;

/** A mask of the canvas pixels inside the clip region (all of them without a clip). */
function clipMask(rCtx: EmfGdiReplayCtx, w: number, h: number): Uint8Array {
	const mask = new Uint8Array(w * h);
	if (!rCtx.clipRegion) {
		mask.fill(1);
		return mask;
	}
	for (const r of scanlineCombineRegions(rCtx.clipRegion, null, 'intersect', { x: 0, y: 0, w, h })) {
		for (let y = Math.max(0, r.y); y < Math.min(h, r.y + r.h); y++) {
			mask.fill(1, y * w + Math.max(0, r.x), y * w + Math.min(w, r.x + r.w));
		}
	}
	return mask;
}

/**
 * The pixels a flood fill from (`sx`, `sy`) covers on the `w` x `h` RGBA
 * `data`, as spans: `inside(rgb)` says whether a pixel colour lets the fill
 * through, `allowed` masks the reachable pixels (the clip).
 */
export function floodSpans(
	data: Uint8ClampedArray,
	w: number,
	h: number,
	sx: number,
	sy: number,
	inside: (rgb: number) => boolean,
	allowed: Uint8Array,
): SpanList {
	const spans = new SpanList();
	const ok = (x: number, y: number): boolean => {
		const i = y * w + x;
		return allowed[i] === 1 && inside((data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2]);
	};
	if (sx < 0 || sy < 0 || sx >= w || sy >= h || !ok(sx, sy)) {
		return spans;
	}
	const seen = new Uint8Array(w * h);
	const stack: number[] = [sx, sy];
	const rows: Array<[number, number, number]> = [];
	while (stack.length > 0) {
		const y = stack.pop() as number;
		const x = stack.pop() as number;
		if (seen[y * w + x] || !ok(x, y)) {
			continue;
		}
		// Scanline fill: extend the run left and right, then seed the rows above and below.
		let x0 = x;
		while (x0 > 0 && !seen[y * w + x0 - 1] && ok(x0 - 1, y)) {
			x0--;
		}
		let x1 = x + 1;
		while (x1 < w && !seen[y * w + x1] && ok(x1, y)) {
			x1++;
		}
		seen.fill(1, y * w + x0, y * w + x1);
		rows.push([y, x0, x1]);
		for (const ny of [y - 1, y + 1]) {
			if (ny < 0 || ny >= h) {
				continue;
			}
			let inRun = false;
			for (let nx = x0; nx < x1; nx++) {
				const can = !seen[ny * w + nx] && ok(nx, ny);
				if (can && !inRun) {
					stack.push(nx, ny);
				}
				inRun = can;
			}
		}
	}
	rows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	for (const [y, x0, x1] of rows) {
		spans.add(y, x0, x1);
	}
	return spans;
}

/** Handles EMR_EXTFLOODFILL; returns false for any other record type. */
export function handleEmfGdiFloodFillRecord(rCtx: EmfGdiReplayCtx, recType: number, dataOff: number, recSize: number): boolean {
	if (recType !== EMR_EXTFLOODFILL) {
		return false;
	}
	if (recSize < 24) {
		return true;
	}
	const { ctx, view, state } = rCtx;
	if (!canReadBack(ctx) || typeof ctx.getImageData !== 'function') {
		emfWarn('EMR_EXTFLOODFILL: the destination cannot be read back (SVG output without a raster mirror); skipped');
		return true;
	}
	const paint = brushPaint(rCtx);
	if (!paint) {
		return true;
	}
	const w = rCtx.canvasW;
	const h = rCtx.canvasH;
	const [fx, fy] = fixPoint(rCtx, view.getInt32(dataOff, true), view.getInt32(dataOff + 4, true));
	const color = resolveColorRefRgb(view.getUint32(dataOff + 8, true), paletteEntries(state));
	const surface = view.getUint32(dataOff + 12, true) === FLOODFILLSURFACE;
	let data: Uint8ClampedArray;
	try {
		data = canvasGetImageData(ctx, 0, 0, w, h).data;
	} catch {
		return true;
	}
	const spans = floodSpans(
		data,
		w,
		h,
		Math.round(fx / 16),
		Math.round(fy / 16),
		surface ? (rgb) => rgb === color : (rgb) => rgb !== color,
		clipMask(rCtx, w, h),
	);
	paintSpansDeferred(rCtx, spans, paint, state.rop2);
	return true;
}
