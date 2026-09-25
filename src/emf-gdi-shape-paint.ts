/**
 * Fill/stroke dispatch for GDI shape and path drawing. {@link paintGdiShape}
 * is the entry point: it sends a fill or stroke to the GDI rasteriser
 * (`gdi-raster.ts`, exact GDI geometry and coverage) when the active brush
 * pattern, a bitwise `SetROP2` mode, or the `gdiAntialias: false` option
 * needs one, and otherwise to the antialiased Canvas path
 * (`applyBrush`/`applyPen` + `ctx.fill()`/`ctx.stroke()`) with GDI's pen
 * geometry ({@link applyGdiPenGeometry}, {@link strokeStyledCosmetic}). The
 * older per-pixel helpers below (`fillCurrentPathWithGdiPattern`,
 * `paintWithRop2PerPixel` inside `fillShapeExactOrFast`/
 * `strokeShapeExactOrFast`) remain as fallbacks for geometry the rasteriser
 * is not handed (a canvas-only caller).
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

import { applyBrush, applyPen, rop2Paint, rop2TransformColor } from './emf-canvas-helpers';
import { hatchBit, realizeBrush, sampleTile } from './emf-gdi-brush-pattern';
import { gdiDeviceMatrix, hasWorldRotation } from './emf-gdi-coord';
import { paintSpansDeferred } from './emf-gdi-raster-paint';
import { flushRasterLayer } from './emf-gdi-raster-layer';
import { brushPaint, paintRasterPath, penIsCosmetic, penIsWidened } from './emf-gdi-raster-shapes';
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
import {
	cosmeticLine,
	cosmeticStyle,
	fillPathSpans,
	geometricStyle,
	SpanList,
	strokeCosmetic,
	styleGapsUseBackground,
	type GdiRasterPath,
	type StyleState,
} from './gdi-raster';
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
	// A hatch under the TRANSPARENT background mode paints only its lines.
	const hatch = state.bkMode === 1 && state.brushPattern?.kind === 'hatch' ? state.brushPattern.hatch : -1;
	const hatchGap = (dx: number, dy: number): boolean =>
		hatch >= 0 && !hatchBit(hatch, ((dx - state.brushOrgX) % 8 + 8) % 8, ((dy - state.brushOrgY) % 8 + 8) % 8);
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
			rgba[i * 4 + 3] = hatch >= 0 && !hatchBit(hatch, i % 8, Math.floor(i / 8)) ? 0 : 255;
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
			if (hatch >= 0 && hatchGap(Math.floor(bounds.left + (x + 0.5) / sx), Math.floor(bounds.top + (y + 0.5) / sy))) {
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


/** `PS_NULL`. */
const PS_NULL = 5;

/**
 * The pen's stroke width in canvas pixels: its logical width scaled by the
 * logical-to-device transform (`scale`, 1 when omitted), at least one pixel
 * (a zero-width or sub-pixel pen is GDI's one-pixel cosmetic pen).
 */
export function penLineWidth(state: DrawState, scale = 1): number {
	return Math.max(state.penWidth * scale, 1);
}

/** The logical-to-device scale a pen width goes through (the transform's area scale). */
export function penScale(rCtx: EmfGdiReplayCtx): number {
	const m = gdiDeviceMatrix(rCtx);
	return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
}

/**
 * The canvas-pixel offset that puts a stroke of the current pen on GDI's
 * pixel grid: `0.5` for an odd integer line width (a 1px cosmetic pen above
 * all), whose centre line must pass through pixel centres to cover whole
 * pixels, and `0` otherwise (an even width already covers whole pixels when
 * centred on a pixel boundary, and a fractional width cannot be aligned).
 * A null pen (`PS_NULL`) draws nothing, so needs no alignment.
 */
export function gdiStrokeAlign(state: DrawState, scale = 1): number {
	if (state.penStyle === PS_NULL) {
		return 0;
	}
	const w = penLineWidth(state, scale);
	return Number.isInteger(w) && w % 2 === 1 ? 0.5 : 0;
}

/**
 * Sets `ctx`'s line width, caps, joins, miter limit and dash pattern to what
 * GDI draws with the current pen (colour and ROP2 excluded):
 *   - width: the logical width through the transform, at least one pixel;
 *   - caps/joins: a wide `CreatePen` pen is round/round; an `ExtCreatePen`
 *     geometric pen carries `PS_ENDCAP_*` (round, square, flat) and
 *     `PS_JOIN_*` (round, bevel, miter) plus the DC's miter limit;
 *   - dashes: GDI's own patterns, measured against real output (see
 *     `cosmeticStyle`/`geometricStyle`, `gdi-raster.ts`); a styled
 *     `CreatePen` pen wider than one pixel draws solid, as GDI does. A
 *     styled cosmetic pen is not dashed here: its pattern steps per pixel
 *     along the major axis, which {@link strokeStyledCosmetic} emulates.
 */
export function applyGdiPenGeometry(ctx: CanvasContext, rCtx: EmfGdiReplayCtx): void {
	const { state } = rCtx;
	const scale = penScale(rCtx);
	const width = penLineWidth(state, scale);
	const flags = state.penFlags ?? state.penStyle;
	ctx.lineWidth = width;
	const cosmetic = penIsCosmetic(rCtx);
	if (!cosmetic && state.penExtended) {
		const cap = flags & 0xf00;
		const join = flags & 0xf000;
		ctx.lineCap = cap === 0x100 ? 'square' : cap === 0x200 ? 'butt' : 'round';
		ctx.lineJoin = join === 0x1000 ? 'bevel' : join === 0x2000 ? 'miter' : 'round';
		ctx.miterLimit = state.miterLimit ?? 10;
		ctx.setLineDash(geometricStyle(flags, width, state.penUserStyle, scale) ?? []);
	} else if (!cosmetic) {
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.setLineDash([]);
	} else {
		ctx.lineWidth = 1;
		ctx.lineCap = 'butt';
		ctx.lineJoin = 'miter';
		ctx.miterLimit = 10;
		ctx.setLineDash([]);
	}
}

/** The current pen's cosmetic dash pattern, or `null` (solid, wide, or null pen). */
function cosmeticPattern(rCtx: EmfGdiReplayCtx): number[] | null {
	const { state } = rCtx;
	if (state.penStyle === PS_NULL || !penIsCosmetic(rCtx)) {
		return null;
	}
	return cosmeticStyle(state.penFlags ?? state.penStyle, state.penUserStyle);
}

/**
 * Strokes a styled cosmetic pen along GDI's own (flattened) geometry with
 * Canvas antialiasing, reproducing GDI's dash placement: GDI steps its
 * pattern once per lit pixel, i.e. per pixel along each segment's major
 * axis, so each segment is stroked on its own with the pattern stretched by
 * that segment's length per pixel, and the pattern position carries from
 * segment to segment (and, through `style`, across consecutive `LineTo`
 * records). With `OPAQUE` background mode the gaps are painted in the
 * background colour, as GDI does for the stock styles.
 */
export function strokeStyledCosmetic(
	rCtx: EmfGdiReplayCtx,
	path: GdiRasterPath,
	pattern: number[],
	style: StyleState,
): void {
	const { ctx, state } = rCtx;
	const flags = state.penFlags ?? state.penStyle;
	const period = pattern.reduce((a, b) => a + b, 0);
	const paint = rop2Paint(state.rop2);
	const bk = state.bkMode === 2 && styleGapsUseBackground(flags);
	const segs: Array<[number, number, number, number, number, number]> = [];
	path.figures.forEach((f, fi) => {
		if (fi > 0) {
			style.pos = 0;
		}
		const p = f.closed ? [...f.pts, f.pts[0], f.pts[1]] : f.pts;
		for (let i = 0; i + 3 < p.length; i += 2) {
			let n = 0;
			cosmeticLine(p[i], p[i + 1], p[i + 2], p[i + 3], () => {
				n++;
			});
			if (n === 0) {
				continue;
			}
			segs.push([p[i], p[i + 1], p[i + 2], p[i + 3], style.pos, n]);
			style.pos += n;
		}
	});
	const c = (v: number) => v / 16 + 0.5;
	ctx.save();
	try {
		ctx.globalCompositeOperation = paint.gco;
		ctx.lineWidth = 1;
		ctx.lineCap = 'butt';
		for (const pass of bk ? ['bk', 'fg'] : ['fg']) {
			ctx.strokeStyle = rop2TransformColor(pass === 'bk' ? state.bkColor : state.penColor, paint.colorTransform);
			for (const [x0, y0, x1, y1, pos, n] of segs) {
				const f = Math.hypot(x1 - x0, y1 - y0) / 16 / n;
				if (pass === 'fg') {
					ctx.setLineDash(pattern.map((v) => v * f));
					ctx.lineDashOffset = (pos % period) * f;
				} else {
					ctx.setLineDash([]);
				}
				ctx.beginPath();
				ctx.moveTo(c(x0), c(y0));
				ctx.lineTo(c(x1), c(y1));
				ctx.stroke();
			}
		}
	} finally {
		ctx.setLineDash([]);
		ctx.lineDashOffset = 0;
		ctx.restore();
	}
}

/**
 * Strokes the shape using the current pen. As with {@link fillShapeExactOrFast},
 * the CALLER must already have run `buildPath` once on `rCtx.ctx`.
 *
 * When the pen can be aligned to GDI's pixel grid ({@link gdiStrokeAlign}),
 * the stroke geometry is rebuilt shifted by that half-pixel offset. The
 * per-pixel `paintWithRop2PerPixel` is used when the active mode is a
 * bitwise one Canvas cannot composite, or under `gdiAntialias: false` for
 * a wide pen (a one-pixel pen goes through the GDI rasteriser instead, see
 * {@link paintGdiShape}); otherwise the GDI pen geometry
 * ({@link applyGdiPenGeometry}) + `stroke()`.
 */
export function strokeShapeExactOrFast(rCtx: EmfGdiReplayCtx, buildPath: (target: CanvasContext) => void): void {
	const { ctx, state } = rCtx;
	const scale = penScale(rCtx);
	const align = gdiStrokeAlign(state, scale);
	const aligned = shifted(buildPath, align);
	const paint = rop2Paint(state.rop2);
	if (state.penStyle !== PS_NULL && (isAliased(rCtx) || (!paint.exact && isExactRop2Bitwise(state.rop2)))) {
		const handled = paintWithRop2PerPixel(
			ctx,
			state.rop2,
			state.penColor,
			(scratch) => {
				applyGdiPenGeometry(scratch, rCtx);
				aligned(scratch);
				scratch.stroke();
			},
			penLineWidth(state, scale) / 2 + 2,
		);
		if (handled) {
			return;
		}
	}
	if (align !== 0) {
		aligned(ctx);
	}
	applyPen(ctx, state);
	if (state.penStyle !== PS_NULL) {
		applyGdiPenGeometry(ctx, rCtx);
	}
	ctx.stroke();
}

// ---------------------------------------------------------------------------
// Shape orchestration
// ---------------------------------------------------------------------------

/** One GDI shape (or bracketed path) to fill and/or stroke. */
export interface GdiShape {
	/** Issues the shape's Canvas geometry (with its own `beginPath()`), for the antialiased route. */
	build: (target: CanvasContext) => void;
	/** Builds GDI's own device geometry, for the exact route (called at most once). */
	raster: () => GdiRasterPath;
	fill: boolean;
	stroke: boolean;
	fillRule?: CanvasFillRule;
	/**
	 * An axis-aligned Rectangle: GDI fills only the interior inside a
	 * one-pixel pen's border (it never combines a border pixel twice). The
	 * Canvas route fills `interior`; the exact route leaves the outline's
	 * pixels out of the fill.
	 */
	axisRect?: { interior?: (target: CanvasContext) => void };
	/** A `Rectangle` record: a wide pen strokes it as GDI does (see `RasterPaintOptions.rectangle`). */
	rectangle?: boolean;
	/** An `Ellipse`/`RoundRect` record: a wide pen strokes it with round caps and joins whatever its style. */
	roundPen?: boolean;
	/** Dash-pattern position to continue (consecutive `LineTo` records). */
	style?: StyleState;
}

/**
 * Fills and/or strokes one shape the way GDI does.
 *
 * The exact GDI rasteriser (`gdi-raster.ts`, painted by
 * `emf-gdi-raster-paint.ts`) is used for the fill under
 * `gdiAntialias: false`, for a hatch/monochrome/DIB pattern brush, and for a
 * bitwise `SetROP2` mode Canvas cannot composite; and for a one-pixel pen's
 * outline under `gdiAntialias: false` or such a ROP2 mode. Everything else
 * takes Canvas's antialiased `fill()`/`stroke()` on the pixel-aligned
 * geometry, with GDI's pen widths, caps, joins and dash patterns
 * ({@link applyGdiPenGeometry}, {@link strokeStyledCosmetic}); only edge
 * coverage differs from GDI there, by design. A wide pen under
 * `gdiAntialias: false` goes through {@link strokeShapeExactOrFast}'s
 * per-pixel route.
 */
export function paintGdiShape(rCtx: EmfGdiReplayCtx, shape: GdiShape): void {
	const { ctx, state } = rCtx;
	const aliased = isAliased(rCtx);
	const bitwise = !rop2Paint(state.rop2).exact && isExactRop2Bitwise(state.rop2);
	const penNull = state.penStyle === PS_NULL;
	const cosmetic = !penNull && penIsCosmetic(rCtx);
	let rasterPath: GdiRasterPath | null = null;
	const getPath = (): GdiRasterPath => {
		rasterPath ??= shape.raster();
		return rasterPath;
	};
	let canvasBuilt = false;
	const ensureCanvas = () => {
		if (!canvasBuilt) {
			shape.build(ctx);
			canvasBuilt = true;
		}
	};
	const fillRule = shape.fillRule ?? 'nonzero';
	if (shape.fill && state.brushStyle !== 1) {
		const tile = realizeBrush(state).kind === 'tile';
		if (aliased || tile || bitwise) {
			const paint = brushPaint(rCtx);
			if (paint) {
				let spans = fillPathSpans(getPath(), fillRule === 'nonzero');
				if (shape.axisRect && shape.stroke && cosmetic) {
					spans = withoutOutline(spans, getPath());
				}
				paintSpansDeferred(rCtx, spans, paint, state.rop2);
			}
		} else {
			ensureCanvas();
			const interior = shape.axisRect && shape.stroke && !penNull ? shape.axisRect.interior : undefined;
			fillShapeExactOrFast(rCtx, shape.build, fillRule, interior);
		}
	}
	if (!shape.stroke || penNull) {
		return;
	}
	if ((cosmetic || penIsWidened(rCtx)) && (aliased || bitwise)) {
		paintRasterPath(rCtx, getPath(), { fill: false, stroke: true, style: shape.style, rectangle: shape.rectangle, roundPen: shape.roundPen });
		return;
	}
	const pattern = cosmeticPattern(rCtx);
	if (pattern && !aliased && !bitwise) {
		strokeStyledCosmetic(rCtx, getPath(), pattern, shape.style ?? { pos: 0 });
		return;
	}
	// Canvas drawing from here on: pending exact pixels must land first.
	flushRasterLayer(rCtx);
	ensureCanvas();
	strokeShapeExactOrFast(rCtx, shape.build);
}

/** `spans` minus the pixels of `path`'s one-pixel outline. */
function withoutOutline(spans: SpanList, path: GdiRasterPath): SpanList {
	const outline = new SpanList();
	strokeCosmetic(path, outline, null, null);
	const rows = new Map<number, Array<[number, number]>>();
	const od = outline.data;
	for (let i = 0; i < outline.length * 3; i += 3) {
		let r = rows.get(od[i]);
		if (!r) {
			r = [];
			rows.set(od[i], r);
		}
		r.push([od[i + 1], od[i + 2]]);
	}
	const out = new SpanList();
	const d = spans.data;
	for (let i = 0; i < spans.length * 3; i += 3) {
		const y = d[i];
		const cuts = (rows.get(y) ?? []).slice().sort((a, b) => a[0] - b[0]);
		let x = d[i + 1];
		const end = d[i + 2];
		for (const [c0, c1] of cuts) {
			if (c1 <= x || c0 >= end) {
				continue;
			}
			out.add(y, x, Math.min(c0, end));
			x = Math.max(x, c1);
		}
		out.add(y, x, end);
	}
	return out;
}
