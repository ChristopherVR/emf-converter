/**
 * Exact bitwise emulation of the AND/OR/XOR-family `SetROP2` modes, for GDI
 * shape and path drawing, plus the small per-pixel engine
 * ({@link measurePathBox}, {@link rewritePixels}) that it and the exact
 * pattern-brush fill (`emf-gdi-shape-paint.ts`) share.
 *
 * `rop2Paint` (`emf-canvas-helpers.ts`) can only approximate these ten modes
 * with Canvas's arithmetic composite operators (`darken`/`lighten`/
 * `difference`), because GDI's ROP2 is a true bitwise boolean function of the
 * pen/brush colour (P) and the destination pixel (D), and Canvas has no
 * bitwise compositing. This module makes them exact instead, the same way
 * `emf-rop3.ts` makes ROP3 blits exact: per-pixel, bit-for-bit.
 *
 * The technique: draw the shape once onto a fully transparent scratch canvas
 * (sized to the shape's own bounding box, not the whole output) with the raw
 * pen/brush colour, source-over. The scratch's alpha channel is then the
 * shape's coverage, and its RGB the raw paint colour, unblended. GDI does
 * not antialias, so coverage is made binary (a pixel is painted when at
 * least half covered) and each painted pixel becomes `ropCombine(P, D)`
 * outright. The rewritten pixels reach the output through `drawImage`, so
 * the active clip region is honoured (see {@link rewritePixels}).
 *
 * Each mode's boolean function of (P, D) is evaluated via `evalRop3`
 * (`emf-rop3.ts`) using a ROP3 truth-table index chosen to be independent of
 * the (unused) S operand: for a combo `(P, D)`, set BOTH the `S = 0` and
 * `S = 1` truth-table bits to that combo's boolean result. `PATCOPY` (P) and
 * `DSTINVERT` (~D) are two well-known ROP3 constants (0xF0, 0x55) built from
 * exactly this construction, which is how the indices below were derived and
 * cross-checked.
 *
 * @module emf-rop2-exact
 */

import { canvasGetImageData, canvasPutImageData, createTempCanvas, type Drawable } from './emf-canvas-helpers';
import {
	R2_MASKPEN,
	R2_MERGEPEN,
	R2_XORPEN,
	R2_NOTXORPEN,
	R2_MASKPENNOT,
	R2_MERGEPENNOT,
	R2_MASKNOTPEN,
	R2_MERGENOTPEN,
	R2_NOTMASKPEN,
	R2_NOTMERGEPEN,
} from './emf-constants';
import { evalRop3 } from './emf-rop3';
import type { CanvasContext } from './emf-types';
import { canReadBack } from './svg-context';

/** ROP3-style truth-table index (bits 16..23 convention), S-independent, per bitwise ROP2 mode. */
const ROP2_EXACT_INDEX: Record<number, number> = {
	[R2_MASKPEN]: 0xa0, // P & D
	[R2_MERGEPEN]: 0xfa, // P | D
	[R2_XORPEN]: 0x5a, // P ^ D
	[R2_NOTXORPEN]: 0xa5, // ~(P ^ D)
	[R2_MASKPENNOT]: 0x50, // P & ~D
	[R2_MERGEPENNOT]: 0xf5, // P | ~D
	[R2_MASKNOTPEN]: 0x0a, // ~P & D
	[R2_MERGENOTPEN]: 0xaf, // ~P | D
	[R2_NOTMASKPEN]: 0x5f, // ~(P & D)
	[R2_NOTMERGEPEN]: 0x05, // ~(P | D)
};

/** True when `rop2` is one of the bitwise modes this module emulates exactly. */
export function isExactRop2Bitwise(rop2: number): boolean {
	return rop2 in ROP2_EXACT_INDEX;
}

/** Test-only: the hand-derived S-independent index for a bitwise mode (cross-checks {@link rop2Rop3Index}). */
export function rop2ExactIndexForTest(rop2: number): number | undefined {
	return ROP2_EXACT_INDEX[rop2];
}

/**
 * The S-independent ROP3 truth-table index for ANY of the sixteen `SetROP2`
 * modes (1 = `R2_BLACK` .. 16 = `R2_WHITE`), for callers that already work
 * per pixel (a pattern-brush fill) and so can apply every mode exactly, not
 * only the bitwise ones Canvas cannot composite. The sixteen modes enumerate
 * every boolean function of (P, D) in order: mode `n`'s result bits for the
 * (P, D) combos (1,1), (1,0), (0,1), (0,0) are bits 3, 2, 1, 0 of `n - 1`, which in
 * the ROP3 layout become `0x50` per high pair and `0x05` per low pair (so
 * `R2_XORPEN` = 7 gives `0x5A`, `R2_COPYPEN` = 13 gives `0xF0`, and
 * `R2_NOP` = 11 gives `0xAA`, the ROP3 `D` identity). `undefined` for an out
 * of range mode.
 */
export function rop2Rop3Index(rop2: number): number | undefined {
	if (!Number.isInteger(rop2) || rop2 < 1 || rop2 > 16) {
		return undefined;
	}
	const n = rop2 - 1;
	return (n >> 2) * 0x50 + (n & 3) * 0x05;
}

function packRgb(r: number, g: number, b: number): number {
	return (r << 16) | (g << 8) | b;
}

/** An integer device-pixel rectangle on the output canvas. */
export interface PixelBox {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** The canvas dimensions behind `ctx`, or `null` when unavailable (e.g. a minimal test stub). */
export function surfaceSize(ctx: CanvasContext): { w: number; h: number } | null {
	const canvas = (ctx as { canvas?: { width?: unknown; height?: unknown } }).canvas;
	const w = canvas?.width;
	const h = canvas?.height;
	return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 ? { w, h } : null;
}

/**
 * The device-space bounding box of whatever geometry `build` issues, found
 * by running it against a recording stand-in context (no canvas, no
 * rasterisation; path calls plus `fillRect`/`strokeRect`), padded by `pad` pixels on every side and clamped to
 * `surface`. Curves contribute their control points (a Bezier lies inside
 * its control polygon's hull) and `ellipse`/`arc` their centre plus the
 * larger radius, so the box is conservative. Only `translate` is tracked
 * as a transform; any other transform call makes the geometry unmeasurable
 * and the whole surface is returned. `null` means `build` issued no
 * geometry inside the surface.
 */
export function measurePathBox(
	build: (target: CanvasContext) => void,
	pad: number,
	surface: { w: number; h: number },
): PixelBox | null {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	let tx = 0;
	let ty = 0;
	let unknown = false;
	const add = (x: number, y: number, r = 0) => {
		minX = Math.min(minX, x + tx - r);
		minY = Math.min(minY, y + ty - r);
		maxX = Math.max(maxX, x + tx + r);
		maxY = Math.max(maxY, y + ty + r);
	};
	const opaque = () => {
		unknown = true;
	};
	const recorder: Record<string, unknown> = {
		moveTo: (x: number, y: number) => add(x, y),
		lineTo: (x: number, y: number) => add(x, y),
		rect: (x: number, y: number, w: number, h: number) => {
			add(x, y);
			add(x + w, y + h);
		},
		fillRect: (x: number, y: number, w: number, h: number) => {
			add(x, y);
			add(x + w, y + h);
		},
		strokeRect: (x: number, y: number, w: number, h: number) => {
			add(x, y);
			add(x + w, y + h);
		},
		bezierCurveTo: (ax: number, ay: number, bx: number, by: number, x: number, y: number) => {
			add(ax, ay);
			add(bx, by);
			add(x, y);
		},
		quadraticCurveTo: (ax: number, ay: number, x: number, y: number) => {
			add(ax, ay);
			add(x, y);
		},
		arcTo: (x1: number, y1: number, x2: number, y2: number) => {
			add(x1, y1);
			add(x2, y2);
		},
		arc: (x: number, y: number, r: number) => add(x, y, Math.abs(r)),
		ellipse: (x: number, y: number, rx: number, ry: number) => add(x, y, Math.max(Math.abs(rx), Math.abs(ry))),
		translate: (x: number, y: number) => {
			tx += x;
			ty += y;
		},
		setTransform: opaque,
		transform: opaque,
		scale: opaque,
		rotate: opaque,
	};
	const noop = () => undefined;
	const stand = new Proxy(recorder, {
		get: (target, prop) => (typeof prop === 'string' && prop in target ? target[prop] : noop),
		set: () => true,
	}) as unknown as CanvasContext;
	build(stand);
	if (unknown) {
		return { x: 0, y: 0, w: surface.w, h: surface.h };
	}
	if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
		return null;
	}
	const x0 = Math.max(0, Math.floor(minX - pad));
	const y0 = Math.max(0, Math.floor(minY - pad));
	const x1 = Math.min(surface.w, Math.ceil(maxX + pad));
	const y1 = Math.min(surface.h, Math.ceil(maxY + pad));
	if (x1 <= x0 || y1 <= y0) {
		return null;
	}
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** A scratch canvas, possibly larger than the region currently in use. */
interface Scratch {
	canvas: Drawable;
	ctx: CanvasContext;
	w: number;
	h: number;
}

/**
 * Largest scratch (in pixels) kept alive between calls; one shape at a time
 * is painted per pixel, and GDI files commonly paint thousands of small
 * shapes, so reusing one canvas saves an allocation per shape without
 * pinning a full-page buffer in memory for the life of the process.
 */
const SCRATCH_CACHE_MAX_PIXELS = 1024 * 1024;

let cachedScratch: Scratch | null = null;

/**
 * A cleared, identity-transformed scratch canvas at least `w` x `h`, reused
 * from the previous call when it is big enough (and small enough to cache),
 * otherwise freshly created. `null` when the backend cannot create one.
 */
function acquireScratch(w: number, h: number): Scratch | null {
	let scratch = cachedScratch && cachedScratch.w >= w && cachedScratch.h >= h ? cachedScratch : null;
	if (!scratch) {
		const cw = Math.max(w, cachedScratch?.w ?? 0);
		const ch = Math.max(h, cachedScratch?.h ?? 0);
		const cacheable = cw * ch <= SCRATCH_CACHE_MAX_PIXELS;
		const created = cacheable ? createTempCanvas(cw, ch) : createTempCanvas(w, h);
		if (!created) {
			return null;
		}
		scratch = { canvas: created.canvas, ctx: created.ctx, w: cacheable ? cw : w, h: cacheable ? ch : h };
		if (cacheable) {
			cachedScratch = scratch;
		}
	}
	const c = scratch.ctx;
	c.setTransform(1, 0, 0, 1, 0, 0);
	c.globalAlpha = 1;
	c.globalCompositeOperation = 'source-over';
	c.clearRect(0, 0, w, h);
	return scratch;
}

/**
 * Copies `pixels` (a `box`-sized RGBA buffer whose untouched pixels are
 * fully transparent and whose painted pixels are opaque) onto `ctx` at
 * `box`, through `scratch` and `drawImage` at identity, so the canvas's
 * ACTIVE CLIP applies: `putImageData` ignores clipping, which let an exact
 * ROP2 or pattern fill paint straight through a GDI clip region before.
 */
function compositeOverlay(ctx: CanvasContext, box: PixelBox, scratch: Scratch, pixels: ImageData): void {
	canvasPutImageData(scratch.ctx, pixels, 0, 0);
	const draw = ctx.drawImage as unknown as (
		img: Scratch['canvas'],
		sx: number,
		sy: number,
		sw: number,
		sh: number,
		dx: number,
		dy: number,
		dw: number,
		dh: number,
	) => void;
	ctx.save();
	try {
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = 'source-over';
		draw.call(ctx, scratch.canvas, 0, 0, box.w, box.h, box.x, box.y, box.w, box.h);
	} finally {
		ctx.restore();
	}
}

/**
 * Rewrites the pixels of `box` on `ctx` one at a time: `op(x, y, d)` gets a
 * device pixel and its current packed `0xRRGGBB` colour, and returns the new
 * packed colour, or `-1` to leave that pixel untouched.
 *
 * The new pixels reach `ctx` through `drawImage` (see `compositeOverlay`),
 * so the active clip still applies, and untouched pixels leave the
 * destination exactly as it was. Only when no scratch canvas can be created
 * are the pixels written back with `putImageData`, which cannot honour the
 * clip. Returns `false` (having drawn nothing) when pixel readback fails.
 */
export function rewritePixels(
	ctx: CanvasContext,
	box: PixelBox,
	op: (x: number, y: number, d: number) => number,
): boolean {
	try {
		const dest = canvasGetImageData(ctx, box.x, box.y, box.w, box.h);
		const dd = dest.data;
		const scratch = acquireScratch(box.w, box.h);
		const overlay = scratch ? canvasGetImageData(scratch.ctx, 0, 0, box.w, box.h) : dest;
		const od = overlay.data;
		for (let y = 0; y < box.h; y++) {
			for (let x = 0; x < box.w; x++) {
				const i = (y * box.w + x) * 4;
				const c = op(box.x + x, box.y + y, packRgb(dd[i], dd[i + 1], dd[i + 2]));
				if (c < 0) {
					continue;
				}
				od[i] = (c >> 16) & 0xff;
				od[i + 1] = (c >> 8) & 0xff;
				od[i + 2] = c & 0xff;
				od[i + 3] = 255;
			}
		}
		if (!scratch) {
			canvasPutImageData(ctx, dest, box.x, box.y);
			return true;
		}
		compositeOverlay(ctx, box, scratch, overlay);
		return true;
	} catch {
		return false;
	}
}

/**
 * Paints `draw` onto `ctx` without antialiasing, combining each covered
 * pixel with the existing destination through ANY of the sixteen `SetROP2`
 * modes (see {@link rop2Rop3Index}; `R2_COPYPEN` simply writes the paint
 * colour P and never reads the destination). `draw` is replayed on a
 * transparent scratch canvas covering only its own bounding box (see
 * {@link measurePathBox}; `pad` must cover half the stroke width) purely to
 * find which pixels it covers; P itself is `color` (a `#rrggbb` string),
 * never the scratch's own RGB, which a canvas stores premultiplied and so
 * reads back rounded wherever coverage is partial.
 *
 * GDI rasterises without antialiasing, so every pixel is either fully
 * painted or left alone, never blended. A fully covered scratch pixel is
 * painted and an untouched one is not. A partially covered (edge) pixel is
 * decided by `fillRule` when given (`draw` fills a path and leaves it
 * current): `isPointInPath` at the pixel's centre, i.e. point sampling like
 * GDI's fill, which keeps a rectangle's corner pixels (only a quarter
 * covered by an edge that crosses mid-pixel in both directions) exactly as
 * GDI does. Without `fillRule` (a stroke) a pixel counts when at least half
 * covered. The result is composited back like {@link rewritePixels},
 * honouring the active clip. Returns `false` (having drawn nothing) for an
 * out-of-range mode or when the canvas backend lacks the pixel-readback
 * support this needs.
 */
export function paintWithRop2PerPixel(
	ctx: CanvasContext,
	rop2: number,
	color: string,
	draw: (scratch: CanvasContext) => void,
	pad = 2,
	fillRule?: CanvasFillRule,
): boolean {
	const index = rop2Rop3Index(rop2);
	if (index === undefined || !canReadBack(ctx)) {
		// No readable destination (SVG output without a canvas backend): the
		// caller's blend-mode approximation is the best available.
		return false;
	}
	if (index === 0xaa) {
		return true; // R2_NOP: the destination is left as it is.
	}
	const size = surfaceSize(ctx);
	if (!size) {
		return false;
	}
	try {
		const box = measurePathBox(draw, pad, size);
		if (!box) {
			return true; // Nothing inside the surface to paint.
		}
		const scratch = acquireScratch(box.w, box.h);
		if (!scratch) {
			return false;
		}
		const sc = scratch.ctx;
		sc.save();
		try {
			sc.fillStyle = color;
			sc.strokeStyle = color;
			sc.translate(-box.x, -box.y);
			draw(sc);
		} finally {
			sc.restore();
		}
		const pointTest = fillRule !== undefined && typeof sc.isPointInPath === 'function';
		const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
		const fixedP = hex ? parseInt(hex[1], 16) : -1;
		const paint = canvasGetImageData(sc, 0, 0, box.w, box.h);
		const pd = paint.data;
		const dd = index === 0xf0 ? null : canvasGetImageData(ctx, box.x, box.y, box.w, box.h).data;
		for (let i = 0; i < pd.length; i += 4) {
			const a = pd[i + 3];
			let covered: boolean;
			if (a === 0) {
				covered = false;
			} else if (a === 255) {
				covered = true;
			} else if (pointTest) {
				const px = (i >> 2) % box.w;
				const py = ((i >> 2) - px) / box.w;
				covered = sc.isPointInPath(px + 0.5, py + 0.5, fillRule);
			} else {
				covered = a >= 128;
			}
			if (!covered) {
				pd[i] = 0;
				pd[i + 1] = 0;
				pd[i + 2] = 0;
				pd[i + 3] = 0;
				continue;
			}
			const p = fixedP >= 0 ? fixedP : packRgb(pd[i], pd[i + 1], pd[i + 2]);
			let c = p;
			if (dd) {
				const d = packRgb(dd[i], dd[i + 1], dd[i + 2]);
				c = evalRop3(index, p, d, d);
			}
			pd[i] = (c >> 16) & 0xff;
			pd[i + 1] = (c >> 8) & 0xff;
			pd[i + 2] = c & 0xff;
			pd[i + 3] = 255;
		}
		compositeOverlay(ctx, box, scratch, paint);
		return true;
	} catch {
		return false;
	}
}

/**
 * {@link paintWithRop2PerPixel} restricted to the ten bitwise modes Canvas
 * cannot composite exactly ({@link isExactRop2Bitwise}). Returns `false`
 * (having drawn nothing) for any other mode, or when the canvas backend
 * lacks pixel readback; callers fall back to the approximate
 * `applyPen`/`applyBrush` + `stroke()`/`fill()` path.
 */
export function paintWithExactRop2(
	ctx: CanvasContext,
	rop2: number,
	color: string,
	draw: (scratch: CanvasContext) => void,
	pad = 2,
	fillRule?: CanvasFillRule,
): boolean {
	if (!isExactRop2Bitwise(rop2)) {
		return false;
	}
	return paintWithRop2PerPixel(ctx, rop2, color, draw, pad, fillRule);
}
