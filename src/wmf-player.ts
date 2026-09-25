/**
 * The state a WMF player keeps while it plays a metafile: the shared GDI
 * replay context (drawing state, clip, exact-pixel layer) plus what only
 * the WMF format has, namely its object table (lowest-free-slot handles
 * for pens, brushes, fonts, palettes and regions), the selected objects
 * themselves (a deleted object stays selected, as in GDI), the palette the
 * colour references resolve through, the map mode, and the text spacing
 * the DC applies (`SetTextCharacterExtra`, `SetTextJustification`).
 *
 * @module wmf-player
 */

import type { EmfGdiReplayCtx, GdiFont } from './emf-types';
import type { WmfMapping } from './wmf-mapping';

/** A pen from `META_CREATEPENINDIRECT` (`LOGPEN16`). */
export interface WmfPen {
	kind: 'pen';
	style: number;
	width: number;
	/** Raw COLORREF (may be a `PALETTEINDEX`). */
	color: number;
}

/** A brush from `META_CREATEBRUSHINDIRECT`, `META_DIBCREATEPATTERNBRUSH` or `META_CREATEPATTERNBRUSH`. */
export interface WmfBrush {
	kind: 'brush';
	/** `BS_SOLID` 0, `BS_NULL` 1, `BS_HATCHED` 2, `BS_PATTERN` 3, `BS_DIBPATTERN` 5, `BS_DIBPATTERNPT` 6. */
	style: number;
	/** Raw COLORREF of a solid or hatched brush. */
	color: number;
	hatch: number;
	/** The pattern of a pattern brush. */
	pattern?: import('./emf-types').GdiBrushPattern;
}

/** A font from `META_CREATEFONTINDIRECT`. */
export interface WmfFontObject {
	kind: 'font';
	font: GdiFont;
}

/** A logical palette (`META_CREATEPALETTE`), entries as `0xFFRRGGBB` with the flags byte on top. */
export interface WmfPalette {
	kind: 'palette';
	/** `peRed | peGreen << 8 | peBlue << 16 | peFlags << 24`, one per entry. */
	entries: number[];
}

/** A region (`META_CREATEREGION`): disjoint device rectangles, `left, top, right, bottom` (right/bottom exclusive). */
export interface WmfRegion {
	kind: 'region';
	rects: Array<[number, number, number, number]>;
}

/** Anything a WMF object-table slot can hold. */
export type WmfObject = WmfPen | WmfBrush | WmfFontObject | WmfPalette | WmfRegion | { kind: 'other' };

/** The part of the DC state `META_SAVEDC` saves beyond the shared {@link EmfGdiReplayCtx} state. */
export interface WmfSavedState {
	mapping: WmfMapping;
	pen: WmfPen;
	brush: WmfBrush;
	palette: WmfPalette | null;
	textColor: number;
	bkColor: number;
	charExtra: number;
	justifyExtra: number;
	justifyCount: number;
	layout: number;
}

/** The WMF player: shared replay context plus WMF-only DC state. */
export interface WmfPlayer extends WmfSavedState {
	rCtx: EmfGdiReplayCtx;
	/** The WMF bytes. */
	view: DataView;
	/** Canvas pixels per playback-device pixel. */
	kx: number;
	ky: number;
	/** Playback-device size in pixels. */
	devW: number;
	devH: number;
	/** The object table; `undefined` marks a free slot. */
	objects: Array<WmfObject | undefined>;
	/** Saved states, parallel to `rCtx.stateStack`. */
	stack: WmfSavedState[];
}
