/**
 * Renders parsed EMF+ gradient brushes (MS-EMFPLUS LinearGradientBrushData /
 * PathGradientBrushData) to Canvas 2D paint styles, the way GDI+ paints them.
 *
 * GDI+ defines both brushes in their own "brush space", mapped to world space
 * by the brush transform (which is also where GDI+ encodes a linear
 * gradient's angle, usually as a shear rather than a rotation):
 *
 * - A linear gradient varies along the x axis of its rectangle only. Its
 *   WrapMode repeats that rectangle as a tile (TileFlipX mirrors alternate
 *   columns; TileFlipY mirrors rows, which a horizontal ramp cannot show).
 * - A path gradient interpolates, along each ray from its centre point, from
 *   the boundary polygon's surround colours to the centre colour, shaped by
 *   the boundary itself (not a circle). Clamp paints nothing outside the
 *   boundary; the tile modes repeat the boundary's bounding box.
 *
 * Both are rasterised once into a brush-space tile at device resolution and
 * installed as a `CanvasPattern` whose matrix is the full brush transform,
 * so any angle, shear or scale is exact up to bilinear sampling. The pattern
 * is also offset by half a device pixel: GDI+ (PixelOffsetMode None) samples
 * a pixel at its integer coordinate, Canvas at its centre.
 *
 * For a path gradient that pattern is now the FALLBACK paint only: every
 * tested canvas backend filters a `CanvasPattern` even at an identity
 * matrix, which left a residual at tile seams, so shape fills go through
 * the exact per-device-pixel path in `emf-plus-exact-fill.ts` (built on
 * {@link pathGradientColorAt}). Linear gradients stay a plain
 * `CanvasGradient`, which is already exact.
 *
 * @module emf-plus-brush-gradient
 */

import {
	canvasCreatePattern,
	canvasPutImageData,
	createImageDataCompat,
	createTempCanvas,
} from './emf-canvas-helpers';
import { emfLog } from './emf-logging';
import { buildLinearRampTable, linearRampOf, linearRampStops } from './emf-plus-linear-ramp';
import type {
	CanvasContext,
	EmfPlusGradient,
	EmfPlusGradientStop,
	EmfPlusGradientWrapMode,
	EmfPlusLinearGradient,
	EmfPlusPathGradientShape,
	EmfPlusRadialGradient,
	EmfPlusRectF,
	TransformMatrix,
} from './emf-types';

// ---------------------------------------------------------------------------
// Affine helpers
// ---------------------------------------------------------------------------

const IDENTITY: TransformMatrix = [1, 0, 0, 1, 0, 0];

/** `a · b`: apply `b` first, then `a`. */
export function mulMatrix(a: TransformMatrix, b: TransformMatrix): TransformMatrix {
	return [
		a[0] * b[0] + a[2] * b[1],
		a[1] * b[0] + a[3] * b[1],
		a[0] * b[2] + a[2] * b[3],
		a[1] * b[2] + a[3] * b[3],
		a[0] * b[4] + a[2] * b[5] + a[4],
		a[1] * b[4] + a[3] * b[5] + a[5],
	];
}

function invertLinear(m: TransformMatrix): [number, number, number, number] | null {
	const det = m[0] * m[3] - m[1] * m[2];
	if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
		return null;
	}
	return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
}

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

/** Packed ARGB linear interpolation. */
function lerpArgb(a: number, b: number, t: number): number {
	const ch = (shift: number): number => {
		const ca = (a >>> shift) & 0xff;
		const cb = (b >>> shift) & 0xff;
		return Math.round(ca + (cb - ca) * t);
	};
	return ((ch(24) << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0;
}

/** Piecewise-linear lookup of `ys` at `x` over ascending `xs` (clamped at both ends). */
function piecewise(xs: readonly number[], ys: readonly number[], x: number): number {
	const n = Math.min(xs.length, ys.length);
	if (n === 0) {
		return x;
	}
	if (x <= xs[0]) {
		return ys[0];
	}
	for (let i = 1; i < n; i++) {
		if (x <= xs[i]) {
			const span = xs[i] - xs[i - 1];
			const f = span > 0 ? (x - xs[i - 1]) / span : 1;
			return ys[i - 1] + (ys[i] - ys[i - 1]) * f;
		}
	}
	return ys[n - 1];
}

/** Colour of a stop list at `t` (0..1), or null when a stop lacks packed ARGB. */
export function stopColorAt(stops: readonly EmfPlusGradientStop[], t: number): number | null {
	if (stops.length === 0 || stops.some((s) => s.argb === undefined)) {
		return null;
	}
	if (t <= stops[0].offset) {
		return stops[0].argb as number;
	}
	for (let i = 1; i < stops.length; i++) {
		const b = stops[i];
		if (t <= b.offset) {
			const a = stops[i - 1];
			const span = b.offset - a.offset;
			return lerpArgb(a.argb as number, b.argb as number, span > 0 ? (t - a.offset) / span : 1);
		}
	}
	return stops[stops.length - 1].argb as number;
}

// ---------------------------------------------------------------------------
// Path-gradient colour (pure)
// ---------------------------------------------------------------------------

/**
 * The GDI+ path-gradient colour at brush-space point (`x`, `y`), or `null`
 * outside the boundary. The boundary is fanned into triangles
 * (centre, v[i], v[i+1]); inside one, the point sits at fraction `s` of the
 * way from the centre to the boundary (0 = centre, 1 = boundary) and at
 * parameter `u` along the edge. The surround colour interpolates along the
 * edge by `u`, then blends toward the centre colour by the blend curve at
 * position `1 - s` (GDI+ blend positions run boundary 0 to centre 1).
 */
export function pathGradientColorAt(
	shape: EmfPlusPathGradientShape,
	x: number,
	y: number,
): number | null {
	const { center, boundary, boundaryArgb } = shape;
	const n = boundary.length;
	const px = x - center.x;
	const py = y - center.y;
	let found = -1;
	let bestS = 0;
	let bestU = 0;
	const eps = 1e-9;
	for (let i = 0; i < n; i++) {
		const v0 = boundary[i];
		const v1 = boundary[(i + 1) % n];
		const ax = v0.x - center.x;
		const ay = v0.y - center.y;
		const ex = v1.x - v0.x;
		const ey = v1.y - v0.y;
		const det = ax * ey - ay * ex;
		if (Math.abs(det) < 1e-12) {
			continue;
		}
		const alpha = (px * ey - py * ex) / det;
		const beta = (ax * py - ay * px) / det;
		if (alpha < -eps || beta < -eps || beta > alpha + eps || alpha > 1 + eps) {
			continue;
		}
		// Later triangles paint over earlier ones, as GDI+ fills them in order.
		found = i;
		bestS = Math.max(0, alpha);
		bestU = alpha > 0 ? Math.min(1, Math.max(0, beta / alpha)) : 0;
	}
	if (found < 0) {
		return null;
	}
	let s = bestS;
	if (shape.focus) {
		const f = Math.min(0.999, Math.max(0, (shape.focus.x + shape.focus.y) / 2));
		s = s <= f ? 0 : (s - f) / (1 - f);
	}
	const pos = 1 - s;
	if (shape.preset && shape.preset.positions.length > 0) {
		const { positions, argb } = shape.preset;
		if (pos <= positions[0]) {
			return argb[0];
		}
		for (let k = 1; k < positions.length; k++) {
			if (pos <= positions[k]) {
				const span = positions[k] - positions[k - 1];
				return lerpArgb(argb[k - 1], argb[k], span > 0 ? (pos - positions[k - 1]) / span : 1);
			}
		}
		return argb[positions.length - 1];
	}
	const c0 = boundaryArgb[found] ?? shape.centerArgb;
	const c1 = boundaryArgb[(found + 1) % n] ?? c0;
	const surround = lerpArgb(c0, c1, bestU);
	const factor = shape.blend ? piecewise(shape.blend.positions, shape.blend.factors, pos) : pos;
	return lerpArgb(surround, shape.centerArgb, Math.min(1, Math.max(0, factor)));
}

// ---------------------------------------------------------------------------
// Tile rasterisation
// ---------------------------------------------------------------------------

/** Cap on a tile's texel count per axis. */
const MAX_TILE = 2048;

function mirrorFlags(wrap: EmfPlusGradientWrapMode): { x: boolean; y: boolean } {
	return {
		x: wrap === 'tile-flip-x' || wrap === 'tile-flip-xy',
		y: wrap === 'tile-flip-y' || wrap === 'tile-flip-xy',
	};
}

/** How a tile's texels sample the brush (see {@link buildPattern}). */
export interface TileSampling {
	/**
	 * Extra texel offset along x at which texels sample. 0.5 samples each
	 * texel at its right edge, so a point exactly on a period boundary reads
	 * the END of the period, as GDI+ does for a tiled linear gradient.
	 */
	phaseX: number;
	/**
	 * Brush-space lag of a mirrored tile. GDI+ mirrors a path gradient's
	 * rasterised tile texel-for-texel, so the mirrored copy is offset by one
	 * device pixel from a mathematical mirror; linear gradients mirror exactly.
	 */
	lagX: number;
	lagY: number;
}

/**
 * Builds a `CanvasPattern` from a tile of `tw` x `th` texels covering the
 * brush-space rectangle `rect`, with texel colours from `colorAt` (packed
 * ARGB, or null for transparent), mirrored per `wrap`, and mapped to user
 * space through `brush` plus the GDI+ half-pixel offset `delta`.
 */
export function buildPattern(
	ctx: CanvasContext,
	rect: EmfPlusRectF,
	tw: number,
	th: number,
	wrap: EmfPlusGradientWrapMode,
	brush: TransformMatrix,
	delta: { x: number; y: number },
	sampling: TileSampling,
	colorAt: (bx: number, by: number) => number | null,
): CanvasPattern | null {
	if (typeof ctx.createPattern !== 'function') {
		return null;
	}
	const mirror = wrap === 'clamp' ? { x: false, y: false } : mirrorFlags(wrap);
	const w = tw * (mirror.x ? 2 : 1);
	const h = th * (mirror.y ? 2 : 1);
	const temp = createTempCanvas(w, h);
	if (!temp) {
		return null;
	}
	const stepX = rect.w / tw;
	const stepY = rect.h / th;
	// Brush-space offset (from the tile origin) that texel `i` / row `j` samples.
	const offX = (i: number): number => {
		const d = (i % tw) * stepX + (0.5 + sampling.phaseX) * stepX;
		return i < tw ? d : rect.w - sampling.lagX - (d - (0.5 + sampling.phaseX) * stepX) - 0.5 * stepX;
	};
	const offY = (j: number): number => {
		const d = ((j % th) + 0.5) * stepY;
		return j < th ? d : rect.h - sampling.lagY - d;
	};
	const data = new Uint8ClampedArray(w * h * 4);
	for (let j = 0; j < h; j++) {
		const by = rect.y + offY(j);
		for (let i = 0; i < w; i++) {
			const c = colorAt(rect.x + offX(i), by);
			if (c === null) {
				continue;
			}
			const o = (j * w + i) * 4;
			data[o] = (c >>> 16) & 0xff;
			data[o + 1] = (c >>> 8) & 0xff;
			data[o + 2] = c & 0xff;
			data[o + 3] = (c >>> 24) & 0xff;
		}
	}
	canvasPutImageData(temp.ctx, createImageDataCompat(data, w, h), 0, 0);
	const pattern = canvasCreatePattern(ctx, temp.canvas, wrap === 'clamp' ? 'no-repeat' : 'repeat');
	if (!pattern || typeof pattern.setTransform !== 'function') {
		return null;
	}
	const place: TransformMatrix = [stepX, 0, 0, stepY, rect.x + sampling.phaseX * stepX, rect.y];
	const m = mulMatrix([1, 0, 0, 1, delta.x, delta.y], mulMatrix(brush, place));
	try {
		pattern.setTransform({ a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] });
	} catch {
		emfLog('buildPattern: pattern.setTransform rejected');
		return null;
	}
	return pattern;
}

/**
 * World-space offset equivalent to half a device pixel, so a canvas pixel
 * centre samples the brush where GDI+ would (at the pixel's integer origin).
 */
export function halfPixelDelta(device: TransformMatrix): { x: number; y: number } {
	const inv = invertLinear(device);
	if (!inv) {
		return { x: 0, y: 0 };
	}
	return { x: inv[0] * 0.5 + inv[2] * 0.5, y: inv[1] * 0.5 + inv[3] * 0.5 };
}

/**
 * Texels per device pixel. Supersampling keeps bilinear pattern filtering
 * from smearing a tile seam (a hard edge in GDI+) across a whole pixel.
 */
const SUPERSAMPLE = 4;

/** Texels needed along a brush axis for {@link SUPERSAMPLE} texels per device pixel. */
function texelsFor(full: TransformMatrix, axis: 'x' | 'y', length: number): number {
	const scale = axis === 'x' ? Math.hypot(full[0], full[1]) : Math.hypot(full[2], full[3]);
	return Math.max(2, Math.min(MAX_TILE, Math.ceil(Math.abs(length) * scale * SUPERSAMPLE)));
}

// ---------------------------------------------------------------------------
// Linear gradients
// ---------------------------------------------------------------------------

/**
 * Pure: world-space endpoints of a plain `CanvasGradient` reproducing a
 * linear brush over one period, for any affine brush transform. Isolines are
 * the images of the rectangle's vertical lines, so the gradient vector is
 * the normal to that image direction (not simply the image of the x axis,
 * which a shear would tilt).
 */
export function linearGradientEndpoints(
	rect: EmfPlusRectF,
	transform: TransformMatrix | null | undefined,
): { x1: number; y1: number; x2: number; y2: number } {
	const m = transform ?? IDENTITY;
	const map = (x: number, y: number) => ({
		x: m[0] * x + m[2] * y + m[4],
		y: m[1] * x + m[3] * y + m[5],
	});
	const p1 = map(rect.x, rect.y + rect.h / 2);
	const pe = map(rect.x + rect.w, rect.y + rect.h / 2);
	const nx = m[3];
	const ny = -m[2];
	const nn = nx * nx + ny * ny;
	if (nn < 1e-12) {
		return { x1: p1.x, y1: p1.y, x2: pe.x, y2: pe.y };
	}
	const t = ((pe.x - p1.x) * nx + (pe.y - p1.y) * ny) / nn;
	return { x1: p1.x, y1: p1.y, x2: p1.x + nx * t, y2: p1.y + ny * t };
}

function plainLinear(ctx: CanvasContext, grad: EmfPlusLinearGradient): CanvasGradient | null {
	if (typeof ctx.createLinearGradient !== 'function') {
		return null;
	}
	const pts = grad.rect ? linearGradientEndpoints(grad.rect, grad.transform) : grad;
	if (pts.x1 === pts.x2 && pts.y1 === pts.y2) {
		return null;
	}
	const g = ctx.createLinearGradient(pts.x1, pts.y1, pts.x2, pts.y2);
	for (const stop of grad.stops) {
		g.addColorStop(stop.offset, stop.color);
	}
	return g;
}

/** Fraction of a period the unrolled ramp is shifted by (see {@link tiledLinear}). */
const SEAM_BIAS = 1e-5;

/** Most gradient periods one tiled linear brush is unrolled into. */
const MAX_PERIODS = 2048;

/** The drawing surface size, when the context exposes its canvas. */
function surfaceSize(ctx: CanvasContext): { w: number; h: number } | null {
	const canvas = (ctx as { canvas?: { width?: unknown; height?: unknown } }).canvas;
	const w = canvas?.width;
	const h = canvas?.height;
	return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 ? { w, h } : null;
}

/**
 * A tiled linear brush as ONE `CanvasGradient`: its period is unrolled
 * (mirrored on alternate periods for TileFlipX/XY) across every period the
 * drawing surface can show, so colours stay exact and seams stay hard. The
 * endpoints come from {@link linearGradientEndpoints} (exact for any affine
 * brush transform) shifted by GDI+'s half-pixel sampling offset.
 */
function tiledLinear(
	ctx: CanvasContext,
	grad: EmfPlusLinearGradient,
	rect: EmfPlusRectF,
	device: TransformMatrix,
): CanvasGradient | null {
	const size = surfaceSize(ctx);
	const inv = invertLinear(device);
	if (!size || !inv || typeof ctx.createLinearGradient !== 'function') {
		return null;
	}
	const e = linearGradientEndpoints(rect, grad.transform);
	const delta = halfPixelDelta(device);
	const dx = e.x2 - e.x1;
	const dy = e.y2 - e.y1;
	// A pixel exactly on a period boundary reads the END of the period in
	// GDI+; nudge the ramp a hair forward so Canvas agrees.
	const x1 = e.x1 + delta.x + dx * SEAM_BIAS;
	const y1 = e.y1 + delta.y + dy * SEAM_BIAS;
	const len2 = dx * dx + dy * dy;
	if (!(len2 > 1e-12)) {
		return null;
	}
	// Period index range covering the surface's corners, in world space.
	let tMin = Infinity;
	let tMax = -Infinity;
	for (const [cx, cy] of [
		[0, 0],
		[size.w, 0],
		[0, size.h],
		[size.w, size.h],
	]) {
		const px = cx - device[4];
		const py = cy - device[5];
		const wx = inv[0] * px + inv[2] * py;
		const wy = inv[1] * px + inv[3] * py;
		const t = ((wx - x1) * dx + (wy - y1) * dy) / len2;
		tMin = Math.min(tMin, t);
		tMax = Math.max(tMax, t);
	}
	const k0 = Math.floor(tMin);
	const k1 = Math.max(k0 + 1, Math.ceil(tMax));
	if (k1 - k0 > MAX_PERIODS) {
		return null;
	}
	const g = ctx.createLinearGradient(x1 + dx * k0, y1 + dy * k0, x1 + dx * k1, y1 + dy * k1);
	const span = k1 - k0;
	const mirrorX = mirrorFlags(grad.wrapMode).x;
	const reversed = [...grad.stops].reverse();
	for (let k = k0; k < k1; k++) {
		const mirrored = mirrorX && ((k % 2) + 2) % 2 === 1;
		for (const stop of mirrored ? reversed : grad.stops) {
			const local = mirrored ? 1 - stop.offset : stop.offset;
			g.addColorStop(Math.min(1, Math.max(0, (k - k0 + local) / span)), stop.color);
		}
	}
	return g;
}

/**
 * The stops a linear gradient is painted with: GDI+'s own interpolation
 * table as one stop per knot (see `emf-plus-linear-ramp.ts`) when the
 * recorded ramp is known, else the descriptor's stops as given.
 */
export function effectiveLinearStops(grad: EmfPlusLinearGradient): EmfPlusGradientStop[] {
	const ramp = grad.rect ? linearRampOf(grad) : null;
	return ramp && grad.rect ? linearRampStops(buildLinearRampTable(ramp, grad.rect)) : grad.stops;
}

function linearPaint(
	ctx: CanvasContext,
	recorded: EmfPlusLinearGradient,
	device: TransformMatrix,
): CanvasGradient | CanvasPattern | null {
	const grad = { ...recorded, stops: effectiveLinearStops(recorded) };
	const rect = grad.rect;
	if (grad.wrapMode !== 'clamp' && rect && rect.w !== 0) {
		const unrolled = tiledLinear(ctx, grad, rect, device);
		if (unrolled) {
			return unrolled;
		}
		if (stopColorAt(grad.stops, 0) !== null) {
			const brush = grad.transform ?? IDENTITY;
			const tw = texelsFor(mulMatrix(device, brush), 'x', rect.w);
			const pattern = buildPattern(
				ctx,
				rect,
				tw,
				1,
				grad.wrapMode,
				brush,
				halfPixelDelta(device),
				{ phaseX: 0.5, lagX: 0, lagY: 0 },
				(bx) => stopColorAt(grad.stops, (bx - rect.x) / rect.w),
			);
			if (pattern) {
				return pattern;
			}
		}
		emfLog('createBrushGradient: linear gradient could not be tiled');
	}
	return plainLinear(ctx, grad);
}

// ---------------------------------------------------------------------------
// Path gradients
// ---------------------------------------------------------------------------

function boundaryBox(points: ReadonlyArray<{ x: number; y: number }>): EmfPlusRectF | null {
	if (points.length < 3) {
		return null;
	}
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const p of points) {
		x0 = Math.min(x0, p.x);
		y0 = Math.min(y0, p.y);
		x1 = Math.max(x1, p.x);
		y1 = Math.max(y1, p.y);
	}
	return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

function pathPaint(
	ctx: CanvasContext,
	shape: EmfPlusPathGradientShape,
	wrap: EmfPlusGradientWrapMode,
	device: TransformMatrix,
): CanvasPattern | null {
	const box = boundaryBox(shape.boundary);
	if (!box) {
		return null;
	}
	const brush = shape.transform ?? IDENTITY;
	const full = mulMatrix(device, brush);
	const pxX = Math.hypot(full[0], full[1]);
	const pxY = Math.hypot(full[2], full[3]);
	return buildPattern(
		ctx,
		box,
		texelsFor(full, 'x', box.w),
		texelsFor(full, 'y', box.h),
		wrap,
		brush,
		halfPixelDelta(device),
		{ phaseX: 0, lagX: pxX > 0 ? 1 / pxX : 0, lagY: pxY > 0 ? 1 / pxY : 0 },
		(bx, by) => pathGradientColorAt(shape, bx, by),
	);
}

function radialFallback(ctx: CanvasContext, grad: EmfPlusRadialGradient): CanvasGradient | null {
	if (!(grad.r > 0) || typeof ctx.createRadialGradient !== 'function') {
		return null;
	}
	const g = ctx.createRadialGradient(grad.cx, grad.cy, 0, grad.cx, grad.cy, grad.r);
	for (const stop of grad.stops) {
		g.addColorStop(stop.offset, stop.color);
	}
	return g;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Builds a Canvas 2D paint style from a parsed EMF+ gradient. `device` is
 * the world-to-device matrix the fill will run under (see
 * `plusWorldMatrix`); it sizes the tile and places the half-pixel offset.
 * Returns `null` when the context lacks gradient support (e.g. test stubs)
 * or the geometry is degenerate, in which case callers fall back to the
 * flat brush colour.
 */
export function createBrushGradient(
	ctx: CanvasContext,
	grad: EmfPlusGradient,
	device: TransformMatrix = IDENTITY,
): CanvasGradient | CanvasPattern | null {
	try {
		if (grad.type === 'linear') {
			return linearPaint(ctx, grad, device);
		}
		if (grad.shape) {
			const pattern = pathPaint(ctx, grad.shape, grad.wrapMode, device);
			if (pattern) {
				return pattern;
			}
			emfLog('createBrushGradient: path gradient pattern unavailable, using the radial approximation');
		}
		return radialFallback(ctx, grad);
	} catch {
		return null;
	}
}
