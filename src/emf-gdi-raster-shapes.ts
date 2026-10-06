/**
 * Builds GDI's own device geometry for EMF shape records and paints it with
 * the GDI rasteriser (`gdi-raster.ts`) instead of Canvas, for
 * `gdiAntialias: false` and for every fill or stroke that has to be exact
 * per pixel in the default mode too (a pattern brush, a bitwise `SetROP2`
 * mode).
 *
 * Coordinates. A logical point goes to device space the way GDI maps it:
 * the linear part of the full logical-to-device matrix and its translation
 * are each rounded to 28.4 fixed point (FIX, 1/16 pixel) separately and then
 * added ({@link fixPoint}; verified against 1000 lines under random rotated
 * and scaled world transforms, all pixel exact). Device pixel `x` of GDI is
 * canvas pixel `x` here (the replay already maps device space onto the
 * canvas, `emf-gdi-coord.ts`), so FIX `16 * x` is that pixel's centre.
 *
 * Boxes. EMF records carry GM_ADVANCED boxes, inclusive on every side (the
 * recorder already converted a GM_COMPATIBLE call's exclusive right/bottom
 * edge; Windows plays EMFs back the same way). A box becomes a
 * parallelogram {@link FixBox} from three transformed corners, the fourth
 * implied (`C = B + D - A`, which is how GDI builds a rotated Rectangle's
 * path: confirmed by `GetPath`).
 *
 * @module emf-gdi-raster-shapes
 */

import { hatchBit, realizeBrush } from './emf-gdi-brush-pattern';
import { gdiDeviceMatrix } from './emf-gdi-coord';
import { paintSpansDeferred, type RasterPaint } from './emf-gdi-raster-paint';
import type { EmfGdiReplayCtx } from './emf-types';
import {
	arcBeziers,
	cosmeticStyle,
	geometricStyle,
	ellipseBeziersBox,
	fillPathSpans,
	fillPolygonSpans,
	GdiRasterPath,
	KAPPA,
	roundRectCorners,
	SpanList,
	strokeCosmetic,
	styleGapsUseBackground,
	type FixBox,
	type StyleState,
} from './gdi-raster';
import { widenPath, type WidenOptions } from './gdi-raster-widen';

/** Packs a `#rrggbb` string. */
function rgbOf(color: string): number {
	const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
	return m ? parseInt(m[1], 16) : 0;
}

/** True when the GDI rasteriser paints every vector shape (`gdiAntialias: false`). */
export function useGdiRaster(rCtx: EmfGdiReplayCtx): boolean {
	return rCtx.gdiAntialias === false;
}

/** Maps a logical point to device FIX, rounding the linear part and the translation separately, as GDI does. */
export function fixPoint(rCtx: EmfGdiReplayCtx, x: number, y: number): [number, number] {
	const m = gdiDeviceMatrix(rCtx);
	const fx = Math.round((m[0] * x + m[2] * y) * 16) + Math.round(m[4] * 16);
	const fy = Math.round((m[1] * x + m[3] * y) * 16) + Math.round(m[5] * 16);
	const whole = rCtx.wholeDevicePixels;
	if (whole) {
		// GM_COMPATIBLE (every WMF): points land on whole device pixels.
		const ux = 16 * whole[0];
		const uy = 16 * whole[1];
		return [Math.round(Math.floor(fx / ux + 0.5) * ux), Math.round(Math.floor(fy / uy + 0.5) * uy)];
	}
	return [fx, fy];
}

/** The device parallelogram of the inclusive logical box `l, t, r, b`. */
export function fixBox(rCtx: EmfGdiReplayCtx, l: number, t: number, r: number, b: number): FixBox {
	const [ax, ay] = fixPoint(rCtx, l, t);
	const [bx, by] = fixPoint(rCtx, r, t);
	const [dx, dy] = fixPoint(rCtx, l, b);
	return { ax, ay, exx: bx - ax, exy: by - ay, eyx: dx - ax, eyy: dy - ay };
}

/** True when `box` is an axis-aligned rectangle (no rotation or skew). */
export function isAxisBox(box: FixBox): boolean {
	return box.exy === 0 && box.eyx === 0;
}

/** The corners of `box` in GDI's Rectangle path order: (right, top), (left, top), (left, bottom), (right, bottom). */
function boxCorners(box: FixBox): number[] {
	const { ax, ay, exx, exy, eyx, eyy } = box;
	return [ax + exx, ay + exy, ax, ay, ax + eyx, ay + eyy, ax + exx + eyx, ay + exy + eyy];
}

/**
 * `box` reflected top to bottom: its logical top edge becomes its bottom.
 * GDI builds a Rectangle or RoundRect under `AD_CLOCKWISE` as the
 * counter-clockwise path of this box (Windows' `GetPath`, Wine
 * `gdi32/tests/path.c`, `test_rectangle` and `test_roundrect`).
 */
function flipBox(box: FixBox): FixBox {
	return { ax: box.ax + box.eyx, ay: box.ay + box.eyy, exx: box.exx, exy: box.exy, eyx: -box.eyx, eyy: -box.eyy };
}

/**
 * GDI's Rectangle path: one closed figure, from the (logical) top right
 * corner towards the top left, or with `clockwise` (`AD_CLOCKWISE`) from
 * the bottom right towards the bottom left.
 */
export function rectRasterPath(box: FixBox, clockwise = false): GdiRasterPath {
	const c = boxCorners(clockwise ? flipBox(box) : box);
	if (box.halfXRect) {
		c[4]--;
		c[6]--;
	}
	const path = new GdiRasterPath();
	path.moveTo(c[0], c[1]);
	path.lineTo(c[2], c[3]);
	path.lineTo(c[4], c[5]);
	path.lineTo(c[6], c[7]);
	path.closeFigure();
	return path;
}

/** GDI's Ellipse path (four Beziers, flattened), clockwise under `AD_CLOCKWISE`. */
export function ellipseRasterPath(box: FixBox, clockwise = false): GdiRasterPath {
	const path = new GdiRasterPath();
	path.addBeziers(ellipseBeziersBox(box, clockwise), true);
	path.closeFigure();
	path.figures[0].roundWiden = true;
	return path;
}

/**
 * Maps points computed in an axis-aligned frame `l..r` x `t..b` onto `box`
 * (identity for an axis-aligned box): `(x, y)` becomes
 * `A + ex (x - l) / w + ey (y - t) / h`, rounded to FIX.
 */
function frameMapper(box: FixBox, l: number, t: number, w: number, h: number): (x: number, y: number) => [number, number] {
	if (isAxisBox(box)) {
		return (x, y) => [x, y];
	}
	return (x, y) => {
		const u = w !== 0 ? (x - l) / w : 0;
		const v = h !== 0 ? (y - t) / h : 0;
		return [Math.round(box.ax + box.exx * u + box.eyx * v), Math.round(box.ay + box.exy * u + box.eyy * v)];
	};
}

/**
 * The axis-aligned frame an axis box's GDI geometry is computed in: its
 * inclusive extent, normalised so `l <= r` and `t <= b`. A rotated box uses
 * the lengths of its edge vectors instead and {@link frameMapper} carries
 * the result onto the parallelogram.
 */
function boxFrame(box: FixBox): { l: number; t: number; r: number; b: number } {
	if (isAxisBox(box)) {
		const x0 = box.ax;
		const x1 = box.ax + box.exx;
		const y0 = box.ay;
		const y1 = box.ay + box.eyy;
		return { l: Math.min(x0, x1), t: Math.min(y0, y1), r: Math.max(x0, x1), b: Math.max(y0, y1) };
	}
	const w = Math.round(Math.hypot(box.exx, box.exy));
	const h = Math.round(Math.hypot(box.eyx, box.eyy));
	return { l: 0, t: 0, r: w, b: h };
}

/**
 * GDI's RoundRect path; `cw`/`ch` are the corner ellipse's device extents
 * (FIX). With `clockwise` (`AD_CLOCKWISE`) the counter-clockwise path is
 * reflected top to bottom, so it starts at the lower end of the right edge.
 * `rectangle` (the call's logical corner width or height is 0) gives the
 * Rectangle path instead; a corner that is merely under a pixel keeps its
 * (degenerate) Beziers (Windows' `GetPath`, Wine `gdi32/tests/path.c`,
 * `test_roundrect`).
 */
export function roundRectDeviceBeziers(box: FixBox, cw: number, ch: number, clockwise = false, compatible = false): number[] {
	const f = boxFrame(box);
	const q = roundRectCorners(f.l, f.t, f.r, f.b, cw, ch, compatible, clockwise);
	const map = frameMapper(box, f.l, f.t, f.r - f.l, f.b - f.t);
	const pts: number[] = [];
	for (let i = 0; i < q.length; i += 2) {
		pts.push(...map(q[i], clockwise ? f.t + f.b - q[i + 1] : q[i + 1]));
	}
	if (box.halfX) {
		// An odd inside-frame pen width (see `FixBox.halfX`).
		if (box.halfXCompat || !clockwise) {
			const cy = (f.t + f.b) / 2;
			const ry = (f.b - f.t) / 2 || 1;
			for (let k = 0; k < 16; k++) {
				const v = (cy - pts[2 * k + 1]) / ry;
				// A tie at the top rounds down (native GetPath, translation sweep: v = 0.5 exactly).
				pts[2 * k] += k >= 8 ? Math.round(1 + v) : Math.ceil(v - 0.5);
			}
		} else {
			// Clockwise: the half first drawn, but its two end points stay when the corner is at least half the box high
			// (native GetPath).
			const tall = box.cornerExact !== undefined && box.cornerExact[1] * 2 >= Math.abs(box.eyy) - 1e-9;
			for (const k of tall ? [1, 2, 3, 4, 5, 6, 8, 15] : [0, 1, 2, 3, 4, 5, 6, 7]) {
				pts[2 * k]++;
			}
		}
	}
	if (box.cornerExact && isAxisBox(box)) {
		// An inside-frame pen's RoundRect: the edge end points and controls round from the unrounded corner scaled onto
		// the box (native GetPath, 2,000 shapes at six scales in GM_ADVANCED and 1,500 at the WMF 0.96 scale, all exact):
		// horizontally onto the width made even upwards (the top edge of an odd width a FIX right of the bottom's),
		// vertically onto the height made even downwards.
		const w = f.r - f.l;
		const h = f.b - f.t;
		if (w >= 0 && h >= 0) {
			const hx = w === 0 ? 0 : Math.round((box.cornerExact[0] * (w + (w % 2))) / w / 2);
			const hy = h === 0 ? 0 : Math.round((box.cornerExact[1] * (clockwise ? h + (h % 2) : h - (h % 2))) / h / 2);
			const hc = Math.ceil(KAPPA * hx);
			const vc = clockwise ? Math.ceil(KAPPA * hy) : Math.floor(KAPPA * hy);
			const set = (k: number, x: number | null, y: number) => {
				if (x !== null) pts[2 * k] = x;
				pts[2 * k + 1] = clockwise ? f.t + f.b - y : y;
			};
			const a = box.halfX ? 1 : 0;
			set(0, null, f.t + hy);
			set(1, null, f.t + hy - vc);
			set(2, f.r + a - hx + hc, f.t);
			set(3, f.r + a - hx, f.t);
			set(4, f.l + a + hx, f.t);
			set(5, f.l + a + hx - hc, f.t);
			set(6, null, f.t + hy - vc);
			set(7, null, f.t + hy);
			set(8, null, f.b - hy);
			set(9, null, f.b - hy + vc);
			set(10, f.l + hx - hc, f.b);
			set(11, f.l + hx, f.b);
			set(12, f.r - hx, f.b);
			set(13, f.r - hx + hc, f.b);
			set(14, null, f.b - hy + vc);
			set(15, null, f.b - hy);
		}
	}
	return pts;
}

export function roundRectRasterPath(box: FixBox, cw: number, ch: number, clockwise = false, rectangle = false, compatible = false): GdiRasterPath {
	if (rectangle) return rectRasterPath(box, clockwise);
	const pts = roundRectDeviceBeziers(box, cw, ch, clockwise, compatible);
	const path = new GdiRasterPath();
	for (let c = 0; c < 4; c++) {
		const o = c * 8;
		path.addBeziers(pts.slice(o, o + 8), c === 0);
	}
	path.closeFigure();
	return path;
}

/** Which arc-family record a path is built for. */
export type ArcKind = 'arc' | 'arcto' | 'chord' | 'pie';

/**
 * GDI's Arc/ArcTo/Chord/Pie path on `box` between the radials through the
 * device FIX points `s` and `e`. `ArcTo` starts with a line from `from`
 * (the current position); `Pie` closes through the centre, `Chord` closes
 * straight. Returns the path and the arc's end point (the new current
 * position for `ArcTo`).
 */
export function arcRasterPath(
	box: FixBox,
	s: [number, number],
	e: [number, number],
	clockwise: boolean,
	kind: ArcKind,
	from?: [number, number],
	path: GdiRasterPath = new GdiRasterPath(),
): { path: GdiRasterPath; end: [number, number] } {
	const f = boxFrame(box);
	const map = frameMapper(box, f.l, f.t, f.r - f.l, f.b - f.t);
	let sx = s[0];
	let sy = s[1];
	let ex = e[0];
	let ey = e[1];
	let cw = clockwise;
	if (!isAxisBox(box)) {
		// Express the radials in the box frame.
		const det = box.exx * box.eyy - box.exy * box.eyx || 1;
		const toFrame = (px: number, py: number): [number, number] => {
			const qx = px - box.ax;
			const qy = py - box.ay;
			const u = (qx * box.eyy - qy * box.eyx) / det;
			const v = (box.exx * qy - box.exy * qx) / det;
			return [f.l + u * (f.r - f.l), f.t + v * (f.b - f.t)];
		};
		[sx, sy] = toFrame(sx, sy);
		[ex, ey] = toFrame(ex, ey);
		if (det < 0) {
			cw = !cw;
		}
	} else {
		// A mirrored axis box reverses the on-screen direction.
		if ((box.exx < 0) !== (box.eyy < 0)) {
			cw = !cw;
		}
	}
	const bz = arcBeziers(f.l, f.t, f.r, f.b, sx, sy, ex, ey, cw, !!box.halfX, !!box.framed);
	const pts: number[] = [];
	for (let i = 0; i < bz.length; i += 2) {
		pts.push(...map(bz[i], bz[i + 1]));
	}
	if (kind === 'arcto' && from) {
		path.continueAt(from[0], from[1]);
		path.addBeziers(pts, false);
	} else {
		path.addBeziers(pts, true);
	}
	if (kind === 'pie') {
		const w = f.r - f.l;
		const h = f.b - f.t;
		const [cx, cy] = map(f.l + Math.ceil(w / 2) + (box.halfX ? 1 : 0), f.t + Math.ceil(h / 2));
		path.lineTo(cx, cy);
	}
	if (kind === 'pie' || kind === 'chord') {
		path.closeFigure();
	}
	return { path, end: [pts[pts.length - 2], pts[pts.length - 1]] };
}

// ---------------------------------------------------------------------------
// Pens
// ---------------------------------------------------------------------------

/** `PS_NULL`. */
const PS_NULL = 5;
/** `PS_TYPE_MASK` bit for a geometric pen (`PS_GEOMETRIC`). */
const PS_GEOMETRIC = 0x10000;

/** The pen's width in device pixels (its logical width scaled by the transform). */
export function penDeviceWidth(rCtx: EmfGdiReplayCtx): number {
	const m = gdiDeviceMatrix(rCtx);
	const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
	const whole = rCtx.wholeDevicePixels;
	if (whole) {
		// GM_COMPATIBLE: a whole number of device pixels.
		return Math.round((rCtx.state.penWidth * scale) / whole[0]) * whole[0];
	}
	return rCtx.state.penWidth * scale;
}

/**
 * True when the current pen draws GDI's one-pixel cosmetic line: a
 * `PS_COSMETIC` extended pen, or any pen whose width maps to at most one
 * device pixel.
 */
export function penIsCosmetic(rCtx: EmfGdiReplayCtx): boolean {
	const flags = rCtx.state.penFlags ?? rCtx.state.penStyle;
	if ((flags & PS_GEOMETRIC) === 0 && rCtx.state.penExtended) {
		return true;
	}
	// GDI rounds the transformed width to whole pixels (a unit-scale rotation
	// gives 1.00000003 in float arithmetic; that is still a one-pixel pen).
	// (Under whole device pixels a canvas pixel may be a fraction of one.)
	return Math.round(penDeviceWidth(rCtx) / (rCtx.wholeDevicePixels?.[0] ?? 1)) <= 1;
}

/**
 * True when the current pen draws at all (not `PS_NULL`). A wide pen is
 * widened by the rasteriser itself (`gdi-raster-widen.ts`) for every cap,
 * join and geometric style.
 */
export function penIsWidened(rCtx: EmfGdiReplayCtx): boolean {
	return (rCtx.state.penStyle & 0x0f) !== PS_NULL;
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

/**
 * The outline options GDI widens a path with for the current (geometric)
 * pen: its device width, caps and joins (a `CreatePen` pen is round; see
 * {@link RasterPaintOptions} for the record-level exceptions), miter
 * limit and geometric dash pattern. Shared by stroking and EMR_WIDENPATH.
 */
export function penWidenOptions(rCtx: EmfGdiReplayCtx, opts: { rectangle?: boolean; roundPen?: boolean } = {}): WidenOptions {
	const { state } = rCtx;
	const flags = state.penFlags ?? state.penStyle;
	const matrix = gdiDeviceMatrix(rCtx);
	const widthPx = rCtx.wholeDevicePixels && (flags & 0xf) === 6
		? state.penWidth * Math.sqrt(Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]))
		: penDeviceWidth(rCtx);
	const capBits = flags & 0xf00;
	const joinBits = flags & 0xf000;
	// Unequal axis scales form an elliptical nib. Its device ellipse is
	// flattened before the stroke's sides/caps are selected, as WidenPath
	// controls show. A dashed pen lays its pattern out in logical space
	// (native WidenPath, 2,160 outlines): the dashes are in logical units and
	// each segment is measured by its logical length (`dashMetric`).
	const ellipse = !rCtx.wholeDevicePixels &&
		state.penWidth * Math.abs(matrix[0]) * 16 >= 1 && state.penWidth * Math.abs(matrix[3]) * 16 >= 1 &&
		Math.abs(matrix[1]) < 1e-6 && Math.abs(matrix[2]) < 1e-6 &&
		Math.abs(Math.abs(matrix[0]) - Math.abs(matrix[3])) > 1e-6;
	// A rotated or sheared matrix that is not a rotation with a uniform scale: the pen is a circle in logical space.
	const det = matrix[0] * matrix[3] - matrix[1] * matrix[2];
	const rotatedOrSheared = Math.abs(matrix[1]) >= 1e-6 || Math.abs(matrix[2]) >= 1e-6;
	// A quarter turn (the diagonal is zero) keeps the uniform device-space pen.
	const quarterTurn = Math.abs(matrix[0]) < 1e-9 && Math.abs(matrix[3]) < 1e-9;
	const general =
		!rCtx.wholeDevicePixels && rotatedOrSheared && !quarterTurn && Math.abs(det) > 1e-9 && state.penWidth * Math.sqrt(Math.abs(det)) * 16 >= 1;
	const dashes = state.penExtended
		? ellipse || general
			? geometricStyle(flags, state.penWidth, state.penUserStyle, 1)
			: geometricStyle(flags, widthPx, state.penUserStyle, widthPx / (state.penWidth || 1))
		: null;
	const dashMetric = ellipse && dashes ? ([Math.abs(matrix[0]), Math.abs(matrix[3])] as [number, number]) : undefined;
	if (general) {
		return {
			width: Math.round(state.penWidth * 16),
			matrix: [matrix[0], matrix[1], matrix[2], matrix[3]],
			deviceNib: true,
			cap: opts.roundPen || !state.penExtended || capBits === 0 ? 'round' : capBits === 0x100 ? 'square' : 'flat',
			join: opts.roundPen
				? 'round'
				: opts.rectangle && !state.penExtended
					? 'miter'
					: !state.penExtended || joinBits === 0
						? 'round'
						: joinBits === 0x1000
							? 'bevel'
							: 'miter',
			miterLimit: state.miterLimit ?? 10,
			dashes: dashes ? dashes.map((v) => v * 16) : null,
			shortenDashes: (flags & 0x0f) !== 7,
		};
	}
	return {
		width: Math.round((ellipse ? state.penWidth * Math.abs(matrix[0]) : widthPx) * 16),
		...(ellipse ? { height: Math.round(state.penWidth * Math.abs(matrix[3]) * 16) } : {}),
		cap: opts.roundPen || !state.penExtended || capBits === 0 ? 'round' : capBits === 0x100 ? 'square' : 'flat',
		join: opts.roundPen
			? 'round'
			: opts.rectangle && !state.penExtended
				? 'miter'
				: !state.penExtended || joinBits === 0
					? 'round'
					: joinBits === 0x1000
						? 'bevel'
						: 'miter',
		miterLimit: state.miterLimit ?? 10,
		dashes: dashes ? dashes.map((v) => v * 16) : null,
		...(dashMetric ? { dashMetric } : {}),
		shortenDashes: (flags & 0x0f) !== 7,
		// One logical unit per device pixel, unrotated: GDI measures dash
		// segments in whole pixels.
		wholePixelDashVectors:
			Math.abs(matrix[0] - 1) < 1e-6 && Math.abs(matrix[3] - 1) < 1e-6 && Math.abs(matrix[1]) < 1e-6 && Math.abs(matrix[2]) < 1e-6,
	};
}

/** The 8x8 mask of a hatch's background pixels (1), which GDI leaves alone in `TRANSPARENT` mode. */
function hatchBackgroundMask(hatch: number): Uint8Array {
	const m = new Uint8Array(64);
	for (let y = 0; y < 8; y++) {
		for (let x = 0; x < 8; x++) {
			m[y * 8 + x] = hatchBit(hatch, x, y) ? 0 : 1;
		}
	}
	return m;
}

/**
 * The paint for the current brush, or `null` for a hollow brush. A hatch
 * brush under the `TRANSPARENT` background mode paints only its lines
 * (GDI fills shapes and regions that way; blits ignore the mode).
 */
export function brushPaint(rCtx: EmfGdiReplayCtx): RasterPaint | null {
	const realized = realizeBrush(rCtx.state);
	if (realized.kind === 'none') {
		return null;
	}
	if (realized.kind === 'solid') {
		return { kind: 'solid', rgb: realized.rgb };
	}
	const sx = rCtx.sx || 1;
	const sy = rCtx.sy || 1;
	const { bounds, state } = rCtx;
	return {
		kind: 'tile',
		tile: realized,
		toDevice: (x, y) => [Math.floor(bounds.left + (x + 0.5) / sx), Math.floor(bounds.top + (y + 0.5) / sy)],
		orgX: state.brushOrgX,
		orgY: state.brushOrgY,
		...(state.bkMode === 1 && state.brushPattern?.kind === 'hatch' ? { skip: hatchBackgroundMask(state.brushPattern.hatch) } : {}),
	};
}

/** Options for {@link paintRasterPath}. */
export interface RasterPaintOptions {
	fill: boolean;
	stroke: boolean;
	/** WINDING (non-zero) instead of ALTERNATE (even-odd) for the fill. */
	winding?: boolean;
	/** The geometry to fill when it differs from the outline (a pen-bordered axis Rectangle's interior). */
	fillPath?: GdiRasterPath | null;
	/** Dash-pattern cursor to continue (consecutive `LineTo` records share one). */
	style?: StyleState;
	/**
	 * `path` is a `Rectangle` record's outline (`rectRasterPath`, which runs
	 * in GDI's own order from the top right corner). GDI strokes it with
	 * miter joins for a wide `CreatePen` pen (measured; an `ExtCreatePen`
	 * pen keeps its own join).
	 */
	rectangle?: boolean;
	/**
	 * `path` is an `Ellipse` or `RoundRect` record's outline: GDI strokes it
	 * with round caps and joins whatever the pen's own (measured).
	 */
	roundPen?: boolean;
	/** The shape was filled with a brush by a separate pass (its stroke is then widened without curve end tangents). */
	filled?: boolean;
}

/**
 * `path` without its Beziers' end tangents. GDI widens a shape it also
 * fills with a brush from the flattened segments alone, where a stroke on
 * its own (or `WidenPath`) takes the curves' end tangents (measured: the
 * native Ellipse, RoundRect, Chord and Pie sweeps with PS_INSIDEFRAME pens).
 */
function withoutCurveTangents(path: GdiRasterPath): GdiRasterPath {
	if (!path.figures.some((f) => f.tangents)) {
		return path;
	}
	const plain = new GdiRasterPath();
	plain.figures = path.figures.map((f) => ({ pts: f.pts, closed: f.closed, roundWiden: f.roundWiden }));
	return plain;
}

/** Applies RTL's pixel-centre reflection to non-box WMF geometry. */
export function layoutRasterPath(rCtx: EmfGdiReplayCtx, path: GdiRasterPath, boxShape = false): GdiRasterPath {
	if (!rCtx.wmfLayoutRtl || boxShape) return path;
	// RTL reflects device pixels about width - 1, while its logical mapping
	// uses width - x. Compatible boxes already account for the excluded edge.
	const shift = Math.round(16 * (rCtx.wholeDevicePixels?.[0] ?? 1));
	const reflected = new GdiRasterPath();
	reflected.figures = path.figures.map((figure) => ({ ...figure, pts: figure.pts.map((v, i) => i % 2 === 0 ? v - shift : v) }));
	return reflected;
}

/**
 * Fills and/or strokes `path` with the current brush and pen, exactly as
 * GDI rasterises it, then combines through the active `SetROP2` mode. The
 * fill is painted first and the outline over it (GDI combines a pixel that
 * both cover twice, except for an axis-aligned Rectangle, whose callers pass
 * the interior as `fillPath`). Returns `false` when the pen is a wide
 * (geometric) pen the rasteriser does not stroke, leaving the stroke to the
 * caller.
 */
export function paintRasterPath(rCtx: EmfGdiReplayCtx, path: GdiRasterPath, opts: RasterPaintOptions): boolean {
	path = layoutRasterPath(rCtx, path, opts.rectangle || opts.roundPen);
	const { ctx, state } = rCtx;
	let filled = !!opts.filled;
	if (opts.fill) {
		const paint = brushPaint(rCtx);
		if (paint) {
			filled = true;
			const fillPath = opts.fillPath ? layoutRasterPath(rCtx, opts.fillPath, opts.rectangle || opts.roundPen) : path;
			const spans = fillPathSpans(fillPath, !!opts.winding);
			paintSpansDeferred(rCtx, spans, paint, state.rop2);
		}
	}
	if (!opts.stroke || state.penStyle === PS_NULL) {
		return true;
	}
	if (!penIsCosmetic(rCtx)) {
		if (!penIsWidened(rCtx)) {
			return false;
		}
		const polys = widenPath(filled ? withoutCurveTangents(path) : path, penWidenOptions(rCtx, opts));
		paintSpansDeferred(rCtx, fillPolygonSpans(polys, true), { kind: 'solid', rgb: rgbOf(state.penColor) }, state.rop2);
		return true;
	}
	const pattern = cosmeticStyle(state.penFlags ?? state.penStyle, state.penUserStyle);
	const on = new SpanList();
	const gapsBk = pattern !== null && state.bkMode === 2 && styleGapsUseBackground(state.penFlags ?? state.penStyle);
	const off = gapsBk ? new SpanList() : null;
	strokeCosmetic(path, on, off, pattern, opts.style ?? { pos: 0 });
	if (off) {
		paintSpansDeferred(rCtx, off, { kind: 'solid', rgb: rgbOf(state.bkColor) }, state.rop2);
	}
	paintSpansDeferred(rCtx, on, { kind: 'solid', rgb: rgbOf(state.penColor) }, state.rop2);
	return true;
}
