/**
 * Fill/stroke dispatch for GDI shape and path drawing: picks an exact
 * per-pixel technique when the active brush pattern, `SetROP2` mode, or the
 * `gdiAntialias: false` option needs one, otherwise the fast path
 * (`applyBrush`/`applyPen` + `ctx.fill()`/`ctx.stroke()`).
 *
 * GDI's pixel grid. GDI names a pixel by its centre: device coordinate `x`
 * IS pixel column `x`, and every box an EMF records (`EMR_RECTANGLE`,
 * `EMR_ELLIPSE`, `EMR_ROUNDRECT`, ...) is already inclusive-inclusive in
 * device terms (the recorder has applied `GM_COMPATIBLE`'s right/bottom
 * exclusion before writing it; confirmed against the `pattern-fill-*`
 * fixtures, whose `Rectangle(20, 20, 140, 100)` is recorded as
 * `20, 20, 139, 99`). Canvas instead puts pixel column `x` between
 * coordinates `x` and `x + 1`. So:
 *   - a stroke of odd pixel width (a 1px cosmetic pen above all) is shifted
 *     by half a pixel ({@link gdiStrokeAlign}), so its centre line passes
 *     through pixel centres and paints the whole pixels GDI paints, instead
 *     of two half-intensity columns straddling a pixel boundary;
 *   - a fill sampled per pixel is sampled at GDI's pixel centres
 *     ({@link GDI_FILL_SHIFT}): just under half a pixel of shift, so a pixel
 *     whose centre lies exactly on a left/top edge is inside and one on a
 *     right/bottom edge is outside, GDI's top-left fill convention. An
 *     antialiased fill keeps the unshifted geometry for an axis-aligned
 *     shape (whose integer edges it already covers crisply) and takes the
 *     shift only under a rotated/skewed world transform.
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
 * (`pattern-fill-*` in `src/__fixtures__/gdi`). Only the shape's own
 * bounding box is read back and rewritten, and the result goes through
 * `drawImage` so the active clip applies (`rewritePixels`,
 * `emf-rop2-exact.ts`). Because the fill already runs per pixel, the active
 * `SetROP2` mode is applied to it exactly too, every one of the sixteen
 * (`rop2Rop3Index`): pattern colour P, destination D, `evalRop3`.
 *
 * With a plain-colour brush or a pen, the per-pixel `paintWithRop2PerPixel`
 * is used when the active mode is one of the bitwise modes Canvas cannot
 * composite exactly, or for every shape when `rCtx.gdiAntialias` is `false`;
 * either way coverage is binary, as in GDI.
 *
 * `buildPath` is a closure issuing the shape's `beginPath()` + geometry
 * calls on whichever context it is given; the CALLER must already have run
 * it once on `rCtx.ctx` before calling `fillShapeExactOrFast`/
 * `strokeShapeExactOrFast` (so the fast path's `fill()`/pattern fill has a
 * path to act on, and a caller that also strokes the same shape does not pay
 * for building the path twice, which for `EMR_PIE`/`EMR_CHORD` would call
 * `closePath()`/`moveTo()` an extra time); `fillShapeExactOrFast` leaves
 * that same path current on `rCtx.ctx` when it returns, so a stroke can
 * follow it. `buildPath` itself is re-invoked
 * here to measure the shape's bounding box, to replay it on an isolated
 * scratch canvas for the per-pixel cases, and to rebuild the pixel-aligned
 * geometry.
 *
 * @module emf-gdi-shape-paint
 */

import { applyBrush, applyPen, rop2Paint } from './emf-canvas-helpers';
import { realizeBrush, sampleTile } from './emf-gdi-brush-pattern';
import { hasWorldRotation } from './emf-gdi-coord';
import {
	isExactRop2Bitwise,
	measurePathBox,
	paintWithRop2PerPixel,
	rewritePixels,
	rop2Rop3Index,
	rop2TransformPacked,
	surfaceSize,
} from './emf-rop2-exact';
import { evalRop3 } from './emf-rop3';
import type { CanvasContext, DrawState, EmfGdiReplayCtx } from './emf-types';
import { isSvgContext } from './svg-context';

/**
 * Canvas-pixel shift that samples a fill at GDI's pixel centres with GDI's
 * top-left rule: half a pixel less 1/32 (half of GDI's 1/16-pixel 28.4
 * fixed-point step), so an edge lying exactly on a pixel centre falls just
 * right/below of it after the shift. A left/top edge then includes that
 * pixel, a right/bottom edge excludes it.
 */
export const GDI_FILL_SHIFT = 0.5 - 1 / 32;

/** Wraps `build` so it issues its geometry translated by (`d`, `d`). */
function shifted(build: (target: CanvasContext) => void, d: number): (target: CanvasContext) => void {
	if (d === 0) {
		return build;
	}
	return (c: CanvasContext) => {
		c.save();
		c.translate(d, d);
		build(c);
		c.restore();
	};
}

/** True when `gdiAntialias: false` asks for GDI's own non-antialiased rasterisation. */
function isAliased(rCtx: EmfGdiReplayCtx): boolean {
	return rCtx.gdiAntialias === false;
}

/**
 * Fills `rCtx.ctx`'s CURRENT path (as left by a preceding `buildPath(ctx)`
 * call, or several `MoveTo`/`LineTo`/`Poly*To` records inside a `BeginPath`/
 * `EndPath` bracket) with a hatch/monochrome/DIB pattern brush, exactly, one
 * device pixel at a time: a pixel is inside when GDI's centre for it is
 * ({@link GDI_FILL_SHIFT}; GDI does not antialias), its pattern colour P
 * comes from `sampleTile`, and the active `SetROP2` mode combines P with the
 * destination D exactly (`R2_COPYPEN` just writes P, `R2_NOP` leaves D).
 * `buildPath`, when given, rebuilds the same path and is used only to limit
 * the work to its bounding box; without it the whole surface is scanned.
 * Returns `false` (having drawn nothing) when the canvas backend lacks the
 * pixel-readback/`isPointInPath` support this needs; the caller falls back
 * to `applyBrush`'s flat-colour approximation.
 */
export function fillCurrentPathWithGdiPattern(
	rCtx: EmfGdiReplayCtx,
	fillRule: CanvasFillRule,
	buildPath?: (target: CanvasContext) => void,
): boolean {
	const { ctx, bounds, state } = rCtx;
	const realized = realizeBrush(state);
	if (realized.kind !== 'tile') {
		return false;
	}
	const sx = rCtx.sx || 1;
	const sy = rCtx.sy || 1;
	const index = rop2Rop3Index(state.rop2) ?? 0xf0;
	if (isSvgContext(ctx) && (index === 0xf0 || !ctx.canReadPixels)) {
		// SVG renders an unfiltered <pattern> natively (the CanvasPattern
		// smearing this module works around does not apply), so a plain
		// R2_COPYPEN brush stays a resolution-independent tile instead of a
		// pixel dump. Other ROP2 modes need the destination, so they take the
		// per-pixel path below whenever the SVG context can read it back.
		const rgba = new Uint8ClampedArray(realized.width * realized.height * 4);
		for (let i = 0; i < realized.rgb.length; i++) {
			const c = realized.rgb[i];
			rgba[i * 4] = (c >>> 16) & 0xff;
			rgba[i * 4 + 1] = (c >>> 8) & 0xff;
			rgba[i * 4 + 2] = c & 0xff;
			rgba[i * 4 + 3] = 255;
		}
		ctx.fillWithTile(
			{ width: realized.width, height: realized.height, rgba },
			(state.brushOrgX - bounds.left) * sx,
			(state.brushOrgY - bounds.top) * sy,
			sx,
			sy,
			fillRule,
		);
		return true;
	}
	const size = surfaceSize(ctx);
	if (!size || typeof ctx.isPointInPath !== 'function') {
		return false;
	}
	if (index === 0xaa) {
		return true; // R2_NOP: the destination is left as it is.
	}
	const box = buildPath ? measurePathBox(buildPath, 1, size) : { x: 0, y: 0, w: size.w, h: size.h };
	if (!box) {
		return true; // Nothing inside the surface to fill.
	}
	// Sampling the unshifted path at (x + 0.5 - shift) is the same test as
	// sampling the path shifted by GDI_FILL_SHIFT at the canvas pixel centre.
	const probe = 0.5 - GDI_FILL_SHIFT;
	const patternAt = (x: number, y: number): number =>
		sampleTile(
			realized,
			Math.floor(bounds.left + (x + 0.5) / sx),
			Math.floor(bounds.top + (y + 0.5) / sy),
			state.brushOrgX,
			state.brushOrgY,
		);
	// Blend-mode stand-in for pixels under text an SVG raster mirror cannot know.
	const approx = rop2Paint(state.rop2);
	return rewritePixels(
		ctx,
		box,
		(x, y, d) => {
			if (!ctx.isPointInPath(x + probe, y + probe, fillRule)) {
				return -1;
			}
			const p = patternAt(x, y);
			return index === 0xf0 ? p : evalRop3(index, p, d, d);
		},
		(x, y) => ({ color: rop2TransformPacked(patternAt(x, y), approx.colorTransform), mode: approx.gco }),
	);
}

/**
 * Fills the shape using the current brush; see the module doc for the
 * exact-pattern, per-pixel ROP2/aliased, and pixel-grid handling this
 * performs. `fillPath`, when given, is the geometry GDI actually fills when
 * it differs from the outline `buildPath` describes (a pen-bordered
 * Rectangle's interior, see `emf-gdi-draw-shapes.ts`); `buildPath` is still
 * left as the current path on return.
 */
export function fillShapeExactOrFast(
	rCtx: EmfGdiReplayCtx,
	buildPath: (target: CanvasContext) => void,
	fillRule: CanvasFillRule = 'nonzero',
	fillPath?: (target: CanvasContext) => void,
): void {
	const { ctx, state } = rCtx;
	if (state.brushStyle === 1) {
		return; // Hollow brush: nothing to fill.
	}
	const geometry = fillPath ?? buildPath;
	if (realizeBrush(state).kind === 'tile') {
		if (fillPath) {
			fillPath(ctx);
		}
		const done = fillCurrentPathWithGdiPattern(rCtx, fillRule, geometry);
		if (fillPath) {
			buildPath(ctx);
		}
		if (done) {
			return;
		}
	} else {
		const paint = rop2Paint(state.rop2);
		if (isAliased(rCtx) || (!paint.exact && isExactRop2Bitwise(state.rop2))) {
			const handled = paintWithRop2PerPixel(
				ctx,
				state.rop2,
				state.brushColor,
				(scratch) => {
					shifted(geometry, GDI_FILL_SHIFT)(scratch);
					scratch.fill(fillRule);
				},
				1,
				fillRule,
			);
			if (handled) {
				return;
			}
		}
	}
	const shift = hasWorldRotation(rCtx) ? GDI_FILL_SHIFT : 0;
	const rebuild = shift !== 0 || fillPath !== undefined;
	if (rebuild) {
		shifted(geometry, shift)(ctx);
	}
	applyBrush(ctx, state);
	ctx.fill(fillRule);
	if (rebuild) {
		buildPath(ctx);
	}
}

/** The pen's stroke width in canvas pixels, as `applyPen` sets it. */
export function penLineWidth(state: DrawState): number {
	return Math.max(state.penWidth, 1);
}

/**
 * The canvas-pixel offset that puts a stroke of the current pen on GDI's
 * pixel grid: `0.5` for an odd integer line width (a 1px cosmetic pen above
 * all), whose centre line must pass through pixel centres to cover whole
 * pixels, and `0` otherwise (an even width already covers whole pixels when
 * centred on a pixel boundary, and a fractional width cannot be aligned).
 * A null pen (`PS_NULL`) draws nothing, so needs no alignment.
 */
export function gdiStrokeAlign(state: DrawState): number {
	if (state.penStyle === 5) {
		return 0;
	}
	const w = penLineWidth(state);
	return Number.isInteger(w) && w % 2 === 1 ? 0.5 : 0;
}

/** Applies pen geometry (width, dash pattern) without the ROP2 colour/composite transform. */
function applyPenGeometry(ctx: CanvasContext, state: DrawState): void {
	ctx.lineWidth = penLineWidth(state);
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
 * the CALLER must already have run `buildPath` once on `rCtx.ctx`.
 *
 * When the pen can be aligned to GDI's pixel grid ({@link gdiStrokeAlign}),
 * the stroke geometry is rebuilt shifted by that half-pixel offset. The
 * per-pixel `paintWithRop2PerPixel` is used when the active mode is a
 * bitwise one Canvas cannot composite, or for every stroke under
 * `gdiAntialias: false` (a null pen, style 5, never draws anything so is
 * left to the fast path, which already no-ops it correctly); otherwise
 * `applyPen` + `stroke()`.
 */
export function strokeShapeExactOrFast(rCtx: EmfGdiReplayCtx, buildPath: (target: CanvasContext) => void): void {
	const { ctx, state } = rCtx;
	const align = gdiStrokeAlign(state);
	const aligned = shifted(buildPath, align);
	const paint = rop2Paint(state.rop2);
	if (state.penStyle !== 5 && (isAliased(rCtx) || (!paint.exact && isExactRop2Bitwise(state.rop2)))) {
		const handled = paintWithRop2PerPixel(
			ctx,
			state.rop2,
			state.penColor,
			(scratch) => {
				applyPenGeometry(scratch, state);
				aligned(scratch);
				scratch.stroke();
			},
			penLineWidth(state) / 2 + 2,
		);
		if (handled) {
			return;
		}
	}
	if (align !== 0) {
		aligned(ctx);
	}
	applyPen(ctx, state);
	ctx.stroke();
}
