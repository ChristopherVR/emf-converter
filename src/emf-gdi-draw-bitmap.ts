/**
 * EMF GDI bitmap-blit record handlers: BitBlt, StretchDIBits.
 *
 * Both records carry a ROP3 raster-operation code; see `emf-rop3.ts` for how
 * each is emulated on Canvas 2D.
 *
 * @module emf-gdi-draw-bitmap
 */

import { canvasDrawImage, canvasGetImageData, canvasPutImageData, createTempCanvas } from './emf-canvas-helpers';
import { EMR_BITBLT, EMR_STRETCHDIBITS } from './emf-constants';
import { decodeDibToImageData } from './emf-dib-decoder';
import { gmx, gmy, gmw, gmh } from './emf-gdi-coord';
import { emfLog, emfWarn } from './emf-logging';
import { classifyRop3, applyRop3Bitwise, invertImageDataRgb, clampPositiveRect } from './emf-rop3';
import type { Rop3Plan } from './emf-rop3';
import type { CanvasContext, EmfGdiReplayCtx } from './emf-types';

/** BS_NULL brush style: brush that paints nothing. */
const BS_NULL = 1;

// ---------------------------------------------------------------------------
// ROP3 plans that never need the decoded source bitmap
// ---------------------------------------------------------------------------

function fillWithBrush(rCtx: EmfGdiReplayCtx, dx: number, dy: number, dw: number, dh: number): void {
	const { ctx, state } = rCtx;
	if (state.brushStyle === BS_NULL) {
		return;
	}
	const prevFill = ctx.fillStyle;
	ctx.fillStyle = state.brushColor;
	ctx.fillRect(dx, dy, dw, dh);
	ctx.fillStyle = prevFill;
}

function fillSolid(ctx: CanvasContext, color: 'black' | 'white', dx: number, dy: number, dw: number, dh: number): void {
	const prevFill = ctx.fillStyle;
	ctx.fillStyle = color === 'black' ? '#000000' : '#ffffff';
	ctx.fillRect(dx, dy, dw, dh);
	ctx.fillStyle = prevFill;
}

/** DSTINVERT: `~D`, exactly reproduced by a full-white `'difference'` blend (same trick `rop2Paint` uses for R2_NOT). */
function invertDestRect(ctx: CanvasContext, dx: number, dy: number, dw: number, dh: number): void {
	const prevGco = ctx.globalCompositeOperation;
	const prevFill = ctx.fillStyle;
	ctx.globalCompositeOperation = 'difference';
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(dx, dy, dw, dh);
	ctx.globalCompositeOperation = prevGco;
	ctx.fillStyle = prevFill;
}

// ---------------------------------------------------------------------------
// ROP3 plans that need the decoded source bitmap
// ---------------------------------------------------------------------------

/**
 * Draws a decoded source bitmap into the destination rect under a ROP3 plan
 * that reads the source (`copy`, `invert-source`, or `bitwise`).
 *
 * A flipped destination rect (negative `dw`/`dh`) is drawn as a plain copy:
 * `drawImage` handles the mirror natively, but the pixel-exact `bitwise` /
 * `invert-source` paths need a positive-extent rect for `getImageData`/
 * `putImageData`, and flipped ROP3 blits are rare enough in practice that
 * degrading them (rather than adding general affine pixel remapping) is the
 * pragmatic tradeoff - logged so it is easy to spot if it ever matters.
 */
function drawSourceWithRop(
	rCtx: EmfGdiReplayCtx,
	imageData: ImageData,
	dx: number,
	dy: number,
	dw: number,
	dh: number,
	plan: Rop3Plan,
): void {
	const { ctx } = rCtx;
	const temp = createTempCanvas(imageData.width, imageData.height);
	if (!temp) {
		return;
	}
	temp.ctx.putImageData(imageData, 0, 0);

	if (plan.kind === 'copy' || dw < 0 || dh < 0) {
		if (plan.kind !== 'copy') {
			emfLog('drawSourceWithRop: flipped destination rect - falling back to SRCCOPY');
		}
		canvasDrawImage(ctx, temp.canvas, dx, dy, dw, dh);
		return;
	}

	const rect = clampPositiveRect(dx, dy, dw, dh, rCtx.canvasW, rCtx.canvasH);
	if (!rect) {
		return;
	}
	const scaled = createTempCanvas(rect.w, rect.h);
	if (!scaled) {
		return;
	}
	canvasDrawImage(scaled.ctx, temp.canvas, dx - rect.x, dy - rect.y, dw, dh);

	if (plan.kind === 'invert-source') {
		const scaledData = canvasGetImageData(scaled.ctx, 0, 0, rect.w, rect.h);
		invertImageDataRgb(scaledData);
		canvasPutImageData(ctx, scaledData, rect.x, rect.y);
		return;
	}

	if (plan.kind !== 'bitwise') {
		return;
	}
	if (typeof ctx.getImageData !== 'function' || typeof ctx.putImageData !== 'function') {
		emfWarn('drawSourceWithRop: bitwise ROP3 needs getImageData/putImageData - falling back to SRCCOPY');
		canvasDrawImage(ctx, temp.canvas, dx, dy, dw, dh);
		return;
	}
	const scaledData = canvasGetImageData(scaled.ctx, 0, 0, rect.w, rect.h);
	const destData = canvasGetImageData(ctx, rect.x, rect.y, rect.w, rect.h);
	applyRop3Bitwise(destData, scaledData, plan.op);
	canvasPutImageData(ctx, destData, rect.x, rect.y);
}

/** Dispatches a ROP3 plan to the right drawing strategy for a BitBlt/StretchDIBits record. */
function applyRop3Plan(
	rCtx: EmfGdiReplayCtx,
	plan: Rop3Plan,
	dx: number,
	dy: number,
	dw: number,
	dh: number,
	view: DataView,
	offset: number,
	offBmiSrc: number,
	cbBmiSrc: number,
	offBitsSrc: number,
	cbBitsSrc: number,
): void {
	switch (plan.kind) {
		case 'pattern':
			fillWithBrush(rCtx, dx, dy, dw, dh);
			return;
		case 'solid':
			fillSolid(rCtx.ctx, plan.color, dx, dy, dw, dh);
			return;
		case 'invert-dest':
			invertDestRect(rCtx.ctx, dx, dy, dw, dh);
			return;
		default: {
			if (!(offBmiSrc > 0 && cbBmiSrc > 0 && offBitsSrc > 0 && cbBitsSrc > 0)) {
				return;
			}
			const imageData = decodeDibToImageData(
				view,
				offset + offBmiSrc,
				offset + offBitsSrc,
				cbBitsSrc,
			);
			if (imageData) {
				drawSourceWithRop(rCtx, imageData, dx, dy, dw, dh, plan);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// EMR_BITBLT (record type 76)
// ---------------------------------------------------------------------------

function handleBitBlt(
	rCtx: EmfGdiReplayCtx,
	offset: number,
	dataOff: number,
	recSize: number,
): boolean {
	const { view } = rCtx;
	if (recSize < 96) {
		return true;
	}
	const dstX = view.getInt32(dataOff + 16, true);
	const dstY = view.getInt32(dataOff + 20, true);
	const dstW = view.getInt32(dataOff + 24, true);
	const dstH = view.getInt32(dataOff + 28, true);
	const rop = view.getUint32(dataOff + 32, true);
	const offBmiSrc = view.getUint32(dataOff + 76, true);
	const cbBmiSrc = view.getUint32(dataOff + 80, true);
	const offBitsSrc = view.getUint32(dataOff + 84, true);
	const cbBitsSrc = view.getUint32(dataOff + 88, true);

	applyRop3Plan(
		rCtx,
		classifyRop3(rop),
		gmx(rCtx, dstX),
		gmy(rCtx, dstY),
		gmw(rCtx, dstW),
		gmh(rCtx, dstH),
		view,
		offset,
		offBmiSrc,
		cbBmiSrc,
		offBitsSrc,
		cbBitsSrc,
	);
	return true;
}

// ---------------------------------------------------------------------------
// EMR_STRETCHDIBITS (record type 81)
// ---------------------------------------------------------------------------

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
	const dstX = view.getInt32(dataOff + 16, true);
	const dstY = view.getInt32(dataOff + 20, true);
	const offBmiSrc = view.getUint32(dataOff + 40, true);
	const cbBmiSrc = view.getUint32(dataOff + 44, true);
	const offBitsSrc = view.getUint32(dataOff + 48, true);
	const cbBitsSrc = view.getUint32(dataOff + 52, true);
	const rop = view.getUint32(dataOff + 60, true);
	const dstW = view.getInt32(dataOff + 64, true);
	const dstH = view.getInt32(dataOff + 68, true);

	applyRop3Plan(
		rCtx,
		classifyRop3(rop),
		gmx(rCtx, dstX),
		gmy(rCtx, dstY),
		gmw(rCtx, dstW),
		gmh(rCtx, dstH),
		view,
		offset,
		offBmiSrc,
		cbBmiSrc,
		offBitsSrc,
		cbBitsSrc,
	);
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
			return handleBitBlt(rCtx, offset, dataOff, recSize);
		case EMR_STRETCHDIBITS:
			return handleStretchDibits(rCtx, offset, dataOff, recSize);
		default:
			return false;
	}
}
