/**
 * Dispatcher for the EMF GDI text, bitmap, and clipping records: ExtTextOutW,
 * BitBlt, StretchDIBits, IntersectClipRect, ExtSelectClipRgn, ExcludeClipRect,
 * OffsetClipRgn.
 *
 * The actual handlers live in three focused modules:
 * - `emf-gdi-draw-text.ts` (ExtTextOutW)
 * - `emf-gdi-draw-bitmap.ts` (BitBlt, StretchDIBits)
 * - `emf-gdi-clip-records.ts` (the clip-rect/region records, plus the shared
 *   `gdiCombineClip` also used by EMR_SELECTCLIPPATH)
 *
 * @module emf-gdi-draw-text-bitmap
 */

import { handleEmfGdiBlendBlitRecord } from './emf-gdi-blend-blits';
import { handleEmfGdiBitmapRecord } from './emf-gdi-draw-bitmap';
import { handleEmfGdiDrawTextRecord } from './emf-gdi-draw-text';
import { handleEmfGdiClipRecord } from './emf-gdi-clip-records';
import { handleEmfGdiFloodFillRecord } from './emf-gdi-floodfill';
import { handleEmfGdiGradientFillRecord } from './emf-gdi-gradient-fill';
import { handleEmfGdiRegionRecord } from './emf-gdi-region-records';
import type { EmfGdiReplayCtx } from './emf-types';

export function handleEmfGdiTextBitmapRecord(
	rCtx: EmfGdiReplayCtx,
	recType: number,
	offset: number,
	dataOff: number,
	recSize: number,
): boolean {
	return (
		handleEmfGdiDrawTextRecord(rCtx, recType, offset, dataOff, recSize) ||
		handleEmfGdiBitmapRecord(rCtx, recType, offset, dataOff, recSize) ||
		handleEmfGdiBlendBlitRecord(rCtx, recType, offset, dataOff, recSize) ||
		handleEmfGdiClipRecord(rCtx, recType, dataOff, recSize) ||
		handleEmfGdiRegionRecord(rCtx, recType, dataOff, recSize) ||
		handleEmfGdiFloodFillRecord(rCtx, recType, dataOff, recSize) ||
		handleEmfGdiGradientFillRecord(rCtx, recType, dataOff, recSize)
	);
}
