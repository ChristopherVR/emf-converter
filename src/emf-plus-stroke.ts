/**
 * EMF+ pen strokes: GDI+ pen geometry (width, caps, join, miter limit, dash
 * style or custom dash pattern and offset, all in pen widths) mapped onto
 * Canvas stroke state, and strokes whose pen carries a texture, linear- or
 * path-gradient brush painted exactly.
 *
 * A pen's brush used to be reduced to its flat colour. Now a raster stroke
 * with such a brush takes the stroke's coverage from Canvas (one opaque
 * stroke on a scratch canvas) and its colour per device pixel from the very
 * brush sampler a fill uses (`paintBrushThroughMask`,
 * `emf-plus-exact-fill.ts`), so the stroke shows the brush exactly as GDI+
 * paints it, unfiltered. SVG output keeps a vector stroke painted with the
 * brush's paint server (`<linearGradient>`, `<pattern>`).
 *
 * @module emf-plus-stroke
 */

import {
	brushSampler,
	cssColorToArgb,
	deviceBounds,
	isPlusAliased,
	paintBrushThroughMask,
	solidSampler,
} from './emf-plus-exact-fill';
import { applyPlusWorldTransform, brushPaint, plusWorldMatrix } from './emf-plus-state-handlers';
import { isSvgContext } from './svg-context';
import type { CanvasContext, EmfPlusPen, EmfPlusReplayCtx } from './emf-types';

/** GDI+ `DashStyle` patterns (Dash, Dot, DashDot, DashDotDot), in pen widths. */
const DASH_PATTERNS: Record<number, number[]> = {
	1: [3, 1],
	2: [1, 1],
	3: [3, 1, 1, 1],
	4: [3, 1, 1, 1, 1, 1],
};

/** Canvas `lineCap` for a GDI+ `LineCap` (anchor caps approximated by their base shape). */
export function canvasLineCap(cap: number | undefined): CanvasLineCap {
	switch (cap) {
		case 1: // Square
		case 0x11: // SquareAnchor
			return 'square';
		case 2: // Round
		case 0x12: // RoundAnchor
		case 3: // Triangle
		case 0x13: // DiamondAnchor
			return 'round';
		default:
			return 'butt';
	}
}

/** Canvas `lineJoin` for a GDI+ `LineJoin` (Miter, Bevel, Round, MiterClipped). */
export function canvasLineJoin(join: number | undefined): CanvasLineJoin {
	if (join === 1) {
		return 'bevel';
	}
	return join === 2 ? 'round' : 'miter';
}

/**
 * The Canvas dash array for a pen, in world units (GDI+ dash lengths are in
 * pen widths), or `[]` for a solid pen.
 */
export function penDashArray(pen: EmfPlusPen): number[] {
	const w = pen.width || 1;
	const pattern = pen.dashStyle === 5 ? pen.dashPattern : DASH_PATTERNS[pen.dashStyle];
	if (!pattern || pattern.length === 0 || pattern.some((v) => !(v >= 0))) {
		return [];
	}
	return pattern.map((v) => v * w);
}

/**
 * Applies a GDI+ pen's stroke geometry (not its paint) to a context.
 * `widthScale` multiplies the width (an inset pen is stroked at twice its
 * width and clipped to the figure, see {@link strokePlusGeometry}). A dashed
 * pen caps every dash with its `DashCap` (flat by default), which is what
 * Canvas's single `lineCap` then carries; a solid pen uses its start cap.
 */
export function applyPlusPenStyle(ctx: CanvasContext, pen: EmfPlusPen, widthScale: number = 1): void {
	ctx.lineWidth = pen.width * widthScale;
	const dashes = penDashArray(pen);
	ctx.lineCap = canvasLineCap(dashes.length > 0 ? (pen.dashCap ?? 0) : (pen.startCap ?? pen.endCap));
	ctx.lineJoin = canvasLineJoin(pen.lineJoin);
	ctx.miterLimit = pen.miterLimit && pen.miterLimit >= 1 ? pen.miterLimit : 10;
	if (typeof ctx.setLineDash === 'function') {
		ctx.setLineDash(dashes);
	}
	ctx.lineDashOffset = dashes.length > 0 ? (pen.dashOffset ?? 0) * (pen.width || 1) : 0;
}

/**
 * Strokes geometry with an EMF+ pen: `buildPath` issues the geometry (world
 * coordinates, `beginPath()` already done) on whichever context it is
 * given, and `points` bound it (world space; control points suffice), for
 * sizing the exact brush path. `closedFigure` is true when every figure is
 * closed (a rectangle, ellipse, pie, polygon or closed path): an Inset pen
 * (`PenAlignment` 1) then paints its whole width inside the figure, as
 * GDI+ does, which is the figure's own stroke at twice the width clipped to
 * its interior. Without a pen object the current stroke style is used, as
 * before.
 */
export function strokePlusGeometry(
	rCtx: EmfPlusReplayCtx,
	pen: EmfPlusPen | null,
	buildPath: (c: CanvasContext) => void,
	points: ReadonlyArray<{ x: number; y: number }> | null,
	closedFigure: boolean = false,
): void {
	const { ctx } = rCtx;
	const inset = !!pen && pen.alignment === 1 && closedFigure;
	const widthScale = inset ? 2 : 1;
	/** Strokes on `c` (transform already set), clipped to the figure for an inset pen. */
	const stroke = (c: CanvasContext): void => {
		if (inset) {
			c.save();
			c.beginPath();
			buildPath(c);
			c.clip();
		}
		c.beginPath();
		buildPath(c);
		c.stroke();
		if (inset) {
			c.restore();
		}
	};
	if (pen) {
		applyPlusPenStyle(ctx, pen, widthScale);
		const aliased = isPlusAliased(rCtx);
		let sampler = pen.brush && !isSvgContext(ctx) ? brushSampler(rCtx, pen.brush) : null;
		if (!sampler && aliased) {
			const argb = cssColorToArgb(pen.color);
			sampler = argb === null ? null : solidSampler(argb);
		}
		if (sampler) {
			const size = surfaceSize(ctx);
			const device = plusWorldMatrix(rCtx);
			const scale = Math.max(Math.hypot(device[0], device[1]), Math.hypot(device[2], device[3]));
			const miter = Math.max(1, ctx.miterLimit || 10);
			const margin = (pen.width * scale * miter) / 2 + 2;
			const box = size ? deviceBounds(points, device, size, margin) : null;
			if (size && !box) {
				return; // Entirely off the surface.
			}
			if (
				box &&
				paintBrushThroughMask(
					rCtx,
					sampler,
					box,
					(c) => {
						applyPlusPenStyle(c, pen, widthScale);
						stroke(c);
						// Leave the geometry current for the aliased hit test.
						c.beginPath();
						buildPath(c);
					},
					aliased,
					(c, x, y) => c.isPointInStroke(x, y) && (!inset || c.isPointInPath(x, y)),
				)
			) {
				return;
			}
		}
		ctx.strokeStyle = pen.brush ? brushPaint(rCtx, pen.brush) : pen.color;
	}
	applyPlusWorldTransform(rCtx);
	stroke(ctx);
}

/** The drawing surface size, when the context exposes its canvas. */
function surfaceSize(ctx: CanvasContext): { w: number; h: number } | null {
	const canvas = (ctx as { canvas?: { width?: unknown; height?: unknown } }).canvas;
	const w = canvas?.width;
	const h = canvas?.height;
	return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 ? { w, h } : null;
}
