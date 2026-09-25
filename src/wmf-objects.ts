/**
 * WMF object records: creation (`META_CREATEPENINDIRECT`,
 * `META_CREATEBRUSHINDIRECT`, `META_DIBCREATEPATTERNBRUSH`,
 * `META_CREATEPATTERNBRUSH`, `META_CREATEFONTINDIRECT`,
 * `META_CREATEPALETTE`, `META_CREATEREGION`), `META_SELECTOBJECT`,
 * `META_DELETEOBJECT`, the palette records (`META_SELECTPALETTE`,
 * `META_REALIZEPALETTE`, `META_SETPALENTRIES`, `META_ANIMATEPALETTE`,
 * `META_RESIZEPALETTE`) and COLORREF resolution.
 *
 * Object table. WMF object records carry no handle: GDI puts each new
 * object in the LOWEST free slot of the metafile's handle table, and
 * `META_SELECTOBJECT`/`META_DELETEOBJECT` name that slot. Deleting an
 * object frees its slot but leaves it selected (the DC keeps drawing with
 * it), so the selected pen, brush and palette are held here by reference,
 * not by slot.
 *
 * Colours. A COLORREF whose high byte is 1 is a `PALETTEINDEX`: the entry
 * of the DC's selected logical palette (the 20-entry default palette until
 * the file selects one); any other value is the RGB it names (a
 * `PALETTERGB` on a true-colour surface included). Pens, brushes and the
 * text and background colours keep their raw COLORREF and are resolved
 * again whenever the palette changes, as GDI resolves them at draw time.
 *
 * @module wmf-objects
 */

import { colorRefToHex } from './emf-color-helpers';
import { decodeMonoBits } from './emf-gdi-brush-pattern';
import { decodeDibToImageData } from './emf-dib-decoder';
import type { GdiBrushPattern, GdiFont } from './emf-types';
import type { WmfBrush, WmfObject, WmfPalette, WmfPen, WmfPlayer, WmfRegion } from './wmf-player';

/** GDI's default palette (`DEFAULT_PALETTE`): the 20 static colours, `0xRRGGBB`. */
export const DEFAULT_PALETTE: readonly number[] = [
	0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0, 0xc0dcc0, 0xa6caf0,
	0xfffbf0, 0xa0a0a4, 0x808080, 0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff,
];

/** The stock objects a fresh DC has selected: `BLACK_PEN` and `WHITE_BRUSH`. */
export function defaultPen(): WmfPen {
	return { kind: 'pen', style: 0, width: 0, color: 0 };
}

/** `WHITE_BRUSH`. */
export function defaultBrush(): WmfBrush {
	return { kind: 'brush', style: 0, color: 0xffffff, hatch: 0 };
}

/** Packs `r, g, b` into `0xRRGGBB`. */
function rgb(r: number, g: number, b: number): number {
	return (r << 16) | (g << 8) | b;
}

/**
 * The `0xRRGGBB` colour a COLORREF paints with under palette `pal`
 * (`null`: the default palette). See the module doc.
 */
export function resolveColorRef(ref: number, pal: WmfPalette | null): number {
	const r = ref & 0xff;
	const g = (ref >>> 8) & 0xff;
	const b = (ref >>> 16) & 0xff;
	if (ref >>> 24 === 1) {
		const index = ref & 0xffff;
		if (pal) {
			const e = pal.entries[index < pal.entries.length ? index : 0];
			return e === undefined ? 0 : rgb(e & 0xff, (e >>> 8) & 0xff, (e >>> 16) & 0xff);
		}
		return DEFAULT_PALETTE[index < DEFAULT_PALETTE.length ? index : 0];
	}
	return rgb(r, g, b);
}

/** {@link resolveColorRef} as `#rrggbb`. */
export function colorCss(p: WmfPlayer, ref: number): string {
	const c = resolveColorRef(ref, p.palette);
	return colorRefToHex((c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);
}

/** Reads a little-endian COLORREF. */
export function readColorRefRaw(view: DataView, off: number): number {
	return view.getUint32(off, true);
}

/** Pushes the selected pen into the shared drawing state. */
export function selectPen(p: WmfPlayer, pen: WmfPen): void {
	p.pen = pen;
	const s = p.rCtx.state;
	s.penStyle = pen.style & 0x0f;
	s.penFlags = pen.style & 0x0f;
	s.penWidth = pen.width;
	s.penColor = colorCss(p, pen.color);
	s.penUserStyle = undefined;
	s.penExtended = false;
}

/** Pushes the selected brush into the shared drawing state. */
export function selectBrush(p: WmfPlayer, brush: WmfBrush): void {
	p.brush = brush;
	const s = p.rCtx.state;
	s.brushStyle = brush.pattern ? (brush.pattern.kind === 'mono' ? 3 : 6) : brush.style;
	s.brushColor = colorCss(p, brush.color);
	s.brushPattern =
		brush.pattern ?? (brush.style === 2 && brush.hatch >= 0 && brush.hatch <= 5 ? { kind: 'hatch', hatch: brush.hatch } : null);
}

/** Re-resolves every palette-dependent colour of the DC (after a palette change). */
export function refreshColors(p: WmfPlayer): void {
	selectPen(p, p.pen);
	selectBrush(p, p.brush);
	p.rCtx.state.textColor = colorCss(p, p.textColor);
	p.rCtx.state.bkColor = colorCss(p, p.bkColor);
}

/** Puts `obj` in the lowest free slot of the object table. */
export function addObject(p: WmfPlayer, obj: WmfObject): void {
	let slot = 0;
	while (p.objects[slot] !== undefined) {
		slot++;
	}
	p.objects[slot] = obj;
}

/** `META_CREATEPENINDIRECT`: `LOGPEN16` (style, width POINT16, COLORREF). */
export function createPen(p: WmfPlayer, dataOff: number, recSize: number): void {
	const { view } = p;
	if (recSize < 16) {
		addObject(p, { kind: 'other' });
		return;
	}
	addObject(p, {
		kind: 'pen',
		style: view.getUint16(dataOff, true),
		width: view.getInt16(dataOff + 2, true),
		color: readColorRefRaw(view, dataOff + 6),
	});
}

/** `META_CREATEBRUSHINDIRECT`: `LOGBRUSH16` (style, COLORREF, hatch). */
export function createBrush(p: WmfPlayer, dataOff: number, recSize: number): void {
	const { view } = p;
	if (recSize < 14) {
		addObject(p, { kind: 'other' });
		return;
	}
	addObject(p, {
		kind: 'brush',
		style: view.getUint16(dataOff, true),
		color: readColorRefRaw(view, dataOff + 2),
		hatch: view.getUint16(dataOff + 6, true),
	});
}

/** `META_CREATEFONTINDIRECT`: the 16-bit `LOGFONT` (face name at byte 18). */
export function createFont(p: WmfPlayer, dataOff: number, recSize: number, recEnd: number): void {
	const { view } = p;
	if (recSize < 24) {
		addObject(p, { kind: 'other' });
		return;
	}
	let family = '';
	for (let i = 0; i < 32 && dataOff + 18 + i < recEnd; i++) {
		const ch = view.getUint8(dataOff + 18 + i);
		if (ch === 0) {
			break;
		}
		family += String.fromCharCode(ch);
	}
	const font: GdiFont = {
		kind: 'font',
		// Sign kept: resolveFontPixelHeight() tells cell from character height by it.
		height: view.getInt16(dataOff, true),
		weight: view.getInt16(dataOff + 8, true),
		italic: view.getUint8(dataOff + 10) !== 0,
		underline: view.getUint8(dataOff + 11) !== 0,
		strikeOut: view.getUint8(dataOff + 12) !== 0,
		family: family || 'sans-serif',
		escapementTenthDeg: view.getInt16(dataOff + 4, true),
		details: {
			width: view.getInt16(dataOff + 2, true),
			orientationTenthDeg: view.getInt16(dataOff + 6, true),
			charSet: view.getUint8(dataOff + 13),
			quality: view.getUint8(dataOff + 16),
			pitchAndFamily: view.getUint8(dataOff + 17),
		},
	};
	addObject(p, { kind: 'font', font });
}

/**
 * Rewrites a `DIB_PAL_COLORS` DIB (colour table of 16-bit palette indices)
 * as a `DIB_RGB_COLORS` one, resolving each index through the selected
 * palette. Returns the new packed DIB (header, table, bits) or `null` when
 * the header is not a `BITMAPINFOHEADER`.
 */
export function palColorsToRgb(p: WmfPlayer, view: DataView, bmi: number, end: number): Uint8Array | null {
	if (bmi + 40 > end) {
		return null;
	}
	const hdrSize = view.getUint32(bmi, true);
	const bitCount = view.getUint16(bmi + 14, true);
	const clrUsed = view.getUint32(bmi + 32, true);
	if (hdrSize < 40 || bitCount > 8) {
		return null;
	}
	const n = clrUsed || 1 << bitCount;
	const tableEnd = bmi + hdrSize + n * 2;
	if (tableEnd > end) {
		return null;
	}
	const bitsLen = end - tableEnd;
	const out = new Uint8Array(hdrSize + n * 4 + bitsLen);
	const src = new Uint8Array(view.buffer, view.byteOffset + bmi, end - bmi);
	out.set(src.subarray(0, hdrSize), 0);
	for (let i = 0; i < n; i++) {
		const c = resolveColorRef(0x01000000 | view.getUint16(bmi + hdrSize + i * 2, true), p.palette);
		out[hdrSize + i * 4] = c & 0xff;
		out[hdrSize + i * 4 + 1] = (c >> 8) & 0xff;
		out[hdrSize + i * 4 + 2] = (c >> 16) & 0xff;
		out[hdrSize + i * 4 + 3] = 0;
	}
	out.set(src.subarray(tableEnd - bmi), hdrSize + n * 4);
	return out;
}

/** The byte size of a packed DIB's header plus colour table (`BITMAPINFOHEADER` only). */
export function dibHeaderAndTableSize(view: DataView, bmi: number, usage: number): number {
	const hdrSize = view.getUint32(bmi, true);
	const bitCount = view.getUint16(bmi + 14, true);
	const compression = view.getUint32(bmi + 16, true);
	const clrUsed = view.getUint32(bmi + 32, true);
	let n = clrUsed;
	if (n === 0 && bitCount <= 8) {
		n = 1 << bitCount;
	}
	const entry = usage === 1 ? 2 : 4;
	let size = hdrSize + n * entry;
	if (compression === 3 && hdrSize === 40) {
		size += 12; // BI_BITFIELDS masks after a BITMAPINFOHEADER
	}
	return size;
}

/** The pattern of a packed DIB at `bmi` (bits right after its colour table). */
function dibPattern(p: WmfPlayer, bmi: number, end: number, usage: number, monoAsText: boolean): GdiBrushPattern | null {
	let view = p.view;
	let at = bmi;
	let stop = end;
	if (usage === 1) {
		const rgb = palColorsToRgb(p, p.view, bmi, end);
		if (!rgb) {
			return null;
		}
		view = new DataView(rgb.buffer);
		at = 0;
		stop = rgb.length;
	}
	if (at + 40 > stop) {
		return null;
	}
	const bits = at + dibHeaderAndTableSize(view, at, 0);
	if (monoAsText && view.getUint16(at + 14, true) === 1) {
		const mono = decodeMonoBits(view, at, bits);
		if (mono) {
			return { kind: 'mono', ...mono };
		}
	}
	const image = decodeDibToImageData(view, at, bits, Math.max(0, stop - bits));
	if (!image) {
		return null;
	}
	const px = new Uint32Array(image.width * image.height);
	for (let i = 0; i < px.length; i++) {
		px[i] = (image.data[i * 4] << 16) | (image.data[i * 4 + 1] << 8) | image.data[i * 4 + 2];
	}
	return { kind: 'bitmap', width: image.width, height: image.height, rgb: px };
}

/**
 * `META_DIBCREATEPATTERNBRUSH`: style, `ColorUsage`, then a packed DIB. A
 * `BS_PATTERN` brush with a one-bit DIB is a monochrome brush (0 bits in the
 * text colour, 1 bits in the background colour, as `CreatePatternBrush`
 * of a monochrome bitmap paints); any other DIB is a colour pattern.
 */
export function createDibPatternBrush(p: WmfPlayer, dataOff: number, recEnd: number): void {
	const { view } = p;
	if (dataOff + 4 + 40 > recEnd) {
		addObject(p, { kind: 'other' });
		return;
	}
	const style = view.getUint16(dataOff, true);
	const usage = view.getUint16(dataOff + 2, true);
	const pattern = dibPattern(p, dataOff + 4, recEnd, usage, style === 3);
	addObject(p, { kind: 'brush', style: pattern ? 6 : 0, color: 0x808080, hatch: 0, ...(pattern ? { pattern } : {}) });
}

/**
 * `META_CREATEPATTERNBRUSH` (a Win16 `Bitmap16` pattern): Windows'
 * `PlayMetaFile` no longer creates this brush, and the record does not take
 * an object-table slot either, so the next object lands where this one
 * would have (measured: `wmf-legacy`). Nothing to do.
 */
export function createPatternBrush(): void {}

/** Reads a WMF `Palette` object (start, count, entries) at `off`. */
function readPaletteEntries(view: DataView, off: number, end: number): { start: number; entries: number[] } {
	const start = view.getUint16(off, true);
	const count = view.getUint16(off + 2, true);
	const entries: number[] = [];
	for (let i = 0; i < count && off + 4 + i * 4 + 4 <= end; i++) {
		entries.push(view.getUint32(off + 4 + i * 4, true));
	}
	return { start, entries };
}

/** `META_CREATEPALETTE`. */
export function createPalette(p: WmfPlayer, dataOff: number, recEnd: number): void {
	if (dataOff + 4 > recEnd) {
		addObject(p, { kind: 'other' });
		return;
	}
	addObject(p, { kind: 'palette', entries: readPaletteEntries(p.view, dataOff, recEnd).entries });
}

/** `META_SETPALENTRIES` / `META_ANIMATEPALETTE`: overwrites a run of the selected palette's entries. */
export function setPaletteEntries(p: WmfPlayer, dataOff: number, recEnd: number, animate: boolean): void {
	const pal = p.palette;
	if (!pal || dataOff + 4 > recEnd) {
		return;
	}
	const { start, entries } = readPaletteEntries(p.view, dataOff, recEnd);
	for (let i = 0; i < entries.length && start + i < pal.entries.length; i++) {
		// AnimatePalette only replaces entries created with PC_RESERVED.
		if (animate && ((pal.entries[start + i] >>> 24) & 0x01) === 0) {
			continue;
		}
		pal.entries[start + i] = entries[i];
	}
	refreshColors(p);
}

/** `META_RESIZEPALETTE`: new entries are black. */
export function resizePalette(p: WmfPlayer, count: number): void {
	const pal = p.palette;
	if (!pal) {
		return;
	}
	if (count < pal.entries.length) {
		pal.entries.length = count;
	} else {
		while (pal.entries.length < count) {
			pal.entries.push(0);
		}
	}
	refreshColors(p);
}

/** `META_SELECTPALETTE`. */
export function selectPalette(p: WmfPlayer, slot: number): void {
	const obj = p.objects[slot];
	if (obj?.kind === 'palette') {
		p.palette = obj;
		refreshColors(p);
	}
}

/**
 * `META_CREATEREGION`: a `Region` object (nextInChain, objectType,
 * objectCount, regionSize, scanCount, maxScan, bounding box, then the
 * scans: count, top, bottom, `count / 2` left/right pairs, count again).
 */
export function createRegion(p: WmfPlayer, dataOff: number, recEnd: number): void {
	const { view } = p;
	const region: WmfRegion = { kind: 'region', rects: [] };
	if (dataOff + 22 <= recEnd) {
		const scanCount = view.getUint16(dataOff + 10, true);
		let off = dataOff + 22;
		for (let s = 0; s < scanCount && off + 6 <= recEnd; s++) {
			const count = view.getUint16(off, true);
			const top = view.getInt16(off + 2, true);
			const bottom = view.getInt16(off + 4, true);
			let q = off + 6;
			for (let i = 0; i + 1 < count && q + 4 <= recEnd; i += 2, q += 4) {
				const left = view.getInt16(q, true);
				const right = view.getInt16(q + 2, true);
				if (right > left && bottom > top) {
					region.rects.push([left, top, right, bottom]);
				}
			}
			off = q + 2;
		}
		if (scanCount === 0) {
			// An empty scan list with a non-empty bounding box is a plain rectangle.
			const l = view.getInt16(dataOff + 14, true);
			const t = view.getInt16(dataOff + 16, true);
			const r = view.getInt16(dataOff + 18, true);
			const b = view.getInt16(dataOff + 20, true);
			if (r > l && b > t) {
				region.rects.push([l, t, r, b]);
			}
		}
	}
	addObject(p, region);
}

/** `META_SELECTOBJECT` for a pen, brush or font (regions and palettes have their own records). */
export function selectObject(p: WmfPlayer, slot: number): WmfObject | undefined {
	const obj = p.objects[slot];
	if (!obj) {
		return undefined;
	}
	const s = p.rCtx.state;
	switch (obj.kind) {
		case 'pen':
			selectPen(p, obj);
			break;
		case 'brush':
			selectBrush(p, obj);
			break;
		case 'font': {
			const f = obj.font;
			s.fontHeight = f.height;
			s.fontWeight = f.weight;
			s.fontItalic = f.italic;
			s.fontUnderline = f.underline;
			s.fontStrikeOut = f.strikeOut;
			s.fontFamily = f.family;
			s.fontEscapementTenthDeg = f.escapementTenthDeg ?? 0;
			s.fontDetails = f.details;
			break;
		}
		default:
			break;
	}
	return obj;
}

/** `META_DELETEOBJECT`: frees the slot (a selected object stays selected). */
export function deleteObject(p: WmfPlayer, slot: number): void {
	if (slot >= 0 && slot < p.objects.length) {
		p.objects[slot] = undefined;
	}
}
