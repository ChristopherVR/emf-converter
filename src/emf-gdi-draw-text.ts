/**
 * EMR_EXTTEXTOUTW record handler.
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
import { EMR_EXTTEXTOUTW } from './emf-constants';
import { gmx, gmy, gmw, gmh, gdiDeviceMatrix, gmapPoint, hasWorldRotation } from './emf-gdi-coord';
import { drawGdiTextCall, ETO_GLYPH_INDEX, ETO_PDY } from './gdi-text-render';
import {
	cumulativeGlyphOffsets,
	totalGlyphAdvance,
	alignmentStartOffset,
	escapementToCanvasRadians,
} from './emf-gdi-text-layout';
import type { CanvasContext, DrawState, EmfGdiReplayCtx } from './emf-types';

type HAlign = 'left' | 'center' | 'right';

/** Reads the record's Dx array (one UINT32 advance per character), if present and in bounds. */
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
		dx.push(view.getUint32(start + i * 4, true));
	}
	return dx;
}

/**
 * Draws the record with the GDI font engine when `EmfConvertOptions.fonts`
 * supplied a usable font (see `gdi-text-render.ts`). Returns false, having
 * drawn nothing, otherwise.
 */
function drawWithFontEngine(rCtx: EmfGdiReplayCtx, offset: number, dataOff: number, nChars: number, offString: number): boolean {
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
	const raw = readDxArray(view, offset, dataOff, pdy ? nChars * 2 : nChars, view.byteLength);
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
	if (textAlign & 0x02) {
		return 'right';
	}
	if (textAlign & 0x06) {
		return 'center';
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
		const prevAlign = ctx.textAlign;
		ctx.textAlign = 'left';
		for (let i = 0; i < text.length && i < offsets.length; i++) {
			ctx.fillText(text[i], runStartX + offsets[i], y);
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
	const refX = view.getInt32(dataOff + 28, true);
	const refY = view.getInt32(dataOff + 32, true);
	const nChars = view.getUint32(dataOff + 36, true);
	const offString = view.getUint32(dataOff + 40, true);
	const viewEnd = view.byteLength;
	if (nChars === 0 || offString === 0 || offset + offString + nChars * 2 > viewEnd) {
		return true;
	}
	if (drawWithFontEngine(rCtx, offset, dataOff, nChars, offString)) {
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

	const dxLogical = readDxArray(view, offset, dataOff, nChars, viewEnd);
	const dxDevice = dxLogical ? dxLogical.map((v) => (advanceScale !== null ? v * advanceScale : gmw(rCtx, v))) : null;
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
		paintRun(ctx, state, text, dxDevice, 0, 0, align, fontScale);
		ctx.restore();
	} else if (escapement !== 0) {
		ctx.save();
		ctx.translate(basePoint.x, basePoint.y);
		ctx.rotate(escapement);
		paintRun(ctx, state, text, dxDevice, 0, 0, align, fontScale);
		ctx.restore();
	} else {
		paintRun(ctx, state, text, dxDevice, basePoint.x, basePoint.y, align, fontScale);
	}
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
	return false;
}
