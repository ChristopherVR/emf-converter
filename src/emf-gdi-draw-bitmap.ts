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
import { EMR_BITBLT, EMR_STRETCHBLT, EMR_STRETCHDIBITS } from './emf-constants';
import { decodeDibToImageData } from './emf-dib-decoder';
import { realizeBrush, sampleTile } from './emf-gdi-brush-pattern';
import type { RealizedBrush } from './emf-gdi-brush-pattern';
import { gmx, gmy, gmw, gmh } from './emf-gdi-coord';
import { HALFTONE, stretchGdi } from './emf-gdi-stretch';
import { emfWarn } from './emf-logging';
import { applyRop3, classifyRop3, clampPositiveRect } from './emf-rop3';
import type { Rop3Pattern, Rop3Plan } from './emf-rop3';
import type { AnyCanvas, CanvasContext, EmfGdiReplayCtx } from './emf-types';

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
	applyRop3(dst, src, patternOperand(rCtx, brush), index, rect.x, rect.y);
	canvasPutImageData(layer.ctx, dst, 0, 0);
	ctx.save();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.globalCompositeOperation = 'source-over';
	ctx.globalAlpha = 1;
	canvasDrawImage(ctx, layer.canvas, rect.x, rect.y, rect.w, rect.h);
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
	executeBlit(rCtx, {
		plan: classifyRop3(rop),
		dx: gmx(rCtx, xDest),
		dy: gmy(rCtx, yDest),
		dw: gmw(rCtx, cxDest),
		dh: gmh(rCtx, cyDest),
		source,
		sx: a * xSrc + (identity ? 0 : m21 * ySrc + mdx),
		sy: d * ySrc + (identity ? 0 : m12 * xSrc + mdy),
		sw: a * cxSrc,
		sh: d * cySrc,
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
	executeBlit(rCtx, {
		plan: classifyRop3(view.getUint32(dataOff + 60, true)),
		dx: gmx(rCtx, view.getInt32(dataOff + 16, true)),
		dy: gmy(rCtx, view.getInt32(dataOff + 20, true)),
		dw: gmw(rCtx, view.getInt32(dataOff + 64, true)),
		dh: gmh(rCtx, view.getInt32(dataOff + 68, true)),
		source: sourceOf(
			offset,
			view.getUint32(dataOff + 40, true),
			view.getUint32(dataOff + 44, true),
			view.getUint32(dataOff + 48, true),
			view.getUint32(dataOff + 52, true),
		),
		sx: view.getInt32(dataOff + 24, true),
		sy: view.getInt32(dataOff + 28, true),
		sw: view.getInt32(dataOff + 32, true),
		sh: view.getInt32(dataOff + 36, true),
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
