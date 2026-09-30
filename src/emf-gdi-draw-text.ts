/**
 * EMF ExtTextOut, PolyTextOut and SmallTextOut record handlers.
 *
 * With `EmfConvertOptions.fonts`, the record is drawn by the GDI font
 * engine (`gdi-text-render.ts`, `gdi-font-engine.ts`): the LOGFONT is
 * realised from the supplied font files and every glyph is grid-fitted,
 * scan-converted and placed the way GDI does, honouring ETO_OPAQUE,
 * ETO_CLIPPED, ETO_PDY, ETO_GLYPH_INDEX, every TA_* alignment including
 * TA_UPDATECP, the OPAQUE background, underline and strike-out.
 *
 * Without it (or when no supplied font can stand in), the canvas font
 * engine draws the text: the record's optional Dx array (per-glyph advance
 * widths) is honoured exactly when present, and the font's LOGFONT
 * escapement (baseline rotation). See `emf-gdi-text-layout.ts` for the
 * pure layout math and the documented limits of both.
 *
 * @module emf-gdi-draw-text
 */

import {
	applyFont,
	drawTextDecorations,
	fontSizePx,
	readUtf16LE,
} from './emf-canvas-helpers';
import { decodeAnsiRecord } from './emf-ansi';
import { EMR_EXTTEXTOUTA, EMR_EXTTEXTOUTW, EMR_POLYTEXTOUTA, EMR_POLYTEXTOUTW, EMR_SMALLTEXTOUT } from './emf-constants';
import { gmx, gmy, gmw, gmh, gdiDeviceMatrix, gmapPoint, hasWorldRotation } from './emf-gdi-coord';
import { drawGdiTextCall, ETO_GLYPH_INDEX, ETO_PDY } from './gdi-text-render';
import {
	cumulativeGlyphOffsets,
	totalGlyphAdvance,
	alignmentStartOffset,
	escapementToCanvasRadians,
	applyTextJustification,
} from './emf-gdi-text-layout';
import type { CanvasContext, DrawState, EmfGdiReplayCtx } from './emf-types';

type HAlign = 'left' | 'center' | 'right';

/** Reads signed Dx advances (interleaved with Dy for ETO_PDY), within the record. */
function readDxArray(
	view: DataView,
	offset: number,
	dataOff: number,
	nChars: number,
	viewEnd: number,
): number[] | null {
	const offDx = view.getUint32(dataOff + 64, true);
	if (offDx === 0) {
		return null;
	}
	const start = offset + offDx;
	const end = start + nChars * 4;
	if (start < 0 || end > viewEnd) {
		return null;
	}
	const dx: number[] = [];
	for (let i = 0; i < nChars; i++) {
		dx.push(view.getInt32(start + i * 4, true));
	}
	return dx;
}

/**
 * Draws the record with the GDI font engine when `EmfConvertOptions.fonts`
 * supplied a usable font (see `gdi-text-render.ts`). Returns false, having
 * drawn nothing, otherwise.
 */
function drawWithFontEngine(rCtx: EmfGdiReplayCtx, offset: number, dataOff: number, nChars: number, offString: number, viewEnd: number): boolean {
	const { ctx, view, state } = rCtx;
	const fonts = rCtx.fonts;
	if (!fonts) {
		return false;
	}
	const options = view.getUint32(dataOff + 44, true);
	const codes: number[] = [];
	for (let i = 0; i < nChars; i++) {
		codes.push(view.getUint16(offset + offString + i * 2, true));
	}
	const pdy = (options & ETO_PDY) !== 0;
	const raw = readDxArray(view, offset, dataOff, pdy ? nChars * 2 : nChars, viewEnd);
	let dx: number[] | null = raw;
	let dy: number[] | null = null;
	if (raw && pdy) {
		dx = [];
		dy = [];
		for (let i = 0; i < nChars; i++) {
			dx.push(raw[i * 2] | 0);
			dy.push(raw[i * 2 + 1] | 0);
		}
	}
	const adv = drawGdiTextCall(ctx, fonts, state, {
		codes,
		glyphIndices: (options & ETO_GLYPH_INDEX) !== 0,
		x: view.getInt32(dataOff + 28, true),
		y: view.getInt32(dataOff + 32, true),
		options,
		rect: {
			left: view.getInt32(dataOff + 48, true),
			top: view.getInt32(dataOff + 52, true),
			right: view.getInt32(dataOff + 56, true),
			bottom: view.getInt32(dataOff + 60, true),
		},
		dx,
		dy,
		matrix: gdiDeviceMatrix(rCtx),
		textJustification: state.textJustification,
	});
	if (!adv) {
		return false;
	}
	if (state.textAlign & 0x01) {
		state.curX += adv.dx;
		state.curY += adv.dy;
	}
	return true;
}

function horizontalAlign(textAlign: number): HAlign {
	if ((textAlign & 0x06) === 0x06) {
		return 'center';
	}
	if (textAlign & 0x02) {
		return 'right';
	}
	return 'left';
}

function verticalBaseline(textAlign: number): CanvasTextBaseline {
	// TA_BASELINE (0x18) includes the TA_BOTTOM (0x08) bit, so the
	// vertical-alignment bits must be masked and compared as a unit.
	const vAlign = textAlign & 0x18;
	return vAlign === 0x18 ? 'alphabetic' : vAlign === 0x08 ? 'bottom' : 'top';
}

/** Paints the opaque text background and, per-glyph or as one run, the glyphs and decorations. */
function paintRun(
	ctx: CanvasContext,
	state: DrawState,
	text: string,
	dxDevice: number[] | null,
	startX: number,
	y: number,
	align: HAlign,
	fontScale: number,
	dyDevice: number[] | null = null,
): void {
	const totalWidth = dxDevice ? totalGlyphAdvance(dxDevice) : ctx.measureText(text).width;
	const runStartX = dxDevice ? startX + alignmentStartOffset(totalWidth, align) : startX;

	if (state.bkMode === 2) {
		const bgH = fontSizePx(state, fontScale);
		const prevFill = ctx.fillStyle;
		ctx.fillStyle = state.bkColor;
		ctx.fillRect(runStartX, y - bgH, totalWidth, bgH);
		ctx.fillStyle = prevFill;
	}

	ctx.fillStyle = state.textColor;
	if (dxDevice) {
		const offsets = cumulativeGlyphOffsets(dxDevice);
		const yOffsets = dyDevice ? cumulativeGlyphOffsets(dyDevice) : null;
		const prevAlign = ctx.textAlign;
		ctx.textAlign = 'left';
		for (let i = 0; i < text.length && i < offsets.length; i++) {
			ctx.fillText(text[i], runStartX + offsets[i], y + (yOffsets?.[i] ?? 0));
		}
		ctx.textAlign = prevAlign;
	} else {
		ctx.fillText(text, startX, y);
	}

	if (state.fontUnderline || state.fontStrikeOut) {
		drawTextDecorations(ctx, state, runStartX, y, totalWidth, fontScale);
	}
}

function handleExtTextOutW(
	rCtx: EmfGdiReplayCtx,
	offset: number,
	dataOff: number,
	recSize: number,
): boolean {
	const { ctx, view, state } = rCtx;
	if (recSize < 76) {
		return true;
	}
	const updateCP = (state.textAlign & 0x01) !== 0;
	const refX = updateCP ? state.curX : view.getInt32(dataOff + 28, true);
	const refY = updateCP ? state.curY : view.getInt32(dataOff + 32, true);
	const nChars = view.getUint32(dataOff + 36, true);
	const offString = view.getUint32(dataOff + 40, true);
	const viewEnd = Math.min(view.byteLength, offset + recSize);
	if (nChars === 0 || offString === 0 || nChars > Math.floor((viewEnd - offset - offString) / 2)) {
		return true;
	}
	if (drawWithFontEngine(rCtx, offset, dataOff, nChars, offString, viewEnd)) {
		return true;
	}
	const text = readUtf16LE(view, offset + offString, nChars);
	if (text.length === 0) {
		return true;
	}

	// A rotated/skewed EMR_SETWORLDTRANSFORM rotates ExtTextOutW's placement
	// AND its glyphs on real GDI (measured against a real fixture:
	// `rotate-text-25deg` under `src/__fixtures__/gdi`), the same as it does
	// for vector shapes. `gmx`/`gmy`/`gmw`/`gmh` only carry the transform's
	// scale/translation, so the rotated case maps the reference point through
	// the full affine (`gmapPoint`) and draws the run under the device
	// matrix's NORMALISED linear part: each basis vector divided by its own
	// length, so the font is realised at the transformed em height
	// (`fontScale`, the length of the mapped y axis) and advances at the
	// length of the mapped x axis (`advanceScale`), while the normalised
	// matrix carries the rotation AND any skew (or reflection) onto the
	// glyphs themselves. For a pure rotation this is exactly the rotation by
	// `atan2(b, a)` it replaces.
	const rotated = hasWorldRotation(rCtx);
	const m = rotated ? gdiDeviceMatrix(rCtx) : null;
	const fontScale = m ? Math.hypot(m[2], m[3]) : Math.abs(gmh(rCtx, 1));
	const advanceScale = m ? Math.hypot(m[0], m[1]) : null;
	applyFont(ctx, state, fontScale);

	const align = horizontalAlign(state.textAlign);
	ctx.textBaseline = verticalBaseline(state.textAlign);
	ctx.textAlign = align === 'center' ? 'center' : align === 'right' ? 'right' : 'left';

	const pdy = (view.getUint32(dataOff + 44, true) & ETO_PDY) !== 0;
	const dxRaw = readDxArray(view, offset, dataOff, pdy ? nChars * 2 : nChars, viewEnd);
	const dxLogical = dxRaw && pdy ? dxRaw.filter((_, i) => i % 2 === 0) : dxRaw;
	const dyLogical = dxRaw && pdy ? dxRaw.filter((_, i) => i % 2 === 1) : null;
	const dyDevice = dyLogical ? dyLogical.map((v) => m ? v * fontScale : gmh(rCtx, v)) : null;
	let dxDevice = dxLogical ? dxLogical.map((v) => (advanceScale !== null ? v * advanceScale : gmw(rCtx, v))) : null;
	if (!dxDevice && state.textJustification && !pdy) {
		const units = text.split('');
		const natural = units.map((ch) => ctx.measureText(ch).width);
		const scale = advanceScale ?? gmw(rCtx, 1);
		dxDevice = applyTextJustification(natural, units.map((ch) => ch.charCodeAt(0)), state.textJustification.extra * scale, state.textJustification.count);
	}
	// Per-glyph placement always anchors left; the run-level alignment is
	// folded into `runStartX` inside paintRun instead.
	if (dxDevice) {
		ctx.textAlign = 'left';
	}

	const basePoint = m ? gmapPoint(rCtx, refX, refY) : { x: gmx(rCtx, refX), y: gmy(rCtx, refY) };
	const escapement = escapementToCanvasRadians(state.fontEscapementTenthDeg);

	if (m && fontScale > 0 && advanceScale) {
		ctx.save();
		ctx.translate(basePoint.x, basePoint.y);
		ctx.transform(
			m[0] / advanceScale,
			m[1] / advanceScale,
			m[2] / fontScale,
			m[3] / fontScale,
			0,
			0,
		);
		if (escapement !== 0) {
			ctx.rotate(escapement);
		}
		paintRun(ctx, state, text, dxDevice, 0, 0, align, fontScale, dyDevice);
		ctx.restore();
	} else if (escapement !== 0) {
		ctx.save();
		ctx.translate(basePoint.x, basePoint.y);
		ctx.rotate(escapement);
		paintRun(ctx, state, text, dxDevice, 0, 0, align, fontScale, dyDevice);
		ctx.restore();
	} else {
		paintRun(ctx, state, text, dxDevice, basePoint.x, basePoint.y, align, fontScale, dyDevice);
	}
	if (updateCP) {
		const scale = advanceScale ?? gmw(rCtx, 1);
		const total = dxDevice && scale ? totalGlyphAdvance(dxDevice) / scale : scale ? ctx.measureText(text).width / scale : 0;
		const advance = align === 'center' ? 0 : align === 'right' ? -total : total;
		const down = align !== 'center' && dyLogical ? totalGlyphAdvance(dyLogical) : 0;
		state.curX += advance * Math.cos(escapement) - down * Math.sin(escapement);
		state.curY += advance * Math.sin(escapement) + down * Math.cos(escapement);
	}
	return true;
}

/** Emits a parsed text call through the same EMR_EXTTEXTOUTW implementation. */
function drawTextCall(rCtx: EmfGdiReplayCtx, x: number, y: number, codes: number[], options: number, rect: [number, number, number, number], dx: number[] | null): void {
	const n = codes.length;
	const offString = 76;
	const offDx = (offString + n * 2 + 3) & ~3;
	const dxCount = dx ? dx.length : 0;
	const size = offDx + dxCount * 4;
	const view = new DataView(new ArrayBuffer(size));
	view.setUint32(44, n, true);
	view.setUint32(48, offString, true);
	view.setUint32(52, options, true);
	view.setInt32(36, x, true);
	view.setInt32(40, y, true);
	view.setInt32(56, rect[0], true); view.setInt32(60, rect[1], true);
	view.setInt32(64, rect[2], true); view.setInt32(68, rect[3], true);
	view.setUint32(72, dx ? offDx : 0, true);
	for (let i = 0; i < n; i++) view.setUint16(offString + i * 2, codes[i], true);
	if (dx) for (let i = 0; i < dxCount; i++) view.setInt32(offDx + i * 4, dx[i], true);
	const child = { ...rCtx, view };
	handleExtTextOutW(child, 0, 8, size);
}

function readAnsiRecord(view: DataView, start: number, count: number, charSet: number): { codes: number[]; byteLengths: number[] } {
	return decodeAnsiRecord(Array.from({ length: count }, (_, i) => view.getUint8(start + i)), charSet);
}

function collapseAnsiDx(dx: number[] | null, byteLengths: number[], pdy: boolean): number[] | null {
	if (!dx) return null;
	const result: number[] = [];
	let at = 0;
	for (const bytes of byteLengths) {
		let x = 0, y = 0;
		for (let i = 0; i < bytes; i++) {
			x += dx[at + i * (pdy ? 2 : 1)] ?? 0;
			if (pdy) y += dx[at + i * 2 + 1] ?? 0;
		}
		result.push(x);
		if (pdy) result.push(y);
		at += bytes * (pdy ? 2 : 1);
	}
	return result;
}

function handlePolyText(rCtx: EmfGdiReplayCtx, offset: number, dataOff: number, recSize: number, wide: boolean): boolean {
	const { view, state } = rCtx;
	const end = Math.min(view.byteLength, offset + recSize);
	if (recSize < 40) return true;
	const count = view.getUint32(dataOff + 28, true);
	const arrayStart = dataOff + 32;
	if (count > Math.floor((end - arrayStart) / 40)) return true;
	const charSet = state.fontDetails?.charSet ?? 1;
	for (let i = 0; i < count; i++) {
		const e = arrayStart + i * 40;
		const x = view.getInt32(e, true), y = view.getInt32(e + 4, true);
		const n = view.getUint32(e + 8, true), offString = view.getUint32(e + 12, true);
		const options = view.getUint32(e + 16, true);
		const rect: [number, number, number, number] = [view.getInt32(e + 20, true), view.getInt32(e + 24, true), view.getInt32(e + 28, true), view.getInt32(e + 32, true)];
		const offDx = view.getUint32(e + 36, true);
		const unit = wide ? 2 : 1;
		if (!offString || offString > end - offset || n > Math.floor((end - (offset + offString)) / unit)) continue;
		const ansi = wide ? null : readAnsiRecord(view, offset + offString, n, charSet);
		const codes = wide ? Array.from({ length: n }, (_, j) => view.getUint16(offset + offString + j * 2, true)) : ansi!.codes;
		let dx: number[] | null = null;
		const pdy = (options & ETO_PDY) !== 0;
		const dxCount = n * (pdy ? 2 : 1);
		if (offDx && offDx <= end - offset && dxCount <= Math.floor((end - (offset + offDx)) / 4)) {
			dx = Array.from({ length: dxCount }, (_, j) => view.getInt32(offset + offDx + j * 4, true));
			if (!wide) dx = collapseAnsiDx(dx, ansi!.byteLengths, pdy);
		}
		drawTextCall(rCtx, x, y, codes, options, rect, dx);
	}
	return true;
}

function handleSmallTextOut(rCtx: EmfGdiReplayCtx, offset: number, dataOff: number, recSize: number): boolean {
	const { view } = rCtx;
	const end = Math.min(view.byteLength, offset + recSize);
	if (recSize < 36) return true;
	const x = view.getInt32(dataOff, true), y = view.getInt32(dataOff + 4, true);
	const n = view.getUint32(dataOff + 8, true), options = view.getUint32(dataOff + 12, true);
	const small = (options & 0x200) !== 0, noRect = (options & 0x100) !== 0;
	const base = dataOff + 28 + (noRect ? 0 : 16);
	if (base > end || n > Math.floor((end - base) / (small ? 1 : 2))) return true;
	const rect: [number, number, number, number] = noRect ? [0, 0, 0, 0] : [view.getInt32(dataOff + 28, true), view.getInt32(dataOff + 32, true), view.getInt32(dataOff + 36, true), view.getInt32(dataOff + 40, true)];
	const codes = small ? Array.from({ length: n }, (_, i) => view.getUint8(base + i)) : Array.from({ length: n }, (_, i) => view.getUint16(base + i * 2, true));
	drawTextCall(rCtx, x, y, codes, options, rect, null);
	return true;
}

export function handleEmfGdiDrawTextRecord(
	rCtx: EmfGdiReplayCtx,
	recType: number,
	offset: number,
	dataOff: number,
	recSize: number,
): boolean {
	if (recType === EMR_EXTTEXTOUTW) {
		return handleExtTextOutW(rCtx, offset, dataOff, recSize);
	}
	if (recType === EMR_EXTTEXTOUTA || recType === EMR_POLYTEXTOUTA || recType === EMR_POLYTEXTOUTW || recType === EMR_SMALLTEXTOUT) {
		if (recType === EMR_POLYTEXTOUTA || recType === EMR_POLYTEXTOUTW) return handlePolyText(rCtx, offset, dataOff, recSize, recType === EMR_POLYTEXTOUTW);
		if (recType === EMR_SMALLTEXTOUT) return handleSmallTextOut(rCtx, offset, dataOff, recSize);
		const { view, state } = rCtx;
		const end = Math.min(view.byteLength, offset + recSize);
		if (recSize < 76) return true;
		const x = view.getInt32(dataOff + 28, true), y = view.getInt32(dataOff + 32, true);
		const n = view.getUint32(dataOff + 36, true), strOff = view.getUint32(dataOff + 40, true), options = view.getUint32(dataOff + 44, true);
		if (!strOff || strOff > end - offset) return true;
		if (n > end - (offset + strOff)) return true;
		const ansi = readAnsiRecord(view, offset + strOff, n, state.fontDetails?.charSet ?? 1);
		const rect: [number, number, number, number] = [view.getInt32(dataOff + 48, true), view.getInt32(dataOff + 52, true), view.getInt32(dataOff + 56, true), view.getInt32(dataOff + 60, true)];
		const offDx = view.getUint32(dataOff + 64, true);
		let dx: number[] | null = null;
		const pdy = (options & ETO_PDY) !== 0;
		const dxCount = n * (pdy ? 2 : 1);
		if (offDx && offDx <= end - offset && dxCount <= Math.floor((end - (offset + offDx)) / 4)) {
			dx = Array.from({ length: dxCount }, (_, i) => view.getInt32(offset + offDx + i * 4, true));
			dx = collapseAnsiDx(dx, ansi.byteLengths, pdy);
		}
		drawTextCall(rCtx, x, y, ansi.codes, options, rect, dx);
		return true;
	}
	return false;
}
