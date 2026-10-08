/**
 * EMF GDI shape record handlers: MoveTo, LineTo, Rectangle, RoundRect,
 * Ellipse, Arc, ArcTo, Chord, and Pie.
 *
 * Every shape is described twice and handed to `paintGdiShape`
 * (`emf-gdi-shape-paint.ts`), which picks the route:
 *   - `build`: Canvas geometry (`beginPath()` + path calls on whichever
 *     context it is given), for the default antialiased route;
 *   - `raster`: GDI's own device geometry in 28.4 fixed point, built the
 *     way GDI builds it (`emf-gdi-raster-shapes.ts`, `gdi-raster.ts`), for
 *     the exact route (`gdiAntialias: false`, pattern brushes, bitwise
 *     `SetROP2` modes).
 * Inside a `BeginPath`/`EndPath` bracket both are recorded instead: the
 * Canvas geometry into `rCtx.pathCmds` (through `gdiPathRecorder`) and the
 * GDI geometry into `rCtx.rasterPath`, for `EMR_FILLPATH` and friends.
 * Rectangle keeps its own `fillRect`/`strokeRect` fast path for the common
 * plain case (solid brush, solid or null one-pixel pen, no rotation, a
 * ROP2 mode Canvas composites exactly).
 *
 * When the active world transform has a rotation/skew component
 * ({@link hasWorldRotation}), the Canvas geometry is built via the
 * full-affine `gmapPoint`/`gdiEllipseParams` (`emf-gdi-coord.ts`) instead of
 * the scale-only `gmx`/`gmy`/`gmw`/`gmh`. A rounded rectangle's Canvas
 * geometry is built in LOGICAL space with its elliptical corners as cubic
 * Beziers ({@link appendRoundRectPath}) mapped through the affine, which
 * carries each corner to the exact transformed quarter ellipse.
 *
 * Arcs run counter-clockwise on screen by default (`AD_COUNTERCLOCKWISE`)
 * and clockwise after `EMR_SETARCDIRECTION` `AD_CLOCKWISE`; both routes
 * honour it.
 */

import { applyPen, applyBrush, rop2Paint } from './emf-canvas-helpers';
import { readStateColorRef } from './emf-gdi-palette';
import {
	EMR_MOVETOEX,
	EMR_LINETO,
	EMR_SETPIXELV,
	EMR_RECTANGLE,
	EMR_ROUNDRECT,
	EMR_ELLIPSE,
	EMR_ARC,
	EMR_ARCTO,
	EMR_CHORD,
	EMR_PIE,
	EMR_ANGLEARC,
} from './emf-constants';
import { realizeBrush } from './emf-gdi-brush-pattern';
import {
	gmx,
	gmy,
	gmw,
	gmh,
	gmapPoint,
	gdiDeviceMatrix,
	gdiDevicePixelX,
	gdiDevicePixelY,
	gdiEllipseParams,
	hasWorldRotation,
} from './emf-gdi-coord';
import { gdiPathRecorder } from './emf-gdi-path-record';
import {
	arcRasterPath,
	ellipseRasterPath,
	fixBox,
	fixPoint,
	isAxisBox,
	penIsCosmetic,
	rectRasterPath,
	roundRectRasterPath,
	roundRectDeviceBeziers,
	type ArcKind,
} from './emf-gdi-raster-shapes';
import { gdiStrokeAlign, paintGdiShape, penLineWidth, penScale } from './emf-gdi-shape-paint';
import { invertAffine } from './emf-plus-exact-fill';
import { isExactRop2Bitwise } from './emf-rop2-exact';
import type { CanvasContext, DrawState, EmfGdiReplayCtx } from './emf-types';
import { angleArcFix, angleArcPieces, circularArcBezier, ellipseBeziersBox, GdiRasterPath, type FixBox } from './gdi-raster';

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

/**
 * True when Rectangle's `fillRect`/`strokeRect` fast path would not paint
 * what GDI paints: a pattern brush, a bitwise ROP2 mode, `gdiAntialias:
 * false`, or a pen that is styled or wider than one pixel.
 */
function needsPathBasedRectangle(rCtx: EmfGdiReplayCtx): boolean {
	const { state } = rCtx;
	const paint = rop2Paint(state.rop2);
	const ropExact = !paint.exact && isExactRop2Bitwise(state.rop2);
	const penPlain = state.penStyle === 5 || ((state.penStyle === 0 || state.penStyle === 6) && penIsCosmetic(rCtx));
	return ropExact || rCtx.gdiAntialias === false || realizeBrush(state).kind === 'tile' || !penPlain;
}

/** The bracket's GDI geometry, created on first use. */
function rasterPathOf(rCtx: EmfGdiReplayCtx): GdiRasterPath {
	rCtx.rasterPath ??= new GdiRasterPath();
	return rCtx.rasterPath;
}

/** Keeps Canvas path brackets in Windows' point order and device precision. */
function recordRectangle(rCtx: EmfGdiReplayCtx, box: FixBox, clockwise: boolean): void {
	const path = rectRasterPath(box, clockwise);
	const pts = path.figures[0].pts;
	const c = gdiPathRecorder(rCtx);
	c.moveTo(pts[0] / 16, pts[1] / 16);
	for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i] / 16, pts[i + 1] / 16);
	c.closePath();
	rasterPathOf(rCtx).append(path);
}

function recordBezierShape(rCtx: EmfGdiReplayCtx, points: number[], stride: 6 | 8): void {
	const c = gdiPathRecorder(rCtx);
	c.moveTo(points[0] / 16, points[1] / 16);
	for (let i = stride === 6 ? 2 : 0; i < points.length; i += stride) {
		if (stride === 8) {
			if (i > 0) c.lineTo(points[i] / 16, points[i + 1] / 16);
		}
		const k = stride === 8 ? i + 2 : i;
		c.bezierCurveTo(points[k] / 16, points[k + 1] / 16, points[k + 2] / 16, points[k + 3] / 16, points[k + 4] / 16, points[k + 5] / 16);
	}
	c.closePath();
}

/**
 * Before a drawing call that continues from the current position inside a
 * path bracket (`LineTo`, `PolylineTo`, `ArcTo`, ...): starts a new figure
 * there unless the open figure already ends there
 * ({@link GdiRasterPath.continueAt}), in the Canvas geometry too.
 */
export function continueFigure(rCtx: EmfGdiReplayCtx): void {
	const path = rasterPathOf(rCtx);
	const [x, y] = currentFix(rCtx);
	const before = path.figures.length;
	path.continueAt(x, y);
	if (path.figures.length !== before) {
		gdiPathRecorder(rCtx).moveTo(x / 16, y / 16);
	}
}

/** The pen's dash-pattern cursor shared by consecutive `LineTo` records. */
function lineStyleOf(rCtx: EmfGdiReplayCtx): { pos: number } {
	rCtx.lineStyle ??= { pos: 0 };
	return rCtx.lineStyle;
}

/** Ends a run of `LineTo` records: the next one starts the dash pattern afresh. */
function resetLineStyle(rCtx: EmfGdiReplayCtx): void {
	rCtx.lineStyle = { pos: 0 };
}

/**
 * The current position in device FIX: the exact arc end an ArcTo left
 * (GDI keeps it at 28.4 precision) while the logical current position is
 * still the one it set, otherwise the mapped logical point.
 */
export function currentFix(rCtx: EmfGdiReplayCtx): [number, number] {
	const c = rCtx.curFix;
	const { state } = rCtx;
	if (c && c.lx === state.curX && c.ly === state.curY) {
		return [c.x, c.y];
	}
	return fixPoint(rCtx, state.curX, state.curY);
}

/**
 * {@link fixBox} of the logical box with its corners ordered first
 * (`left <= right`, `top <= bottom`): GDI builds the Rectangle, RoundRect
 * and Ellipse of an inverted box as it does the upright one (Windows'
 * `GetPath` in `GM_ADVANCED`, Wine `gdi32/tests/path.c`, `test_rectangle`,
 * `test_roundrect`, `test_ellipse`), so only the arc direction and the
 * world transform decide which way the path runs.
 */
function uprightFixBox(rCtx: EmfGdiReplayCtx, l: number, t: number, r: number, b: number): FixBox {
	return fixBox(rCtx, Math.min(l, r), Math.min(t, b), Math.max(l, r), Math.max(t, b));
}

/** A logical extent `v` along the device x (`axis` 0) or y (`axis` 1) direction, in device FIX. */
function fixExtent(rCtx: EmfGdiReplayCtx, v: number, axis: 0 | 1): number {
	const m = gdiDeviceMatrix(rCtx);
	const k = axis === 0 ? Math.hypot(m[0], m[1]) : Math.hypot(m[2], m[3]);
	return Math.round(Math.abs(v) * k * 16);
}

/** `PS_INSIDEFRAME`. */
const PS_INSIDEFRAME = 6;

/** Per-side inside-frame insets in canvas FIX (see {@link insideFrameInset}). */
interface FrameInset {
	left: number;
	right: number;
	top: number;
	bottom: number;
	/** The left and right edges lie on half a FIX (an odd width): see `FixBox.halfX`. */
	half: boolean;
	/** A Rectangle of odd width: see `FixBox.halfXRect`. */
	halfRect: boolean;
}

/**
 * How far a `PS_INSIDEFRAME` pen pulls an axis-aligned Rectangle, RoundRect,
 * Ellipse, Arc, Chord or Pie box in, per side, in canvas FIX (`null` when
 * the pen leaves the box alone). Measured with `GetPath` in `GM_ADVANCED`
 * (3,600 boxes, six scales, widths 1 to 15 px; the narrower WMF rule is in
 * `wmf-shapes.ts`):
 *   - the pen width along each axis is its width times that axis' scale, in
 *     whole FIX of a device pixel (`wx`, `wy`);
 *   - a pen under 1.5 pixels along both axes (24 FIX) is cosmetic and does
 *     not move the box;
 *   - a box narrower than the pen along either axis is drawn unchanged;
 *   - otherwise the box shrinks by the width along each axis, each horizontal
 *     edge moving in by half of it rounded up and each vertical edge by half
 *     of it: rounded up on a Rectangle's left edge and down on its right. An
 *     odd width puts the other shapes' vertical edges on half a FIX: their
 *     paths are those of the box rounded down on the left and up on the
 *     right, with the first half of the path a FIX further right (`halfX`).
 */
function insideFrameInset(rCtx: EmfGdiReplayCtx, box: FixBox, rectangle = false, clockwiseRoundRect = false): FrameInset | null {
	if ((rCtx.state.penStyle & 0x0f) !== PS_INSIDEFRAME || !isAxisBox(box) || hasWorldRotation(rCtx)) {
		return null;
	}
	const m = gdiDeviceMatrix(rCtx);
	const px = gdiDevicePixelX(rCtx);
	const py = gdiDevicePixelY(rCtx);
	const widthX = (Math.abs(rCtx.state.penWidth * m[0]) / px) * 16;
	const widthY = (Math.abs(rCtx.state.penWidth * m[3]) / py) * 16;
	if (Math.max(widthX, widthY) < 24) {
		return null;
	}
	const wx = Math.round(widthX);
	const wy = Math.round(widthY);
	if (Math.abs(box.exx) / px < wx || Math.abs(box.eyy) / py < wy) {
		return null;
	}
	const lo = Math.floor(wx / 2);
	const hi = Math.ceil(wx / 2);
	// Clockwise RoundRect keeps the lower half-FIX inset on both y sides.
	// Public GetPath controls distinguish this from the other box shapes.
	const y = Math.round((clockwiseRoundRect ? Math.floor(wy / 2) : Math.ceil(wy / 2)) * py);
	return {
		left: Math.round((rectangle ? hi : lo) * px),
		right: Math.round((rectangle ? lo : hi) * px),
		top: y,
		bottom: y,
		half: wx % 2 === 1 && !rectangle,
		halfRect: wx % 2 === 1 && rectangle,
	};
}

/**
 * True when a `PS_INSIDEFRAME` pen is wider than the box along an axis: an Arc, Chord or Pie then paints nothing and has
 * an empty path (native, a DIB probe and `GetPath`), where an Ellipse, Rectangle or RoundRect keeps the box as given.
 */
function insideFramePenTooWide(rCtx: EmfGdiReplayCtx, box: FixBox): boolean {
	if ((rCtx.state.penStyle & 0x0f) !== PS_INSIDEFRAME || !isAxisBox(box) || hasWorldRotation(rCtx)) {
		return false;
	}
	const m = gdiDeviceMatrix(rCtx);
	const px = gdiDevicePixelX(rCtx);
	const py = gdiDevicePixelY(rCtx);
	const widthX = (Math.abs(rCtx.state.penWidth * m[0]) / px) * 16;
	const widthY = (Math.abs(rCtx.state.penWidth * m[3]) / py) * 16;
	if (Math.max(widthX, widthY) < 24) {
		return false;
	}
	return Math.abs(box.exx) / px < Math.round(widthX) || Math.abs(box.eyy) / py < Math.round(widthY);
}

/** `box` pulled in by `inset` (a mirrored box keeps its orientation). */
function insetFixBox(box: FixBox, inset: FrameInset): FixBox {
	const sx = box.exx < 0 ? -1 : 1;
	const sy = box.eyy < 0 ? -1 : 1;
	const framed: FixBox = {
		ax: box.ax + sx * inset.left,
		ay: box.ay + sy * inset.top,
		exx: box.exx - sx * (inset.left + inset.right),
		exy: 0,
		eyx: 0,
		eyy: box.eyy - sy * (inset.top + inset.bottom),
		framed: true,
	};
	if (inset.half && sx > 0) {
		framed.halfX = true;
	}
	if (inset.halfRect && sx > 0) {
		framed.halfXRect = true;
	}
	return framed;
}

/** `box`, pulled in by the current pen when it is a `PS_INSIDEFRAME` one ({@link insideFrameInset}). */
function framedBox(rCtx: EmfGdiReplayCtx, box: FixBox): FixBox {
	const inset = insideFrameInset(rCtx, box);
	return inset ? insetFixBox(box, inset) : box;
}

/**
 * Whether two nonzero integer radial vectors describe the same ellipse point.
 * Work in doubled logical coordinates so an odd-sized box keeps its exact
 * half-integer centre. The cross product can exceed Number's integer range
 * for valid LONG coordinates; BigInt avoids mistaking nearby rays for one.
 */
function sameEllipseRay(l: number, t: number, r: number, b: number, sx: number, sy: number, ex: number, ey: number): boolean {
	const ax = BigInt(2 * sx - l - r);
	const ay = BigInt(2 * sy - t - b);
	const bx = BigInt(2 * ex - l - r);
	const by = BigInt(2 * ey - t - b);
	return ax * by === ay * bx && ax * bx + ay * by > 0n;
}

// ---------------------------------------------------------------------------
// Individual shape handlers
// ---------------------------------------------------------------------------

function handleSetPixelV(rCtx: EmfGdiReplayCtx, dataOff: number, recSize: number): boolean {
	const { ctx, view } = rCtx;
	if (recSize >= 20) {
		const x = view.getInt32(dataOff, true);
		const y = view.getInt32(dataOff + 4, true);
		const color = readStateColorRef(rCtx.state, view, dataOff + 8);
		const p = hasWorldRotation(rCtx) ? gmapPoint(rCtx, x, y) : { x: gmx(rCtx, x), y: gmy(rCtx, y) };
		ctx.fillStyle = color;
		ctx.fillRect(p.x, p.y, 1, 1);
	}
	return true;
}

function handleMoveToEx(rCtx: EmfGdiReplayCtx, dataOff: number, recSize: number): boolean {
	const { view, state, inPath } = rCtx;
	if (recSize >= 16) {
		state.curX = view.getInt32(dataOff, true);
		state.curY = view.getInt32(dataOff + 4, true);
		resetLineStyle(rCtx);
		rCtx.curFix = undefined;
		if (inPath) {
			const p = hasWorldRotation(rCtx)
				? gmapPoint(rCtx, state.curX, state.curY)
				: { x: gmx(rCtx, state.curX), y: gmy(rCtx, state.curY) };
			gdiPathRecorder(rCtx).moveTo(p.x, p.y);
			const f = fixPoint(rCtx, state.curX, state.curY);
			rasterPathOf(rCtx).moveTo(f[0], f[1]);
		}
	}
	return true;
}

function handleLineTo(rCtx: EmfGdiReplayCtx, dataOff: number, recSize: number): boolean {
	const { view, state, inPath } = rCtx;
	if (recSize >= 16) {
		const lx = view.getInt32(dataOff, true);
		const ly = view.getInt32(dataOff + 4, true);
		const rotated = hasWorldRotation(rCtx);
		const to = rotated ? gmapPoint(rCtx, lx, ly) : { x: gmx(rCtx, lx), y: gmy(rCtx, ly) };
		const fixTo = fixPoint(rCtx, lx, ly);
		if (inPath) {
			continueFigure(rCtx);
			gdiPathRecorder(rCtx).lineTo(to.x, to.y);
			rasterPathOf(rCtx).lineTo(fixTo[0], fixTo[1]);
		} else {
			const from = rotated
				? gmapPoint(rCtx, state.curX, state.curY)
				: { x: gmx(rCtx, state.curX), y: gmy(rCtx, state.curY) };
			const fixFrom = currentFix(rCtx);
			paintGdiShape(rCtx, {
				build: (c: CanvasContext) => {
					c.beginPath();
					c.moveTo(from.x, from.y);
					c.lineTo(to.x, to.y);
				},
				raster: () => {
					const path = new GdiRasterPath();
					path.moveTo(fixFrom[0], fixFrom[1]);
					path.lineTo(fixTo[0], fixTo[1]);
					return path;
				},
				fill: false,
				stroke: true,
				style: lineStyleOf(rCtx),
			});
		}
		state.curX = lx;
		state.curY = ly;
	}
	return true;
}

/**
 * A Rectangle drawn with a cosmetic (one device pixel) pen takes every edge to the next whole device pixel: native playback of
 * 5,040 recorded rectangles (`compat-rects-*`, eight map modes and two world scales, window and viewport origins, 1/7 to 6/7
 * fractions) puts the outline and the fill at `ceil(device coordinate)` on all four sides, where the exact FIX box rounded to
 * the nearest pixel. A null pen keeps the exact box (its edges already agree) and a wide pen builds the shape in FIX.
 */
function cosmeticRectangleBox(rCtx: EmfGdiReplayCtx, box: FixBox): FixBox {
	const { state } = rCtx;
	if (rCtx.inPath || state.penStyle === 5 || state.penStyle === 6 || box.exy !== 0 || box.eyx !== 0 || box.exx === 0 || box.eyy === 0 || !penIsCosmetic(rCtx)) {
		return box;
	}
	const ax = Math.ceil(box.ax / 16) * 16;
	const ay = Math.ceil(box.ay / 16) * 16;
	return { ...box, ax, ay, exx: Math.ceil((box.ax + box.exx) / 16) * 16 - ax, eyy: Math.ceil((box.ay + box.eyy) / 16) * 16 - ay };
}

/**
 * The same axis-aligned box with its extents positive. A Rectangle that is drawn (not collected in a path bracket) is traversed in
 * device space whichever way the map mirrors it: from the right-top corner towards the left (the right-bottom corner towards the left
 * under `AD_CLOCKWISE`), which only a dotted or dashed outline shows (`compat-rects-m*-dot`, 12 sheets of 315 Rectangles each, all
 * pixel-exact). `GetPath` of the same record is the mirror image of that (the path is built in logical space and mapped), and so is
 * a RoundRect, drawn or not.
 */
function devicePositiveBox(box: FixBox): FixBox {
	if (!isAxisBox(box) || (box.exx >= 0 && box.eyy >= 0)) {
		return box;
	}
	const ax = box.exx < 0 ? box.ax + box.exx : box.ax;
	const ay = box.eyy < 0 ? box.ay + box.eyy : box.ay;
	return { ...box, ax, ay, exx: Math.abs(box.exx), eyy: Math.abs(box.eyy) };
}

function handleRectangle(rCtx: EmfGdiReplayCtx, dataOff: number, recSize: number): boolean {
	const { ctx, view, state, inPath } = rCtx;
	if (recSize >= 24) {
		const l = view.getInt32(dataOff, true);
		const t = view.getInt32(dataOff + 4, true);
		const r = view.getInt32(dataOff + 8, true);
		const b = view.getInt32(dataOff + 12, true);
		const unframed = cosmeticRectangleBox(rCtx, uprightFixBox(rCtx, l, t, r, b));
		const inset = insideFrameInset(rCtx, unframed, true, rCtx.state.arcDirection === 2);
		const box = inset ? insetFixBox(unframed, inset) : unframed;
		const clockwise = rCtx.state.arcDirection === 2;
		if (!inPath) {
			resetLineStyle(rCtx);
		}
		const rotated = hasWorldRotation(rCtx);
		if (rotated) {
			const p1 = gmapPoint(rCtx, l, t);
			const p2 = gmapPoint(rCtx, r, t);
			const p3 = gmapPoint(rCtx, r, b);
			const p4 = gmapPoint(rCtx, l, b);
			// Appends the rectangle's outline to whatever path is already open;
			// the caller decides whether that is a fresh path (immediate shape)
			// or the CURRENT BeginPath/EndPath bracket (inPath), which must NOT
			// be reset here.
			const appendRect = (c: CanvasContext) => {
				c.moveTo(p1.x, p1.y);
				c.lineTo(p2.x, p2.y);
				c.lineTo(p3.x, p3.y);
				c.lineTo(p4.x, p4.y);
				c.closePath();
			};
			if (inPath) {
				recordRectangle(rCtx, box, clockwise);
			} else {
				paintGdiShape(rCtx, {
					build: (c: CanvasContext) => {
						c.beginPath();
						appendRect(c);
					},
					raster: () => rectRasterPath(box, clockwise),
					rectangle: true,
					fill: true,
					stroke: true,
					axisRect: isAxisBox(box) ? {} : undefined,
				});
			}
			return true;
		}
		let x = gmx(rCtx, l);
		let y = gmy(rCtx, t);
		let w = gmw(rCtx, r - l);
		let h = gmh(rCtx, b - t);
		if (inset) {
			x = Math.min(box.ax, box.ax + box.exx) / 16;
			y = Math.min(box.ay, box.ay + box.eyy) / 16;
			w = Math.abs(box.exx) / 16;
			h = Math.abs(box.eyy) / 16;
		}
		if (inPath) {
			recordRectangle(rCtx, box, clockwise);
		} else if (needsPathBasedRectangle(rCtx)) {
			paintGdiShape(rCtx, {
				build: (c: CanvasContext) => {
					c.beginPath();
					c.rect(x, y, w, h);
				},
				raster: () => rectRasterPath(devicePositiveBox(box), clockwise),
				rectangle: true,
				fill: true,
				stroke: true,
				axisRect: { interior: rectangleInterior(state, x, y, w, h, penScale(rCtx)) },
			});
		} else {
			applyBrush(ctx, state);
			ctx.fillRect(x, y, w, h);
			applyPen(ctx, state);
			// The fast path only takes one-pixel (cosmetic) pens.
			ctx.lineWidth = 1;
			const align = gdiStrokeAlign(state, penScale(rCtx));
			ctx.strokeRect(x + align, y + align, w, h);
		}
	}
	return true;
}

/**
 * The part of an axis-aligned, pen-bordered Rectangle that GDI fills with
 * the brush: the inclusive box minus its 1px border. GDI paints the border
 * pixels with the pen ONLY, never brush-then-pen, which is visible under a
 * `SetROP2` mode where combining twice differs from combining once (an XOR
 * brush under an XOR pen, say; confirmed by `rop2-bitwise-grid`). The
 * right/bottom border already lies outside the canvas rectangle `x..x+w`
 * (its pixels are columns `x..x+w-1`, the pen's are `x+w`), so only the
 * left/top edge moves in. `undefined` (fill the whole rectangle) for a null
 * or wider pen, or a rectangle too small to have an interior.
 */
function rectangleInterior(
	state: DrawState,
	x: number,
	y: number,
	w: number,
	h: number,
	scale = 1,
): ((c: CanvasContext) => void) | undefined {
	if (gdiStrokeAlign(state, scale) === 0 || penLineWidth(state, scale) !== 1) {
		return undefined;
	}
	const x0 = Math.min(x, x + w);
	const y0 = Math.min(y, y + h);
	const iw = Math.abs(w) - 1;
	const ih = Math.abs(h) - 1;
	if (iw <= 0 || ih <= 0) {
		return undefined;
	}
	return (c: CanvasContext) => {
		c.beginPath();
		c.rect(x0 + 1, y0 + 1, iw, ih);
	};
}

/** Bezier control-point factor that best fits a quarter ellipse (4/3 * (sqrt(2) - 1)). */
const KAPPA = 0.5522847498307936;

/**
 * Appends a rounded rectangle's outline to `c`'s current path: the box
 * `x0..x1` x `y0..y1` (any orientation) with elliptical corners of radii
 * `rx`, `ry` (each clamped to half the box), in a source space that `map`
 * carries to device space. With `map` null the box is already in device
 * space and each corner is an exact axis-aligned `ellipse()` quarter.
 * Otherwise each corner is the standard four-arc cubic
 * Bezier quarter ellipse (control points `KAPPA` times the radius along the
 * tangents), built in the source space; `map` is affine (the world
 * transform composed with the device mapping), and an affine map carries a
 * Bezier's control points to exactly the mapped curve, so the corners stay
 * exact quarter ellipses under rotation, skew, and anisotropic scale, where
 * `arcTo`'s circular, locally right-angled corners cannot follow.
 */
function appendRoundRectPath(
	c: CanvasContext,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	rx: number,
	ry: number,
	map: ((x: number, y: number) => { x: number; y: number }) | null,
): void {
	const left = Math.min(x0, x1);
	const right = Math.max(x0, x1);
	const top = Math.min(y0, y1);
	const bottom = Math.max(y0, y1);
	const ex = Math.min(Math.abs(rx), (right - left) / 2);
	const ey = Math.min(Math.abs(ry), (bottom - top) / 2);
	if (!map) {
		if (ex <= 0 || ey <= 0) {
			c.rect(left, top, right - left, bottom - top);
			return;
		}
		const q = Math.PI / 2;
		c.moveTo(left + ex, top);
		c.lineTo(right - ex, top);
		c.ellipse(right - ex, top + ey, ex, ey, 0, -q, 0);
		c.lineTo(right, bottom - ey);
		c.ellipse(right - ex, bottom - ey, ex, ey, 0, 0, q);
		c.lineTo(left + ex, bottom);
		c.ellipse(left + ex, bottom - ey, ex, ey, 0, q, 2 * q);
		c.lineTo(left, top + ey);
		c.ellipse(left + ex, top + ey, ex, ey, 0, 2 * q, 3 * q);
		c.closePath();
		return;
	}
	const move = (x: number, y: number) => {
		const p = map(x, y);
		c.moveTo(p.x, p.y);
	};
	const line = (x: number, y: number) => {
		const p = map(x, y);
		c.lineTo(p.x, p.y);
	};
	const curve = (ax: number, ay: number, bx: number, by: number, x: number, y: number) => {
		const p1 = map(ax, ay);
		const p2 = map(bx, by);
		const p3 = map(x, y);
		c.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
	};
	if (ex <= 0 || ey <= 0) {
		move(left, top);
		line(right, top);
		line(right, bottom);
		line(left, bottom);
		c.closePath();
		return;
	}
	const kx = ex * KAPPA;
	const ky = ey * KAPPA;
	move(left + ex, top);
	line(right - ex, top);
	curve(right - ex + kx, top, right, top + ey - ky, right, top + ey);
	line(right, bottom - ey);
	curve(right, bottom - ey + ky, right - ex + kx, bottom, right - ex, bottom);
	line(left + ex, bottom);
	curve(left + ex - kx, bottom, left, bottom - ey + ky, left, bottom - ey);
	line(left, top + ey);
	curve(left, top + ey - ky, left + ex - kx, top, left + ex, top);
	c.closePath();
}

function handleRoundRect(rCtx: EmfGdiReplayCtx, dataOff: number, recSize: number): boolean {
	const { view, inPath } = rCtx;
	if (recSize >= 32) {
		const l = view.getInt32(dataOff, true);
		const t = view.getInt32(dataOff + 4, true);
		const r = view.getInt32(dataOff + 8, true);
		const b = view.getInt32(dataOff + 12, true);
		const cornerW = view.getInt32(dataOff + 16, true);
		const cornerH = view.getInt32(dataOff + 20, true);
		const clockwise = rCtx.state.arcDirection === 2;
		const unframed = uprightFixBox(rCtx, l, t, r, b);
		const inset = insideFrameInset(rCtx, unframed, false, clockwise);
		const framed = inset ? insetFixBox(unframed, inset) : unframed;
		// The corner ellipse is scaled onto an inside-frame pen's smaller box.
		const devM = gdiDeviceMatrix(rCtx);
		const cornerFixW = inset ? Math.abs(cornerW * devM[0]) * 16 : fixExtent(rCtx, cornerW, 0);
		const cornerFixH = inset ? Math.abs(cornerH * devM[3]) * 16 : fixExtent(rCtx, cornerH, 1);
		const cornerOnFrame = (fix: number, size: number, framedSize: number): number => (inset && size !== 0 ? Math.floor((Math.min(fix, size) * framedSize) / size) : fix);
		let cw = cornerOnFrame(cornerFixW, Math.abs((r - l) * devM[0]) * 16, Math.abs(framed.exx));
		let ch = cornerOnFrame(cornerFixH, Math.abs((b - t) * devM[3]) * 16, Math.abs(framed.eyy));
		// A null pen's box grows by a quarter pixel on every side (identity scale), and GDI scales the corner ellipse onto the grown box,
		// truncating to whole FIX (native GetPath and playback of 400 null-pen RoundRects in either graphics mode).
		const drawBox = inset ? framed : curvedFixBox(rCtx, l, t, r, b, true);
		if (!inset && drawBox.exx !== unframed.exx && Math.abs(unframed.exx) > 0 && Math.abs(unframed.eyy) > 0 && cornerW !== 0 && cornerH !== 0) {
			cw = Math.floor((Math.min(cornerFixW, Math.abs(unframed.exx)) * Math.abs(drawBox.exx)) / Math.abs(unframed.exx));
			ch = Math.floor((Math.min(cornerFixH, Math.abs(unframed.eyy)) * Math.abs(drawBox.eyy)) / Math.abs(unframed.eyy));
		}
		// A wide or cosmetic pen keeps the corner unscaled on the record's box in every graphics mode: PlayEnhMetaFile draws a RoundRect
		// record the same whether the application recorded it in GM_COMPATIBLE (the record then stores the call's right and bottom less
		// one) or in GM_ADVANCED (native GetPath after playback, 400 shapes per mode, emf-roundrect-mode-paths.json.gz). The scaling a
		// GM_COMPATIBLE application sees when it draws straight onto a device (emf-roundrect-wide-paths.json.gz) is not part of playback.
		// Rotated/skewed: build in LOGICAL space and map every point (Bezier
		// control points included) through the full affine. Otherwise the
		// device mapping is a plain per-axis scale + offset, so build directly
		// in device space.
		const drawRoundRect: (c: CanvasContext) => void = inset
			? (c) =>
					appendRoundRectPath(
						c,
						Math.min(framed.ax, framed.ax + framed.exx) / 16,
						Math.min(framed.ay, framed.ay + framed.eyy) / 16,
						Math.max(framed.ax, framed.ax + framed.exx) / 16,
						Math.max(framed.ay, framed.ay + framed.eyy) / 16,
						cw / 32,
						ch / 32,
						null,
					)
			: hasWorldRotation(rCtx)
				? (c) => appendRoundRectPath(c, l, t, r, b, cornerW / 2, cornerH / 2, (x, y) => gmapPoint(rCtx, x, y))
				: (c) =>
						appendRoundRectPath(
							c,
							gmx(rCtx, l),
							gmy(rCtx, t),
							gmx(rCtx, r),
							gmy(rCtx, b),
							gmw(rCtx, cornerW) / 2,
							gmh(rCtx, cornerH) / 2,
							null,
						);
		if (inset) {
			const fullW = Math.abs((r - l) * devM[0]) * 16;
			const fullH = Math.abs((b - t) * devM[3]) * 16;
			if (fullW > 0 && fullH > 0) {
				framed.cornerExact = [(Math.min(cornerFixW, fullW) * Math.abs(framed.exx)) / fullW, (Math.min(cornerFixH, fullH) * Math.abs(framed.eyy)) / fullH];
			}
		}
		const raster = (box = framed) => roundRectRasterPath(box, cw, ch, clockwise, cornerW === 0 || cornerH === 0);
		if (inPath) {
			const box = drawBox;
			if (cornerW === 0 || cornerH === 0) recordRectangle(rCtx, box, clockwise);
			else {
				recordBezierShape(rCtx, roundRectDeviceBeziers(box, cw, ch, clockwise), 8);
				rasterPathOf(rCtx).append(raster(box));
			}
		} else {
			resetLineStyle(rCtx);
			paintGdiShape(rCtx, {
				build: (c: CanvasContext) => {
					c.beginPath();
					drawRoundRect(c);
				},
				raster: () => raster(drawBox),
				roundPen: true,
				fill: true,
				stroke: true,
			});
		}
	}
	return true;
}

/**
 * GDI's device box for a curved shape (Ellipse, RoundRect, Chord, Pie). With
 * a null pen and a box whose four edges all land on whole device pixels GDI
 * grows it by a quarter pixel (4 FIX) on every side before building the path,
 * so the filled area reaches the inclusive box's right and bottom edges. Native
 * playback of 840 recorded null-pen ellipses (`compat-ellipses-*`, ten maps and
 * world scales) shows the growth in every box with four whole-pixel edges (identity, 2:1, and
 * the integral boxes of 3:4, 4:3, 2:3 maps) and in none of the 1,600 with a fractional edge; the
 * earlier "identity scale only" rule measured direct calls with fractional edges.
 */
function curvedFixBox(rCtx: EmfGdiReplayCtx, l: number, t: number, r: number, b: number, upright = false): FixBox {
	const box = upright ? uprightFixBox(rCtx, l, t, r, b) : fixBox(rCtx, l, t, r, b);
	if (rCtx.state.penStyle !== 5) {
		return box;
	}
	const m = gdiDeviceMatrix(rCtx);
	if (m[1] !== 0 || m[2] !== 0) {
		return box;
	}
	const whole = box.ax % 16 === 0 && box.ay % 16 === 0 && box.exx % 16 === 0 && box.eyy % 16 === 0;
	const gx = whole ? 4 : 0;
	const gy = gx;
	const sx = box.exx < 0 ? -1 : 1;
	const sy = box.eyy < 0 ? -1 : 1;
	return {
		ax: box.ax - gx * sx,
		ay: box.ay - gy * sy,
		exx: box.exx + 2 * gx * sx,
		exy: 0,
		eyx: 0,
		eyy: box.eyy + 2 * gy * sy,
	};
}

function handleEllipse(rCtx: EmfGdiReplayCtx, dataOff: number, recSize: number): boolean {
	const { view, inPath } = rCtx;
	if (recSize >= 24) {
		const l = view.getInt32(dataOff, true);
		const t = view.getInt32(dataOff + 4, true);
		const r = view.getInt32(dataOff + 8, true);
		const b = view.getInt32(dataOff + 12, true);
		const clockwise = rCtx.state.arcDirection === 2;
		const unframed = uprightFixBox(rCtx, l, t, r, b);
		const inset = insideFrameInset(rCtx, unframed, false, rCtx.state.arcDirection === 2);
		const framed = inset ? insetFixBox(unframed, inset) : unframed;
		const params = inset
			? { cx: (framed.ax + framed.exx / 2) / 16, cy: (framed.ay + framed.eyy / 2) / 16, rx: Math.abs(framed.exx) / 32, ry: Math.abs(framed.eyy) / 32, rotation: 0 }
			: hasWorldRotation(rCtx)
				? gdiEllipseParams(rCtx, (l + r) / 2, (t + b) / 2, Math.abs(r - l) / 2, Math.abs(b - t) / 2)
				: {
						cx: gmx(rCtx, (l + r) / 2),
						cy: gmy(rCtx, (t + b) / 2),
						rx: Math.abs(gmw(rCtx, r - l)) / 2,
						ry: Math.abs(gmh(rCtx, b - t)) / 2,
						rotation: 0,
					};
		if (inPath) {
			const box = framed;
			recordBezierShape(rCtx, ellipseBeziersBox(box, clockwise), 6);
			rasterPathOf(rCtx).append(ellipseRasterPath(box, clockwise));
		} else {
			resetLineStyle(rCtx);
			paintGdiShape(rCtx, {
				build: (c: CanvasContext) => {
					c.beginPath();
					c.ellipse(params.cx, params.cy, params.rx, params.ry, params.rotation, 0, Math.PI * 2);
				},
				raster: () => ellipseRasterPath(inset ? framed : curvedFixBox(rCtx, l, t, r, b, true), clockwise),
				roundPen: true,
				fill: true,
				stroke: true,
			});
		}
	}
	return true;
}

function handleArcFamily(rCtx: EmfGdiReplayCtx, recType: number, dataOff: number, recSize: number): boolean {
	const { ctx, view, state, inPath } = rCtx;
	if (recSize >= 40) {
		const l = view.getInt32(dataOff, true);
		const t = view.getInt32(dataOff + 4, true);
		const r = view.getInt32(dataOff + 8, true);
		const b = view.getInt32(dataOff + 12, true);
		const startX = view.getInt32(dataOff + 16, true);
		const startY = view.getInt32(dataOff + 20, true);
		const endX = view.getInt32(dataOff + 24, true);
		const endY = view.getInt32(dataOff + 28, true);
		const cxA = (l + r) / 2;
		const cyA = (t + b) / 2;
		const rx = Math.abs(r - l) / 2;
		const ry = Math.abs(b - t) / 2;
		// LOCAL angle parameter along the (pre-rotation) ellipse; unaffected by
		// the device mapping, rotated or not (see gdiEllipseParams's doc comment).
		const startAngle = Math.atan2((startY - cyA) / (ry || 1), (startX - cxA) / (rx || 1));
		const clockwise = state.arcDirection === 2;
		// Arc, ArcTo and Chord explicitly draw a complete ellipse when the
		// effective endpoints coincide. Canvas treats equal angles as empty.
		// Pie's same-ray case remains unchanged pending a native reference.
		// https://learn.microsoft.com/windows/win32/api/wingdi/nf-wingdi-arc
		// https://learn.microsoft.com/windows/win32/api/wingdi/nf-wingdi-arcto
		// https://learn.microsoft.com/windows/win32/api/wingdi/nf-wingdi-chord
		const fullEllipse = recType !== EMR_PIE && rx > 0 && ry > 0 && sameEllipseRay(l, t, r, b, startX, startY, endX, endY);
		const endAngle = fullEllipse
			? startAngle + (clockwise ? 2 : -2) * Math.PI
			: Math.atan2((endY - cyA) / (ry || 1), (endX - cxA) / (rx || 1));
		const rotated = hasWorldRotation(rCtx);
		const unframed = fixBox(rCtx, l, t, r, b);
		if (recType !== EMR_ARCTO && insideFramePenTooWide(rCtx, unframed)) {
			return true;
		}
		const inset = insideFrameInset(rCtx, unframed, false, rCtx.state.arcDirection === 2);
		const framed = inset ? insetFixBox(unframed, inset) : unframed;
		const params = inset
			? { cx: (framed.ax + framed.exx / 2) / 16, cy: (framed.ay + framed.eyy / 2) / 16, rx: Math.abs(framed.exx) / 32, ry: Math.abs(framed.eyy) / 32, rotation: 0 }
			: rotated
				? gdiEllipseParams(rCtx, cxA, cyA, rx, ry)
				: {
						cx: gmx(rCtx, cxA),
						cy: gmy(rCtx, cyA),
						rx: Math.abs(gmw(rCtx, rx)),
						ry: Math.abs(gmh(rCtx, ry)),
						rotation: 0,
					};
		const isArcTo = recType === EMR_ARCTO;
		const needsFill = recType === EMR_PIE || recType === EMR_CHORD;
		// AD_COUNTERCLOCKWISE (GDI's default) runs counter-clockwise on screen,
		// i.e. towards decreasing Canvas angles (y grows downwards).
		const startPoint = rotated
			? gmapPoint(rCtx, cxA + rx * Math.cos(startAngle), cyA + ry * Math.sin(startAngle))
			: { x: params.cx + params.rx * Math.cos(startAngle), y: params.cy + params.ry * Math.sin(startAngle) };
		const build = (c: CanvasContext) => {
			if (recType === EMR_PIE) {
				c.moveTo(params.cx, params.cy);
			} else if (!isArcTo && inPath) {
				// Arc and Chord start a separate figure, unlike ArcTo.
				c.moveTo(startPoint.x, startPoint.y);
			}
			if (isArcTo) {
				if (!inPath) {
					const from = currentFix(rCtx);
					c.moveTo(from[0] / 16, from[1] / 16);
				}
				c.lineTo(startPoint.x, startPoint.y);
			}
			c.ellipse(params.cx, params.cy, params.rx, params.ry, params.rotation, startAngle, endAngle, !clockwise);
			if (needsFill) {
				c.closePath();
			}
		};
		const kind: ArcKind = isArcTo ? 'arcto' : recType === EMR_PIE ? 'pie' : recType === EMR_CHORD ? 'chord' : 'arc';
		// Windows measures a radial's angle in logical space, as the fraction of the record's box it sits at, and carries that
		// fraction onto the device box it draws (an inside-frame pen's smaller box, a curved shape's grown one). A radial
		// rounded to FIX first moves by up to half a FIX against the box, which flips points of an arc under a map whose
		// ratio is not a multiple of 1/16 (the 3,600 native playback paths of `compat-playback-paths.json.gz`).
		const radialOnBox = (box: FixBox, x: number, y: number): [number, number] => {
			const wl = r - l;
			const hl = b - t;
			if (wl === 0 || hl === 0) {
				return fixPoint(rCtx, x, y);
			}
			const u = (x - l) / wl;
			const v = (y - t) / hl;
			return [box.ax + box.exx * u + box.eyx * v, box.ay + box.exy * u + box.eyy * v];
		};
		// A map that mirrors an axis: GDI writes the box corners in device order, so the record of a mirrored map often stores a box
		// (`l > r` or `t > b`) whose own orientation is already undone, and the direction it records is that of the DC that played
		// it. The shape is Windows' logical one mapped point by point, which `arcRasterPath` rebuilds from the map's mirroring
		// (the box's own signs mean nothing). A rotated or sheared map has no mirroring to name: the arc runs the other way on
		// screen when its determinant is negative, which `arcRasterPath` applies from the box, so the map's is applied net of it.
		const devM = gdiDeviceMatrix(rCtx);
		const mapFlips = devM[0] * devM[3] - devM[1] * devM[2] < 0;
		const axisMap = devM[1] === 0 && devM[2] === 0;
		const rasterArgs = (immediate = false) => {
			const box = inset ? framed : immediate && needsFill ? curvedFixBox(rCtx, l, t, r, b) : unframed;
			const boxFlips = box.exx * box.eyy - box.exy * box.eyx < 0;
			const mirror = axisMap && isAxisBox(box) ? { x: devM[0] < 0, y: devM[3] < 0 } : undefined;
			return {
				box,
				mirror,
				clockwise: mirror ? clockwise : clockwise !== (mapFlips !== boxFlips),
				s: radialOnBox(box, startX, startY),
				// Device FIX rounding can separate distinct radial points on the
				// same logical ray. Preserve their proven endpoint identity.
				e: fullEllipse ? radialOnBox(box, startX, startY) : radialOnBox(box, endX, endY),
				from: currentFix(rCtx),
			};
		};
		if (inPath) {
			if (isArcTo) {
				continueFigure(rCtx);
			}
			build(gdiPathRecorder(rCtx));
			const a = rasterArgs();
			arcRasterPath(a.box, a.s, a.e, a.clockwise, kind, a.from, rasterPathOf(rCtx), a.mirror);
			if (needsFill) {
				rasterPathOf(rCtx).closeFigure();
			}
		} else {
			resetLineStyle(rCtx);
			ctx.beginPath();
			paintGdiShape(rCtx, {
				build: (c: CanvasContext) => {
					c.beginPath();
					build(c);
				},
				raster: () => {
					const a = rasterArgs(true);
					return arcRasterPath(a.box, a.s, a.e, a.clockwise, kind, a.from, undefined, a.mirror).path;
				},
				fill: needsFill,
				stroke: true,
			});
		}
		if (isArcTo) {
			// GDI leaves the current position at the arc's end point truncated
			// to its device pixel (the 28.4 end point floored to whole pixels,
			// measured with GetCurrentPositionEx under a 1/16 world scale), and
			// the next LineTo starts exactly there (inside a path the next segment
			// continues from the unrounded end point).
			const a = rasterArgs();
			const end = arcRasterPath(a.box, a.s, a.e, a.clockwise, 'arc', undefined, undefined, a.mirror).end;
			const dx = Math.floor(end[0] / 16);
			const dy = Math.floor(end[1] / 16);
			const inv = invertAffine(gdiDeviceMatrix(rCtx));
			if (inv) {
				state.curX = Math.round(inv[0] * dx + inv[2] * dy + inv[4]);
				state.curY = Math.round(inv[1] * dx + inv[3] * dy + inv[5]);
			} else {
				state.curX = Math.round(cxA + rx * Math.cos(endAngle));
				state.curY = Math.round(cyA + ry * Math.sin(endAngle));
			}
			rCtx.curFix = inPath
				? { x: end[0], y: end[1], lx: state.curX, ly: state.curY }
				: { x: dx * 16, y: dy * 16, lx: state.curX, ly: state.curY };
		}
	}
	return true;
}

/**
 * EMR_ANGLEARC (41): a straight line from the current position to the
 * circle's point at `eStartAngle` degrees (counter-clockwise from the
 * x axis, y up), then the circular arc of `eSweepAngle` degrees
 * (counter-clockwise when positive, whatever the arc direction; a sweep of
 * a full turn or more draws the whole circle first), leaving the current
 * position at the arc's end. The arc's Beziers are GDI's own
 * (`angleArcBeziers`), built in logical space and mapped to device FIX.
 */
function handleAngleArc(rCtx: EmfGdiReplayCtx, dataOff: number, recSize: number): boolean {
	const { view, state, inPath } = rCtx;
	if (recSize < 28) {
		return true;
	}
	const cx = view.getInt32(dataOff, true);
	const cy = view.getInt32(dataOff + 4, true);
	const radius = view.getUint32(dataOff + 8, true);
	const startDeg = view.getFloat32(dataOff + 12, true);
	const sweepDeg = view.getFloat32(dataOff + 16, true);
	if (!Number.isFinite(startDeg) || !Number.isFinite(sweepDeg) || radius > 0x7fffffff) {
		return true;
	}
	const a0 = (startDeg * Math.PI) / 180;
	const a1 = ((startDeg + sweepDeg) * Math.PI) / 180;
	const sx = cx + radius * Math.cos(a0);
	const sy = cy - radius * Math.sin(a0);
	const ex = cx + radius * Math.cos(a1);
	const ey = cy - radius * Math.sin(a1);
	const clockwise = sweepDeg < 0;
	const turns = Math.min(8, Math.trunc(Math.abs(sweepDeg) / 360));
	const circleBox = fixBox(rCtx, cx - radius, cy - radius, cx + radius, cy + radius);
	let fixPts: number[];
	if (isAxisBox(circleBox)) {
		fixPts = angleArcFix(circleBox, startDeg, sweepDeg);
	} else {
		// Rotated or skewed: the circular-arc Beziers built in logical space
		// and mapped (GDI's whole-quadrant rounding has no upright frame here).
		fixPts = [...fixPoint(rCtx, cx + radius * Math.cos(a0), cy - radius * Math.sin(a0))];
		for (const p of angleArcPieces(startDeg, sweepDeg)) {
			const bz = circularArcBezier(cx, cy, radius, radius, p.from, p.to);
			for (let i = 0; i < 6; i += 2) {
				fixPts.push(...fixPoint(rCtx, bz[i], bz[i + 1]));
			}
		}
	}
	const e: [number, number] = [fixPts[fixPts.length - 2], fixPts[fixPts.length - 1]];
	/** Appends the line from the current position `from` and the arc(s) to `path`. */
	const buildRaster = (path: GdiRasterPath, from: [number, number]): void => {
		path.continueAt(from[0], from[1]);
		path.addBeziers(fixPts, false);
	};
	const params = gdiEllipseParams(rCtx, cx, cy, radius, radius);
	const startPx = gmapPoint(rCtx, sx, sy);
	/** Canvas geometry: local ellipse angles run clockwise on screen (y down). */
	const buildCanvas = (c: CanvasContext): void => {
		c.lineTo(startPx.x, startPx.y);
		if (radius === 0) {
			return;
		}
		const span = Math.min(Math.abs(a1 - a0), Math.PI * 2 * (turns + 1));
		c.ellipse(params.cx, params.cy, params.rx, params.ry, params.rotation, -a0, clockwise ? -a0 + span : -a0 - span, !clockwise);
	};
	if (inPath) {
		continueFigure(rCtx);
		buildCanvas(gdiPathRecorder(rCtx));
		buildRaster(rasterPathOf(rCtx), currentFix(rCtx));
	} else {
		resetLineStyle(rCtx);
		const from = currentFix(rCtx);
		const fromPx = gmapPoint(rCtx, state.curX, state.curY);
		paintGdiShape(rCtx, {
			build: (c: CanvasContext) => {
				c.beginPath();
				c.moveTo(fromPx.x, fromPx.y);
				buildCanvas(c);
			},
			raster: () => {
				const path = new GdiRasterPath();
				buildRaster(path, from);
				return path;
			},
			fill: false,
			stroke: true,
		});
	}
	// The current position: the arc's end, truncated to its device pixel as
	// ArcTo leaves it (exact inside a path).
	const dx = Math.floor(e[0] / 16);
	const dy = Math.floor(e[1] / 16);
	const inv = invertAffine(gdiDeviceMatrix(rCtx));
	state.curX = inv ? Math.round(inv[0] * dx + inv[2] * dy + inv[4]) : Math.round(ex);
	state.curY = inv ? Math.round(inv[1] * dx + inv[3] * dy + inv[5]) : Math.round(ey);
	rCtx.curFix = inPath ? { x: e[0], y: e[1], lx: state.curX, ly: state.curY } : { x: dx * 16, y: dy * 16, lx: state.curX, ly: state.curY };
	return true;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export function handleEmfGdiShapeRecord(
	rCtx: EmfGdiReplayCtx,
	recType: number,
	dataOff: number,
	recSize: number,
): boolean {
	switch (recType) {
		case EMR_SETPIXELV:
			return handleSetPixelV(rCtx, dataOff, recSize);
		case EMR_MOVETOEX:
			return handleMoveToEx(rCtx, dataOff, recSize);
		case EMR_LINETO:
			return handleLineTo(rCtx, dataOff, recSize);
		case EMR_RECTANGLE:
			return handleRectangle(rCtx, dataOff, recSize);
		case EMR_ROUNDRECT:
			return handleRoundRect(rCtx, dataOff, recSize);
		case EMR_ELLIPSE:
			return handleEllipse(rCtx, dataOff, recSize);
		case EMR_ANGLEARC:
			return handleAngleArc(rCtx, dataOff, recSize);
		case EMR_ARC:
		case EMR_ARCTO:
		case EMR_CHORD:
		case EMR_PIE:
			return handleArcFamily(rCtx, recType, dataOff, recSize);
		default:
			return false;
	}
}
