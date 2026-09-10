/**
 * Resolves a parsed EMF+ gradient brush descriptor to a Canvas 2D paint
 * style: a plain `CanvasGradient` for `WrapMode.Clamp` (Canvas's native
 * gradient behaviour already matches Clamp: the end colours extend
 * indefinitely past the 0..1 stop range), or a repeating `CanvasPattern`
 * that reproduces `Tile` / `TileFlipX` / `TileFlipY` / `TileFlipXY` for an
 * axis-aligned linear gradient (its own axis exactly horizontal or
 * vertical).
 *
 * An ANGLED linear gradient with a non-Clamp wrap mode, and every path
 * (radial-approximated) gradient's wrap mode, are not tiled: GDI+'s pattern
 * there would need to repeat along an arbitrary axis (linear) or around a
 * non-circular boundary (path), neither of which this module attempts.
 * Both degrade to the same plain, Clamp-style gradient this converter
 * already produced before wrap modes were parsed at all - a real limitation,
 * not a regression.
 *
 * @module emf-plus-brush-gradient
 */

import { canvasCreatePattern, createTempCanvas } from './emf-canvas-helpers';
import { emfLog } from './emf-logging';
import type {
	CanvasContext,
	EmfPlusGradient,
	EmfPlusGradientStop,
	EmfPlusLinearGradient,
} from './emf-types';

/** A tileable axis-aligned linear-gradient plan, in world (brush) space. */
export interface AxisTilePlan {
	axis: 'horizontal' | 'vertical';
	/** World-space coordinate that maps to the tile's pixel column/row 0. */
	originX: number;
	originY: number;
	/** Pixel length of one gradient period along the tiling axis (>= 1). */
	tileLength: number;
	/** Whether alternate periods must mirror (TileFlipX/Y/XY on this axis). */
	mirror: boolean;
	/** Colour stops repositioned to the world-increasing direction of the axis. */
	stops: EmfPlusGradientStop[];
}

/**
 * Pure decision function: does this linear gradient's wrap mode need
 * tiling, and if so, along which axis? Returns `null` when the wrap mode is
 * `'clamp'` (nothing to do - a plain gradient already matches) or the
 * gradient's axis is neither purely horizontal nor purely vertical (not
 * supported; caller falls back to a plain gradient).
 */
export function planAxisTile(grad: EmfPlusLinearGradient): AxisTilePlan | null {
	if (grad.wrapMode === 'clamp') {
		return null;
	}
	const { x1, y1, x2, y2, stops, wrapMode } = grad;
	const horizontal = y1 === y2 && x1 !== x2;
	const vertical = x1 === x2 && y1 !== y2;
	if (!horizontal && !vertical) {
		return null;
	}

	if (horizontal) {
		const increasing = x2 > x1;
		const period = Math.abs(x2 - x1);
		return {
			axis: 'horizontal',
			originX: Math.min(x1, x2),
			originY: y1,
			tileLength: Math.max(1, Math.round(period)),
			mirror: wrapMode === 'tile-flip-x' || wrapMode === 'tile-flip-xy',
			stops: reorientStops(stops, increasing),
		};
	}
	const increasing = y2 > y1;
	const period = Math.abs(y2 - y1);
	return {
		axis: 'vertical',
		originX: x1,
		originY: Math.min(y1, y2),
		tileLength: Math.max(1, Math.round(period)),
		mirror: wrapMode === 'tile-flip-y' || wrapMode === 'tile-flip-xy',
		stops: reorientStops(stops, increasing),
	};
}

/** Flips stop offsets when the gradient runs opposite to the world-increasing axis direction. */
function reorientStops(stops: EmfPlusGradientStop[], increasing: boolean): EmfPlusGradientStop[] {
	return increasing ? stops : stops.map((s) => ({ offset: 1 - s.offset, color: s.color }));
}

/** Mirrors a stop list around its own midpoint (used to paint a flipped tile half). */
function mirrorStops(stops: EmfPlusGradientStop[]): EmfPlusGradientStop[] {
	return stops.map((s) => ({ offset: 1 - s.offset, color: s.color }));
}

function paintLinear(
	tctx: CanvasContext,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	stops: EmfPlusGradientStop[],
	rectW: number,
	rectH: number,
	rectX: number,
	rectY: number,
): void {
	const g = tctx.createLinearGradient(x0, y0, x1, y1);
	for (const s of stops) {
		g.addColorStop(s.offset, s.color);
	}
	tctx.fillStyle = g;
	tctx.fillRect(rectX, rectY, rectW, rectH);
}

/** A small, arbitrary cross-axis tile thickness: gradient content is constant across it. */
const TILE_THICKNESS = 4;

/**
 * Renders an {@link AxisTilePlan} to a repeating `CanvasPattern`, anchored so
 * the tile's own origin lands on the gradient's world-space origin (via
 * `CanvasPattern.setTransform`, when available). Returns `null` when the
 * environment lacks pattern/tile-canvas support (e.g. this package's Node
 * test environment, or a context stub).
 */
export function buildTiledGradientPattern(
	ctx: CanvasContext,
	plan: AxisTilePlan,
): CanvasPattern | null {
	if (typeof ctx.createPattern !== 'function') {
		return null;
	}
	const horizontal = plan.axis === 'horizontal';
	const periodPx = plan.tileLength;
	const tileW = horizontal ? (plan.mirror ? periodPx * 2 : periodPx) : TILE_THICKNESS;
	const tileH = horizontal ? TILE_THICKNESS : plan.mirror ? periodPx * 2 : periodPx;

	const temp = createTempCanvas(tileW, tileH);
	if (!temp || typeof temp.ctx.createLinearGradient !== 'function') {
		return null;
	}
	const tctx = temp.ctx;

	if (horizontal) {
		paintLinear(tctx, 0, 0, periodPx, 0, plan.stops, periodPx, tileH, 0, 0);
		if (plan.mirror) {
			paintLinear(
				tctx,
				periodPx,
				0,
				periodPx * 2,
				0,
				mirrorStops(plan.stops),
				periodPx,
				tileH,
				periodPx,
				0,
			);
		}
	} else {
		paintLinear(tctx, 0, 0, 0, periodPx, plan.stops, tileW, periodPx, 0, 0);
		if (plan.mirror) {
			paintLinear(
				tctx,
				0,
				periodPx,
				0,
				periodPx * 2,
				mirrorStops(plan.stops),
				tileW,
				periodPx,
				0,
				periodPx,
			);
		}
	}

	const pattern = canvasCreatePattern(ctx, temp.canvas, 'repeat');
	if (!pattern) {
		return null;
	}
	if (typeof pattern.setTransform === 'function') {
		try {
			pattern.setTransform({ a: 1, b: 0, c: 0, d: 1, e: plan.originX, f: plan.originY });
		} catch {
			// A rejected DOMMatrix2DInit still leaves a correctly tiling pattern,
			// just anchored at (0,0) instead of the gradient's own origin.
			emfLog('buildTiledGradientPattern: pattern.setTransform rejected - origin not anchored');
		}
	}
	return pattern;
}

/**
 * Builds a Canvas 2D paint style from a parsed EMF+ gradient: a repeating
 * `CanvasPattern` for a tileable wrap mode on an axis-aligned linear
 * gradient, otherwise a plain `CanvasGradient`. Returns `null` when the
 * context lacks gradient support (e.g. test stubs) or the geometry is
 * degenerate, in which case callers fall back to the flat brush colour.
 */
export function createBrushGradient(
	ctx: CanvasContext,
	grad: EmfPlusGradient,
): CanvasGradient | CanvasPattern | null {
	try {
		if (grad.type === 'linear') {
			if (grad.x1 === grad.x2 && grad.y1 === grad.y2) {
				return null;
			}
			const plan = planAxisTile(grad);
			if (plan) {
				const pattern = buildTiledGradientPattern(ctx, plan);
				if (pattern) {
					return pattern;
				}
			} else if (grad.wrapMode !== 'clamp') {
				emfLog(
					`createBrushGradient: wrapMode '${grad.wrapMode}' on a non-axis-aligned linear gradient - falling back to a clamped gradient`,
				);
			}
			if (typeof ctx.createLinearGradient !== 'function') {
				return null;
			}
			const g = ctx.createLinearGradient(grad.x1, grad.y1, grad.x2, grad.y2);
			for (const stop of grad.stops) {
				g.addColorStop(stop.offset, stop.color);
			}
			return g;
		}
		if (grad.type === 'radial') {
			if (!(grad.r > 0) || typeof ctx.createRadialGradient !== 'function') {
				return null;
			}
			const g = ctx.createRadialGradient(grad.cx, grad.cy, 0, grad.cx, grad.cy, grad.r);
			for (const stop of grad.stops) {
				g.addColorStop(stop.offset, stop.color);
			}
			return g;
		}
		return null;
	} catch {
		return null;
	}
}
