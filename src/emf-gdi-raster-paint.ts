/**
 * Paints the pixel spans produced by the GDI rasteriser (`gdi-raster.ts`)
 * onto the output canvas, exactly as GDI would write them: every covered
 * pixel gets one colour, combined with the destination through the active
 * `SetROP2` mode, never blended.
 *
 * Two routes, chosen per call:
 *
 *   - Destination-independent paint (a solid colour under `R2_COPYPEN`,
 *     `R2_BLACK`, `R2_WHITE` or `R2_NOTCOPYPEN`, the overwhelmingly common
 *     case): the spans become a path of whole-pixel rectangles, merged
 *     vertically where consecutive rows cover the same columns, filled once
 *     with the resulting colour at an identity transform. Rectangles on
 *     integer coordinates cover their pixels completely, so every backend
 *     (and the SVG output, where they stay vector geometry) paints exactly
 *     those pixels, with the canvas clip applied as usual. This is also what
 *     makes the non-antialiased mode as fast as the antialiased one: no
 *     read-back, one native fill per primitive.
 *   - Anything that needs the destination (the ten bitwise ROP2 modes,
 *     `R2_NOT`) or varies per pixel (a hatch/monochrome/DIB pattern brush):
 *     the spans' bounding box is read back once, each covered pixel is
 *     computed (`evalRop3` with an S-independent ROP3 index, pattern colour
 *     from `sampleTile`), and the result is composited through a scratch
 *     canvas and `drawImage`, so the clip still applies (see
 *     `compositeOverlay`, `emf-rop2-exact.ts`).
 *
 * The SVG output without a canvas backend cannot read pixels back; there a
 * destination-reading mode falls back to `rop2Paint`'s blend-mode
 * approximation on the same rectangle path, and a pattern brush to the SVG
 * context's native unfiltered tile fill.
 *
 * @module emf-gdi-raster-paint
 */

import { canvasGetImageData, rop2Paint, rop2TransformColor } from './emf-canvas-helpers';
import { sampleTile } from './emf-gdi-brush-pattern';
import { flushRasterLayer, rasterLayerOf } from './emf-gdi-raster-layer';
import { acquireScratch, compositeOverlay, rop2Rop3Index, surfaceSize } from './emf-rop2-exact';
import { evalRop3 } from './emf-rop3';
import type { CanvasContext, EmfGdiReplayCtx } from './emf-types';
import type { SpanList } from './gdi-raster';
import { canReadBack, isSvgContext } from './svg-context';

/** What each covered pixel is painted with (before the ROP2 combine). */
export type RasterPaint =
	| { kind: 'solid'; rgb: number }
	| {
			kind: 'tile';
			tile: { width: number; height: number; rgb: Uint32Array };
			/** Maps a canvas pixel to the device pixel the brush origin is relative to. */
			toDevice: (x: number, y: number) => [number, number];
			orgX: number;
			orgY: number;
	  };

/** `#rrggbb` for a packed colour. */
function hex(rgb: number): string {
	return `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** True when ROP3-style index `index` (S-independent) reads the destination. */
function usesDest(index: number): boolean {
	for (const p of [0, 0xffffff]) {
		if (evalRop3(index, p, 0, 0) !== evalRop3(index, p, 0, 0xffffff)) {
			return true;
		}
	}
	return false;
}

/**
 * Issues the spans as a path of whole-pixel rectangles on `ctx` (after a
 * `beginPath()`), merging rows with identical column ranges into one
 * rectangle.
 */
export function buildSpanPath(ctx: CanvasContext, spans: SpanList): void {
	const n = spans.length;
	const d = spans.data;
	const order = new Array<number>(n);
	for (let i = 0; i < n; i++) {
		order[i] = i * 3;
	}
	// Group by column range, then by row, so vertical runs are adjacent.
	order.sort((a, b) => d[a + 1] - d[b + 1] || d[a + 2] - d[b + 2] || d[a] - d[b]);
	ctx.beginPath();
	let i = 0;
	while (i < n) {
		const o = order[i];
		const x0 = d[o + 1];
		const x1 = d[o + 2];
		const y0 = d[o];
		let y1 = y0 + 1;
		let j = i + 1;
		while (j < n) {
			const q = order[j];
			if (d[q + 1] !== x0 || d[q + 2] !== x1 || d[q] > y1) {
				break;
			}
			if (d[q] === y1) {
				y1++;
			}
			j++;
		}
		ctx.rect(x0, y0, x1 - x0, y1 - y0);
		i = j;
	}
}

/** Fills the span rectangles with one CSS colour, at identity, source-over (or `gco`). */
function fillSpanRects(ctx: CanvasContext, spans: SpanList, color: string, gco: GlobalCompositeOperation = 'source-over'): void {
	ctx.save();
	try {
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = gco;
		ctx.fillStyle = color;
		buildSpanPath(ctx, spans);
		ctx.fill('nonzero');
	} finally {
		ctx.restore();
	}
}

/**
 * {@link paintSpans} through the replay's deferred pixel layer
 * (`emf-gdi-raster-layer.ts`) when there is one and the ROP2 mode does not
 * read the destination: the pixels are written into the layer; otherwise the
 * layer is flushed first (so the destination is current) and the spans are
 * painted directly.
 */
export function paintSpansDeferred(
	rCtx: EmfGdiReplayCtx,
	spans: SpanList,
	paint: RasterPaint,
	rop2: number,
): void {
	if (spans.length === 0) {
		return;
	}
	const index = rop2Rop3Index(rop2) ?? 0xf0;
	if (index === 0xaa) {
		return;
	}
	const layer = usesDest(index) ? null : rasterLayerOf(rCtx);
	if (!layer) {
		flushRasterLayer(rCtx);
		paintSpans(rCtx.ctx, spans, paint, rop2);
		return;
	}
	const { w, h, data } = layer;
	const d = spans.data;
	const solid = paint.kind === 'solid' ? evalRop3(index, paint.rgb, 0, 0) : 0;
	for (let s = 0; s < spans.length * 3; s += 3) {
		const y = d[s];
		if (y < 0 || y >= h) {
			continue;
		}
		const sx0 = Math.max(0, d[s + 1]);
		const sx1 = Math.min(w, d[s + 2]);
		if (sx1 <= sx0) {
			continue;
		}
		if (sx0 < layer.x0) layer.x0 = sx0;
		if (sx1 > layer.x1) layer.x1 = sx1;
		if (y < layer.y0) layer.y0 = y;
		if (y + 1 > layer.y1) layer.y1 = y + 1;
		let i = (y * w + sx0) * 4;
		for (let x = sx0; x < sx1; x++, i += 4) {
			let c = solid;
			if (paint.kind === 'tile') {
				const [dx, dy] = paint.toDevice(x, y);
				c = evalRop3(index, sampleTile(paint.tile, dx, dy, paint.orgX, paint.orgY), 0, 0);
			}
			data[i] = (c >> 16) & 0xff;
			data[i + 1] = (c >> 8) & 0xff;
			data[i + 2] = c & 0xff;
			data[i + 3] = 255;
		}
	}
}

/**
 * Paints `spans` with `paint` under `SetROP2` mode `rop2` (1..16; anything
 * else is treated as `R2_COPYPEN`). Pixels outside the canvas are skipped;
 * the active clip applies. A pixel listed twice (a self-intersecting
 * stroke) is combined twice, as in GDI.
 */
export function paintSpans(ctx: CanvasContext, spans: SpanList, paint: RasterPaint, rop2: number): void {
	if (spans.length === 0) {
		return;
	}
	const index = rop2Rop3Index(rop2) ?? 0xf0;
	if (index === 0xaa) {
		return; // R2_NOP
	}
	const needD = usesDest(index);
	if (paint.kind === 'solid' && !needD) {
		fillSpanRects(ctx, spans, hex(evalRop3(index, paint.rgb, 0, 0)));
		return;
	}
	if (!canReadBack(ctx) || (paint.kind === 'tile' && isSvgContext(ctx) && index === 0xf0)) {
		if (paint.kind === 'tile' && isSvgContext(ctx) && index === 0xf0) {
			// Unfiltered native SVG pattern on the exact pixel geometry.
			const { tile, orgX, orgY } = paint;
			const rgba = new Uint8ClampedArray(tile.width * tile.height * 4);
			for (let i = 0; i < tile.rgb.length; i++) {
				rgba[i * 4] = (tile.rgb[i] >>> 16) & 0xff;
				rgba[i * 4 + 1] = (tile.rgb[i] >>> 8) & 0xff;
				rgba[i * 4 + 2] = tile.rgb[i] & 0xff;
				rgba[i * 4 + 3] = 255;
			}
			const [ox, oy] = paint.toDevice(0, 0);
			ctx.save();
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			buildSpanPath(ctx, spans);
			ctx.fillWithTile({ width: tile.width, height: tile.height, rgba }, orgX - ox, orgY - oy, 1, 1, 'nonzero');
			ctx.restore();
			return;
		}
		// No destination to read: the blend-mode approximation.
		const rgb = paint.kind === 'solid' ? paint.rgb : paint.tile.rgb[0];
		const rp = rop2Paint(rop2);
		fillSpanRects(ctx, spans, rop2TransformColor(hex(rgb), rp.colorTransform), rp.gco);
		return;
	}
	const b = spans.bounds();
	const size = surfaceSize(ctx);
	if (!b) {
		return;
	}
	const x0 = Math.max(0, b.x0);
	const y0 = Math.max(0, b.y0);
	const x1 = size ? Math.min(size.w, b.x1) : b.x1;
	const y1 = size ? Math.min(size.h, b.y1) : b.y1;
	if (x1 <= x0 || y1 <= y0) {
		return;
	}
	const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
	const scratch = acquireScratch(box.w, box.h);
	if (!scratch) {
		return;
	}
	const dest = canvasGetImageData(ctx, box.x, box.y, box.w, box.h).data;
	const overlay = canvasGetImageData(scratch.ctx, 0, 0, box.w, box.h);
	const od = overlay.data;
	const d = spans.data;
	for (let s = 0; s < spans.length * 3; s += 3) {
		const y = d[s];
		if (y < y0 || y >= y1) {
			continue;
		}
		const sx0 = Math.max(x0, d[s + 1]);
		const sx1 = Math.min(x1, d[s + 2]);
		for (let x = sx0; x < sx1; x++) {
			const i = ((y - y0) * box.w + (x - x0)) * 4;
			let p: number;
			if (paint.kind === 'solid') {
				p = paint.rgb;
			} else {
				const [dx, dy] = paint.toDevice(x, y);
				p = sampleTile(paint.tile, dx, dy, paint.orgX, paint.orgY);
			}
			let c = p;
			if (needD) {
				// A pixel painted earlier in this call is the destination now.
				const dv =
					od[i + 3] === 255
						? (od[i] << 16) | (od[i + 1] << 8) | od[i + 2]
						: (dest[i] << 16) | (dest[i + 1] << 8) | dest[i + 2];
				c = evalRop3(index, p, dv, dv);
			} else {
				c = evalRop3(index, p, 0, 0);
			}
			od[i] = (c >> 16) & 0xff;
			od[i + 1] = (c >> 8) & 0xff;
			od[i + 2] = c & 0xff;
			od[i + 3] = 255;
		}
	}
	compositeOverlay(ctx, box, scratch, overlay);
}
