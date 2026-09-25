/**
 * A deferred pixel layer for the GDI rasteriser under `gdiAntialias: false`:
 * the pixels that consecutive GDI shapes paint with a destination-independent
 * ROP2 mode (`R2_COPYPEN` above all) are written straight into one RGBA
 * buffer the size of the canvas, in record order, and reach the canvas in a
 * single `drawImage` of the touched area (through a scratch canvas, so the
 * canvas clip applies) only when something else needs the canvas: a record
 * that is not a GDI shape or a pure state change, a clip change, a ROP2 mode
 * that reads the destination, or the end of the replay
 * (`emf-record-replay.ts` calls {@link flushRasterLayer}).
 *
 * This is what makes the exact rasteriser as cheap as Canvas's antialiased
 * `fill()`: a shape costs a few typed-array writes instead of a native path
 * fill per shape. Painted pixels are opaque and unpainted ones transparent,
 * so a source-over `drawImage` reproduces the painted pixels exactly and
 * leaves every other pixel as it was.
 *
 * The layer is only used for a real canvas (the SVG output keeps vector
 * geometry) no larger than {@link MAX_LAYER_PIXELS}.
 *
 * @module emf-gdi-raster-layer
 */

import { canvasGetImageData, canvasPutImageData, createImageDataCompat } from './emf-canvas-helpers';
import { acquireScratch, compositeOverlay, surfaceSize } from './emf-rop2-exact';
import type { EmfGdiReplayCtx } from './emf-types';
import { isSvgContext } from './svg-context';

/** Largest canvas (in pixels) the layer is allocated for (64 MB of RGBA). */
export const MAX_LAYER_PIXELS = 16 * 1024 * 1024;

/** The deferred pixels and the bounding box of the ones written since the last flush. */
export interface RasterLayer {
	w: number;
	h: number;
	data: Uint8ClampedArray;
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/**
 * The replay's layer, created on first use; `null` when layering does not
 * apply (antialiased mode, SVG output, no canvas size, or too large a
 * canvas), in which case the caller paints directly.
 */
export function rasterLayerOf(rCtx: EmfGdiReplayCtx): RasterLayer | null {
	if (rCtx.gdiAntialias !== false) {
		return null;
	}
	if (rCtx.rasterLayer !== undefined) {
		return rCtx.rasterLayer;
	}
	const size = surfaceSize(rCtx.ctx);
	if (!size || isSvgContext(rCtx.ctx) || size.w * size.h > MAX_LAYER_PIXELS) {
		rCtx.rasterLayer = null;
		return null;
	}
	rCtx.rasterLayer = {
		w: size.w,
		h: size.h,
		data: new Uint8ClampedArray(size.w * size.h * 4),
		x0: size.w,
		y0: size.h,
		x1: 0,
		y1: 0,
	};
	return rCtx.rasterLayer;
}

/**
 * Draws the layer's pending pixels onto the canvas (clip applied) and clears
 * them. A no-op when nothing is pending.
 */
export function flushRasterLayer(rCtx: EmfGdiReplayCtx): void {
	const layer = rCtx.rasterLayer;
	if (!layer || layer.x1 <= layer.x0 || layer.y1 <= layer.y0) {
		return;
	}
	const box = { x: layer.x0, y: layer.y0, w: layer.x1 - layer.x0, h: layer.y1 - layer.y0 };
	const pixels = new Uint8ClampedArray(box.w * box.h * 4);
	for (let y = 0; y < box.h; y++) {
		const from = ((box.y + y) * layer.w + box.x) * 4;
		pixels.set(layer.data.subarray(from, from + box.w * 4), y * box.w * 4);
		layer.data.fill(0, from, from + box.w * 4);
	}
	layer.x0 = layer.w;
	layer.y0 = layer.h;
	layer.x1 = 0;
	layer.y1 = 0;
	const scratch = acquireScratch(box.w, box.h);
	if (scratch) {
		compositeOverlay(rCtx.ctx, box, scratch, createImageDataCompat(pixels, box.w, box.h));
		return;
	}
	// No scratch canvas: blend the opaque pixels into a read-back copy.
	const dest = canvasGetImageData(rCtx.ctx, box.x, box.y, box.w, box.h);
	for (let i = 0; i < pixels.length; i += 4) {
		if (pixels[i + 3] !== 0) {
			dest.data[i] = pixels[i];
			dest.data[i + 1] = pixels[i + 1];
			dest.data[i + 2] = pixels[i + 2];
			dest.data[i + 3] = 255;
		}
	}
	canvasPutImageData(rCtx.ctx, dest, box.x, box.y);
}

/**
 * EMF record types that neither draw outside the rasteriser nor change the
 * canvas clip, so the layer can stay pending across them: GDI shapes and
 * paths (all rasterised under `gdiAntialias: false`), object creation and
 * selection, and drawing-state/mapping changes.
 */
const LAYER_SAFE_RECORDS = new Set<number>([
	// shapes, polys, paths
	2, 3, 4, 5, 6, 7, 8, 27, 42, 43, 44, 45, 46, 47, 54, 55, 59, 60, 61, 62, 63, 64, 85, 86, 87, 88, 89, 90, 91,
	// objects
	37, 38, 39, 40, 82, 93, 94, 95,
	// state and mapping
	9, 10, 11, 12, 13, 17, 18, 19, 20, 21, 22, 24, 25, 31, 32, 33, 35, 36, 57, 58,
	// palettes, and state/informational records that draw nothing
	16, 23, 48, 49, 50, 51, 52, 99, 100, 101, 102, 103, 104, 105, 106, 109, 110, 111, 112, 113, 119, 120, 121, 122,
]);

/** True when record type `recType` can run with the layer still pending. */
export function isLayerSafeRecord(recType: number): boolean {
	return LAYER_SAFE_RECORDS.has(recType);
}
