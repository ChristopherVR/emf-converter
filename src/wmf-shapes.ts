/**
 * WMF box shapes: `META_RECTANGLE`, `META_ROUNDRECT`, `META_ELLIPSE`,
 * `META_ARC`, `META_CHORD` and `META_PIE`, drawn with the GDI rasteriser
 * and shape painter the EMF records use (`paintGdiShape`,
 * `emf-gdi-shape-paint.ts`), but with the geometry GDI builds when it plays
 * a WMF, which it always does in the `GM_COMPATIBLE` graphics mode:
 *   - the box's corners go to device space (28.4 fixed point, as for EMF)
 *     and are ordered, and the right and bottom edges are then pulled in by
 *     one device pixel: the box excludes its right/bottom edge, in device
 *     space, whatever the mapping;
 *   - arcs run in the arc direction as seen in DEVICE space (a mirroring
 *     mapping does not reverse them), from the radials through the start
 *     and end points mapped to device space.
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
import { EmfRecordWriter, playEmfRecord } from './wmf-emf-bridge';

/** `PS_NULL`. */
const PS_NULL = 5;

/** A compatible-mode device box in canvas FIX, inclusive (`x0 <= x1`, `y0 <= y1`). */
interface CompatBox {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/**
 * The inclusive device box GDI draws `l, t, r, b` into under
 * `GM_COMPATIBLE` (see the module doc).
 */
export function compatBox(p: WmfPlayer, l: number, t: number, r: number, b: number, shrink = 1, curved = false): CompatBox {
	const a = fixPoint(p.rCtx, l, t);
	const c = fixPoint(p.rCtx, r, b);
	const px = Math.round(16 * p.kx * shrink);
	const py = Math.round(16 * p.ky * shrink);
	const g = curved && penIsNull(p) ? Number(process.env.WMF_G ?? 4) : 0;
	const g2 = curved && penIsNull(p) ? Number(process.env.WMF_G2 ?? -12) : 0;
	const box = {
		x0: Math.min(a[0], c[0]) - g,
		y0: Math.min(a[1], c[1]) - g,
		x1: Math.max(a[0], c[0]) - px + g2,
		y1: Math.max(a[1], c[1]) - py + g2,
	};
	const st = p.rCtx.state;
	if (shrink !== 0 && (st.penStyle & 0x0f) === 6) {
		// PS_INSIDEFRAME: the box shrinks so the whole pen lies inside it.
		const w = Math.round(penDeviceWidth(p.rCtx));
		if (w > 1) {
			const lo = Number(process.env.WMF_IFA ?? Math.floor(w / 2)) * 16;
			const hi = Number(process.env.WMF_IFB ?? Math.floor((w - 1) / 2)) * 16;
			box.x0 += lo;
			box.y0 += lo;
			box.x1 -= hi;
			box.y1 -= hi;
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
	const box = compatBox(p, l, t, r, b, 1, true);
	if (box.x1 < box.x0 || box.y1 < box.y0) {
		return;
	}
	const m = gdiDeviceMatrix(p.rCtx);
	const cw = Math.round(Math.abs(w * m[0]) * 16);
	const ch = Math.round(Math.abs(h * m[3]) * 16);
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
	const box = compatBox(p, l, t, r, b, 1, true);
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
	if (process.env.WMF_ARCEMF) {
		const w = new EmfRecordWriter(kind === 'arc' ? 45 : kind === 'chord' ? 46 : 47, 48);
		w.i32(Math.min(l, r)).i32(Math.min(t, b)).i32(Math.max(l, r) - 1).i32(Math.max(t, b) - 1).i32(xs).i32(ys).i32(xe).i32(ye);
		playEmfRecord(p.rCtx, w.finish());
		return;
	}
	const box = compatBox(p, l, t, r, b, Number(process.env.WMF_ARCSHRINK ?? 1), kind !== 'arc');
	if (box.x1 < box.x0 || box.y1 < box.y0) {
		return;
	}
	// GDI measures the radials' angles about the centre of the box as given,
	// not of the box it shrank: move them with the centre.
	const raw = compatBox(p, l, t, r, b, 0);
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
