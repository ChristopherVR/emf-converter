/**
 * WMF pixel records: `META_SETPIXEL`, `META_FLOODFILL` and
 * `META_EXTFLOODFILL`.
 *
 * `SetPixel` writes one device pixel (the logical point mapped and rounded
 * to the nearest pixel) with the colour it names. The flood fills read the
 * surface back and grow a 4-connected area from the start pixel:
 * `FLOODFILLBORDER` (and `META_FLOODFILL`) spreads over every pixel that is
 * not the border colour, `FLOODFILLSURFACE` over every pixel that is the
 * surface colour; nothing is filled when the start pixel already stops the
 * fill. The area is painted with the selected brush through the exact span
 * painter, so pattern brushes and `SetROP2` modes apply as in GDI. The
 * surface is read through the canvas (or the SVG output's raster mirror);
 * without one the fill is skipped.
 *
 * @module wmf-pixel
 */

import { canvasGetImageData } from './emf-canvas-helpers';
import { paintSpansDeferred } from './emf-gdi-raster-paint';
import { flushRasterLayer } from './emf-gdi-raster-layer';
import { brushPaint } from './emf-gdi-raster-shapes';
import { surfaceSize } from './emf-rop2-exact';
import { SpanList } from './gdi-raster';
import { canReadBack } from './svg-context';
import { resolveColorRef } from './wmf-objects';
import type { WmfPlayer } from './wmf-player';
import { deviceRect } from './wmf-region';

/** The canvas pixels of device pixel (`x`, `y`) as spans. */
function devicePixelSpans(p: WmfPlayer, x: number, y: number): SpanList {
	const spans = new SpanList();
	const x0 = Math.round(x * p.kx);
	const x1 = Math.max(x0 + 1, Math.round((x + 1) * p.kx));
	const y0 = Math.round(y * p.ky);
	const y1 = Math.max(y0 + 1, Math.round((y + 1) * p.ky));
	for (let row = y0; row < y1; row++) {
		spans.add(row, x0, x1);
	}
	return spans;
}

/** `META_SETPIXEL`. */
export function wmfSetPixel(p: WmfPlayer, x: number, y: number, colorRef: number): void {
	const [dx, dy] = deviceRect(p, x, y, x, y);
	paintSpansDeferred(p.rCtx, devicePixelSpans(p, dx, dy), { kind: 'solid', rgb: resolveColorRef(colorRef, p.palette) }, 13);
}

/** `META_FLOODFILL` (`type` 0) / `META_EXTFLOODFILL` (`FLOODFILLBORDER` 0, `FLOODFILLSURFACE` 1). */
export function wmfExtFloodFill(p: WmfPlayer, x: number, y: number, colorRef: number, type: number): void {
	const { rCtx } = p;
	const { ctx } = rCtx;
	const size = surfaceSize(ctx);
	if (!size || !canReadBack(ctx) || typeof ctx.getImageData !== 'function') {
		return;
	}
	const paint = brushPaint(rCtx);
	if (!paint) {
		return;
	}
	flushRasterLayer(rCtx);
	const [dx, dy] = deviceRect(p, x, y, x, y);
	const sx = Math.floor((dx + 0.5) * p.kx);
	const sy = Math.floor((dy + 0.5) * p.ky);
	const { w, h } = size;
	if (sx < 0 || sy < 0 || sx >= w || sy >= h) {
		return;
	}
	const data = canvasGetImageData(ctx, 0, 0, w, h).data;
	const target = resolveColorRef(colorRef, p.palette);
	const at = (i: number): number => {
		// An unpainted (transparent) pixel reads as the white page GDI plays onto.
		if (data[i * 4 + 3] === 0) {
			return 0xffffff;
		}
		return (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2];
	};
	const surface = type === 1;
	const fillable = (i: number) => (surface ? at(i) === target : at(i) !== target);
	const start = sy * w + sx;
	if (!fillable(start)) {
		return;
	}
	const seen = new Uint8Array(w * h);
	const stack = [start];
	seen[start] = 1;
	while (stack.length > 0) {
		const i = stack.pop()!;
		const px = i % w;
		const py = (i - px) / w;
		const visit = (j: number) => {
			if (!seen[j] && fillable(j)) {
				seen[j] = 1;
				stack.push(j);
			}
		};
		if (px > 0) visit(i - 1);
		if (px + 1 < w) visit(i + 1);
		if (py > 0) visit(i - w);
		if (py + 1 < h) visit(i + w);
	}
	const spans = new SpanList();
	for (let row = 0; row < h; row++) {
		let run = -1;
		for (let col = 0; col <= w; col++) {
			const on = col < w && seen[row * w + col] === 1;
			if (on && run < 0) {
				run = col;
			} else if (!on && run >= 0) {
				spans.add(row, run, col);
				run = -1;
			}
		}
	}
	paintSpansDeferred(rCtx, spans, paint, rCtx.state.rop2);
}
