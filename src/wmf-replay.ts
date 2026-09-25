/**
 * WMF (Windows Metafile) record replay.
 *
 * Plays every record of MS-WMF the way Windows' `PlayMetaFile` plays it,
 * onto the same replay context and drawing machinery as the EMF records
 * (`EmfGdiReplayCtx`): the GDI rasteriser for shapes, the exact ROP3 blit
 * evaluator for bitmaps, the clip-region engine, the GDI font engine for
 * text, and every output (canvas, the pure-JavaScript raster, SVG). The
 * WMF-only parts live alongside:
 *   - `wmf-player.ts`: the player state (object table, selected objects,
 *     palette, map mode, text spacing, saved DC states);
 *   - `wmf-mapping.ts`: the playback device, map modes, window/viewport;
 *   - `wmf-objects.ts`: object records, palettes and colour references;
 *   - `wmf-shapes.ts`: box shapes under `GM_COMPATIBLE`;
 *   - `wmf-text.ts`: ANSI text, character extra and justification;
 *   - `wmf-bitmap.ts`: `BitBlt`/`StretchBlt`/`PatBlt`/`StretchDIBits`/
 *     `SetDIBitsToDevice` records;
 *   - `wmf-region.ts`: clipping and region painting;
 *   - `wmf-pixel.ts`: `SetPixel` and flood fills;
 *   - `wmf-emf-bridge.ts`: plays a WMF record as its EMF counterpart.
 * A WMF that carries an embedded EMF (`META_ESCAPE` `MFCOMMENT` chunks, see
 * `wmf-embedded-emf.ts`) is played as that EMF instead, before this module
 * is reached (`emf-converter.ts`).
 *
 * @module wmf-replay
 */

import {
	META_EOF,
	META_SETWINDOWORG,
	META_SETWINDOWEXT,
	META_SETVIEWPORTORG,
	META_SETVIEWPORTEXT,
	META_OFFSETWINDOWORG,
	META_OFFSETVIEWPORTORG,
	META_SCALEWINDOWEXT,
	META_SCALEVIEWPORTEXT,
	META_SETMAPMODE,
	META_SAVEDC,
	META_RESTOREDC,
	META_SETTEXTCOLOR,
	META_SETBKCOLOR,
	META_SETBKMODE,
	META_SETROP2,
	META_SETRELABS,
	META_SETPOLYFILLMODE,
	META_SETSTRETCHBLTMODE,
	META_SETTEXTALIGN,
	META_SETTEXTCHAREXTRA,
	META_SETTEXTJUSTIFICATION,
	META_SETMAPPERFLAGS,
	META_SETLAYOUT,
	META_ESCAPE,
	META_CREATEPENINDIRECT,
	META_CREATEBRUSHINDIRECT,
	META_CREATEFONTINDIRECT,
	META_DIBCREATEPATTERNBRUSH,
	META_CREATEPATTERNBRUSH,
	META_CREATEPALETTE,
	META_CREATEREGION,
	META_CREATEBRUSH,
	META_CREATEBITMAP,
	META_CREATEBITMAPINDIRECT,
	META_SELECTOBJECT,
	META_SELECTPALETTE,
	META_REALIZEPALETTE,
	META_SETPALENTRIES,
	META_ANIMATEPALETTE,
	META_RESIZEPALETTE,
	META_DELETEOBJECT,
	META_MOVETO,
	META_LINETO,
	META_RECTANGLE,
	META_ROUNDRECT,
	META_ELLIPSE,
	META_ARC,
	META_PIE,
	META_CHORD,
	META_POLYGON,
	META_POLYLINE,
	META_POLYPOLYGON,
	META_TEXTOUT,
	META_EXTTEXTOUT,
	META_PATBLT,
	META_BITBLT,
	META_STRETCHBLT,
	META_DIBBITBLT,
	META_DIBSTRETCHBLT,
	META_STRETCHDIB,
	META_SETDIBTODEV,
	META_INTERSECTCLIPRECT,
	META_EXCLUDECLIPRECT,
	META_OFFSETCLIPRGN,
	META_SELECTCLIPREGION,
	META_FILLREGION,
	META_FRAMEREGION,
	META_INVERTREGION,
	META_PAINTREGION,
	META_SETPIXEL,
	META_FLOODFILL,
	META_EXTFLOODFILL,
	MAX_RECORDS_DEFAULT,
	EMR_SAVEDC,
	EMR_RESTOREDC,
	EMR_SETBKMODE,
	EMR_SETROP2,
	EMR_SETPOLYFILLMODE,
	EMR_SETSTRETCHBLTMODE,
	EMR_SETTEXTALIGN,
	EMR_MOVETOEX,
	EMR_LINETO,
	EMR_POLYGON16,
	EMR_POLYLINE16,
	EMR_POLYPOLYGON16,
} from './emf-constants';
import { flushRasterLayer } from './emf-gdi-raster-layer';
import type { CanvasContext, EmfGdiReplayCtx, GdiObject, DrawState, WmfHeader, ReplayOptions } from './emf-types';
import { defaultState } from './emf-types';
import { wmfBitBlt, wmfDibBitBlt, wmfPatBlt, wmfSetDibToDev, wmfStretchDib } from './wmf-bitmap';
import { EmfRecordWriter, playEmfRecord } from './wmf-emf-bridge';
import {
	applyWmfMapping,
	cloneMapping,
	scaleViewportExt,
	scaleWindowExt,
	setMapMode,
	setViewportExt,
	setWindowExt,
	wmfPlayback,
} from './wmf-mapping';
import {
	colorCss,
	createBrush,
	createDibPatternBrush,
	createFont,
	createPalette,
	createPatternBrush,
	createPen,
	createRegion,
	defaultBrush,
	defaultPen,
	deleteObject,
	addObject,
	readColorRefRaw,
	refreshColors,
	resizePalette,
	selectBrush,
	selectObject,
	selectPalette,
	selectPen,
	setPaletteEntries,
} from './wmf-objects';
import { wmfExtFloodFill, wmfSetPixel } from './wmf-pixel';
import type { WmfPlayer, WmfSavedState } from './wmf-player';
import {
	wmfExcludeClipRect,
	wmfFillRegion,
	wmfFrameRegion,
	wmfIntersectClipRect,
	wmfInvertRegion,
	wmfOffsetClipRgn,
	wmfPaintRegion,
	wmfSelectClipRegion,
} from './wmf-region';
import { wmfArcFamily, wmfEllipse, wmfRectangle, wmfRoundRect } from './wmf-shapes';
import { wmfExtTextOut, wmfTextOut } from './wmf-text';

// ---------------------------------------------------------------------------
// Player setup
// ---------------------------------------------------------------------------

/** Creates the player for `view` drawing onto `ctx` (`canvasW` x `canvasH`). */
export function createWmfPlayer(
	view: DataView,
	ctx: CanvasContext,
	header: WmfHeader,
	canvasW: number,
	canvasH: number,
	replayOptions: ReplayOptions = {},
): WmfPlayer {
	const playback = wmfPlayback(view, header);
	const kx = canvasW / playback.width;
	const ky = canvasH / playback.height;
	const state: DrawState = { ...defaultState(), fontFamilyMap: replayOptions.fontFamilyMap, textAlign: 0 };
	const rCtx: EmfGdiReplayCtx = {
		ctx,
		view,
		objectTable: new Map<number, GdiObject>(),
		state,
		stateStack: [],
		inPath: false,
		windowOrg: { x: 0, y: 0 },
		windowExt: { cx: 1, cy: 1 },
		viewportOrg: { x: 0, y: 0 },
		viewportExt: { cx: 1, cy: 1 },
		useMappingMode: true,
		clipSaveDepth: 0,
		bounds: { left: 0, top: 0, right: playback.width, bottom: playback.height },
		canvasW,
		canvasH,
		sx: kx,
		sy: ky,
		pathCmds: [],
		gdiAntialias: replayOptions.gdiAntialias,
		fonts: replayOptions.fonts,
		wholeDevicePixels: [kx, ky],
	};
	const p: WmfPlayer = {
		rCtx,
		view,
		kx,
		ky,
		devW: playback.width,
		devH: playback.height,
		objects: [],
		stack: [],
		mapping: playback.mapping,
		pen: defaultPen(),
		brush: defaultBrush(),
		palette: null,
		textColor: 0,
		bkColor: 0xffffff,
		charExtra: 0,
		justifyExtra: 0,
		justifyCount: 0,
		layout: 0,
	};
	applyWmfMapping(rCtx, p.mapping, kx, ky);
	refreshColors(p);
	return p;
}

/** Re-derives the shared context's mapping after a mapping record. */
function remap(p: WmfPlayer): void {
	applyWmfMapping(p.rCtx, p.mapping, p.kx, p.ky);
}

/** The WMF-only part of the DC state, for `META_SAVEDC`. */
function saveState(p: WmfPlayer): WmfSavedState {
	return {
		mapping: cloneMapping(p.mapping),
		pen: p.pen,
		brush: p.brush,
		palette: p.palette,
		textColor: p.textColor,
		bkColor: p.bkColor,
		charExtra: p.charExtra,
		justifyExtra: p.justifyExtra,
		justifyCount: p.justifyCount,
		layout: p.layout,
	};
}

/** Plays a one-field EMF state record (`u32` value). */
function playEmfValue(p: WmfPlayer, type: number, value: number): void {
	playEmfRecord(p.rCtx, new EmfRecordWriter(type, 16).u32(value).finish());
}

/** Plays `EMR_POLYGON16` / `EMR_POLYLINE16` for `count` int16 points at `ptOff`. */
function playPoly16(p: WmfPlayer, type: number, count: number, ptOff: number): void {
	const w = new EmfRecordWriter(type, 28 + count * 4);
	w.i32(0).i32(0).i32(-1).i32(-1).u32(count);
	for (let i = 0; i < count; i++) {
		w.i16(p.view.getInt16(ptOff + i * 4, true)).i16(p.view.getInt16(ptOff + i * 4 + 2, true));
	}
	playEmfRecord(p.rCtx, w.finish());
}

// ---------------------------------------------------------------------------
// Record dispatch
// ---------------------------------------------------------------------------

/**
 * Plays one record. `offset` is the record's start, `recSize` its size in
 * bytes; parameters start at `offset + 6`.
 */
export function playWmfRecord(p: WmfPlayer, recType: number, offset: number, recSize: number): void {
	const { view, rCtx } = p;
	const d = offset + 6;
	const end = offset + recSize;
	const has = (bytes: number) => d + bytes <= end;
	const i16 = (k: number) => view.getInt16(d + k * 2, true);
	const u16 = (k: number) => view.getUint16(d + k * 2, true);

	switch (recType) {
		// ---- mapping ----
		case META_SETMAPMODE:
			if (has(2)) {
				setMapMode(p.mapping, u16(0));
				remap(p);
			}
			return;
		case META_SETWINDOWORG:
			if (has(4)) {
				p.mapping.winOrg = { y: i16(0), x: i16(1) };
				remap(p);
			}
			return;
		case META_SETWINDOWEXT:
			if (has(4)) {
				setWindowExt(p.mapping, i16(1), i16(0));
				remap(p);
			}
			return;
		case META_SETVIEWPORTORG:
			if (has(4)) {
				p.mapping.vpOrg = { y: i16(0), x: i16(1) };
				remap(p);
			}
			return;
		case META_SETVIEWPORTEXT:
			if (has(4)) {
				setViewportExt(p.mapping, i16(1), i16(0));
				remap(p);
			}
			return;
		case META_OFFSETWINDOWORG:
			if (has(4)) {
				p.mapping.winOrg = { x: p.mapping.winOrg.x + i16(1), y: p.mapping.winOrg.y + i16(0) };
				remap(p);
			}
			return;
		case META_OFFSETVIEWPORTORG:
			if (has(4)) {
				p.mapping.vpOrg = { x: p.mapping.vpOrg.x + i16(1), y: p.mapping.vpOrg.y + i16(0) };
				remap(p);
			}
			return;
		case META_SCALEWINDOWEXT:
			if (has(8)) {
				scaleWindowExt(p.mapping, i16(3), i16(2), i16(1), i16(0));
				remap(p);
			}
			return;
		case META_SCALEVIEWPORTEXT:
			if (has(8)) {
				scaleViewportExt(p.mapping, i16(3), i16(2), i16(1), i16(0));
				remap(p);
			}
			return;

		// ---- DC state ----
		case META_SAVEDC:
			p.stack.push(saveState(p));
			playEmfRecord(rCtx, new EmfRecordWriter(EMR_SAVEDC, 8).finish());
			return;
		case META_RESTOREDC: {
			let rel = has(2) ? i16(0) : -1;
			const depth = p.stack.length;
			if (rel < 0) {
				rel = depth + rel + 1;
			}
			if (rel < 1 || rel > depth) {
				return;
			}
			const saved = p.stack[rel - 1];
			p.stack.length = rel - 1;
			playEmfRecord(rCtx, new EmfRecordWriter(EMR_RESTOREDC, 12).i32(rel).finish());
			Object.assign(p, { ...saved, mapping: cloneMapping(saved.mapping) });
			remap(p);
			refreshColors(p);
			return;
		}
		case META_SETTEXTCOLOR:
			if (has(4)) {
				p.textColor = readColorRefRaw(view, d);
				rCtx.state.textColor = colorCss(p, p.textColor);
			}
			return;
		case META_SETBKCOLOR:
			if (has(4)) {
				p.bkColor = readColorRefRaw(view, d);
				rCtx.state.bkColor = colorCss(p, p.bkColor);
			}
			return;
		case META_SETBKMODE:
			if (has(2)) {
				playEmfValue(p, EMR_SETBKMODE, u16(0));
			}
			return;
		case META_SETROP2:
			if (has(2)) {
				playEmfValue(p, EMR_SETROP2, u16(0));
			}
			return;
		case META_SETPOLYFILLMODE:
			if (has(2)) {
				playEmfValue(p, EMR_SETPOLYFILLMODE, u16(0));
			}
			return;
		case META_SETSTRETCHBLTMODE:
			if (has(2)) {
				playEmfValue(p, EMR_SETSTRETCHBLTMODE, u16(0));
			}
			return;
		case META_SETTEXTALIGN:
			if (has(2)) {
				playEmfValue(p, EMR_SETTEXTALIGN, u16(0));
			}
			return;
		case META_SETTEXTCHAREXTRA:
			if (has(2)) {
				p.charExtra = i16(0);
			}
			return;
		case META_SETTEXTJUSTIFICATION:
			if (has(4)) {
				p.justifyCount = i16(0);
				p.justifyExtra = i16(1);
			}
			return;
		case META_SETLAYOUT:
			if (has(4)) {
				p.layout = view.getUint32(d, true);
			}
			return;
		case META_SETRELABS:
		case META_SETMAPPERFLAGS:
		case META_ESCAPE:
		case META_REALIZEPALETTE:
			// No effect on a playback DC's pixels (an embedded EMF in an
			// escape is handled before the WMF is played).
			return;

		// ---- objects ----
		case META_CREATEPENINDIRECT:
			createPen(p, d, recSize);
			return;
		case META_CREATEBRUSHINDIRECT:
			createBrush(p, d, recSize);
			return;
		case META_CREATEFONTINDIRECT:
			createFont(p, d, recSize, end);
			return;
		case META_DIBCREATEPATTERNBRUSH:
			createDibPatternBrush(p, d, end);
			return;
		case META_CREATEPATTERNBRUSH:
			createPatternBrush(p, d, end);
			return;
		case META_CREATEPALETTE:
			createPalette(p, d, end);
			return;
		case META_CREATEREGION:
			createRegion(p, d, end);
			return;
		case META_CREATEBRUSH:
		case META_CREATEBITMAP:
		case META_CREATEBITMAPINDIRECT:
			// Obsolete records that still take a slot.
			addObject(p, { kind: 'other' });
			return;
		case META_SELECTOBJECT:
			if (has(2)) {
				const obj = p.objects[u16(0)];
				if (obj?.kind === 'region') {
					// SelectObject of a region is SelectClipRgn.
					wmfSelectClipRegion(p, u16(0));
				} else {
					selectObject(p, u16(0));
				}
			}
			return;
		case META_SELECTPALETTE:
			if (has(2)) {
				selectPalette(p, u16(0));
			}
			return;
		case META_SETPALENTRIES:
			setPaletteEntries(p, d, end, false);
			return;
		case META_ANIMATEPALETTE:
			setPaletteEntries(p, d, end, true);
			return;
		case META_RESIZEPALETTE:
			if (has(2)) {
				resizePalette(p, u16(0));
			}
			return;
		case META_DELETEOBJECT:
			if (has(2)) {
				deleteObject(p, u16(0));
			}
			return;

		// ---- lines and shapes ----
		case META_MOVETO:
			if (has(4)) {
				playEmfRecord(rCtx, new EmfRecordWriter(EMR_MOVETOEX, 16).i32(i16(1)).i32(i16(0)).finish());
			}
			return;
		case META_LINETO:
			if (has(4)) {
				playEmfRecord(rCtx, new EmfRecordWriter(EMR_LINETO, 16).i32(i16(1)).i32(i16(0)).finish());
			}
			return;
		case META_RECTANGLE:
			if (has(8)) {
				wmfRectangle(p, i16(3), i16(2), i16(1), i16(0));
			}
			return;
		case META_ROUNDRECT:
			if (has(12)) {
				wmfRoundRect(p, i16(5), i16(4), i16(3), i16(2), i16(1), i16(0));
			}
			return;
		case META_ELLIPSE:
			if (has(8)) {
				wmfEllipse(p, i16(3), i16(2), i16(1), i16(0));
			}
			return;
		case META_ARC:
		case META_CHORD:
		case META_PIE:
			if (has(16)) {
				const kind = recType === META_ARC ? 'arc' : recType === META_CHORD ? 'chord' : 'pie';
				wmfArcFamily(p, kind, i16(7), i16(6), i16(5), i16(4), i16(3), i16(2), i16(1), i16(0));
			}
			return;
		case META_POLYGON:
		case META_POLYLINE:
			if (has(2)) {
				const count = i16(0);
				if (count > 0 && has(2 + count * 4)) {
					playPoly16(p, recType === META_POLYGON ? EMR_POLYGON16 : EMR_POLYLINE16, count, d + 2);
				}
			}
			return;
		case META_POLYPOLYGON:
			if (has(2)) {
				const n = u16(0);
				if (n === 0 || !has(2 + n * 2)) {
					return;
				}
				const counts: number[] = [];
				let total = 0;
				for (let i = 0; i < n; i++) {
					const c = view.getUint16(d + 2 + i * 2, true);
					counts.push(c);
					total += c;
				}
				const ptOff = d + 2 + n * 2;
				if (!has(2 + n * 2 + total * 4)) {
					return;
				}
				const w = new EmfRecordWriter(EMR_POLYPOLYGON16, 32 + n * 4 + total * 4);
				w.i32(0).i32(0).i32(-1).i32(-1).u32(n).u32(total);
				for (const c of counts) {
					w.u32(c);
				}
				for (let i = 0; i < total; i++) {
					w.i16(view.getInt16(ptOff + i * 4, true)).i16(view.getInt16(ptOff + i * 4 + 2, true));
				}
				playEmfRecord(rCtx, w.finish());
			}
			return;

		// ---- text ----
		case META_TEXTOUT:
			wmfTextOut(p, d, end);
			return;
		case META_EXTTEXTOUT:
			wmfExtTextOut(p, d, end);
			return;

		// ---- bitmaps ----
		case META_PATBLT:
			wmfPatBlt(p, d, end);
			return;
		case META_BITBLT:
		case META_STRETCHBLT:
			wmfBitBlt(p, recType === META_STRETCHBLT, offset, recSize);
			return;
		case META_DIBBITBLT:
		case META_DIBSTRETCHBLT:
			wmfDibBitBlt(p, recType === META_DIBSTRETCHBLT, offset, recSize);
			return;
		case META_STRETCHDIB:
			wmfStretchDib(p, d, end);
			return;
		case META_SETDIBTODEV:
			wmfSetDibToDev(p, d, end);
			return;

		// ---- clipping and regions ----
		case META_INTERSECTCLIPRECT:
			if (has(8)) {
				wmfIntersectClipRect(p, i16(3), i16(2), i16(1), i16(0));
			}
			return;
		case META_EXCLUDECLIPRECT:
			if (has(8)) {
				wmfExcludeClipRect(p, i16(3), i16(2), i16(1), i16(0));
			}
			return;
		case META_OFFSETCLIPRGN:
			if (has(4)) {
				wmfOffsetClipRgn(p, i16(1), i16(0));
			}
			return;
		case META_SELECTCLIPREGION:
			if (has(2)) {
				wmfSelectClipRegion(p, u16(0));
			}
			return;
		case META_FILLREGION:
			if (has(4)) {
				wmfFillRegion(p, u16(1), u16(0));
			}
			return;
		case META_PAINTREGION:
			if (has(2)) {
				wmfPaintRegion(p, u16(0));
			}
			return;
		case META_INVERTREGION:
			if (has(2)) {
				wmfInvertRegion(p, u16(0));
			}
			return;
		case META_FRAMEREGION:
			if (has(8)) {
				wmfFrameRegion(p, u16(3), u16(2), i16(1), i16(0));
			}
			return;

		// ---- pixels ----
		case META_SETPIXEL:
			if (has(8)) {
				wmfSetPixel(p, i16(3), i16(2), readColorRefRaw(view, d));
			}
			return;
		case META_FLOODFILL:
			if (has(8)) {
				wmfExtFloodFill(p, i16(3), i16(2), readColorRefRaw(view, d), 0);
			}
			return;
		case META_EXTFLOODFILL:
			if (has(10)) {
				wmfExtFloodFill(p, i16(4), i16(3), readColorRefRaw(view, d + 2), u16(0));
			}
			return;
		default:
			return;
	}
}

// ---------------------------------------------------------------------------
// Main WMF replay
// ---------------------------------------------------------------------------

/**
 * Plays every record of the WMF in `view` onto `ctx`, a `canvasW` x
 * `canvasH` surface showing the whole picture (see `wmf-mapping.ts` for
 * how the picture maps onto it).
 */
export function replayWmfRecords(
	view: DataView,
	ctx: CanvasContext,
	header: WmfHeader,
	canvasW: number,
	canvasH: number,
	replayOptions: ReplayOptions = {},
): void {
	const p = createWmfPlayer(view, ctx, header, canvasW, canvasH, replayOptions);
	let offset = header.headerSize;
	const maxOffset = view.byteLength;
	const maxRecords = replayOptions.maxRecords ?? MAX_RECORDS_DEFAULT;
	let recordCount = 0;

	while (offset + 6 <= maxOffset && recordCount < maxRecords) {
		const recSize = view.getUint32(offset, true) * 2;
		const recType = view.getUint16(offset + 4, true);
		if (recSize < 6 || offset + recSize > maxOffset || recType === META_EOF) {
			break;
		}
		recordCount++;
		playWmfRecord(p, recType, offset, recSize);
		offset += recSize;
	}
	flushRasterLayer(p.rCtx);
	// Pop every canvas save() the records left open (unmatched SaveDC).
	let open = p.rCtx.clipSaveDepth + p.rCtx.stateStack.length;
	while (open-- > 0) {
		ctx.restore();
	}

	if (recordCount >= maxRecords) {
		console.warn(`[emf-converter] WMF record limit reached (${maxRecords}). Output may be incomplete.`);
	}
}

export { selectBrush, selectPen };
