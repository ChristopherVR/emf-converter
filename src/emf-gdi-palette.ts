/**
 * GDI logical palettes and palette-relative colours for the EMF replay:
 * EMR_CREATEPALETTE, EMR_SELECTPALETTE, EMR_SETPALETTEENTRIES,
 * EMR_RESIZEPALETTE and EMR_REALIZEPALETTE, plus the resolution of the
 * COLORREF forms that address a palette.
 *
 * A COLORREF's high byte selects how it is read (measured against real GDI
 * drawing into a 32bpp DIB section, `emfrec-palette-index`):
 *
 *   - `0x00` (plain RGB) and `0x02` (`PALETTERGB`): the RGB itself (a true
 *     colour surface needs no nearest-entry match).
 *   - `0x01` (`PALETTEINDEX(i)`): entry `i` of the DC's selected logical
 *     palette, or the stock `DEFAULT_PALETTE` (the 20 static system colours)
 *     when none is selected. An index past the end of the palette takes
 *     entry 0.
 *   - `0x10` (`DIBPALETTEINDEX(i)`): an index into the colour table of the
 *     DIB section selected into the DC. The replay draws onto a true colour
 *     surface without a colour table, where GDI paints it black.
 *
 * GDI resolves a palette-relative colour when it is used, not when the
 * object is created: pens and brushes keep their raw COLORREF
 * (`GdiPen.colorRef`, `GdiBrush.colorRef`) and are resolved when selected,
 * and the DC's current pen, brush, text and background colours are
 * re-resolved whenever the palette changes (`refreshPaletteColors`), so a
 * palette selected or edited after the fact still takes effect.
 * `DIB_PAL_COLORS` bitmaps (colour tables of 16-bit palette indices) are
 * resolved against {@link paletteEntries} at draw time by the DIB decoder.
 *
 * `RealizePalette` only maps a palette onto a palette device's hardware;
 * on a true colour surface it changes nothing, so EMR_REALIZEPALETTE is
 * consumed without effect (as is EMR_COLORCORRECTPALETTE, an ICM record).
 *
 * @module emf-gdi-palette
 */

import { colorRefToHex } from './emf-color-helpers';
import {
	DEFAULT_PALETTE_STOCK_INDEX,
	EMR_CREATEPALETTE,
	EMR_REALIZEPALETTE,
	EMR_RESIZEPALETTE,
	EMR_SELECTPALETTE,
	EMR_SETPALETTEENTRIES,
	STOCK_OBJECT_BASE,
} from './emf-constants';
import type { DrawState, EmfGdiReplayCtx, GdiPalette } from './emf-types';

/**
 * The stock `DEFAULT_PALETTE`: the 20 static system colours, as `0xRRGGBB`
 * (entries 0..9 and 19 read back from real GDI, the rest from the system
 * palette they mirror).
 */
export const DEFAULT_PALETTE_ENTRIES: readonly number[] = [
	0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0, 0xc0dcc0, 0xa6caf0,
	0xfffbf0, 0xa0a0a4, 0x808080, 0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff,
];

/** The raw 32-bit COLORREF at `offset` (`0x00BBGGRR` plus the high flag byte). */
export function readRawColorRef(view: DataView, offset: number): number {
	return view.getUint32(offset, true);
}

/** True when `colorRef` addresses a palette (`PALETTEINDEX`, `PALETTERGB`, `DIBPALETTEINDEX`). */
export function isPaletteRelative(colorRef: number): boolean {
	return colorRef >>> 24 !== 0;
}

/** The entries of the DC's selected logical palette (the default palette when none is selected). */
export function paletteEntries(state: DrawState): readonly number[] {
	return state.palette?.entries ?? DEFAULT_PALETTE_ENTRIES;
}

/** Resolves a COLORREF to `0xRRGGBB` against `entries` (see the module doc). */
export function resolveColorRefRgb(colorRef: number, entries: readonly number[]): number {
	const flags = colorRef >>> 24;
	if (flags & 0x10) {
		return 0;
	}
	if (flags & 0x01) {
		const index = colorRef & 0xffff;
		return entries.length === 0 ? 0 : entries[index < entries.length ? index : 0];
	}
	return ((colorRef & 0xff) << 16) | (colorRef & 0xff00) | ((colorRef >>> 16) & 0xff);
}

/** Resolves a COLORREF to a `#rrggbb` string against the DC's selected palette. */
export function resolveColorRef(state: DrawState, colorRef: number): string {
	const rgb = resolveColorRefRgb(colorRef, paletteEntries(state));
	return colorRefToHex((rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff);
}

/** Reads the COLORREF at `offset` and resolves it against the DC's selected palette. */
export function readStateColorRef(state: DrawState, view: DataView, offset: number): string {
	return resolveColorRef(state, readRawColorRef(view, offset));
}

/**
 * Records which of the DC's current colours is palette-relative (`raw`
 * `undefined` or plain RGB clears the slot), replacing `colorRefs` so a
 * saved copy of the state is unaffected.
 */
export function setColorRefSlot(state: DrawState, slot: 'pen' | 'brush' | 'text' | 'bk', raw: number | undefined): void {
	const next = { ...state.colorRefs };
	if (raw !== undefined && isPaletteRelative(raw)) {
		next[slot] = raw;
	} else {
		delete next[slot];
	}
	state.colorRefs = next;
}

/** Re-resolves the DC's palette-relative pen, brush, text and background colours after a palette change. */
export function refreshPaletteColors(state: DrawState): void {
	const refs = state.colorRefs;
	if (!refs) {
		return;
	}
	if (refs.pen !== undefined) {
		state.penColor = resolveColorRef(state, refs.pen);
	}
	if (refs.brush !== undefined) {
		state.brushColor = resolveColorRef(state, refs.brush);
	}
	if (refs.text !== undefined) {
		state.textColor = resolveColorRef(state, refs.text);
	}
	if (refs.bk !== undefined) {
		state.bkColor = resolveColorRef(state, refs.bk);
	}
}

/** Reads `count` PALETTEENTRY structures (R, G, B, flags) at `offset` as `0xRRGGBB`. */
function readEntries(view: DataView, offset: number, count: number): number[] {
	const out: number[] = [];
	for (let i = 0; i < count && offset + i * 4 + 4 <= view.byteLength; i++) {
		const o = offset + i * 4;
		out.push((view.getUint8(o) << 16) | (view.getUint8(o + 1) << 8) | view.getUint8(o + 2));
	}
	return out;
}

/** The palette object `ihPal` names, if it is one. */
function paletteObject(rCtx: EmfGdiReplayCtx, ihPal: number): GdiPalette | null {
	const obj = rCtx.objectTable.get(ihPal);
	return obj && obj.kind === 'palette' ? obj : null;
}

/** Refreshes the DC colours when `palette` is the selected one. */
function paletteEdited(rCtx: EmfGdiReplayCtx, palette: GdiPalette): void {
	if (rCtx.state.palette === palette) {
		refreshPaletteColors(rCtx.state);
	}
}

/** Handles the palette records; returns false for any other record type. */
export function handleEmfPaletteRecord(rCtx: EmfGdiReplayCtx, recType: number, dataOff: number, recSize: number): boolean {
	const { view, state } = rCtx;
	switch (recType) {
		case EMR_CREATEPALETTE: {
			// ihPal, then LOGPALETTE: palVersion (0x300), palNumEntries, entries.
			if (recSize >= 16) {
				const ihPal = view.getUint32(dataOff, true);
				const count = view.getUint16(dataOff + 6, true);
				rCtx.objectTable.set(ihPal, { kind: 'palette', entries: readEntries(view, dataOff + 8, Math.min(count, (recSize - 16) / 4)) });
			}
			return true;
		}
		case EMR_SELECTPALETTE: {
			if (recSize >= 12) {
				const ihPal = view.getUint32(dataOff, true);
				if (ihPal === (STOCK_OBJECT_BASE | DEFAULT_PALETTE_STOCK_INDEX) >>> 0) {
					state.palette = null;
				} else {
					const palette = paletteObject(rCtx, ihPal);
					if (!palette) {
						return true;
					}
					state.palette = palette;
				}
				refreshPaletteColors(state);
			}
			return true;
		}
		case EMR_SETPALETTEENTRIES: {
			// ihPal, Start, NumberofEntries, entries.
			if (recSize >= 20) {
				const palette = paletteObject(rCtx, view.getUint32(dataOff, true));
				const start = view.getUint32(dataOff + 4, true);
				const count = view.getUint32(dataOff + 8, true);
				if (palette) {
					const entries = readEntries(view, dataOff + 12, Math.min(count, (recSize - 20) / 4));
					for (let i = 0; i < entries.length && start + i < palette.entries.length; i++) {
						palette.entries[start + i] = entries[i];
					}
					paletteEdited(rCtx, palette);
				}
			}
			return true;
		}
		case EMR_RESIZEPALETTE: {
			// ihPal, NumberOfEntries: new entries are black, surplus ones dropped.
			if (recSize >= 16) {
				const palette = paletteObject(rCtx, view.getUint32(dataOff, true));
				const count = Math.min(view.getUint32(dataOff + 4, true), 1024);
				if (palette) {
					palette.entries.length = Math.min(palette.entries.length, count);
					while (palette.entries.length < count) {
						palette.entries.push(0);
					}
					paletteEdited(rCtx, palette);
				}
			}
			return true;
		}
		case EMR_REALIZEPALETTE:
			return true;
		default:
			return false;
	}
}
