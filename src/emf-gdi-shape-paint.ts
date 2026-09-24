/**
 * Fill/stroke dispatch for immediate (non-path-bracketed) GDI shape drawing:
 * picks an exact per-pixel technique when the active brush pattern or
 * `SetROP2` mode needs one, otherwise the existing fast/approximate path
 * (`applyBrush`/`applyPen` + `ctx.fill()`/`ctx.stroke()`).
 *
 * A hatch/monochrome/DIB pattern brush ({@link fillCurrentPathWithGdiPattern})
 * fills the CURRENT path pixel-by-pixel via `ctx.isPointInPath` and the same
 * `sampleTile` sampler the exact ROP3 blit evaluator uses. This exists
 * because a `CanvasPattern` was tried first and rejected: every tested
 * canvas backend (this package's browser, worker, and `@napi-rs/canvas`
 * targets included) samples a `CanvasPattern` with some filter regardless of
 * `imageSmoothingEnabled` (which only ever affects `drawImage`), smearing a
 * hard-edged pattern tile's texels across several device pixels even at an
 * identity (1:1) pattern transform, confirmed against real GDI fixtures
 * (`pattern-fill-*` in `src/__fixtures__/gdi`). Reading back and rewriting
 * every canvas pixel is not cheap, but it is only paid for the (relatively
 * rare) combination of a pattern brush and an actual shape fill; the far
 * more common ROP3 blit path (`emf-gdi-draw-bitmap.ts`) already worked
 * per-pixel and is untouched.
 *
 * The exact bitwise ROP2 combine (`emf-rop2-exact.ts`) is applied when the
 * active mode needs it and the brush is a plain colour; a pattern brush
 * combined with a bitwise ROP2 mode is not implemented and keeps the
 * approximate colour path (a documented residual, see the README).
 *
 * `buildPath` is a closure issuing the shape's `beginPath()` + geometry
 * calls on whichever context it is given; the CALLER must already have run
 * it once on `rCtx.ctx` before calling `fillShapeExactOrFast`/
 * `strokeShapeExactOrFast` (so the fast path's `fill()`/pattern fill has a
 * path to act on, and a caller that also strokes the same shape does not pay
 * for building the path twice, which for `EMR_PIE`/`EMR_CHORD` would call
 * `closePath()`/`moveTo()` an extra time). `buildPath` itself is only
 * re-invoked here for the exact-ROP2 case, which replays it on an isolated
 * scratch canvas.
 *
 * @module emf-gdi-shape-paint
 */

import { applyBrush, applyPen, canvasGetImageData, canvasPutImageData, rop2Paint } from './emf-canvas-helpers';
import { realizeBrush, sampleTile } from './emf-gdi-brush-pattern';
import { isExactRop2Bitwise, paintWithExactRop2 } from './emf-rop2-exact';
import type { CanvasContext, DrawState, EmfGdiReplayCtx } from './emf-types';

/** The canvas dimensions behind `ctx`, or `null` when unavailable (e.g. a minimal test stub). */
function surfaceSize(ctx: CanvasContext): { w: number; h: number } | null {
	const canvas = (ctx as { canvas?: { width?: unknown; height?: unknown } }).canvas;
	const w = canvas?.width;
	const h = canvas?.height;
	return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 ? { w, h } : null;
}

/**
 * Fills `rCtx.ctx`'s CURRENT path (as left by a preceding `buildPath(ctx)`
 * call, or several `MoveTo`/`LineTo`/`Poly*To` records inside a `BeginPath`/
 * `EndPath` bracket) with a hatch/monochrome/DIB pattern brush, exactly, one
 * device pixel at a time. Returns `false` (having drawn nothing) when the
 * canvas backend lacks the pixel-readback/`isPointInPath` support this
 * needs; the caller falls back to `applyBrush`'s flat-colour approximation.
 */
export function fillCurrentPathWithGdiPattern(rCtx: EmfGdiReplayCtx, fillRule: CanvasFillRule): boolean {
	const { ctx, bounds, state } = rCtx;
	const realized = realizeBrush(state);
	if (realized.kind !== 'tile') {
		return false;
	}
	const size = surfaceSize(ctx);
	if (!size || typeof ctx.isPointInPath !== 'function') {
		return false;
	}
	const sx = rCtx.sx || 1;
	const sy = rCtx.sy || 1;
	try {
		const img = canvasGetImageData(ctx, 0, 0, size.w, size.h);
		const d = img.data;
		for (let y = 0; y < size.h; y++) {
			for (let x = 0; x < size.w; x++) {
				if (!ctx.isPointInPath(x + 0.5, y + 0.5, fillRule)) {
					continue;
				}
				const lx = Math.floor(bounds.left + (x + 0.5) / sx);
				const ly = Math.floor(bounds.top + (y + 0.5) / sy);
				const c = sampleTile(realized, lx, ly, state.brushOrgX, state.brushOrgY);
				const o = (y * size.w + x) * 4;
				d[o] = (c >>> 16) & 0xff;
				d[o + 1] = (c >>> 8) & 0xff;
				d[o + 2] = c & 0xff;
				d[o + 3] = 255;
			}
		}
		canvasPutImageData(ctx, img, 0, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Fills the shape using the current brush; see the module doc for the
 * exact-pattern and exact-ROP2 dispatch this performs.
 */
export function fillShapeExactOrFast(
	rCtx: EmfGdiReplayCtx,
	buildPath: (target: CanvasContext) => void,
	fillRule: CanvasFillRule = 'nonzero',
): void {
	const { ctx, state } = rCtx;
	if (state.brushStyle === 1) {
		return; // Hollow brush: nothing to fill.
	}
	if (realizeBrush(state).kind === 'tile') {
		if (fillCurrentPathWithGdiPattern(rCtx, fillRule)) {
			return;
		}
	} else {
		const paint = rop2Paint(state.rop2);
		if (!paint.exact && isExactRop2Bitwise(state.rop2)) {
			const handled = paintWithExactRop2(ctx, state.rop2, state.brushColor, (scratch) => {
				buildPath(scratch);
				scratch.fill(fillRule);
			});
			if (handled) {
				return;
			}
		}
	}
	applyBrush(ctx, state);
	ctx.fill(fillRule);
}

/** Applies pen geometry (width, dash pattern) without the ROP2 colour/composite transform. */
function applyPenGeometry(ctx: CanvasContext, state: DrawState): void {
	ctx.lineWidth = Math.max(state.penWidth, 1);
	switch (state.penStyle) {
		case 1:
			ctx.setLineDash([8, 4]);
			break;
		case 2:
			ctx.setLineDash([2, 2]);
			break;
		case 3:
			ctx.setLineDash([8, 4, 2, 4]);
			break;
		case 4:
			ctx.setLineDash([8, 4, 2, 4, 2, 4]);
			break;
		default:
			ctx.setLineDash([]);
			break;
	}
}

/**
 * Strokes the shape using the current pen. As with {@link fillShapeExactOrFast},
 * the CALLER must already have run `buildPath` once on `rCtx.ctx`; it is only
 * re-invoked here for the exact-ROP2 scratch-canvas replay. Uses the exact
 * bitwise ROP2 combine when the active mode needs it (a null pen, style 5,
 * never draws anything so is left to the fast path, which already no-ops it
 * correctly); otherwise uses the existing `applyPen` + `stroke()` path
 * unchanged.
 */
export function strokeShapeExactOrFast(rCtx: EmfGdiReplayCtx, buildPath: (target: CanvasContext) => void): void {
	const { ctx, state } = rCtx;
	const paint = rop2Paint(state.rop2);
	if (!paint.exact && isExactRop2Bitwise(state.rop2) && state.penStyle !== 5) {
		const handled = paintWithExactRop2(ctx, state.rop2, state.penColor, (scratch) => {
			applyPenGeometry(scratch, state);
			buildPath(scratch);
			scratch.stroke();
		});
		if (handled) {
			return;
		}
	}
	applyPen(ctx, state);
	ctx.stroke();
}
