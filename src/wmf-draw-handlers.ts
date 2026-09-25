/**
 * WMF drawing record handlers (shapes, poly, text).
 */

import { applyPen, applyBrush, applyFont } from './emf-canvas-helpers';
import {
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
} from './emf-constants';
import type { TransformMatrix, WmfReplayCtx } from './emf-types';
import { drawGdiTextCall, ETO_CLIPPED, ETO_OPAQUE, type DeviceRect } from './gdi-text-render';

/** Windows-1252 code points for bytes 0x80..0x9F (the rest of the code page is Latin-1). */
const CP1252_HIGH = [
	0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
	0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

/**
 * Decodes a WMF (ANSI) text byte the way GDI does for the selected font's
 * charset: SYMBOL_CHARSET bytes index the font's symbol range directly,
 * every other charset here is read as Windows-1252 (the US/Western ANSI
 * code page).
 */
function ansiToCode(b: number, charSet: number): number {
	if (charSet === 2) {
		return b;
	}
	return b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : b;
}

/**
 * Draws a WMF text record with the GDI font engine (`EmfConvertOptions.fonts`).
 * Returns false, having drawn nothing, when no usable font was supplied.
 */
function drawWmfTextWithEngine(
	wCtx: WmfReplayCtx,
	bytes: number[],
	x: number,
	y: number,
	options: number,
	rect: DeviceRect | null,
	dx: number[] | null,
): boolean {
	const { ctx, state, coord, fonts } = wCtx;
	if (!fonts || bytes.length === 0) {
		return false;
	}
	const ox = coord.mx(0);
	const oy = coord.my(0);
	const matrix: TransformMatrix = [coord.mx(1) - ox, 0, 0, coord.my(1) - oy, ox, oy];
	const charSet = state.fontDetails?.charSet ?? 1;
	const adv = drawGdiTextCall(ctx, fonts, state, {
		codes: bytes.map((b) => ansiToCode(b, charSet)),
		glyphIndices: false,
		x,
		y,
		options,
		rect,
		dx,
		dy: null,
		matrix,
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

export function handleWmfDrawRecord(
	wCtx: WmfReplayCtx,
	recType: number,
	offset: number,
	dataOff: number,
	recSize: number,
): boolean {
	const { ctx, view, state, coord } = wCtx;
	const { mx, my, mw, mh } = coord;

	switch (recType) {
		case META_MOVETO:
			if (recSize >= 10) {
				state.curY = view.getInt16(dataOff, true);
				state.curX = view.getInt16(dataOff + 2, true);
			}
			return true;

		case META_LINETO:
			if (recSize >= 10) {
				const ly = view.getInt16(dataOff, true);
				const lx = view.getInt16(dataOff + 2, true);
				applyPen(ctx, state);
				ctx.beginPath();
				ctx.moveTo(mx(state.curX), my(state.curY));
				ctx.lineTo(mx(lx), my(ly));
				ctx.stroke();
				state.curX = lx;
				state.curY = ly;
			}
			return true;

		case META_PATBLT:
			// PatBlt with the brush-only raster operations a solid fill uses:
			// PATCOPY (the selected brush), BLACKNESS and WHITENESS. Params are
			// stored last-first: rop(4) height width y x.
			if (recSize >= 18) {
				const rop = view.getUint32(dataOff, true);
				const h = view.getInt16(dataOff + 4, true);
				const w = view.getInt16(dataOff + 6, true);
				const y = view.getInt16(dataOff + 8, true);
				const x = view.getInt16(dataOff + 10, true);
				const color =
					rop === 0x00f00021 && state.brushStyle !== 1
						? state.brushColor
						: rop === 0x00000042
							? '#000000'
							: rop === 0x00ff0062
								? '#ffffff'
								: null;
				if (color) {
					const x0 = Math.round(mx(x));
					const y0 = Math.round(my(y));
					const x1 = Math.round(mx(x + w));
					const y1 = Math.round(my(y + h));
					ctx.fillStyle = color;
					ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
				}
			}
			return true;

		case META_RECTANGLE:
			if (recSize >= 14) {
				const b = view.getInt16(dataOff, true);
				const r = view.getInt16(dataOff + 2, true);
				const t = view.getInt16(dataOff + 4, true);
				const l = view.getInt16(dataOff + 6, true);
				applyBrush(ctx, state);
				ctx.fillRect(mx(l), my(t), mw(r - l), mh(b - t));
				applyPen(ctx, state);
				ctx.strokeRect(mx(l), my(t), mw(r - l), mh(b - t));
			}
			return true;

		case META_ROUNDRECT:
			if (recSize >= 18) {
				const rh = Math.abs(mh(view.getInt16(dataOff, true))) / 2;
				const rw = Math.abs(mw(view.getInt16(dataOff + 2, true))) / 2;
				const b = view.getInt16(dataOff + 4, true);
				const r = view.getInt16(dataOff + 6, true);
				const t = view.getInt16(dataOff + 8, true);
				const l = view.getInt16(dataOff + 10, true);
				const x1 = mx(l),
					y1 = my(t);
				const w = mw(r - l),
					h = mh(b - t);
				const radius = Math.min(rw, rh, w / 2, h / 2);
				ctx.beginPath();
				ctx.moveTo(x1 + radius, y1);
				ctx.lineTo(x1 + w - radius, y1);
				ctx.arcTo(x1 + w, y1, x1 + w, y1 + radius, radius);
				ctx.lineTo(x1 + w, y1 + h - radius);
				ctx.arcTo(x1 + w, y1 + h, x1 + w - radius, y1 + h, radius);
				ctx.lineTo(x1 + radius, y1 + h);
				ctx.arcTo(x1, y1 + h, x1, y1 + h - radius, radius);
				ctx.lineTo(x1, y1 + radius);
				ctx.arcTo(x1, y1, x1 + radius, y1, radius);
				ctx.closePath();
				applyBrush(ctx, state);
				ctx.fill();
				applyPen(ctx, state);
				ctx.stroke();
			}
			return true;

		case META_ELLIPSE:
			if (recSize >= 14) {
				const b = view.getInt16(dataOff, true);
				const r = view.getInt16(dataOff + 2, true);
				const t = view.getInt16(dataOff + 4, true);
				const l = view.getInt16(dataOff + 6, true);
				ctx.beginPath();
				ctx.ellipse(
					mx((l + r) / 2),
					my((t + b) / 2),
					Math.abs(mw(r - l)) / 2,
					Math.abs(mh(b - t)) / 2,
					0,
					0,
					Math.PI * 2,
				);
				applyBrush(ctx, state);
				ctx.fill();
				applyPen(ctx, state);
				ctx.stroke();
			}
			return true;

		case META_ARC:
		case META_PIE:
		case META_CHORD:
			if (recSize >= 22) {
				const endY = view.getInt16(dataOff, true);
				const endX = view.getInt16(dataOff + 2, true);
				const startY = view.getInt16(dataOff + 4, true);
				const startX = view.getInt16(dataOff + 6, true);
				const b = view.getInt16(dataOff + 8, true);
				const r = view.getInt16(dataOff + 10, true);
				const t = view.getInt16(dataOff + 12, true);
				const l = view.getInt16(dataOff + 14, true);
				const cxA = (l + r) / 2;
				const cyA = (t + b) / 2;
				const rxA = Math.abs(r - l) / 2;
				const ryA = Math.abs(b - t) / 2;
				const startAngle = Math.atan2((startY - cyA) / (ryA || 1), (startX - cxA) / (rxA || 1));
				const endAngle = Math.atan2((endY - cyA) / (ryA || 1), (endX - cxA) / (rxA || 1));
				ctx.beginPath();
				if (recType === META_PIE) {
					ctx.moveTo(mx(cxA), my(cyA));
				}
				ctx.ellipse(
					mx(cxA),
					my(cyA),
					Math.abs(mw(rxA)),
					Math.abs(mh(ryA)),
					0,
					startAngle,
					endAngle,
					false,
				);
				if (recType === META_PIE || recType === META_CHORD) {
					ctx.closePath();
				}
				if (recType === META_PIE || recType === META_CHORD) {
					applyBrush(ctx, state);
					ctx.fill();
				}
				applyPen(ctx, state);
				ctx.stroke();
			}
			return true;

		// ---- poly ----
		case META_POLYGON:
			if (recSize >= 10) {
				const count = view.getInt16(dataOff, true);
				if (count > 0 && dataOff + 2 + count * 4 <= offset + recSize) {
					ctx.beginPath();
					for (let i = 0; i < count; i++) {
						const px = view.getInt16(dataOff + 2 + i * 4, true);
						const py = view.getInt16(dataOff + 4 + i * 4, true);
						if (i === 0) {
							ctx.moveTo(mx(px), my(py));
						} else {
							ctx.lineTo(mx(px), my(py));
						}
					}
					ctx.closePath();
					applyBrush(ctx, state);
					ctx.fill(state.polyFillMode === 2 ? 'nonzero' : 'evenodd');
					applyPen(ctx, state);
					ctx.stroke();
				}
			}
			return true;

		case META_POLYLINE:
			if (recSize >= 10) {
				const count = view.getInt16(dataOff, true);
				if (count > 0 && dataOff + 2 + count * 4 <= offset + recSize) {
					ctx.beginPath();
					for (let i = 0; i < count; i++) {
						const px = view.getInt16(dataOff + 2 + i * 4, true);
						const py = view.getInt16(dataOff + 4 + i * 4, true);
						if (i === 0) {
							ctx.moveTo(mx(px), my(py));
						} else {
							ctx.lineTo(mx(px), my(py));
						}
					}
					applyPen(ctx, state);
					ctx.stroke();
				}
			}
			return true;

		case META_POLYPOLYGON:
			if (recSize >= 10) {
				const numPolys = view.getUint16(dataOff, true);
				let polyOff = dataOff + 2;
				const counts: number[] = [];
				for (let p = 0; p < numPolys && polyOff + 2 <= offset + recSize; p++) {
					counts.push(view.getInt16(polyOff, true));
					polyOff += 2;
				}
				ctx.beginPath();
				for (const count of counts) {
					if (count > 0 && polyOff + count * 4 <= offset + recSize) {
						for (let i = 0; i < count; i++) {
							const px = view.getInt16(polyOff + i * 4, true);
							const py = view.getInt16(polyOff + i * 4 + 2, true);
							if (i === 0) {
								ctx.moveTo(mx(px), my(py));
							} else {
								ctx.lineTo(mx(px), my(py));
							}
						}
						ctx.closePath();
						polyOff += count * 4;
					}
				}
				applyBrush(ctx, state);
				ctx.fill(state.polyFillMode === 2 ? 'nonzero' : 'evenodd');
				applyPen(ctx, state);
				ctx.stroke();
			}
			return true;

		// ---- text ----
		case META_TEXTOUT:
			if (recSize >= 12) {
				const nChars = view.getInt16(dataOff, true);
				if (nChars > 0 && dataOff + 2 + nChars <= offset + recSize) {
					let text = '';
					for (let i = 0; i < nChars; i++) {
						const ch = view.getUint8(dataOff + 2 + i);
						if (ch === 0) {
							break;
						}
						text += String.fromCharCode(ch);
					}
					const strBytes = nChars + (nChars % 2);
					const txOff = dataOff + 2 + strBytes;
					if (txOff + 4 <= offset + recSize) {
						const ty2 = view.getInt16(txOff, true);
						const txCoord = view.getInt16(txOff + 2, true);
						const bytes: number[] = [];
						for (let i = 0; i < nChars; i++) {
							bytes.push(view.getUint8(dataOff + 2 + i));
						}
						if (drawWmfTextWithEngine(wCtx, bytes, txCoord, ty2, 0, null, null)) {
							return true;
						}
						applyFont(ctx, state, Math.abs(mh(1)));
						ctx.fillStyle = state.textColor;
						ctx.fillText(text, mx(txCoord), my(ty2));
					}
				}
			}
			return true;

		case META_EXTTEXTOUT:
			if (recSize >= 14) {
				const ty2 = view.getInt16(dataOff, true);
				const txCoord = view.getInt16(dataOff + 2, true);
				const nChars = view.getInt16(dataOff + 4, true);
				const fwOpts = view.getUint16(dataOff + 6, true);
				// The rectangle is present for ETO_OPAQUE as well as ETO_CLIPPED.
				const hasRect = (fwOpts & (ETO_OPAQUE | ETO_CLIPPED)) !== 0;
				const stringOff = dataOff + 8 + (hasRect ? 8 : 0);
				if (nChars > 0 && stringOff + nChars <= offset + recSize) {
					const bytes: number[] = [];
					for (let i = 0; i < nChars; i++) {
						bytes.push(view.getUint8(stringOff + i));
					}
					const rect: DeviceRect | null = hasRect
						? {
								left: view.getInt16(dataOff + 8, true),
								top: view.getInt16(dataOff + 10, true),
								right: view.getInt16(dataOff + 12, true),
								bottom: view.getInt16(dataOff + 14, true),
							}
						: null;
					const dxOff = stringOff + nChars + (nChars % 2);
					let dx: number[] | null = null;
					if (dxOff + nChars * 2 <= offset + recSize) {
						dx = [];
						for (let i = 0; i < nChars; i++) {
							dx.push(view.getInt16(dxOff + i * 2, true));
						}
					}
					if (drawWmfTextWithEngine(wCtx, bytes, txCoord, ty2, fwOpts, rect, dx)) {
						return true;
					}
					let text = '';
					for (let i = 0; i < nChars; i++) {
						const ch = view.getUint8(stringOff + i);
						if (ch === 0) {
							break;
						}
						text += String.fromCharCode(ch);
					}
					applyFont(ctx, state, Math.abs(mh(1)));
					ctx.fillStyle = state.textColor;
					ctx.fillText(text, mx(txCoord), my(ty2));
				}
			}
			return true;

		default:
			return false;
	}
}
