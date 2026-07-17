/**
 * EMF GDI text, bitmap, and clipping record handlers:
 * ExtTextOutW, BitBlt, StretchDIBits, IntersectClipRect.
 */

import {
	applyFont,
	drawTextDecorations,
	readUtf16LE,
	createTempCanvas,
} from './emf-canvas-helpers';
import {
	applyClipShapes,
	combineClip,
	rectClipShape,
	rectsClipShape,
	reapplyClipRegion,
	translateClipRegion,
	type ClipCombineOp,
	type ClipShape,
} from './emf-clip-region';
import {
	EMR_EXTTEXTOUTW,
	EMR_BITBLT,
	EMR_STRETCHDIBITS,
	EMR_INTERSECTCLIPRECT,
	EMR_EXTSELECTCLIPRGN,
	EMR_EXCLUDECLIPRECT,
	EMR_OFFSETCLIPRGN,
} from './emf-constants';
import { decodeDibToImageData } from './emf-dib-decoder';
import { gmx, gmy, gmw, gmh } from './emf-gdi-coord';
import { emfLog } from './emf-logging';
import type { EmfGdiReplayCtx } from './emf-types';

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function handleExtTextOutW(
	rCtx: EmfGdiReplayCtx,
	offset: number,
	dataOff: number,
	recSize: number,
): boolean {
	const { ctx, view, state } = rCtx;
	if (recSize >= 76) {
		const refX = view.getInt32(dataOff + 28, true);
		const refY = view.getInt32(dataOff + 32, true);
		const nChars = view.getUint32(dataOff + 36, true);
		const offString = view.getUint32(dataOff + 40, true);
		const maxOffset = view.byteLength;
		if (nChars > 0 && offString > 0 && offset + offString + nChars * 2 <= maxOffset) {
			const text = readUtf16LE(view, offset + offString, nChars);
			if (text.length > 0) {
				applyFont(ctx, state);
				ctx.fillStyle = state.textColor;
				let alignBaseline: CanvasTextBaseline = 'alphabetic';
				let alignHoriz: CanvasTextAlign = 'left';
				if (state.textAlign & 0x08) {
					alignBaseline = 'bottom';
				}
				if (state.textAlign & 0x18) {
					alignBaseline = 'alphabetic';
				}
				if (state.textAlign & 0x06) {
					alignHoriz = 'center';
				}
				if (state.textAlign & 0x02) {
					alignHoriz = 'right';
				}
				ctx.textBaseline = alignBaseline;
				ctx.textAlign = alignHoriz;
				if (state.bkMode === 2) {
					const measured = ctx.measureText(text);
					const bgH = state.fontHeight || 12;
					ctx.fillStyle = state.bkColor;
					ctx.fillRect(gmx(rCtx, refX), gmy(rCtx, refY) - bgH, measured.width, bgH);
					ctx.fillStyle = state.textColor;
				}
				ctx.fillText(text, gmx(rCtx, refX), gmy(rCtx, refY));
				if (state.fontUnderline || state.fontStrikeOut) {
					const w = ctx.measureText(text).width;
					const baseX = gmx(rCtx, refX);
					const startX =
						alignHoriz === 'center'
							? baseX - w / 2
							: alignHoriz === 'right'
								? baseX - w
								: baseX;
					drawTextDecorations(ctx, state, startX, gmy(rCtx, refY), w);
				}
			}
		}
	}
	return true;
}

// ---------------------------------------------------------------------------
// Bitmap operations
// ---------------------------------------------------------------------------

function handleBitBlt(
	rCtx: EmfGdiReplayCtx,
	offset: number,
	dataOff: number,
	recSize: number,
): boolean {
	const { ctx, view } = rCtx;
	if (recSize >= 96) {
		const dstX = view.getInt32(dataOff + 16, true);
		const dstY = view.getInt32(dataOff + 20, true);
		const dstW = view.getInt32(dataOff + 24, true);
		const dstH = view.getInt32(dataOff + 28, true);
		const offBmiSrc = view.getUint32(dataOff + 76, true);
		const cbBmiSrc = view.getUint32(dataOff + 80, true);
		const offBitsSrc = view.getUint32(dataOff + 84, true);
		const cbBitsSrc = view.getUint32(dataOff + 88, true);
		if (offBmiSrc > 0 && cbBmiSrc > 0 && offBitsSrc > 0 && cbBitsSrc > 0) {
			const imageData = decodeDibToImageData(
				view,
				offset + offBmiSrc,
				offset + offBitsSrc,
				cbBitsSrc,
			);
			if (imageData) {
				const temp = createTempCanvas(imageData.width, imageData.height);
				if (temp) {
					temp.ctx.putImageData(imageData, 0, 0);
					ctx.drawImage(
						temp.canvas as CanvasImageSource,
						gmx(rCtx, dstX),
						gmy(rCtx, dstY),
						gmw(rCtx, dstW),
						gmh(rCtx, dstH),
					);
				}
			}
		}
	}
	return true;
}

function handleStretchDibits(
	rCtx: EmfGdiReplayCtx,
	offset: number,
	dataOff: number,
	recSize: number,
): boolean {
	const { ctx, view } = rCtx;
	if (recSize >= 80) {
		const dstX = view.getInt32(dataOff + 16, true);
		const dstY = view.getInt32(dataOff + 20, true);
		const dstW = view.getInt32(dataOff + 64, true);
		const dstH = view.getInt32(dataOff + 68, true);
		const offBmiSrc = view.getUint32(dataOff + 40, true);
		const cbBmiSrc = view.getUint32(dataOff + 44, true);
		const offBitsSrc = view.getUint32(dataOff + 48, true);
		const cbBitsSrc = view.getUint32(dataOff + 52, true);
		if (offBmiSrc > 0 && cbBmiSrc > 0 && offBitsSrc > 0 && cbBitsSrc > 0) {
			const imageData = decodeDibToImageData(
				view,
				offset + offBmiSrc,
				offset + offBitsSrc,
				cbBitsSrc,
			);
			if (imageData) {
				const temp = createTempCanvas(imageData.width, imageData.height);
				if (temp) {
					temp.ctx.putImageData(imageData, 0, 0);
					ctx.drawImage(
						temp.canvas as CanvasImageSource,
						gmx(rCtx, dstX),
						gmy(rCtx, dstY),
						gmw(rCtx, dstW),
						gmh(rCtx, dstH),
					);
				}
			}
		}
	}
	return true;
}

// ---------------------------------------------------------------------------
// Clipping
// ---------------------------------------------------------------------------

/**
 * Combine the tracked clip region with a new device-space shape and rebuild
 * the canvas clip state.
 *
 * When the active clip contains an untracked component (EMR_SELECTCLIPPATH
 * clips with the live ctx path, which cannot be recorded), only ops that can
 * be layered incrementally on top of the existing canvas clip are applied
 * (`intersect`, and `exclude` via the even-odd inversion); the rest degrade
 * conservatively.
 */
export function gdiCombineClip(rCtx: EmfGdiReplayCtx, shape: ClipShape, op: ClipCombineOp): void {
	const { ctx } = rCtx;

	if (rCtx.clipUntracked && op !== 'replace') {
		switch (op) {
			case 'intersect':
			case 'complement': {
				// complement ⊆ shape, so intersecting with the shape is the closest
				// stackable approximation.
				ctx.save();
				rCtx.clipSaveDepth++;
				applyClipShapes(ctx, [shape]);
				if (op === 'complement') {
					emfLog('gdiCombineClip: complement on untracked clip — approximated as intersect');
				}
				return;
			}
			case 'exclude':
			case 'xor': {
				// current − shape stacks as an intersection with ¬shape. For xor this
				// yields the (current − shape) subset of the symmetric difference.
				const inv = combineClip(null, shape, 'exclude');
				ctx.save();
				rCtx.clipSaveDepth++;
				applyClipShapes(ctx, inv.region ?? [shape]);
				if (op === 'xor') {
					emfLog('gdiCombineClip: xor on untracked clip — approximated as exclude');
				}
				return;
			}
			case 'union':
				emfLog('gdiCombineClip: union on untracked clip — clip left unchanged');
				return;
		}
	}

	const res = combineClip(op === 'replace' ? null : (rCtx.clipRegion ?? null), shape, op);
	if (!res.exact) {
		emfLog(`gdiCombineClip: '${op}' approximated (region too complex for exact combination)`);
	}
	rCtx.clipRegion = res.region;
	rCtx.clipUntracked = false;
	reapplyClipRegion(rCtx, res.region);
}

function readClipRectShape(rCtx: EmfGdiReplayCtx, dataOff: number): ClipShape {
	const { view } = rCtx;
	const left = view.getInt32(dataOff, true);
	const top = view.getInt32(dataOff + 4, true);
	const right = view.getInt32(dataOff + 8, true);
	const bottom = view.getInt32(dataOff + 12, true);
	return rectClipShape(
		gmx(rCtx, left),
		gmy(rCtx, top),
		gmw(rCtx, right - left),
		gmh(rCtx, bottom - top),
	);
}

function handleIntersectClipRect(rCtx: EmfGdiReplayCtx, dataOff: number, recSize: number): boolean {
	if (recSize >= 24) {
		gdiCombineClip(rCtx, readClipRectShape(rCtx, dataOff), 'intersect');
	}
	return true;
}

// ---------------------------------------------------------------------------
// EMR_EXCLUDECLIPRECT (record type 29)
// ---------------------------------------------------------------------------

function handleExcludeClipRect(rCtx: EmfGdiReplayCtx, dataOff: number, recSize: number): boolean {
	if (recSize >= 24) {
		gdiCombineClip(rCtx, readClipRectShape(rCtx, dataOff), 'exclude');
	}
	return true;
}

// ---------------------------------------------------------------------------
// EMR_EXTSELECTCLIPRGN (record type 75)
// ---------------------------------------------------------------------------

/** RegionMode (MS-EMF 2.1.29) → boolean combine op. */
const RGN_MODE_OPS: Record<number, ClipCombineOp> = {
	1: 'intersect', // RGN_AND
	2: 'union', // RGN_OR
	3: 'xor', // RGN_XOR
	4: 'exclude', // RGN_DIFF
	5: 'replace', // RGN_COPY
};

function handleExtSelectClipRgn(rCtx: EmfGdiReplayCtx, dataOff: number, recSize: number): boolean {
	const { view } = rCtx;
	if (recSize < 16) {
		return true;
	}

	const cbRgnData = view.getUint32(dataOff, true);
	const iMode = view.getUint32(dataOff + 4, true);
	const op = RGN_MODE_OPS[iMode];

	if (!op) {
		emfLog(`EMR_EXTSELECTCLIPRGN: unknown RegionMode ${iMode} — ignored`);
		return true;
	}

	if (cbRgnData === 0) {
		// A null region is only meaningful with RGN_COPY: reset to no clip.
		if (op === 'replace') {
			rCtx.clipRegion = null;
			rCtx.clipUntracked = false;
			reapplyClipRegion(rCtx, null);
			emfLog('EMR_EXTSELECTCLIPRGN: RGN_COPY with empty region — clip reset');
		}
		return true;
	}

	// Parse RGNDATAHEADER (32 bytes)
	const rgnStart = dataOff + 8;
	if (cbRgnData < 32) {
		return true;
	}
	const nCount = view.getUint32(rgnStart + 8, true);
	if (nCount === 0) {
		return true;
	}

	// RGNDATA scanline rects are pairwise disjoint, so the shape stays simple.
	const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
	const rectsStart = rgnStart + 32;
	for (let i = 0; i < nCount; i++) {
		const rOff = rectsStart + i * 16;
		if (rOff + 16 > dataOff + 8 + cbRgnData) {
			break;
		}
		const left = view.getInt32(rOff, true);
		const top = view.getInt32(rOff + 4, true);
		const right = view.getInt32(rOff + 8, true);
		const bottom = view.getInt32(rOff + 12, true);
		rects.push({
			x: gmx(rCtx, left),
			y: gmy(rCtx, top),
			w: gmw(rCtx, right - left),
			h: gmh(rCtx, bottom - top),
		});
	}
	if (rects.length === 0) {
		return true;
	}

	gdiCombineClip(rCtx, rectsClipShape(rects), op);
	emfLog(`EMR_EXTSELECTCLIPRGN: mode=${iMode} (${op}) with ${rects.length} rect(s)`);
	return true;
}

// ---------------------------------------------------------------------------
// EMR_OFFSETCLIPRGN (record type 26)
// ---------------------------------------------------------------------------

function handleOffsetClipRgn(rCtx: EmfGdiReplayCtx, dataOff: number, recSize: number): boolean {
	if (recSize >= 16) {
		const dx = rCtx.view.getInt32(dataOff, true);
		const dy = rCtx.view.getInt32(dataOff + 4, true);
		if (rCtx.clipUntracked) {
			emfLog(`EMR_OFFSETCLIPRGN: offset=(${dx},${dy}) skipped — active clip is untracked`);
			return true;
		}
		if (rCtx.clipRegion) {
			rCtx.clipRegion = translateClipRegion(rCtx.clipRegion, gmw(rCtx, dx), gmh(rCtx, dy));
			reapplyClipRegion(rCtx, rCtx.clipRegion);
			emfLog(`EMR_OFFSETCLIPRGN: clip translated by (${dx},${dy}) logical units`);
		}
	}
	return true;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export function handleEmfGdiTextBitmapRecord(
	rCtx: EmfGdiReplayCtx,
	recType: number,
	offset: number,
	dataOff: number,
	recSize: number,
): boolean {
	switch (recType) {
		case EMR_EXTTEXTOUTW:
			return handleExtTextOutW(rCtx, offset, dataOff, recSize);
		case EMR_BITBLT:
			return handleBitBlt(rCtx, offset, dataOff, recSize);
		case EMR_STRETCHDIBITS:
			return handleStretchDibits(rCtx, offset, dataOff, recSize);
		case EMR_INTERSECTCLIPRECT:
			return handleIntersectClipRect(rCtx, dataOff, recSize);
		case EMR_EXTSELECTCLIPRGN:
			return handleExtSelectClipRgn(rCtx, dataOff, recSize);
		case EMR_EXCLUDECLIPRECT:
			return handleExcludeClipRect(rCtx, dataOff, recSize);
		case EMR_OFFSETCLIPRGN:
			return handleOffsetClipRgn(rCtx, dataOff, recSize);
		default:
			return false;
	}
}
