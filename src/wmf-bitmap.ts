/**
 * WMF bitmap records: `META_PATBLT`, `META_BITBLT` and `META_STRETCHBLT`
 * (a `Bitmap16` device bitmap, or none), `META_DIBBITBLT` and
 * `META_DIBSTRETCHBLT` (a packed DIB, or none), `META_STRETCHDIB` and
 * `META_SETDIBTODEV`.
 *
 * Each is played as its EMF counterpart (`EMR_BITBLT`, `EMR_STRETCHBLT`,
 * `EMR_STRETCHDIBITS`) through the EMF bitmap handler
 * (`emf-gdi-draw-bitmap.ts`), so every ROP3 code, the brush pattern and
 * origin, mirroring, source sub-rectangles and the stretch modes are
 * evaluated by the same exact code. A record "without a bitmap" (its size
 * is the parameters alone, MS-WMF 2.3.1) is a pattern-only blit. A
 * monochrome `Bitmap16` source paints its 0 bits in the text colour and its
 * 1 bits in the background colour, as `BitBlt` does from a monochrome
 * device bitmap; a `DIB_PAL_COLORS` DIB is resolved through the selected
 * palette first.
 *
 * @module wmf-bitmap
 */

import { EMR_BITBLT, EMR_STRETCHBLT, EMR_STRETCHDIBITS } from './emf-constants';
import { gdiDeviceMatrix } from './emf-gdi-coord';
import { EmfRecordWriter, playEmfRecord } from './wmf-emf-bridge';
import { dibHeaderAndTableSize, palColorsToRgb, readBitmap16, resolveColorRef } from './wmf-objects';
import type { WmfPlayer } from './wmf-player';

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

/** A `Bitmap16` source (bits `skip` bytes after its header) as a top-down 32 bpp DIB. */
function bitmap16Dib(p: WmfPlayer, off: number, end: number): PackedDib | null {
	const bmp = readBitmap16(p.view, off, end, 10);
	if (!bmp) {
		return null;
	}
	const { width, height } = bmp;
	const bmi = new Uint8Array(40);
	const hv = new DataView(bmi.buffer);
	hv.setUint32(0, 40, true);
	hv.setInt32(4, width, true);
	hv.setInt32(8, -height, true);
	hv.setUint16(12, 1, true);
	hv.setUint16(14, 32, true);
	const bits = new Uint8Array(width * height * 4);
	const fg = resolveColorRef(p.textColor, p.palette);
	const bk = resolveColorRef(p.bkColor, p.palette);
	for (let i = 0; i < width * height; i++) {
		const c = bmp.kind === 'mono' ? (bmp.bits[i] ? bk : fg) : bmp.kind === 'bitmap' ? bmp.rgb[i] : 0;
		bits[i * 4] = c & 0xff;
		bits[i * 4 + 1] = (c >> 8) & 0xff;
		bits[i * 4 + 2] = (c >> 16) & 0xff;
	}
	return { bmi, bits };
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
	playEmfRecord(p.rCtx, w.finish());
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
): void {
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
	playEmfRecord(p.rCtx, w.finish());
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
 * `META_BITBLT` / `META_STRETCHBLT`: rop, [src height, src width,] src y,
 * src x, [reserved when bitmapless,] dest height, dest width, dest y,
 * dest x, then a `Bitmap16`.
 */
export function wmfBitBlt(p: WmfPlayer, stretch: boolean, offset: number, recSize: number): void {
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
	const dib = none ? null : bitmap16Dib(p, k, end);
	playBlt(p, stretch, rop, dx, dy, dw, dh, sx, sy, stretch ? sw : dw, stretch ? sh : dh, dib);
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
	const dib = none ? null : readDib(p, k, end, 0);
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
	// The DIB holds only rows startScan .. startScan + scanCount - 1.
	const bmi = dib.bmi.slice();
	const hv = new DataView(bmi.buffer);
	const fullH = hv.getInt32(8, true);
	hv.setInt32(8, fullH < 0 ? -scanCount : scanCount, true);
	// Extents are device pixels: express them in logical units for the blit.
	const m = gdiDeviceMatrix(p.rCtx);
	const lw = (w * p.kx) / (m[0] || 1);
	const lh = (h * p.ky) / (m[3] || 1);
	playStretchDibitsExact(p, dx, dy, lw, lh, sx, sy - startScan, w, h, { bmi, bits: dib.bits });
}

/** {@link playStretchDibits} with `SRCCOPY` and fractional logical extents (scaled to fixed point 1/65536). */
function playStretchDibitsExact(
	p: WmfPlayer,
	dx: number,
	dy: number,
	lw: number,
	lh: number,
	sx: number,
	sy: number,
	sw: number,
	sh: number,
	dib: PackedDib,
): void {
	if (Number.isInteger(lw) && Number.isInteger(lh)) {
		playStretchDibits(p, 0x00cc0020, dx, dy, lw, lh, sx, sy, sw, sh, dib);
		return;
	}
	// Fractional logical extents (a scaled mapping): blit through a finer
	// logical grid so the device extent stays exact.
	const { rCtx } = p;
	const savedOrg = rCtx.windowOrg;
	const savedExt = rCtx.windowExt;
	const f = 64;
	rCtx.windowOrg = { x: savedOrg.x * f, y: savedOrg.y * f };
	rCtx.windowExt = { cx: savedExt.cx * f, cy: savedExt.cy * f };
	try {
		playStretchDibits(p, 0x00cc0020, dx * f, dy * f, Math.round(lw * f), Math.round(lh * f), sx, sy, sw, sh, dib);
	} finally {
		rCtx.windowOrg = savedOrg;
		rCtx.windowExt = savedExt;
	}
}
