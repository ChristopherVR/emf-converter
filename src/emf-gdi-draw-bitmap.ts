/**
 * EMF GDI bitmap-blit record handlers: EMR_BITBLT, EMR_STRETCHBLT and
 * EMR_STRETCHDIBITS.
 *
 * All three carry a ROP3 raster-operation code, a destination rectangle and
 * (optionally) a source DIB plus source rectangle. The source rectangle is
 * honoured (GDI often records only part of the source surface, addressed
 * through XformSrc), mirrored destinations and sources flip the image the
 * way GDI does, and every ROP3 code is evaluated exactly (see `emf-rop3.ts`)
 * against the realised brush pattern (see `emf-gdi-brush-pattern.ts`).
 *
 * @module emf-gdi-draw-bitmap
 */

import {
	canvasDrawImage,
	canvasGetImageData,
	canvasPutImageData,
	createImageDataCompat,
	createTempCanvas,
} from './emf-canvas-helpers';
import { EMR_BITBLT, EMR_STRETCHBLT, EMR_STRETCHDIBITS, MAX_CANVAS_DIMENSION } from './emf-constants';
import { decodeDibToImageData } from './emf-dib-decoder';
import { realizeBrush, sampleTile } from './emf-gdi-brush-pattern';
import type { RealizedBrush } from './emf-gdi-brush-pattern';
import { gmx, gmy, gmw, gmh, hasWorldRotation } from './emf-gdi-coord';
import { fixPoint } from './emf-gdi-raster-shapes';
import { HALFTONE, stretchGdi } from './emf-gdi-stretch';
import { emfWarn } from './emf-logging';
import { drawBlendLayers, splitUnknownDestination, unknownDestination, type BlendLayer } from './emf-rop2-exact';
import { rewritePixels } from './emf-rop2-exact';
import { applyRop3, classifyRop3, clampPositiveRect, evalRop3, rop3Index, rop3Operands } from './emf-rop3';
import type { Rop3Pattern, Rop3Plan } from './emf-rop3';
import type { AnyCanvas, CanvasContext, EmfGdiReplayCtx } from './emf-types';
import { canReadBack } from './svg-context';

/** A decoded blit: destination rect (canvas px, may be negative) and optional source. */
interface BlitRequest {
	plan: Rop3Plan;
	dx: number;
	dy: number;
	dw: number;
	dh: number;
	/** Source bitmap location inside the record, or null for pattern-only blits. */
	source: { bmi: number; bits: number; cbBits: number } | null;
	/** Source rectangle in top-down bitmap pixels (may be negative = mirrored). */
	sx: number;
	sy: number;
	sw: number;
	sh: number;
	/** STRETCHDIBITS addresses a bottom-up DIB from its lower-left corner. */
	dibOrigin: 'top-left' | 'bottom-left';
}

// ---------------------------------------------------------------------------
// Operand realisation
// ---------------------------------------------------------------------------

/**
 * Builds the P operand for a blit: a solid colour or a sampler over canvas
 * pixels that maps back to the recording device's pixel grid (where GDI
 * anchors the brush origin), so a tile scales with `dpiScale`.
 */
function patternOperand(rCtx: EmfGdiReplayCtx, brush: RealizedBrush): Rop3Pattern {
	if (brush.kind === 'solid') {
		return brush.rgb;
	}
	if (brush.kind === 'none') {
		return 0;
	}
	const { state, bounds } = rCtx;
	const sx = rCtx.sx || 1;
	const sy = rCtx.sy || 1;
	return (x: number, y: number) =>
		sampleTile(
			brush,
			Math.floor(bounds.left + (x + 0.5) / sx),
			Math.floor(bounds.top + (y + 0.5) / sy),
			state.brushOrgX,
			state.brushOrgY,
		);
}

/**
 * Draws the source rectangle of the decoded source into `target` so it lands
 * on the (possibly mirrored) destination rect, expressed relative to
 * `target`'s own origin (`offsetX`, `offsetY`). A negative destination or
 * source extent mirrors the image on that axis, as GDI's StretchBlt does;
 * both negative cancel out. Non-HALFTONE modes resample exactly like GDI
 * (see `emf-gdi-stretch.ts`); HALFTONE uses the canvas's filtered resample.
 */
function drawSourceMapped(
	target: CanvasContext,
	decoded: DecodedSource,
	req: BlitRequest,
	offsetX: number,
	offsetY: number,
	mode: number,
): void {
	const dLeft = Math.min(req.dx, req.dx + req.dw) - offsetX;
	const dTop = Math.min(req.dy, req.dy + req.dh) - offsetY;
	if (mode !== HALFTONE) {
		const px = stretchGdi(decoded.pixels, req.sx, req.sy, req.sw, req.sh, req.dw, req.dh, mode);
		const tile = createTempCanvas(px.width, px.height);
		if (!tile) {
			return;
		}
		canvasPutImageData(tile.ctx, createImageDataCompat(px.data, px.width, px.height), 0, 0);
		target.save();
		target.globalCompositeOperation = 'source-over';
		canvasDrawImage(target, tile.canvas, Math.round(dLeft), Math.round(dTop), px.width, px.height);
		target.restore();
		return;
	}
	const flipX = req.dw < 0 !== req.sw < 0;
	const flipY = req.dh < 0 !== req.sh < 0;
	const adw = Math.abs(req.dw);
	const adh = Math.abs(req.dh);
	target.save();
	target.imageSmoothingEnabled = true;
	target.transform(
		flipX ? -1 : 1,
		0,
		0,
		flipY ? -1 : 1,
		flipX ? dLeft * 2 + adw : 0,
		flipY ? dTop * 2 + adh : 0,
	);
	const draw = target.drawImage as unknown as (
		img: AnyCanvas,
		sx: number,
		sy: number,
		sw: number,
		sh: number,
		dx: number,
		dy: number,
		dw: number,
		dh: number,
	) => void;
	draw.call(
		target,
		decoded.canvas,
		Math.min(req.sx, req.sx + req.sw),
		Math.min(req.sy, req.sy + req.sh),
		Math.abs(req.sw),
		Math.abs(req.sh),
		dLeft,
		dTop,
		adw,
		adh,
	);
	target.restore();
}

/** A decoded source DIB: its pixels and a canvas holding them. */
interface DecodedSource {
	pixels: ImageData;
	canvas: AnyCanvas;
}

/** Decodes the record's source DIB into a canvas, resolving the source rect's origin. */
function decodeSource(
	rCtx: EmfGdiReplayCtx,
	req: BlitRequest,
): { decoded: DecodedSource; req: BlitRequest } | null {
	if (!req.source) {
		return null;
	}
	const image = decodeDibToImageData(rCtx.view, req.source.bmi, req.source.bits, req.source.cbBits);
	if (!image) {
		return null;
	}
	const temp = createTempCanvas(image.width, image.height);
	if (!temp) {
		return null;
	}
	canvasPutImageData(temp.ctx, image, 0, 0);
	let { sy } = req;
	if (req.dibOrigin === 'bottom-left' && rCtx.view.getInt32(req.source.bmi + 8, true) > 0) {
		sy = image.height - sy - req.sh;
	}
	return {
		decoded: { pixels: image, canvas: temp.canvas },
		req: { ...req, sy },
	};
}

// ---------------------------------------------------------------------------
// Plan execution
// ---------------------------------------------------------------------------

function fillRectWith(
	ctx: CanvasContext,
	style: string,
	gco: GlobalCompositeOperation,
	req: BlitRequest,
): void {
	const prevGco = ctx.globalCompositeOperation;
	const prevFill = ctx.fillStyle;
	ctx.globalCompositeOperation = gco;
	ctx.fillStyle = style;
	ctx.fillRect(req.dx, req.dy, req.dw, req.dh);
	ctx.globalCompositeOperation = prevGco;
	ctx.fillStyle = prevFill;
}

/**
 * Exact ternary path: reads D back, builds S (scaled and mirrored like GDI)
 * and P, evaluates the ROP3 function per pixel, and composites the opaque
 * result through `drawImage` so the active clip still applies (unlike a raw
 * `putImageData`).
 */
/**
 * ROP3 codes that combine ONE operand with the destination through AND, OR
 * or XOR, expressed as `[operand-only ROP index, blend mode]`: the operand
 * layer is evaluated alone (its result does not depend on D) and composited
 * with a blend mode that equals the bitwise op for black/white operands
 * (multiply = AND, screen = OR, difference = XOR) and approximates it for
 * other colours. Used when the destination cannot be read back (SVG output
 * with `exactRasterOps: false`), where the exact per-pixel evaluation is
 * impossible, and as the stand-in for pixels under text that the pure-
 * JavaScript raster mirror does not know and whose result mixes destination
 * bits within a channel (`splitUnknownDestination`); the transparent-bitmap
 * idiom (SRCAND mask + SRCPAINT/SRCINVERT image) is exact this way.
 */
const ROP3_BLEND_APPROX: Record<number, [number, GlobalCompositeOperation]> = {
	0x88: [0xcc, 'multiply'], // SRCAND: S & D
	0x22: [0x33, 'multiply'], // ~S & D
	0xee: [0xcc, 'screen'], // SRCPAINT: S | D
	0xbb: [0x33, 'screen'], // MERGEPAINT: ~S | D
	0x66: [0xcc, 'difference'], // SRCINVERT: S ^ D
	0x99: [0x33, 'difference'], // ~(S ^ D)
	0xa0: [0xf0, 'multiply'], // P & D
	0x0a: [0x0f, 'multiply'], // ~P & D
	0xfa: [0xf0, 'screen'], // P | D
	0xaf: [0x0f, 'screen'], // ~P | D
	0x5a: [0xf0, 'difference'], // PATINVERT: P ^ D
	0xa5: [0x0f, 'difference'], // ~(P ^ D)
};

function runTernary(rCtx: EmfGdiReplayCtx, req: BlitRequest, index: number, usesP: boolean, usesS: boolean): void {
	const { ctx } = rCtx;
	const rect = clampPositiveRect(req.dx, req.dy, req.dw, req.dh, rCtx.canvasW, rCtx.canvasH);
	if (!rect) {
		return;
	}
	if (typeof ctx.getImageData !== 'function') {
		emfWarn('runTernary: context cannot read pixels back; ROP3 skipped');
		return;
	}
	let blend: GlobalCompositeOperation = 'source-over';
	if (!canReadBack(ctx) && rop3Operands(index).usesD) {
		const approx = ROP3_BLEND_APPROX[index];
		if (!approx) {
			emfWarn(`runTernary: ROP3 0x${index.toString(16)} needs the destination, which SVG output without a raster mirror cannot read; skipped`);
			return;
		}
		[index, blend] = approx;
		usesP = rop3Operands(index).usesP;
		usesS = rop3Operands(index).usesS;
	}
	const brush = realizeBrush(rCtx.state);
	if (usesP && brush.kind === 'none') {
		return;
	}
	const layer = createTempCanvas(rect.w, rect.h);
	if (!layer) {
		return;
	}
	let src: ImageData | null = null;
	if (usesS) {
		const decoded = decodeSource(rCtx, req);
		if (!decoded) {
			return;
		}
		drawSourceMapped(layer.ctx, decoded.decoded, decoded.req, rect.x, rect.y, rCtx.state.stretchBltMode);
		src = canvasGetImageData(layer.ctx, 0, 0, rect.w, rect.h);
	}
	const dst = canvasGetImageData(ctx, rect.x, rect.y, rect.w, rect.h);
	const pattern = patternOperand(rCtx, brush);
	applyRop3(dst, src, pattern, index, rect.x, rect.y);
	// Pixels under text the SVG backend's raster mirror cannot draw: keep
	// every destination-independent result exact and let the SVG renderer
	// apply the rest against the real glyphs (see splitUnknownDestination).
	const unknown = blend === 'source-over' && rop3Operands(index).usesD ? unknownDestination(ctx, rect) : null;
	let layers: BlendLayer[] = [];
	if (unknown) {
		const sd = src ? src.data : null;
		const pAt = (i: number): number =>
			typeof pattern === 'number' ? pattern : pattern(rect.x + (i % rect.w), rect.y + Math.floor(i / rect.w));
		const sAt = (i: number): number => (sd ? (sd[i * 4] << 16) | (sd[i * 4 + 1] << 8) | sd[i * 4 + 2] : 0);
		const approx = ROP3_BLEND_APPROX[index];
		layers = splitUnknownDestination(
			dst.data,
			rect.w * rect.h,
			unknown,
			(i, d) => evalRop3(index, pAt(i), sAt(i), d),
			approx ? (i) => ({ color: evalRop3(approx[0], pAt(i), sAt(i), 0), mode: approx[1] }) : undefined,
		);
	}
	canvasPutImageData(layer.ctx, dst, 0, 0);
	ctx.save();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.globalCompositeOperation = blend;
	ctx.globalAlpha = 1;
	canvasDrawImage(ctx, layer.canvas, rect.x, rect.y, rect.w, rect.h);
	ctx.restore();
	drawBlendLayers(ctx, rect, layers);
}

/**
 * The sign of `v + e * dx + e^2 * dy` for an infinitesimal `e > 0`: the sign
 * a quantity that is linear in the device position takes at a pixel centre
 * nudged right by `e` and down by `e^2` (`dx`, `dy`: its derivatives along
 * device x and y).
 */
function nudgedSign(v: number, dx: number, dy: number): number {
	return v !== 0 ? Math.sign(v) : dx !== 0 ? Math.sign(dx) : Math.sign(dy);
}

/** Whether `0 <= n < den` holds for the nudged numerator `n` (see {@link nudgedSign}). */
function inHalfOpen(n: number, den: number, dx: number, dy: number): boolean {
	return nudgedSign(n, dx, dy) >= 0 && nudgedSign(n - den, dx, dy) < 0;
}

/**
 * `floor(num / den)` for the nudged numerator `num` (see {@link nudgedSign}):
 * an exact multiple of `den` that the nudge moves down counts as the
 * texel below.
 */
function nudgedFloor(num: number, den: number, dx: number, dy: number): number {
	const q = Math.floor(num / den);
	return num === q * den && nudgedSign(0, dx, dy) < 0 ? q - 1 : q;
}

/**
 * Full-affine (rotated/skewed `EMR_SETWORLDTRANSFORM`) bitmap blit for
 * BitBlt/StretchBlt/StretchDIBits, done the way GDI does it: per DEVICE
 * pixel, never by resampling a local raster.
 *
 * GDI turns the destination rectangle into a parallelogram in device 28.4
 * fixed point (FIX): the corners the logical (x, y), (x + w, y) and
 * (x, y + h) map to, each through `fixPoint` (the transform's linear part
 * and its translation rounded to FIX separately), the fourth corner
 * implied. A device pixel is painted when its centre (FIX `16 * x`) lies in
 * the parallelogram, half-open on the far edges (`0 <= u, v < 1` in the
 * parallelogram's own coordinates); its source texel is the one the centre
 * maps back to (`floor(u * |sw|)`, `floor(v * |sh|)`, counted inward from the
 * anchor for a mirrored source), with the ROP3 evaluated against that very
 * device pixel's destination value (D) and the brush pattern sampled there
 * (P). All of it is exact integer arithmetic on the FIX corners; matched
 * against real GDI rotated, mirrored, stretched and skewed blits (see the
 * `raster-blit-*` fixtures).
 *
 * A centre that falls exactly on an edge or on a texel boundary is decided
 * as if it sat an infinitesimal to the right and a smaller one further down
 * (`nudgedSign`): 360 of 360 whole-degree rotations and every
 * `raster-blit-*` fixture pixel-exact.
 *
 * The painted pixels reach the canvas through `rewritePixels`, so the
 * active clip applies.
 */
function executeRotatedBlit(
	rCtx: EmfGdiReplayCtx,
	logDx: number,
	logDy: number,
	logDw: number,
	logDh: number,
	rop: number,
	source: BlitRequest['source'],
	sx: number,
	sy: number,
	sw: number,
	sh: number,
	dibOrigin: 'top-left' | 'bottom-left',
): void {
	const { ctx } = rCtx;
	const index = rop3Index(rop);
	if (index === 0xaa) {
		return; // D: leaves the destination untouched.
	}
	const operands = rop3Operands(index);
	if (!canReadBack(ctx) && operands.usesD) {
		emfWarn('executeRotatedBlit: rotated destination-reading ROP3 needs pixel read-back; skipped in SVG output');
		return;
	}
	if (typeof ctx.getImageData !== 'function') {
		emfWarn('executeRotatedBlit: context cannot read pixels back; rotated ROP3 skipped');
		return;
	}
	if (logDw === 0 || logDh === 0) {
		return;
	}

	// The device parallelogram, in FIX.
	const [ax, ay] = fixPoint(rCtx, logDx, logDy);
	const [bx, by] = fixPoint(rCtx, logDx + logDw, logDy);
	const [qx, qy] = fixPoint(rCtx, logDx, logDy + logDh);
	const exx = bx - ax;
	const exy = by - ay;
	const eyx = qx - ax;
	const eyy = qy - ay;
	let det = exx * eyy - exy * eyx;
	if (det === 0) {
		return;
	}
	const sign = det < 0 ? -1 : 1;
	det *= sign;
	const xs = [ax, bx, qx, bx + eyx];
	const ys = [ay, by, qy, by + eyy];
	const size = { w: rCtx.canvasW, h: rCtx.canvasH };
	const x0 = Math.max(0, Math.floor(Math.min(...xs) / 16) - 1);
	const y0 = Math.max(0, Math.floor(Math.min(...ys) / 16) - 1);
	const x1 = Math.min(size.w, Math.ceil(Math.max(...xs) / 16) + 2);
	const y1 = Math.min(size.h, Math.ceil(Math.max(...ys) / 16) + 2);
	if (x1 <= x0 || y1 <= y0) {
		return;
	}

	const brush = realizeBrush(rCtx.state);
	if (operands.usesP && brush.kind === 'none') {
		return;
	}
	const pattern = patternOperand(rCtx, brush);

	// The source texels, unscaled: GDI samples the source bitmap itself.
	let src: ImageData | null = null;
	let srcX = sx;
	let srcY = sy;
	if (operands.usesS) {
		const decoded = decodeSource(rCtx, {
			plan: { kind: 'ternary', index, operands },
			dx: 0,
			dy: 0,
			dw: logDw,
			dh: logDh,
			source,
			sx,
			sy,
			sw,
			sh,
			dibOrigin,
		});
		if (!decoded) {
			return;
		}
		src = decoded.decoded.pixels;
		srcX = decoded.req.sx;
		srcY = decoded.req.sy;
	}
	const asw = Math.abs(sw) || 1;
	const ash = Math.abs(sh) || 1;
	// decodeSource has already turned a bottom-up DIB's source rect into
	// top-down image rows; a negative source extent mirrors, addressing texels
	// from the anchor inward.
	const texel = (ix: number, iy: number): number => {
		if (!src) {
			return 0;
		}
		let tx = sw < 0 ? srcX - 1 - ix : srcX + ix;
		let ty = sh < 0 ? srcY - 1 - iy : srcY + iy;
		tx = Math.max(0, Math.min(src.width - 1, tx));
		ty = Math.max(0, Math.min(src.height - 1, ty));
		const i = (ty * src.width + tx) * 4;
		return (src.data[i] << 16) | (src.data[i + 1] << 8) | src.data[i + 2];
	};

	// Derivatives of the u and v numerators along device x and y.
	const dux = sign * eyy;
	const duy = -sign * eyx;
	const dvx = -sign * exy;
	const dvy = sign * exx;
	rewritePixels(ctx, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, (x, y, d) => {
		const px = x * 16 - ax;
		const py = y * 16 - ay;
		const un = sign * (px * eyy - py * eyx);
		const vn = sign * (exx * py - exy * px);
		// A centre exactly on an edge or a texel boundary is decided as if it
		// were nudged right by an infinitesimal, then down by a smaller one
		// (GDI's top-left rule; 360 of 360 whole-degree rotations exact).
		if (!inHalfOpen(un, det, dux, duy) || !inHalfOpen(vn, det, dvx, dvy)) {
			return -1;
		}
		const ix = Math.min(asw - 1, nudgedFloor(un * asw, det, dux, duy));
		const iy = Math.min(ash - 1, nudgedFloor(vn * ash, det, dvx, dvy));
		const s = operands.usesS ? texel(ix, iy) : 0;
		const p = typeof pattern === 'function' ? pattern(x, y) : pattern;
		return evalRop3(index, p, s, d);
	});
}

/**
 * GDI addresses a mirrored destination from its anchor pixel inward: a
 * negative extent `w` at `x` covers device pixels `x+w+1 .. x`, one pixel
 * right of Canvas's `[x+w, x)`. Shift by one device pixel to match.
 */
function alignMirroredDest(rCtx: EmfGdiReplayCtx, req: BlitRequest): BlitRequest {
	const pxX = rCtx.useMappingMode ? 1 : rCtx.sx;
	const pxY = rCtx.useMappingMode ? 1 : rCtx.sy;
	return {
		...req,
		dx: req.dw < 0 ? req.dx + pxX : req.dx,
		dy: req.dh < 0 ? req.dy + pxY : req.dy,
	};
}

function executeBlit(rCtx: EmfGdiReplayCtx, request: BlitRequest): void {
	const { ctx } = rCtx;
	const req = alignMirroredDest(rCtx, request);
	const plan = req.plan;
	switch (plan.kind) {
		case 'noop':
			return;
		case 'solid':
			fillRectWith(ctx, plan.color === 'black' ? '#000000' : '#ffffff', 'source-over', req);
			return;
		case 'invert-dest':
			fillRectWith(ctx, '#ffffff', 'difference', req);
			return;
		case 'copy': {
			const decoded = decodeSource(rCtx, req);
			if (decoded) {
				drawSourceMapped(ctx, decoded.decoded, decoded.req, 0, 0, rCtx.state.stretchBltMode);
			}
			return;
		}
		case 'ternary': {
			// PATCOPY with a solid (or null) brush needs no read-back.
			const brush = realizeBrush(rCtx.state);
			if (plan.index === 0xf0 && brush.kind !== 'tile') {
				if (brush.kind === 'solid') {
					fillRectWith(ctx, rCtx.state.brushColor, 'source-over', req);
				}
				return;
			}
			runTernary(rCtx, req, plan.index, plan.operands.usesP, plan.operands.usesS);
		}
	}
}

// ---------------------------------------------------------------------------
// Record parsing
// ---------------------------------------------------------------------------

function sourceOf(
	offset: number,
	offBmi: number,
	cbBmi: number,
	offBits: number,
	cbBits: number,
): BlitRequest['source'] {
	return offBmi > 0 && cbBmi > 0 && offBits > 0 && cbBits > 0
		? { bmi: offset + offBmi, bits: offset + offBits, cbBits }
		: null;
}

/**
 * EMR_BITBLT (76) / EMR_STRETCHBLT (77). XformSrc maps the source DC's
 * coordinates into the recorded bitmap, which GDI usually crops to the
 * region actually read.
 */
function handleBlt(
	rCtx: EmfGdiReplayCtx,
	offset: number,
	dataOff: number,
	recSize: number,
	stretch: boolean,
): boolean {
	const { view } = rCtx;
	// The fixed part is 100 bytes (108 for STRETCHBLT); tolerate a short
	// BITBLT that stops before cbBitsSrc when no source is attached.
	if (recSize < (stretch ? 108 : 96)) {
		return true;
	}
	const xDest = view.getInt32(dataOff + 16, true);
	const yDest = view.getInt32(dataOff + 20, true);
	const cxDest = view.getInt32(dataOff + 24, true);
	const cyDest = view.getInt32(dataOff + 28, true);
	const rop = view.getUint32(dataOff + 32, true);
	const xSrc = view.getInt32(dataOff + 36, true);
	const ySrc = view.getInt32(dataOff + 40, true);
	const m11 = view.getFloat32(dataOff + 44, true);
	const m12 = view.getFloat32(dataOff + 48, true);
	const m21 = view.getFloat32(dataOff + 52, true);
	const m22 = view.getFloat32(dataOff + 56, true);
	const mdx = view.getFloat32(dataOff + 60, true);
	const mdy = view.getFloat32(dataOff + 64, true);
	const cxSrc = stretch ? view.getInt32(dataOff + 92, true) : cxDest;
	const cySrc = stretch ? view.getInt32(dataOff + 96, true) : cyDest;
	const source =
		recSize >= 100
			? sourceOf(
					offset,
					view.getUint32(dataOff + 76, true),
					view.getUint32(dataOff + 80, true),
					view.getUint32(dataOff + 84, true),
					view.getUint32(dataOff + 88, true),
				)
			: null;
	// An all-zero XformSrc (seen from some writers) means identity.
	const identity = m11 === 0 && m22 === 0 && m12 === 0 && m21 === 0;
	const a = identity ? 1 : m11;
	const d = identity ? 1 : m22;
	const srcRect = {
		sx: a * xSrc + (identity ? 0 : m21 * ySrc + mdx),
		sy: d * ySrc + (identity ? 0 : m12 * xSrc + mdy),
		sw: a * cxSrc,
		sh: d * cySrc,
	};
	if (hasWorldRotation(rCtx)) {
		executeRotatedBlit(
			rCtx,
			xDest,
			yDest,
			cxDest,
			cyDest,
			rop,
			source,
			srcRect.sx,
			srcRect.sy,
			srcRect.sw,
			srcRect.sh,
			'top-left',
		);
		return true;
	}
	executeBlit(rCtx, {
		plan: classifyRop3(rop),
		dx: gmx(rCtx, xDest),
		dy: gmy(rCtx, yDest),
		dw: gmw(rCtx, cxDest),
		dh: gmh(rCtx, cyDest),
		source,
		...srcRect,
		dibOrigin: 'top-left',
	});
	return true;
}

/** EMR_STRETCHDIBITS (81): the source rect addresses the DIB in DIB coordinates. */
function handleStretchDibits(
	rCtx: EmfGdiReplayCtx,
	offset: number,
	dataOff: number,
	recSize: number,
): boolean {
	const { view } = rCtx;
	if (recSize < 80) {
		return true;
	}
	const xDest = view.getInt32(dataOff + 16, true);
	const yDest = view.getInt32(dataOff + 20, true);
	const cxDest = view.getInt32(dataOff + 64, true);
	const cyDest = view.getInt32(dataOff + 68, true);
	const rop = view.getUint32(dataOff + 60, true);
	const source = sourceOf(
		offset,
		view.getUint32(dataOff + 40, true),
		view.getUint32(dataOff + 44, true),
		view.getUint32(dataOff + 48, true),
		view.getUint32(dataOff + 52, true),
	);
	const sx = view.getInt32(dataOff + 24, true);
	const sy = view.getInt32(dataOff + 28, true);
	const sw = view.getInt32(dataOff + 32, true);
	const sh = view.getInt32(dataOff + 36, true);
	if (hasWorldRotation(rCtx)) {
		executeRotatedBlit(rCtx, xDest, yDest, cxDest, cyDest, rop, source, sx, sy, sw, sh, 'bottom-left');
		return true;
	}
	executeBlit(rCtx, {
		plan: classifyRop3(rop),
		dx: gmx(rCtx, xDest),
		dy: gmy(rCtx, yDest),
		dw: gmw(rCtx, cxDest),
		dh: gmh(rCtx, cyDest),
		source,
		sx,
		sy,
		sw,
		sh,
		dibOrigin: 'bottom-left',
	});
	return true;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export function handleEmfGdiBitmapRecord(
	rCtx: EmfGdiReplayCtx,
	recType: number,
	offset: number,
	dataOff: number,
	recSize: number,
): boolean {
	switch (recType) {
		case EMR_BITBLT:
			return handleBlt(rCtx, offset, dataOff, recSize, false);
		case EMR_STRETCHBLT:
			return handleBlt(rCtx, offset, dataOff, recSize, true);
		case EMR_STRETCHDIBITS:
			return handleStretchDibits(rCtx, offset, dataOff, recSize);
		default:
			return false;
	}
}
