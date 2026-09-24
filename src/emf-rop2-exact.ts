/**
 * Exact bitwise emulation of the AND/OR/XOR-family `SetROP2` modes, for
 * immediate (non-path-bracketed) GDI drawing.
 *
 * `rop2Paint` (`emf-canvas-helpers.ts`) can only approximate these ten modes
 * with Canvas's arithmetic composite operators (`darken`/`lighten`/
 * `difference`), because GDI's ROP2 is a true bitwise boolean function of the
 * pen/brush colour (P) and the destination pixel (D), and Canvas has no
 * bitwise compositing. This module makes them exact instead, the same way
 * `emf-rop3.ts` makes ROP3 blits exact: per-pixel, bit-for-bit.
 *
 * The technique: draw the shape once onto a fully transparent scratch canvas
 * with the raw pen/brush colour, source-over. Canvas 2D's own compositing
 * then gives, for free and exactly:
 *   - `coverage` = the resulting alpha channel (source-over onto a fully
 *     transparent destination has `out_alpha = src_alpha`, so this is exact
 *     antialiasing coverage, not an approximation);
 *   - the raw paint colour, unblended (RGB channels are unaffected by a fully
 *     transparent destination contributing nothing).
 * The final pixel is `lerp(D, ropCombine(paint, D), coverage)`, which
 * reproduces GDI's non-antialiased hard edges exactly at full coverage and
 * degrades gracefully (an arithmetic blend, same as the approximated modes)
 * only at Canvas's own antialiased edge pixels, which GDI does not have.
 *
 * Each mode's boolean function of (P, D) is evaluated via `evalRop3`
 * (`emf-rop3.ts`) using a ROP3 truth-table index chosen to be independent of
 * the (unused) S operand: for a combo `(P, D)`, set BOTH the `S = 0` and
 * `S = 1` truth-table bits to that combo's boolean result. `PATCOPY` (P) and
 * `DSTINVERT` (~D) are two well-known ROP3 constants (0xF0, 0x55) built from
 * exactly this construction, which is how the indices below were derived and
 * cross-checked.
 *
 * @module emf-rop2-exact
 */

import { canvasGetImageData, createTempCanvas, canvasPutImageData } from './emf-canvas-helpers';
import {
	R2_MASKPEN,
	R2_MERGEPEN,
	R2_XORPEN,
	R2_NOTXORPEN,
	R2_MASKPENNOT,
	R2_MERGEPENNOT,
	R2_MASKNOTPEN,
	R2_MERGENOTPEN,
	R2_NOTMASKPEN,
	R2_NOTMERGEPEN,
} from './emf-constants';
import { evalRop3 } from './emf-rop3';
import type { CanvasContext } from './emf-types';

/** ROP3-style truth-table index (bits 16..23 convention), S-independent, per bitwise ROP2 mode. */
const ROP2_EXACT_INDEX: Record<number, number> = {
	[R2_MASKPEN]: 0xa0, // P & D
	[R2_MERGEPEN]: 0xfa, // P | D
	[R2_XORPEN]: 0x5a, // P ^ D
	[R2_NOTXORPEN]: 0xa5, // ~(P ^ D)
	[R2_MASKPENNOT]: 0x50, // P & ~D
	[R2_MERGEPENNOT]: 0xf5, // P | ~D
	[R2_MASKNOTPEN]: 0x0a, // ~P & D
	[R2_MERGENOTPEN]: 0xaf, // ~P | D
	[R2_NOTMASKPEN]: 0x5f, // ~(P & D)
	[R2_NOTMERGEPEN]: 0x05, // ~(P | D)
};

/** True when `rop2` is one of the bitwise modes this module emulates exactly. */
export function isExactRop2Bitwise(rop2: number): boolean {
	return rop2 in ROP2_EXACT_INDEX;
}

function packRgb(r: number, g: number, b: number): number {
	return (r << 16) | (g << 8) | b;
}

/** The canvas dimensions behind `ctx`, or `null` when unavailable (e.g. a minimal test stub). */
function surfaceSize(ctx: CanvasContext): { w: number; h: number } | null {
	const canvas = (ctx as { canvas?: { width?: unknown; height?: unknown } }).canvas;
	const w = canvas?.width;
	const h = canvas?.height;
	return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 ? { w, h } : null;
}

/**
 * Paints `draw` onto `ctx` (the whole canvas) combined with the existing
 * destination via the exact bitwise ROP2 function `rop2`. Returns `false`
 * (having drawn nothing) when `rop2` is not one of the bitwise modes, or the
 * canvas backend lacks the pixel-readback support this needs; callers fall
 * back to the approximate `applyPen`/`applyBrush` + `stroke()`/`fill()` path.
 */
export function paintWithExactRop2(
	ctx: CanvasContext,
	rop2: number,
	color: string,
	draw: (scratch: CanvasContext) => void,
): boolean {
	const index = ROP2_EXACT_INDEX[rop2];
	if (index === undefined) {
		return false;
	}
	const size = surfaceSize(ctx);
	if (!size) {
		return false;
	}
	try {
		const temp = createTempCanvas(size.w, size.h);
		if (!temp) {
			return false;
		}
		temp.ctx.fillStyle = color;
		temp.ctx.strokeStyle = color;
		draw(temp.ctx);
		const paint = canvasGetImageData(temp.ctx, 0, 0, size.w, size.h);
		const dest = canvasGetImageData(ctx, 0, 0, size.w, size.h);
		const pd = paint.data;
		const dd = dest.data;
		for (let i = 0; i < dd.length; i += 4) {
			const coverage = pd[i + 3] / 255;
			if (coverage <= 0) {
				continue;
			}
			const p = packRgb(pd[i], pd[i + 1], pd[i + 2]);
			const d = packRgb(dd[i], dd[i + 1], dd[i + 2]);
			const combined = evalRop3(index, p, d, d);
			const cr = (combined >> 16) & 0xff;
			const cg = (combined >> 8) & 0xff;
			const cb = combined & 0xff;
			dd[i] = Math.round(dd[i] + (cr - dd[i]) * coverage);
			dd[i + 1] = Math.round(dd[i + 1] + (cg - dd[i + 1]) * coverage);
			dd[i + 2] = Math.round(dd[i + 2] + (cb - dd[i + 2]) * coverage);
			dd[i + 3] = 255;
		}
		canvasPutImageData(ctx, dest, 0, 0);
		return true;
	} catch {
		return false;
	}
}
