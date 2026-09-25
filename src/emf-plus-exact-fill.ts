/**
 * Exact, per-device-pixel EMF+ brush fills.
 *
 * Canvas 2D can only paint a raster brush through a `CanvasPattern`, and
 * every tested backend (browser, worker and `@napi-rs/canvas`) samples a
 * pattern through a smoothing filter regardless of `imageSmoothingEnabled`,
 * even at an identity pattern matrix: a hard texel edge comes out blurred
 * across a device pixel and the interior loses a few percent of alpha. That
 * is what kept an EMF+ TextureFill brush about 25% away from GDI+ output and
 * left a residual at the tile seams of every tiled path gradient.
 *
 * This module sidesteps patterns for the brushes where that matters. A
 * brush is resolved to a {@link DeviceBrushSampler}: a pure function that
 * computes the brush colour of each device pixel in a rectangle directly,
 * the way GDI+ does (the pixel is mapped back through the inverse of
 * world-to-device x brush transform, sampled at its integer origin per
 * GDI+'s PixelOffsetMode None, and wrapped per `WrapMode`). The
 * shape is then filled by {@link tryFillPlusShapeExact}: the colours are rendered
 * for the shape's device bounding box only, the shape's path is installed
 * as a clip (so its edge keeps Canvas's own anti-aliasing and any existing
 * EMF+ clip still applies), and the block is composited with `drawImage` at
 * an integer device offset and identity transform, which every backend
 * copies without filtering.
 *
 * Brushes without a device sampler (solid colours, linear gradients, which
 * are already exact as an unrolled `CanvasGradient`) and contexts without
 * the needed canvas support take the fill handlers' ordinary `fillStyle` +
 * `fill()` path.
 *
 * @module emf-plus-exact-fill
 */

import { canvasPutImageData, createImageDataCompat, createTempCanvas } from './emf-canvas-helpers';
import { mulMatrix, pathGradientColorAt } from './emf-plus-brush-gradient';
import { textureTexelAt } from './emf-plus-brush-texture';
import { applyPlusWorldTransform, plusWorldMatrix } from './emf-plus-state-handlers';
import type {
	CanvasContext,
	EmfPlusGradientWrapMode,
	EmfPlusPathGradientShape,
	EmfPlusReplayCtx,
	EmfPlusTexture,
	TransformMatrix,
} from './emf-types';

const IDENTITY: TransformMatrix = [1, 0, 0, 1, 0, 0];

/** Most device pixels one exact fill renders (larger fills use the pattern path). */
const MAX_EXACT_PIXELS = 16 * 1024 * 1024;

/** Device-pixel nudge applied to a Clamp path gradient's sample point (see {@link pathGradientSampler}). */
const CLAMP_EDGE_BIAS = 1e-4;

/**
 * Writes the brush colour of every device pixel in the `w` x `h` rectangle
 * at (`x0`, `y0`) into `out` (non-premultiplied RGBA, row-major, pre-zeroed;
 * pixels the brush does not paint are left transparent).
 */
export type DeviceBrushSampler = (x0: number, y0: number, w: number, h: number, out: Uint8ClampedArray) => void;

/** Full affine inverse, or `null` for a singular matrix. */
export function invertAffine(m: TransformMatrix): TransformMatrix | null {
	const det = m[0] * m[3] - m[1] * m[2];
	if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
		return null;
	}
	const a = m[3] / det;
	const b = -m[1] / det;
	const c = -m[2] / det;
	const d = m[0] / det;
	return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

/** The drawing surface size, when the context exposes its canvas. */
function surfaceSize(ctx: CanvasContext): { w: number; h: number } | null {
	const canvas = (ctx as { canvas?: { width?: unknown; height?: unknown } }).canvas;
	const w = canvas?.width;
	const h = canvas?.height;
	return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 ? { w, h } : null;
}

// ---------------------------------------------------------------------------
// Samplers
// ---------------------------------------------------------------------------

/**
 * A texture brush sampled per device pixel: nearest texel at the pixel's
 * integer origin, wrapped per the brush's `WrapMode` (see
 * {@link textureTexelAt}). `device` is the world-to-device matrix.
 */
export function textureSampler(texture: EmfPlusTexture, device: TransformMatrix): DeviceBrushSampler | null {
	const { width, height, rgba, wrapMode } = texture;
	if (width <= 0 || height <= 0) {
		return null;
	}
	const inv = invertAffine(mulMatrix(device, texture.transform ?? IDENTITY));
	if (!inv) {
		return null;
	}
	return (x0, y0, w, h, out) => {
		for (let j = 0; j < h; j++) {
			for (let i = 0; i < w; i++) {
				const t = textureTexelAt(inv, width, height, wrapMode, x0 + i, y0 + j);
				if (t < 0) {
					continue;
				}
				const o = (j * w + i) * 4;
				out[o] = rgba[t];
				out[o + 1] = rgba[t + 1];
				out[o + 2] = rgba[t + 2];
				out[o + 3] = rgba[t + 3];
			}
		}
	};
}

/** Bounding box of a path gradient's boundary polygon (its tile), or `null` when degenerate. */
function boundaryBox(
	points: ReadonlyArray<{ x: number; y: number }>,
): { x: number; y: number; w: number; h: number } | null {
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

/**
 * Folds brush-space coordinate `v` into one tile `[origin, origin + size)`
 * per a WrapMode axis: repetition, or (when `mirror`) repetition with every
 * odd tile reflected, where a reflected tile is additionally shifted back
 * by `lag` (GDI+ mirrors its rasterised tile texel-for-texel, so the
 * mirrored copy sits one device pixel off a mathematical mirror). Pure.
 */
export function foldIntoTile(v: number, origin: number, size: number, mirror: boolean, lag: number): number {
	const rel = v - origin;
	const k = Math.floor(rel / size);
	const local = rel - k * size;
	if (mirror && ((k % 2) + 2) % 2 === 1) {
		return origin + size - lag - local;
	}
	return origin + local;
}

/**
 * A path-gradient brush sampled per device pixel: each pixel's integer
 * origin maps into brush space, folds into the boundary's bounding box per
 * `wrap` (Clamp paints only inside the boundary itself), and takes
 * {@link pathGradientColorAt} there.
 */
export function pathGradientSampler(
	shape: EmfPlusPathGradientShape,
	wrap: EmfPlusGradientWrapMode,
	device: TransformMatrix,
): DeviceBrushSampler | null {
	const box = boundaryBox(shape.boundary);
	const full = mulMatrix(device, shape.transform ?? IDENTITY);
	const inv = invertAffine(full);
	if (!box || !inv) {
		return null;
	}
	const pxX = Math.hypot(full[0], full[1]);
	const pxY = Math.hypot(full[2], full[3]);
	const lagX = pxX > 0 ? 1 / pxX : 0;
	const lagY = pxY > 0 ? 1 / pxY : 0;
	const mirrorX = wrap === 'tile-flip-x' || wrap === 'tile-flip-xy';
	const mirrorY = wrap === 'tile-flip-y' || wrap === 'tile-flip-xy';
	// Clamp paints the boundary polygon itself, whose right/bottom edges
	// GDI+ leaves unpainted (a top-left fill rule): nudging the sample point
	// a hair right/down moves a pixel exactly on such an edge outside, while
	// one on a left/top edge stays inside. The tiled modes fold every point
	// into the tile, where that edge IS the next tile's left/top edge, so
	// they sample unbiased.
	const bias = wrap === 'clamp' ? CLAMP_EDGE_BIAS : 0;
	return (x0, y0, w, h, out) => {
		for (let j = 0; j < h; j++) {
			const dy = y0 + j + bias;
			for (let i = 0; i < w; i++) {
				const dx = x0 + i + bias;
				let bx = inv[0] * dx + inv[2] * dy + inv[4];
				let by = inv[1] * dx + inv[3] * dy + inv[5];
				if (wrap !== 'clamp') {
					bx = foldIntoTile(bx, box.x, box.w, mirrorX, lagX);
					by = foldIntoTile(by, box.y, box.h, mirrorY, lagY);
				}
				const c = pathGradientColorAt(shape, bx, by);
				if (c === null) {
					continue;
				}
				const o = (j * w + i) * 4;
				out[o] = (c >>> 16) & 0xff;
				out[o + 1] = (c >>> 8) & 0xff;
				out[o + 2] = c & 0xff;
				out[o + 3] = (c >>> 24) & 0xff;
			}
		}
	};
}

/**
 * The per-device-pixel sampler for the brush a fill record names, or
 * `null` when it is an inline colour or a brush Canvas already paints
 * exactly (solid, hatch, linear gradient).
 */
export function deviceBrushSampler(
	rCtx: EmfPlusReplayCtx,
	flags: number,
	brushIdOrColor: number,
): DeviceBrushSampler | null {
	if (flags & 0x8000) {
		return null;
	}
	const obj = rCtx.objectTable.get(brushIdOrColor & 0xff);
	if (!obj || obj.kind !== 'plus-brush') {
		return null;
	}
	const device = plusWorldMatrix(rCtx);
	if (obj.texture) {
		return textureSampler(obj.texture, device);
	}
	if (obj.gradient && obj.gradient.type === 'radial' && obj.gradient.shape) {
		return pathGradientSampler(obj.gradient.shape, obj.gradient.wrapMode, device);
	}
	return null;
}

// ---------------------------------------------------------------------------
// Fill
// ---------------------------------------------------------------------------

/**
 * Device-pixel bounding box (clamped to the surface) of world-space points
 * under `device`, or the whole surface when `points` is null or empty.
 */
function deviceBounds(
	points: ReadonlyArray<{ x: number; y: number }> | null,
	device: TransformMatrix,
	size: { w: number; h: number },
): { x: number; y: number; w: number; h: number } | null {
	if (!points || points.length === 0) {
		return { x: 0, y: 0, w: size.w, h: size.h };
	}
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const p of points) {
		const x = device[0] * p.x + device[2] * p.y + device[4];
		const y = device[1] * p.x + device[3] * p.y + device[5];
		x0 = Math.min(x0, x);
		y0 = Math.min(y0, y);
		x1 = Math.max(x1, x);
		y1 = Math.max(y1, y);
	}
	if (!Number.isFinite(x0 + y0 + x1 + y1)) {
		return { x: 0, y: 0, w: size.w, h: size.h };
	}
	const bx0 = Math.max(0, Math.floor(x0) - 1);
	const by0 = Math.max(0, Math.floor(y0) - 1);
	const bx1 = Math.min(size.w, Math.ceil(x1) + 1);
	const by1 = Math.min(size.h, Math.ceil(y1) + 1);
	return bx1 > bx0 && by1 > by0 ? { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 } : null;
}

/**
 * Fills a shape exactly with an EMF+ brush that has a
 * {@link DeviceBrushSampler}, as the module doc describes. `buildPath` adds
 * the shape's geometry (world coordinates) to the context's current path,
 * after `beginPath()` has been issued; `points` are world-space points whose
 * bounding box contains the shape (a curve's control points suffice), used
 * to limit the work to the shape's device bounds (null: the whole surface).
 *
 * Returns `false`, having drawn nothing, when the brush has no sampler or
 * the context lacks the needed support; the caller then runs its ordinary
 * `fillStyle` (`resolveBrushPaint`) + `fill()` code.
 */
export function tryFillPlusShapeExact(
	rCtx: EmfPlusReplayCtx,
	flags: number,
	brushIdOrColor: number,
	buildPath: (ctx: CanvasContext) => void,
	points: ReadonlyArray<{ x: number; y: number }> | null,
	fillRule: CanvasFillRule = 'nonzero',
): boolean {
	const { ctx } = rCtx;
	const size = surfaceSize(ctx);
	if (!size || typeof ctx.clip !== 'function' || typeof ctx.drawImage !== 'function') {
		return false;
	}
	const sampler = deviceBrushSampler(rCtx, flags, brushIdOrColor);
	if (!sampler) {
		return false;
	}
	const box = deviceBounds(points, plusWorldMatrix(rCtx), size);
	if (!box) {
		return true; // Entirely off the surface: nothing to paint.
	}
	if (box.w * box.h > MAX_EXACT_PIXELS) {
		return false;
	}
	const temp = createTempCanvas(box.w, box.h);
	if (!temp) {
		return false;
	}
	const data = new Uint8ClampedArray(box.w * box.h * 4);
	sampler(box.x, box.y, box.w, box.h, data);
	canvasPutImageData(temp.ctx, createImageDataCompat(data, box.w, box.h), 0, 0);
	ctx.save();
	try {
		applyPlusWorldTransform(rCtx);
		ctx.beginPath();
		buildPath(ctx);
		ctx.clip(fillRule);
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.imageSmoothingEnabled = false;
		(ctx.drawImage as unknown as (img: unknown, x: number, y: number) => void).call(ctx, temp.canvas, box.x, box.y);
	} finally {
		ctx.restore();
	}
	return true;
}
