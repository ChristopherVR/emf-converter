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
import { gmx, gmy, gmw, gmh, gdiDeviceMatrix, gmapPoint, hasWorldRotation } from './emf-gdi-coord';
import { HALFTONE, stretchGdi } from './emf-gdi-stretch';
import { emfWarn } from './emf-logging';
import { drawBlendLayers, splitUnknownDestination, unknownDestination, type BlendLayer } from './emf-rop2-exact';
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
 * Full-affine (rotated/skewed `EMR_SETWORLDTRANSFORM`) bitmap blit for
 * BitBlt/StretchBlt/StretchDIBits. Real GDI DOES rotate a blit's destination
 * under a rotated world transform (measured against a real fixture:
 * `probe-rotate-bitblt-25deg` under `src/__fixtures__/gdi`, where the
 * blitted source's horizontal colour bands come out visibly tilted); the
 * axis-aligned `runTernary` above only carries the transform's scale and
 * translation, since its exact per-pixel evaluator assumes a destination
 * rectangle it can `getImageData`/`putImageData` directly.
 *
 * Technique ("draw to a scratch canvas in device space then combine"): the
 * exact per-pixel ROP3 combine still runs on an UNROTATED local raster
 * (sized from the transform's true per-axis magnitude via `Math.hypot`, not
 * just `a`/`d`, so a rotated blit is not mis-sized). That sizing is exact
 * for a skew as well, not an approximation: the local raster's axes ARE the
 * mapped basis vectors (the placement below uses them unchanged), so one
 * local step moves exactly one device pixel along each mapped axis. Under a
 * skew the two axes are no longer perpendicular, so the raster holds
 * `1 / sin(angle between the axes)` samples per device pixel of area:
 * slightly oversampled, never undersampled, and every device pixel in the
 * parallelogram still receives a texel. Each local pixel's
 * destination operand (D) is sampled from its actual rotated DEVICE
 * position (nearest-neighbour, read once from a single bounding-box
 * `getImageData`) rather than from the same local index `applyRop3` assumes.
 * The finished local raster is then placed with `ctx.setTransform` using the
 * same per-step device deltas, so `drawImage` performs the (unavoidable,
 * since a rotated raster blit cannot stay nearest-neighbour-exact at every
 * output pixel) final resample; the brush pattern (P) is sampled at the true
 * device position too, matching `SetBrushOrgEx`'s device-space anchor.
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

	const m = gdiDeviceMatrix(rCtx);
	const origin = gmapPoint(rCtx, logDx, logDy);
	const scaleX = Math.hypot(m[0], m[1]);
	const scaleY = Math.hypot(m[2], m[3]);
	const dw = Math.max(1, Math.min(MAX_CANVAS_DIMENSION, Math.round(scaleX * Math.abs(logDw)) || 1));
	const dh = Math.max(1, Math.min(MAX_CANVAS_DIMENSION, Math.round(scaleY * Math.abs(logDh)) || 1));
	// Device-space delta per local step (one step per output pixel); the sign
	// of the logical width/height folds GDI's mirrored-destination convention
	// directly into the basis vectors.
	const signDw = logDw < 0 ? -1 : 1;
	const signDh = logDh < 0 ? -1 : 1;
	const exX = (m[0] * signDw * Math.abs(logDw)) / dw;
	const exY = (m[1] * signDw * Math.abs(logDw)) / dw;
	const eyX = (m[2] * signDh * Math.abs(logDh)) / dh;
	const eyY = (m[3] * signDh * Math.abs(logDh)) / dh;

	const corners = [
		origin,
		{ x: origin.x + exX * dw, y: origin.y + exY * dw },
		{ x: origin.x + eyX * dh, y: origin.y + eyY * dh },
		{ x: origin.x + exX * dw + eyX * dh, y: origin.y + exY * dw + eyY * dh },
	];
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const c of corners) {
		minX = Math.min(minX, c.x);
		minY = Math.min(minY, c.y);
		maxX = Math.max(maxX, c.x);
		maxY = Math.max(maxY, c.y);
	}
	const bx = Math.max(0, Math.floor(minX));
	const by = Math.max(0, Math.floor(minY));
	const bw = Math.min(rCtx.canvasW, Math.ceil(maxX)) - bx;
	const bh = Math.min(rCtx.canvasH, Math.ceil(maxY)) - by;
	if (bw <= 0 || bh <= 0) {
		return;
	}

	const brush = realizeBrush(rCtx.state);
	if (operands.usesP && brush.kind === 'none') {
		return;
	}
	const pattern = patternOperand(rCtx, brush);

	// Build S in LOCAL (unrotated) raster space: source stretch-mode sampling
	// is unaffected by the destination's rotation, only its placement is.
	let src: ImageData | null = null;
	if (operands.usesS) {
		const localReq: BlitRequest = {
			plan: { kind: 'ternary', index, operands },
			dx: 0,
			dy: 0,
			dw: signDw * dw,
			dh: signDh * dh,
			source,
			sx,
			sy,
			sw,
			sh,
			dibOrigin,
		};
		const decoded = decodeSource(rCtx, localReq);
		if (!decoded) {
			return;
		}
		const srcLayer = createTempCanvas(dw, dh);
		if (!srcLayer) {
			return;
		}
		drawSourceMapped(srcLayer.ctx, decoded.decoded, decoded.req, 0, 0, rCtx.state.stretchBltMode);
		src = canvasGetImageData(srcLayer.ctx, 0, 0, dw, dh);
	}

	const destBBox = canvasGetImageData(ctx, bx, by, bw, bh);
	const dd = destBBox.data;
	const out = new Uint8ClampedArray(dw * dh * 4);
	for (let ly = 0; ly < dh; ly++) {
		for (let lx = 0; lx < dw; lx++) {
			const devX = origin.x + exX * lx + eyX * ly;
			const devY = origin.y + exY * lx + eyY * ly;
			const oi = (ly * dw + lx) * 4;
			const ix = Math.round(devX) - bx;
			const iy = Math.round(devY) - by;
			if (ix < 0 || iy < 0 || ix >= bw || iy >= bh) {
				continue; // Leaves this output texel transparent: outside the canvas.
			}
			const di = (iy * bw + ix) * 4;
			const dv = (dd[di] << 16) | (dd[di + 1] << 8) | dd[di + 2];
			const si = (ly * dw + lx) * 4;
			const sv = src ? (src.data[si] << 16) | (src.data[si + 1] << 8) | src.data[si + 2] : 0;
			const pv = typeof pattern === 'function' ? pattern(Math.round(devX), Math.round(devY)) : pattern;
			const r = evalRop3(index, pv, sv, dv);
			out[oi] = (r >> 16) & 0xff;
			out[oi + 1] = (r >> 8) & 0xff;
			out[oi + 2] = r & 0xff;
			out[oi + 3] = 255;
		}
	}

	const outLayer = createTempCanvas(dw, dh);
	if (!outLayer) {
		return;
	}
	canvasPutImageData(outLayer.ctx, createImageDataCompat(out, dw, dh), 0, 0);
	ctx.save();
	ctx.setTransform(exX, exY, eyX, eyY, origin.x, origin.y);
	ctx.imageSmoothingEnabled = false;
	ctx.globalCompositeOperation = 'source-over';
	ctx.globalAlpha = 1;
	canvasDrawImage(ctx, outLayer.canvas, 0, 0, dw, dh);
	ctx.restore();
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
