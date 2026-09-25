/**
 * WMF text records, `META_TEXTOUT` and `META_EXTTEXTOUT`, played as the
 * equivalent `EMR_EXTTEXTOUTW` through the EMF text handler
 * (`emf-gdi-draw-text.ts`): the GDI font engine with the `fonts` option,
 * the canvas font engine otherwise, every `ETO_*` option and `TA_*`
 * alignment alike.
 *
 * A WMF string is ANSI: each byte is decoded the way GDI decodes it for the
 * selected font's character set (`SYMBOL_CHARSET` bytes index the font's
 * symbol range directly, every other charset here reads as Windows-1252).
 *
 * The DC's character extra (`META_SETTEXTCHAREXTRA`) and justification
 * (`META_SETTEXTJUSTIFICATION`) apply to a call without its own Dx array:
 * GDI then adds the extra (logical units, converted to whole device pixels)
 * after every character, and spreads the justification's extra pixels over
 * the break characters, the first ones taking one pixel more when it does
 * not divide evenly. A call that brings a Dx array is placed by it alone.
 *
 * @module wmf-text
 */

import { EMR_EXTTEXTOUTW } from './emf-constants';
import { gdiDeviceMatrix } from './emf-gdi-coord';
import { flushRasterLayer } from './emf-gdi-raster-layer';
import { deviceLogFont, drawGdiTextCall, ETO_CLIPPED, ETO_OPAQUE } from './gdi-text-render';
import { EmfRecordWriter, playEmfRecord } from './wmf-emf-bridge';
import type { WmfPlayer } from './wmf-player';

/** Windows-1252 code points for bytes 0x80..0x9F (the rest of the code page is Latin-1). */
const CP1252_HIGH = [
	0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
	0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

/** Decodes one ANSI byte for character set `charSet` (see the module doc). */
export function ansiToCode(b: number, charSet: number): number {
	if (charSet === 2) {
		return b;
	}
	return b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : b;
}

/** One WMF text call in logical units. */
interface WmfTextCall {
	x: number;
	y: number;
	bytes: number[];
	options: number;
	rect: [number, number, number, number] | null;
	dx: number[] | null;
}

/**
 * Device advances of `codes` in the selected font (the font engine's own
 * widths), or `null` without the `fonts` option or a usable font.
 */
function fontAdvances(p: WmfPlayer, codes: number[]): number[] | null {
	const fonts = p.rCtx.fonts;
	if (!fonts) {
		return null;
	}
	const m = gdiDeviceMatrix(p.rCtx);
	const font = fonts.realize(deviceLogFont(p.rCtx.state, Math.hypot(m[2], m[3]), Math.hypot(m[0], m[1])), p.rCtx.state.fontFamilyMap);
	return font ? codes.map((c) => font.advance(font.glyphIndex(c))) : null;
}

/**
 * The Dx array (logical units) GDI lays the call out with when the DC adds
 * character extra or justification and the call has none of its own;
 * `null` when neither applies or the widths are unknown.
 */
function spacedDx(p: WmfPlayer, codes: number[]): number[] | null {
	if (p.charExtra === 0 && (p.justifyExtra === 0 || p.justifyCount === 0)) {
		return null;
	}
	const adv = fontAdvances(p, codes);
	if (!adv) {
		return null;
	}
	const m = gdiDeviceMatrix(p.rCtx);
	const kx = Math.hypot(m[0], m[1]) || 1;
	const extraDev = Math.round(p.charExtra * kx);
	const breakChar = 0x20;
	const breaks = codes.filter((c) => c === breakChar).length;
	const justify = p.justifyCount > 0 ? Math.round(p.justifyExtra * kx) : 0;
	const per = breaks > 0 ? Math.trunc(justify / breaks) : 0;
	let rem = breaks > 0 ? justify - per * breaks : 0;
	return adv.map((a, i) => {
		let d = a + extraDev;
		if (codes[i] === breakChar && breaks > 0) {
			d += per;
			if (rem !== 0) {
				d += Math.sign(rem);
				rem -= Math.sign(rem);
			}
		}
		return d / kx;
	});
}

/** Draws the call with the GDI font engine; false (nothing drawn) without a usable font. */
function drawWithFontEngine(p: WmfPlayer, call: WmfTextCall, codes: number[], dx: number[] | null): boolean {
	const { rCtx } = p;
	if (!rCtx.fonts) {
		return false;
	}
	flushRasterLayer(rCtx);
	const r = call.rect;
	const adv = drawGdiTextCall(rCtx.ctx, rCtx.fonts, rCtx.state, {
		codes,
		glyphIndices: false,
		x: call.x,
		y: call.y,
		options: call.options,
		rect: r ? { left: r[0], top: r[1], right: r[2], bottom: r[3] } : null,
		dx,
		dy: null,
		matrix: gdiDeviceMatrix(rCtx),
	});
	if (!adv) {
		return false;
	}
	if (rCtx.state.textAlign & 0x01) {
		rCtx.state.curX += adv.dx;
		rCtx.state.curY += adv.dy;
	}
	return true;
}

/** Plays the call: the font engine when it can, else `EMR_EXTTEXTOUTW` through the EMF handler. */
function playText(p: WmfPlayer, call: WmfTextCall): void {
	const charSet = p.rCtx.state.fontDetails?.charSet ?? 1;
	const codes = call.bytes.map((b) => ansiToCode(b, charSet));
	const n = codes.length;
	if (n === 0) {
		return;
	}
	const dx = call.dx ?? spacedDx(p, codes);
	if (drawWithFontEngine(p, call, codes, dx)) {
		return;
	}
	const w = new EmfRecordWriter(EMR_EXTTEXTOUTW, 76 + n * 6 + 8);
	w.i32(0).i32(0).i32(-1).i32(-1); // rclBounds
	w.u32(1); // GM_COMPATIBLE
	w.f32(1).f32(1);
	w.i32(call.x).i32(call.y);
	w.u32(n);
	const offStringAt = w.offset;
	w.u32(0);
	w.u32(call.options);
	const r = call.rect ?? [0, 0, 0, 0];
	w.i32(r[0]).i32(r[1]).i32(r[2]).i32(r[3]);
	const offDxAt = w.offset;
	w.u32(0);
	w.patchU32(offStringAt, w.offset);
	for (const c of codes) {
		w.u16(c);
	}
	w.align();
	if (dx) {
		w.patchU32(offDxAt, w.offset);
		for (const v of dx) {
			// The EMF handler reads unsigned advances; a fractional logical
			// advance (from spacing) keeps its device value through the scale.
			w.u32(Math.round(v) >>> 0);
		}
	}
	playEmfRecord(p.rCtx, w.finish());
}

/** `META_TEXTOUT`: string length, string (padded to a word), y, x. */
export function wmfTextOut(p: WmfPlayer, dataOff: number, recEnd: number): void {
	const { view } = p;
	if (dataOff + 2 > recEnd) {
		return;
	}
	const n = view.getInt16(dataOff, true);
	const strOff = dataOff + 2;
	const posOff = strOff + n + (n & 1);
	if (n <= 0 || posOff + 4 > recEnd) {
		return;
	}
	const bytes: number[] = [];
	for (let i = 0; i < n; i++) {
		bytes.push(view.getUint8(strOff + i));
	}
	playText(p, {
		y: view.getInt16(posOff, true),
		x: view.getInt16(posOff + 2, true),
		bytes,
		options: 0,
		rect: null,
		dx: null,
	});
}

/** `META_EXTTEXTOUT`: y, x, string length, options, optional rectangle, string, optional Dx array. */
export function wmfExtTextOut(p: WmfPlayer, dataOff: number, recEnd: number): void {
	const { view } = p;
	if (dataOff + 8 > recEnd) {
		return;
	}
	const y = view.getInt16(dataOff, true);
	const x = view.getInt16(dataOff + 2, true);
	const n = view.getInt16(dataOff + 4, true);
	const options = view.getUint16(dataOff + 6, true);
	const hasRect = (options & (ETO_OPAQUE | ETO_CLIPPED)) !== 0;
	const strOff = dataOff + 8 + (hasRect ? 8 : 0);
	const rect: [number, number, number, number] | null =
		hasRect && dataOff + 16 <= recEnd
			? [view.getInt16(dataOff + 8, true), view.getInt16(dataOff + 10, true), view.getInt16(dataOff + 12, true), view.getInt16(dataOff + 14, true)]
			: null;
	const count = Math.max(0, n);
	if (strOff + count > recEnd) {
		return;
	}
	const bytes: number[] = [];
	for (let i = 0; i < count; i++) {
		bytes.push(view.getUint8(strOff + i));
	}
	const dxOff = strOff + count + (count & 1);
	let dx: number[] | null = null;
	if (count > 0 && dxOff + count * 2 <= recEnd) {
		dx = [];
		for (let i = 0; i < count; i++) {
			dx.push(view.getInt16(dxOff + i * 2, true));
		}
	}
	if (count === 0) {
		// An empty string still paints the ETO_OPAQUE rectangle.
		if (rect && options & ETO_OPAQUE) {
			playText(p, { x, y, bytes: [0x20], options, rect, dx: [0] });
		}
		return;
	}
	playText(p, { x, y, bytes, options, rect, dx });
}
