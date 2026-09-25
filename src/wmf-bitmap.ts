/**
 * WMF bitmap records: `META_PATBLT`, `META_BITBLT` and `META_STRETCHBLT`
 * (Win16 device-bitmap blits, see {@link wmfBitBlt}), `META_DIBBITBLT` and
 * `META_DIBSTRETCHBLT` (a packed DIB, or none), `META_STRETCHDIB` and
 * `META_SETDIBTODEV`.
 *
 * Each is played as its EMF counterpart (`EMR_BITBLT`, `EMR_STRETCHBLT`,
 * `EMR_STRETCHDIBITS`) through the EMF bitmap handler
 * (`emf-gdi-draw-bitmap.ts`), so every ROP3 code, the brush pattern and
 * origin, mirroring, source sub-rectangles and the stretch modes are
 * evaluated by the same exact code. A record "without a bitmap" (its size
 * is the parameters alone, MS-WMF 2.3.1) is a pattern-only blit. A
 * `DIB_PAL_COLORS` DIB is resolved through the selected palette first.
 * Every destination is rounded to whole device pixels first, as GDI's
 * `GM_COMPATIBLE` mode does, and the blit then runs on the device grid.
 *
 * @module wmf-bitmap
 */

import { EMR_BITBLT, EMR_STRETCHBLT, EMR_STRETCHDIBITS } from './emf-constants';
import { gdiDeviceMatrix } from './emf-gdi-coord';
import { EmfRecordWriter, playEmfRecord } from './wmf-emf-bridge';
import { dibHeaderAndTableSize, palColorsToRgb, resolveColorRef } from './wmf-objects';
import type { WmfPlayer } from './wmf-player';

/**
 * Maps a logical destination (`x`, `y`, extents `w`, `h`) to whole device
 * pixels, each corner rounded to the nearest pixel (GDI's `GM_COMPATIBLE`
 * blit destination; a negative extent stays a mirror).
 */
function deviceDest(p: WmfPlayer, x: number, y: number, w: number, h: number): [number, number, number, number] {
	const m = gdiDeviceMatrix(p.rCtx);
	const dev = (lx: number, ly: number): [number, number] => [
		Math.floor((m[0] * lx + m[2] * ly + m[4]) / p.kx + 0.5),
		Math.floor((m[1] * lx + m[3] * ly + m[5]) / p.ky + 0.5),
	];
	const a = dev(x, y);
	const b = dev(x + w, y + h);
	return [a[0], a[1], b[0] - a[0], b[1] - a[1]];
}

/**
 * Runs `play` with the shared context mapping device pixels one to one
 * (logical = device), so a blit's already-rounded destination lands as is.
 */
function onDevicePixels(p: WmfPlayer, play: () => void): void {
	const { rCtx } = p;
	const saved = {
		windowOrg: rCtx.windowOrg,
		windowExt: rCtx.windowExt,
		viewportOrg: rCtx.viewportOrg,
		viewportExt: rCtx.viewportExt,
	};
	rCtx.windowOrg = { x: 0, y: 0 };
	rCtx.windowExt = { cx: 1, cy: 1 };
	rCtx.viewportOrg = { x: 0, y: 0 };
	rCtx.viewportExt = { cx: p.kx, cy: p.ky };
	try {
		play();
	} finally {
		Object.assign(rCtx, saved);
	}
}

/**
 * A one-bit DIB in a `META_DIBBITBLT`/`META_DIBSTRETCHBLT` is played as the
 * monochrome device bitmap it was recorded from: its 0 bits in the DC's
 * text colour and its 1 bits in the background colour, whatever its colour
 * table says (measured: `wmf-bitmaps`).
 */
function monoAsDeviceColors(p: WmfPlayer, dib: PackedDib | null): PackedDib | null {
	if (!dib || dib.bmi.length < 48) {
		return dib;
	}
	const v = new DataView(dib.bmi.buffer, dib.bmi.byteOffset, dib.bmi.byteLength);
	if (v.getUint16(14, true) !== 1) {
		return dib;
	}
	const bmi = dib.bmi.slice();
	const head = v.getUint32(0, true);
	const put = (i: number, c: number) => {
		bmi[head + i * 4] = c & 0xff;
		bmi[head + i * 4 + 1] = (c >> 8) & 0xff;
		bmi[head + i * 4 + 2] = (c >> 16) & 0xff;
		bmi[head + i * 4 + 3] = 0;
	};
	put(0, resolveColorRef(p.textColor, p.palette));
	put(1, resolveColorRef(p.bkColor, p.palette));
	return { bmi, bits: dib.bits };
}

/** A packed DIB: header plus colour table, and bits. */
interface PackedDib {
	bmi: Uint8Array;
	bits: Uint8Array;
}

/** Extracts the packed DIB at `off..end` (`usage` 1 = `DIB_PAL_COLORS`, resolved to RGB). */
function readDib(p: WmfPlayer, off: number, end: number, usage: number): PackedDib | null {
	const { view } = p;
	if (off + 40 > end) {
		return null;
	}
	let src = new Uint8Array(view.buffer, view.byteOffset + off, end - off);
	let v = new DataView(src.buffer, src.byteOffset, src.byteLength);
	if (usage === 1) {
		const rgb = palColorsToRgb(p, view, off, end);
		if (!rgb) {
			return null;
		}
		src = rgb;
		v = new DataView(rgb.buffer);
	}
	if (v.getUint32(0, true) < 40) {
		return null;
	}
	const head = dibHeaderAndTableSize(v, 0, 0);
	if (head > src.length) {
		return null;
	}
	return { bmi: src.subarray(0, head), bits: src.subarray(head) };
}

/** Plays `EMR_BITBLT`/`EMR_STRETCHBLT` with an optional source DIB (top-down source coordinates). */
function playBlt(
	p: WmfPlayer,
	stretch: boolean,
	rop: number,
	dx: number,
	dy: number,
	dw: number,
	dh: number,
	sx: number,
	sy: number,
	sw: number,
	sh: number,
	dib: PackedDib | null,
): void {
	[dx, dy, dw, dh] = deviceDest(p, dx, dy, dw, dh);
	const fixed = stretch ? 108 : 100;
	const w = new EmfRecordWriter(stretch ? EMR_STRETCHBLT : EMR_BITBLT, fixed + (dib ? dib.bmi.length + dib.bits.length + 8 : 0));
	w.i32(0).i32(0).i32(-1).i32(-1);
	w.i32(dx).i32(dy).i32(dw).i32(dh);
	w.u32(rop);
	w.i32(sx).i32(sy);
	w.f32(1).f32(0).f32(0).f32(1).f32(0).f32(0); // XformSrc: identity
	w.u32(0); // crBkColorSrc
	w.u32(0); // iUsageSrc: DIB_RGB_COLORS
	const offBmiAt = w.offset;
	w.u32(0).u32(0).u32(0).u32(0);
	if (stretch) {
		w.i32(sw).i32(sh);
	}
	if (dib) {
		const bmiAt = w.offset;
		w.raw(dib.bmi).align();
		const bitsAt = w.offset;
		w.raw(dib.bits);
		w.patchU32(offBmiAt, bmiAt).patchU32(offBmiAt + 4, dib.bmi.length).patchU32(offBmiAt + 8, bitsAt).patchU32(offBmiAt + 12, dib.bits.length);
	}
	const record = w.finish();
	onDevicePixels(p, () => playEmfRecord(p.rCtx, record));
}

/** Plays `EMR_STRETCHDIBITS` (bottom-left source coordinates). */
function playStretchDibits(
	p: WmfPlayer,
	rop: number,
	dx: number,
	dy: number,
	dw: number,
	dh: number,
	sx: number,
	sy: number,
	sw: number,
	sh: number,
	dib: PackedDib,
	onDevice = false,
): void {
	if (!onDevice) {
		[dx, dy, dw, dh] = deviceDest(p, dx, dy, dw, dh);
	}
	const w = new EmfRecordWriter(EMR_STRETCHDIBITS, 80 + dib.bmi.length + dib.bits.length + 8);
	w.i32(0).i32(0).i32(-1).i32(-1);
	w.i32(dx).i32(dy);
	w.i32(sx).i32(sy).i32(sw).i32(sh);
	const offBmiAt = w.offset;
	w.u32(0).u32(0).u32(0).u32(0);
	w.u32(0); // iUsageSrc
	w.u32(rop);
	w.i32(dw).i32(dh);
	const bmiAt = w.offset;
	w.raw(dib.bmi).align();
	const bitsAt = w.offset;
	w.raw(dib.bits);
	w.patchU32(offBmiAt, bmiAt).patchU32(offBmiAt + 4, dib.bmi.length).patchU32(offBmiAt + 8, bitsAt).patchU32(offBmiAt + 12, dib.bits.length);
	const record = w.finish();
	onDevicePixels(p, () => playEmfRecord(p.rCtx, record));
}

/** `META_PATBLT`: rop, height, width, y, x. */
export function wmfPatBlt(p: WmfPlayer, d: number, end: number): void {
	const { view } = p;
	if (d + 12 > end) {
		return;
	}
	const rop = view.getUint32(d, true);
	const h = view.getInt16(d + 4, true);
	const wd = view.getInt16(d + 6, true);
	const y = view.getInt16(d + 8, true);
	const x = view.getInt16(d + 10, true);
	playBlt(p, false, rop, x, y, wd, h, 0, 0, wd, h, null);
}

/** True when a blit record carries no bitmap (MS-WMF: its size is the parameters alone). */
function withoutBitmap(recType: number, recSize: number): boolean {
	return recSize / 2 === (recType >> 8) + 3;
}

/**
 * `META_BITBLT` / `META_STRETCHBLT`: the Win16 records with a `Bitmap16`
 * device bitmap. Windows' `PlayMetaFile` no longer draws that bitmap, at
 * any bit depth (measured: `wmf-legacy`), but a record WITHOUT a bitmap
 * (its size is the parameters alone) is still the pattern blit it
 * describes: rop, [src height, src width,] src y, src x, reserved, dest
 * height, dest width, dest y, dest x.
 */
export function wmfBitBlt(p: WmfPlayer, stretch: boolean, offset: number, recSize: number): void {
	const { view } = p;
	const recType = view.getUint16(offset + 4, true);
	if (!withoutBitmap(recType, recSize)) {
		return;
	}
	const d = offset + 6;
	const k = d + 4 + (stretch ? 4 : 0) + 6;
	if (k + 8 > offset + recSize) {
		return;
	}
	const rop = view.getUint32(d, true);
	const dh = view.getInt16(k, true);
	const dw = view.getInt16(k + 2, true);
	const dy = view.getInt16(k + 4, true);
	const dx = view.getInt16(k + 6, true);
	playBlt(p, false, rop, dx, dy, dw, dh, 0, 0, dw, dh, null);
}

/**
 * `META_DIBBITBLT` / `META_DIBSTRETCHBLT`: as {@link wmfBitBlt}, with a
 * packed DIB (`DIB_RGB_COLORS`) instead of a `Bitmap16`.
 */
export function wmfDibBitBlt(p: WmfPlayer, stretch: boolean, offset: number, recSize: number): void {
	const { view } = p;
	const recType = view.getUint16(offset + 4, true);
	const d = offset + 6;
	const end = offset + recSize;
	const none = withoutBitmap(recType, recSize);
	let k = d + 4;
	const rd = () => {
		const v = view.getInt16(k, true);
		k += 2;
		return v;
	};
	if (d + 4 + (stretch ? 16 : 12) > end) {
		return;
	}
	const rop = view.getUint32(d, true);
	const sh = stretch ? rd() : 0;
	const sw = stretch ? rd() : 0;
	const sy = rd();
	const sx = rd();
	if (none) {
		k += 2;
	}
	const dh = rd();
	const dw = rd();
	const dy = rd();
	const dx = rd();
	const dib = none ? null : monoAsDeviceColors(p, readDib(p, k, end, 0));
	playBlt(p, stretch, rop, dx, dy, dw, dh, sx, sy, stretch ? sw : dw, stretch ? sh : dh, dib);
}

/**
 * `META_STRETCHDIB`: rop, colour usage, src height, src width, src y,
 * src x, dest height, dest width, dest y, dest x, packed DIB.
 */
export function wmfStretchDib(p: WmfPlayer, d: number, end: number): void {
	const { view } = p;
	if (d + 22 > end) {
		return;
	}
	const rop = view.getUint32(d, true);
	const usage = view.getUint16(d + 4, true);
	const sh = view.getInt16(d + 6, true);
	const sw = view.getInt16(d + 8, true);
	const sy = view.getInt16(d + 10, true);
	const sx = view.getInt16(d + 12, true);
	const dh = view.getInt16(d + 14, true);
	const dw = view.getInt16(d + 16, true);
	const dy = view.getInt16(d + 18, true);
	const dx = view.getInt16(d + 20, true);
	const dib = readDib(p, d + 22, end, usage);
	if (dib) {
		playStretchDibits(p, rop, dx, dy, dw, dh, sx, sy, sw, sh, dib);
	}
}

/**
 * `META_SETDIBTODEV`: colour usage, scan count, start scan, src y, src x,
 * height, width, dest y, dest x, packed DIB holding `scanCount` rows from
 * `startScan` up. Copies the source rectangle unscaled (`SRCCOPY`), one
 * DIB pixel per device pixel, at the mapped destination origin.
 */
export function wmfSetDibToDev(p: WmfPlayer, d: number, end: number): void {
	const { view } = p;
	if (d + 18 > end) {
		return;
	}
	const usage = view.getUint16(d, true);
	const scanCount = view.getUint16(d + 2, true);
	const startScan = view.getUint16(d + 4, true);
	const sy = view.getInt16(d + 6, true);
	const sx = view.getInt16(d + 8, true);
	const h = view.getInt16(d + 10, true);
	const w = view.getInt16(d + 12, true);
	const dy = view.getInt16(d + 14, true);
	const dx = view.getInt16(d + 16, true);
	const dib = readDib(p, d + 18, end, usage);
	if (!dib || scanCount === 0) {
		return;
	}
	// The DIB holds only the (bottom-up) rows startScan .. startScan +
	// scanCount - 1; only the part of the source rectangle they cover is
	// drawn, at its place in the destination. The destination origin is
	// mapped; the extent is pixels (the bits are never stretched).
	const dibRows = Math.abs(new DataView(dib.bmi.buffer, dib.bmi.byteOffset, dib.bmi.byteLength).getInt32(8, true));
	if (startScan !== 0 || scanCount < dibRows) {
		// Windows' PlayMetaFile draws a META_SETDIBTODEV only when it carries
		// the whole DIB from its first scan line: a band of scan lines draws
		// nothing (measured: `wmf-bitmaps`).
		return;
	}
	const lo = Math.max(sy, startScan);
	const hi = Math.min(sy + h, startScan + scanCount);
	if (hi <= lo || w <= 0) {
		return;
	}
	const bmi = dib.bmi.slice();
	const hv = new DataView(bmi.buffer);
	const fullH = hv.getInt32(8, true);
	hv.setInt32(8, fullH < 0 ? -scanCount : scanCount, true);
	const [ox, oy] = deviceDest(p, dx, dy, 0, 0);
	playStretchDibits(p, 0x00cc0020, ox, oy + (sy + h - hi), w, hi - lo, sx, lo - startScan, w, hi - lo, { bmi, bits: dib.bits }, true);
}
