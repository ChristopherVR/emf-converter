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

import { canvasGetImageData, canvasPutImageData, createImageDataCompat, createTempCanvas } from './emf-canvas-helpers';
import { mulMatrix, pathGradientColorAt } from './emf-plus-brush-gradient';
import { writeTextureColor } from './emf-plus-brush-texture';
import { isHalfPixelOffset } from './emf-plus-image-resample';
import { linearRampSampler } from './emf-plus-linear-ramp';
import { applyPlusWorldTransform, plusWorldMatrix } from './emf-plus-state-handlers';
import { flatteningContext } from './emf-plus-flatten';
import { isSvgContext } from './svg-context';
import type {
	CanvasContext,
	EmfPlusBrush,
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
 * A texture brush sampled per device pixel the way GDI+ samples it:
 * bilinearly (whatever the InterpolationMode), wrapped per the brush's
 * `WrapMode`, on the grid of the active `PixelOffsetMode` (`halfPixel`),
 * see {@link writeTextureColor}. `device` is the world-to-device matrix.
 */
export function textureSampler(
	texture: EmfPlusTexture,
	device: TransformMatrix,
	halfPixel: boolean = false,
): DeviceBrushSampler | null {
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
				writeTextureColor(inv, width, height, rgba, wrapMode, halfPixel, x0 + i, y0 + j, out, (j * w + i) * 4);
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
 * exactly (solid, hatch; a linear gradient in SVG output).
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
	return brushSampler(rCtx, obj);
}

/**
 * The per-device-pixel sampler of an EMF+ brush object (a fill record's
 * brush, or a pen's own brush), or `null` for a brush Canvas already paints
 * exactly (solid, hatch; a linear gradient in SVG output).
 */
export function brushSampler(rCtx: EmfPlusReplayCtx, obj: EmfPlusBrush): DeviceBrushSampler | null {
	const device = plusWorldMatrix(rCtx);
	if (obj.texture) {
		return textureSampler(obj.texture, device, isHalfPixelOffset(rCtx.pixelOffsetMode ?? 0));
	}
	if (obj.gradient && obj.gradient.type === 'radial' && obj.gradient.shape) {
		return pathGradientSampler(obj.gradient.shape, obj.gradient.wrapMode, device);
	}
	// SVG keeps a linear gradient as a vector <linearGradient> (its stops are
	// GDI+'s table knots already, see effectiveLinearStops); a raster fill
	// reproduces GDI+'s fixed-point per-pixel interpolation as well.
	if (obj.gradient && obj.gradient.type === 'linear' && !isSvgContext(rCtx.ctx)) {
		return linearRampSampler(obj.gradient, device, isHalfPixelOffset(rCtx.pixelOffsetMode ?? 0));
	}
	return null;
}

// ---------------------------------------------------------------------------
// Fill
// ---------------------------------------------------------------------------

/**
 * Device-pixel bounding box (clamped to the surface) of world-space points
 * under `device`, grown by `margin` device pixels on every side, or the
 * whole surface when `points` is null or empty.
 */
export function deviceBounds(
	points: ReadonlyArray<{ x: number; y: number }> | null,
	device: TransformMatrix,
	size: { w: number; h: number },
	margin: number = 0,
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
	const m = Math.ceil(Math.max(0, margin)) + 1;
	const bx0 = Math.max(0, Math.floor(x0) - m);
	const by0 = Math.max(0, Math.floor(y0) - m);
	const bx1 = Math.min(size.w, Math.ceil(x1) + m);
	const by1 = Math.min(size.h, Math.ceil(y1) + m);
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
	if (isPlusAliased(rCtx)) {
		const any = anyBrushSampler(rCtx, flags, brushIdOrColor);
		if (any && fillPlusShapeAliased(rCtx, any, buildPath, points, fillRule, size)) {
			return true;
		}
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

// ---------------------------------------------------------------------------
// Strokes and text: brush colour through a coverage mask
// ---------------------------------------------------------------------------

/**
 * Paints a brush through a coverage mask, exactly: the geometry
 * `drawCoverage` draws (a stroke, glyphs) is rendered ONCE, opaque, onto a
 * scratch canvas the size of `box` (its alpha is the coverage, with
 * Canvas's own antialiasing at the edges), the brush colour of every
 * device pixel in the box comes from `sampler` (exactly as a fill does),
 * the two are multiplied, and the block is composited at an integer device
 * offset under an identity transform, which every backend copies
 * unfiltered, through the live clip. This replaces painting a stroke or
 * text through a `CanvasPattern` (which every canvas backend filters) or
 * a flat colour. `drawCoverage` receives the scratch context already
 * transformed so world coordinates land on the box, and must draw in an
 * opaque colour. Returns `false`, having drawn nothing, when the context
 * lacks the canvas support this needs or the box is implausibly large.
 */
export function paintBrushThroughMask(
	rCtx: EmfPlusReplayCtx,
	sampler: DeviceBrushSampler,
	box: { x: number; y: number; w: number; h: number },
	drawCoverage: (c: CanvasContext) => void,
	aliased: boolean = false,
	hitTest?: (c: CanvasContext, x: number, y: number) => boolean,
): boolean {
	const { ctx } = rCtx;
	if (typeof ctx.drawImage !== 'function' || box.w * box.h > MAX_EXACT_PIXELS) {
		return false;
	}
	const mask = createTempCanvas(box.w, box.h);
	const out = createTempCanvas(box.w, box.h);
	if (!mask || !out || typeof mask.ctx.getImageData !== 'function') {
		return false;
	}
	const device = plusWorldMatrix(rCtx);
	const m = mask.ctx;
	// An aliased mask moves GDI+'s sample point of each pixel onto the
	// canvas pixel's centre, less a hair (see aliasedSampleShift): a pixel is
	// covered when that point is inside the geometry (GDI+'s top-left rule
	// on ties). Fully covered and fully empty pixels are decided by the
	// rendered coverage alone; a partly covered one (an edge pixel) asks
	// `hitTest` (`isPointInPath`/`isPointInStroke` on the geometry
	// `drawCoverage` left current), or, without one, whether it is at least
	// half covered.
	const shift = aliased ? aliasedSampleShift(rCtx) : 0;
	m.setTransform(device[0], device[1], device[2], device[3], device[4] - box.x + shift, device[5] - box.y + shift);
	m.fillStyle = '#000';
	m.strokeStyle = '#000';
	// Aliased: curves become the polygon GDI+ flattens them to (emf-plus-flatten.ts).
	drawCoverage(aliased ? flatteningContext(m, device) : m);
	const coverage = canvasGetImageData(m, 0, 0, box.w, box.h).data;
	if (aliased) {
		const probe = hitTest && typeof m.isPointInPath === 'function' ? hitTest : null;
		for (let i = 3; i < coverage.length; i += 4) {
			const cv = coverage[i];
			if (cv === 0 || cv === 255) {
				continue;
			}
			if (probe) {
				const p = (i - 3) / 4;
				const px = (p % box.w) + 0.5;
				const py = Math.floor(p / box.w) + 0.5;
				// isPointInPath/isPointInStroke take untransformed canvas coordinates.
				coverage[i] = probe(m, px, py) ? 255 : 0;
			} else {
				coverage[i] = cv >= 128 ? 255 : 0;
			}
		}
	}
	const data = new Uint8ClampedArray(box.w * box.h * 4);
	sampler(box.x, box.y, box.w, box.h, data);
	for (let i = 3; i < data.length; i += 4) {
		data[i] = (data[i] * coverage[i] + 127) / 255;
	}
	canvasPutImageData(out.ctx, createImageDataCompat(data, box.w, box.h), 0, 0);
	ctx.save();
	try {
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.imageSmoothingEnabled = false;
		(ctx.drawImage as unknown as (img: unknown, x: number, y: number) => void).call(ctx, out.canvas, box.x, box.y);
	} finally {
		ctx.restore();
	}
	return true;
}

/**
 * Canvas-space shift that puts GDI+'s sample point of a device pixel at the
 * canvas pixel's centre, less 1/32 pixel (half of GDI+'s 1/16-pixel 28.4
 * fixed-point step) so a sample exactly on a left or top edge lands inside
 * and one exactly on a right or bottom edge outside (GDI+'s top-left rule).
 * Under `PixelOffsetMode` None GDI+ samples pixel (x, y) at the point
 * (x, y), half a pixel before the canvas centre; under Half/HighQuality at
 * (x + 0.5, y + 0.5).
 */
export function aliasedSampleShift(rCtx: EmfPlusReplayCtx): number {
	return (isHalfPixelOffset(rCtx.pixelOffsetMode ?? 0) ? 0 : 0.5) - 1 / 32;
}

/**
 * True when EMF+ fills and strokes must be rasterised without antialiasing,
 * on GDI+'s own pixel grid: the `gdiAntialias: false` option is set, the
 * recorded GDI+ `SmoothingMode` is not antialiased (GDI+'s default), and
 * the output is raster (SVG keeps vector edges).
 */
export function isPlusAliased(rCtx: EmfPlusReplayCtx): boolean {
	return rCtx.gdiAntialias === false && !rCtx.antiAlias && !isSvgContext(rCtx.ctx);
}

/** A sampler painting one flat colour (packed ARGB) everywhere. */
export function solidSampler(argb: number): DeviceBrushSampler {
	const a = (argb >>> 24) & 0xff;
	const r = (argb >>> 16) & 0xff;
	const g = (argb >>> 8) & 0xff;
	const b = argb & 0xff;
	return (_x0, _y0, w, h, out) => {
		for (let i = 0; i < w * h * 4; i += 4) {
			out[i] = r;
			out[i + 1] = g;
			out[i + 2] = b;
			out[i + 3] = a;
		}
	};
}

/** Parses a CSS `rgba(r,g,b,a)`/`#rrggbb` colour (as the parsers produce) to packed ARGB, or `null`. */
export function cssColorToArgb(color: string): number | null {
	const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(color);
	if (m) {
		const a = m[4] === undefined ? 1 : Number(m[4]);
		const ch = (v: string): number => Math.min(255, Math.max(0, Math.round(Number(v))));
		return ((Math.round(Math.min(1, Math.max(0, a)) * 255) << 24) | (ch(m[1]) << 16) | (ch(m[2]) << 8) | ch(m[3])) >>> 0;
	}
	const h = /^#([0-9a-f]{6})$/i.exec(color);
	return h ? (0xff000000 | parseInt(h[1], 16)) >>> 0 : null;
}

/**
 * The sampler for a fill record's brush, including a flat colour (an inline
 * ARGB colour or a solid/hatch brush's colour), for the aliased path which
 * must paint every brush through a mask.
 */
function anyBrushSampler(rCtx: EmfPlusReplayCtx, flags: number, brushIdOrColor: number): DeviceBrushSampler | null {
	if (flags & 0x8000) {
		return solidSampler(brushIdOrColor >>> 0);
	}
	const exact = deviceBrushSampler(rCtx, flags, brushIdOrColor);
	if (exact) {
		return exact;
	}
	const obj = rCtx.objectTable.get(brushIdOrColor & 0xff);
	const argb = obj && obj.kind === 'plus-brush' ? cssColorToArgb(obj.color) : null;
	return argb === null ? null : solidSampler(argb);
}

/**
 * Fills a shape without antialiasing, on GDI+'s pixel grid (see
 * {@link isPlusAliased}): the shape's coverage is thresholded per pixel at
 * GDI+'s sample point and every covered pixel takes the brush colour.
 */
function fillPlusShapeAliased(
	rCtx: EmfPlusReplayCtx,
	sampler: DeviceBrushSampler,
	buildPath: (ctx: CanvasContext) => void,
	points: ReadonlyArray<{ x: number; y: number }> | null,
	fillRule: CanvasFillRule,
	size: { w: number; h: number },
): boolean {
	const box = deviceBounds(points, plusWorldMatrix(rCtx), size);
	if (!box) {
		return true;
	}
	return paintBrushThroughMask(
		rCtx,
		sampler,
		box,
		(c) => {
			c.beginPath();
			buildPath(c);
			c.fill(fillRule);
		},
		true,
		(c, x, y) => c.isPointInPath(x, y, fillRule),
	);
}
