/**
 * WMF box shapes: `META_RECTANGLE`, `META_ROUNDRECT`, `META_ELLIPSE`,
 * `META_ARC`, `META_CHORD` and `META_PIE`, drawn with the GDI rasteriser
 * and shape painter the EMF records use (`paintGdiShape`,
 * `emf-gdi-shape-paint.ts`), but with the geometry GDI builds when it plays
 * a WMF, which it always does in the `GM_COMPATIBLE` graphics mode:
 *   - every point lands on a whole device pixel (`fixPoint` rounds to them
 *     under `rCtx.wholeDevicePixels`), and so does the pen width;
 *   - the box's corners are ordered and its right and bottom edges pulled
 *     in by one device pixel: the box excludes its right/bottom edge, in
 *     device space, whatever the mapping (see {@link compatBox} for the
 *     null-pen and `PS_INSIDEFRAME` boxes);
 *   - arcs run in the arc direction as seen in DEVICE space (a mirroring
 *     mapping does not reverse them), and their radials are measured about
 *     the centre of the box as given, not of the box it shrank.
 * (An EMF records the same calls already converted to `GM_ADVANCED`'s
 * inclusive logical boxes, so the EMF handlers cannot be reused as-is.)
 *
 * @module wmf-shapes
 */

import { fixPoint, penDeviceWidth, arcRasterPath, ellipseRasterPath, rectRasterPath, roundRectRasterPath, penIsCosmetic, type ArcKind } from './emf-gdi-raster-shapes';
import { gdiDeviceMatrix } from './emf-gdi-coord';
import { gdiStrokeAlign, paintGdiShape, penLineWidth, penScale } from './emf-gdi-shape-paint';
import { applyBrush, applyPen, rop2Paint } from './emf-canvas-helpers';
import { realizeBrush } from './emf-gdi-brush-pattern';
import { flushRasterLayer } from './emf-gdi-raster-layer';
import { isExactRop2Bitwise } from './emf-rop2-exact';
import type { CanvasContext } from './emf-types';
import { axisBox, type FixBox } from './gdi-raster';
import type { WmfPlayer } from './wmf-player';

/** `PS_NULL`. */
const PS_NULL = 5;
/** `PS_INSIDEFRAME`. */
const PS_INSIDEFRAME = 6;

/** A compatible-mode device box in canvas FIX, inclusive (`x0 <= x1`, `y0 <= y1`). */
interface CompatBox {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** How {@link compatBox} builds a box. */
interface CompatBoxOptions {
	/** Pull the right/bottom edge in by a device pixel (false: the box as given, for the arc radials). */
	exclusive?: boolean;
	/** An Ellipse/RoundRect/Chord/Pie (a null pen changes their box). */
	curved?: boolean;
}

/**
 * The inclusive device box GDI draws `l, t, r, b` into under
 * `GM_COMPATIBLE` (see the module doc), in canvas FIX. Measured against
 * `wmf-shapes*`:
 *   - a curved shape drawn with a null pen is one device pixel smaller
 *     still on the right and bottom, and then grown by a quarter pixel on
 *     every side (the quarter pixel `GM_ADVANCED` also adds, see
 *     `curvedFixBox` in `emf-gdi-draw-shapes.ts`);
 *   - a `PS_INSIDEFRAME` pen wider than a pixel moves the left/top edge in
 *     by half its width (rounded down) and the right/bottom edge by half
 *     of one less, so the whole stroke lies inside the box.
 */
export function compatBox(p: WmfPlayer, l: number, t: number, r: number, b: number, opts: CompatBoxOptions = {}): CompatBox {
	const exclusive = opts.exclusive !== false;
	const a = fixPoint(p.rCtx, l, t);
	const c = fixPoint(p.rCtx, r, b);
	const ux = 16 * p.kx;
	const uy = 16 * p.ky;
	const box = {
		x0: Math.min(a[0], c[0]),
		y0: Math.min(a[1], c[1]),
		x1: Math.max(a[0], c[0]) - (exclusive ? Math.round(ux) : 0),
		y1: Math.max(a[1], c[1]) - (exclusive ? Math.round(uy) : 0),
	};
	if (!exclusive) {
		return box;
	}
	if (opts.curved && penIsNull(p)) {
		box.x0 -= Math.round(ux / 4);
		box.y0 -= Math.round(uy / 4);
		box.x1 -= Math.round((ux * 3) / 4);
		box.y1 -= Math.round((uy * 3) / 4);
	}
	if ((p.rCtx.state.penStyle & 0x0f) === PS_INSIDEFRAME) {
		const w = Math.round(penDeviceWidth(p.rCtx) / p.kx);
		if (w > 1) {
			box.x0 += Math.round(Math.floor(w / 2) * ux);
			box.y0 += Math.round(Math.floor(w / 2) * uy);
			box.x1 -= Math.round(Math.floor((w - 1) / 2) * ux);
			box.y1 -= Math.round(Math.floor((w - 1) / 2) * uy);
		}
	}
	return box;
}

/** The {@link CompatBox} as the rasteriser's {@link FixBox}. */
function fixBoxOf(box: CompatBox): FixBox {
	return axisBox(box.x0, box.y0, Math.max(box.x0, box.x1), Math.max(box.y0, box.y1));
}

/** Canvas-space corners of a {@link CompatBox} (FIX / 16). */
function canvasRect(box: CompatBox): { x: number; y: number; w: number; h: number } {
	return { x: box.x0 / 16, y: box.y0 / 16, w: Math.max(0, box.x1 - box.x0) / 16, h: Math.max(0, box.y1 - box.y0) / 16 };
}

/** The interior a one-pixel pen's Rectangle fills (the antialiased route's `axisRect.interior`). */
function rectInterior(p: WmfPlayer, box: CompatBox): ((c: CanvasContext) => void) | undefined {
	const { state } = p.rCtx;
	const scale = penScale(p.rCtx);
	if (gdiStrokeAlign(state, scale) === 0 || penLineWidth(state, scale) !== 1) {
		return undefined;
	}
	const r = canvasRect(box);
	if (r.w <= 1 || r.h <= 1) {
		return undefined;
	}
	return (c: CanvasContext) => {
		c.beginPath();
		c.rect(r.x + 1, r.y + 1, r.w - 1, r.h - 1);
	};
}

/** `META_RECTANGLE`. */
export function wmfRectangle(p: WmfPlayer, l: number, t: number, r: number, b: number): void {
	const box = compatBox(p, l, t, r, b);
	if (box.x1 < box.x0 || box.y1 < box.y0) {
		return;
	}
	const cr = canvasRect(box);
	const { rCtx } = p;
	const { state } = rCtx;
	const penPlain = state.penStyle === PS_NULL || ((state.penStyle === 0 || state.penStyle === 6) && penIsCosmetic(rCtx));
	if (
		rCtx.gdiAntialias !== false &&
		penPlain &&
		realizeBrush(state).kind !== 'tile' &&
		(rop2Paint(state.rop2).exact || !isExactRop2Bitwise(state.rop2))
	) {
		// The plain case, as for EMF: one fillRect and one strokeRect.
		const { ctx } = rCtx;
		flushRasterLayer(rCtx);
		applyBrush(ctx, state);
		ctx.fillRect(cr.x, cr.y, cr.w, cr.h);
		applyPen(ctx, state);
		ctx.lineWidth = 1;
		const align = gdiStrokeAlign(state, penScale(rCtx));
		ctx.strokeRect(cr.x + align, cr.y + align, cr.w, cr.h);
		return;
	}
	paintGdiShape(p.rCtx, {
		build: (c: CanvasContext) => {
			c.beginPath();
			c.rect(cr.x, cr.y, cr.w, cr.h);
		},
		raster: () => rectRasterPath(fixBoxOf(box)),
		rectangle: true,
		fill: true,
		stroke: true,
		axisRect: { interior: rectInterior(p, box) },
	});
}

/** `META_ROUNDRECT`: `w`, `h` are the corner ellipse's logical width and height. */
export function wmfRoundRect(p: WmfPlayer, l: number, t: number, r: number, b: number, w: number, h: number): void {
	const box = compatBox(p, l, t, r, b, { curved: true });
	if (box.x1 < box.x0 || box.y1 < box.y0) {
		return;
	}
	const m = gdiDeviceMatrix(p.rCtx);
	let cw = Math.round(Math.abs(w * m[0]) * 16);
	let ch = Math.round(Math.abs(h * m[3]) * 16);
	if (!penIsNull(p) && !penIsCosmetic(p.rCtx)) {
		// Under a wide pen the corner ellipse is a whole even number of
		// pixels on each axis, rounded down (measured: `wmf-shapes`).
		cw = Math.floor(cw / 32) * 32;
		ch = Math.floor(ch / 32) * 32;
	}
	const cr = canvasRect(box);
	paintGdiShape(p.rCtx, {
		build: (c: CanvasContext) => {
			c.beginPath();
			const ex = Math.min(cw / 32, cr.w / 2);
			const ey = Math.min(ch / 32, cr.h / 2);
			if (ex <= 0 || ey <= 0) {
				c.rect(cr.x, cr.y, cr.w, cr.h);
				return;
			}
			const q = Math.PI / 2;
			const right = cr.x + cr.w;
			const bottom = cr.y + cr.h;
			c.moveTo(cr.x + ex, cr.y);
			c.lineTo(right - ex, cr.y);
			c.ellipse(right - ex, cr.y + ey, ex, ey, 0, -q, 0);
			c.lineTo(right, bottom - ey);
			c.ellipse(right - ex, bottom - ey, ex, ey, 0, 0, q);
			c.lineTo(cr.x + ex, bottom);
			c.ellipse(cr.x + ex, bottom - ey, ex, ey, 0, q, 2 * q);
			c.lineTo(cr.x, cr.y + ey);
			c.ellipse(cr.x + ex, cr.y + ey, ex, ey, 0, 2 * q, 3 * q);
			c.closePath();
		},
		raster: () => roundRectRasterPath(fixBoxOf(box), cw, ch),
		roundPen: true,
		fill: true,
		stroke: true,
	});
}

/** `META_ELLIPSE`. */
export function wmfEllipse(p: WmfPlayer, l: number, t: number, r: number, b: number): void {
	const box = compatBox(p, l, t, r, b, { curved: true });
	if (box.x1 < box.x0 || box.y1 < box.y0) {
		return;
	}
	const cr = canvasRect(box);
	paintGdiShape(p.rCtx, {
		build: (c: CanvasContext) => {
			c.beginPath();
			c.ellipse(cr.x + cr.w / 2, cr.y + cr.h / 2, cr.w / 2, cr.h / 2, 0, 0, Math.PI * 2);
		},
		raster: () => ellipseRasterPath(fixBoxOf(box)),
		roundPen: true,
		fill: true,
		stroke: true,
	});
}

/** `META_ARC` / `META_CHORD` / `META_PIE`: the box, then the start and end radial points. */
export function wmfArcFamily(
	p: WmfPlayer,
	kind: ArcKind,
	l: number,
	t: number,
	r: number,
	b: number,
	xs: number,
	ys: number,
	xe: number,
	ye: number,
): void {
	const box = compatBox(p, l, t, r, b, { curved: kind !== 'arc' });
	if (box.x1 < box.x0 || box.y1 < box.y0) {
		return;
	}
	// GDI measures the radials' angles about the centre of the box as given,
	// not of the box it shrank: move them with the centre.
	const raw = compatBox(p, l, t, r, b, { exclusive: false });
	const rdx = (box.x0 + box.x1 - raw.x0 - raw.x1) / 2;
	const rdy = (box.y0 + box.y1 - raw.y0 - raw.y1) / 2;
	const s0 = fixPoint(p.rCtx, xs, ys);
	const e0 = fixPoint(p.rCtx, xe, ye);
	const s: [number, number] = [s0[0] + rdx, s0[1] + rdy];
	const e: [number, number] = [e0[0] + rdx, e0[1] + rdy];
	const clockwise = p.rCtx.state.arcDirection === 2;
	const cr = canvasRect(box);
	const cx = cr.x + cr.w / 2;
	const cy = cr.y + cr.h / 2;
	const rx = cr.w / 2 || 1;
	const ry = cr.h / 2 || 1;
	const a0 = Math.atan2((s[1] / 16 - cy) / ry, (s[0] / 16 - cx) / rx);
	const a1 = Math.atan2((e[1] / 16 - cy) / ry, (e[0] / 16 - cx) / rx);
	const fill = kind === 'chord' || kind === 'pie';
	paintGdiShape(p.rCtx, {
		build: (c: CanvasContext) => {
			c.beginPath();
			if (kind === 'pie') {
				c.moveTo(cx, cy);
			}
			c.ellipse(cx, cy, cr.w / 2, cr.h / 2, 0, a0, a1, !clockwise);
			if (fill) {
				c.closePath();
			}
		},
		raster: () => arcRasterPath(fixBoxOf(box), s, e, clockwise, kind).path,
		fill,
		stroke: true,
	});
}

/** True when the selected pen draws nothing (`PS_NULL`). */
export function penIsNull(p: WmfPlayer): boolean {
	return (p.rCtx.state.penStyle & 0x0f) === PS_NULL;
}

export { penIsCosmetic };
