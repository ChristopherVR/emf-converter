/**
 * EMF bitmap records beyond the ROP3 blits: EMR_ALPHABLEND, EMR_TRANSPARENTBLT,
 * EMR_MASKBLT, EMR_PLGBLT and EMR_SETDIBITSTODEVICE.
 *
 * Every one of them is evaluated per DEVICE pixel, the way GDI writes it,
 * and reaches the canvas through `rewritePixels` (`emf-rop2-exact.ts`), so
 * the destination is read back where the result depends on it and the
 * active clip region applies. In SVG output the destination comes from the
 * raster mirror and the changed pixels become an `<image>` patch; without a
 * mirror (`exactRasterOps: false`) the destination-independent parts are
 * still painted exactly and the rest is approximated or skipped (see each
 * handler).
 *
 * Geometry (matched against real GDI, `src/__fixtures__/gdi/emfrec-*`):
 *
 *   - AlphaBlend, TransparentBlt and MaskBlt map the destination rectangle
 *     axis-aligned (`gmx`/`gmy`), a mirrored (negative) extent anchored one
 *     device pixel inward like StretchBlt's, and pick each device pixel's
 *     source texel with GDI's nearest-neighbour rule (`gdiNearest`), which
 *     is what their stretching uses whatever the stretch mode.
 *   - PlgBlt maps the source onto the device parallelogram of its three
 *     points exactly like a rotated BitBlt (`paintParallelogram`).
 *   - SetDIBitsToDevice copies without stretching; a record holds only the
 *     scan lines `iStartScan .. iStartScan + cScans - 1` (counted from the
 *     bottom of a bottom-up DIB), and only those rows are painted.
 *
 * AlphaBlend's arithmetic (all 86,016 channel values of
 * `emfrec-alphablend-sweep` reproduced exactly), per channel with
 * `div255(v) = round(v / 255)`:
 *
 *   - no `AC_SRC_ALPHA`, or an opaque source pixel under a constant alpha
 *     `SCA < 255`: `D + div255((S - D) * SCA)`;
 *   - `AC_SRC_ALPHA` (the source premultiplied): a zero-alpha source pixel
 *     leaves the destination alone; otherwise `S' + div255(D * (255 - A'))`
 *     with `S' = S`, `A' = A` at `SCA = 255` and `S' = div255(S * SCA)`,
 *     `A' = div255(A * SCA)` below it. The three sums are added as one
 *     packed BGR word, so a channel that overflows (a source that is not
 *     really premultiplied) wraps and carries into the next one, blue into
 *     green into red, as Windows does.
 *
 * @module emf-gdi-blend-blits
 */

import { createImageDataCompat } from './emf-canvas-helpers';
import { decodeDibToImageData } from './emf-dib-decoder';
import {
	EMR_ALPHABLEND,
	EMR_MASKBLT,
	EMR_PLGBLT,
	EMR_SETDIBITSTODEVICE,
	EMR_TRANSPARENTBLT,
} from './emf-constants';
import { realizeBrush } from './emf-gdi-brush-pattern';
import { gmh, gmw, gmx, gmy } from './emf-gdi-coord';
import { paintParallelogram, patternOperand } from './emf-gdi-draw-bitmap';
import { paletteEntries, resolveColorRefRgb } from './emf-gdi-palette';
import { fixPoint } from './emf-gdi-raster-shapes';
import { gdiNearest } from './emf-gdi-stretch';
import { emfWarn } from './emf-logging';
import { acquireScratch, compositeOverlay, rewritePixels, type PixelBox } from './emf-rop2-exact';
import { evalRop3, rop3Operands } from './emf-rop3';
import type { EmfGdiReplayCtx } from './emf-types';
import { canReadBack } from './svg-context';

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** A decoded source bitmap: top-down pixels (RGBA; alpha as stored when asked for). */
type Source = ImageData;

/**
 * Decodes the bitmap a record carries at the record-relative offsets
 * `offBmi`/`offBits`. `usage` 1 (DIB_PAL_COLORS) resolves its colour table
 * through the selected palette; `rawAlpha` keeps a 32bpp alpha byte.
 */
function readSource(
	rCtx: EmfGdiReplayCtx,
	offset: number,
	offBmi: number,
	cbBmi: number,
	offBits: number,
	cbBits: number,
	usage: number,
	rawAlpha = false,
): Source | null {
	if (!offBmi || !cbBmi || !offBits || !cbBits) {
		return null;
	}
	return decodeDibToImageData(
		rCtx.view,
		offset + offBmi,
		offset + offBits,
		cbBits,
		usage === 1 ? paletteEntries(rCtx.state) : null,
		rawAlpha,
	);
}

/**
 * A 1bpp mask's bits, top-down, one byte (0/1) per pixel: MaskBlt and PlgBlt
 * read the bit values themselves, whatever colour table the recorder wrote.
 */
function readMask(rCtx: EmfGdiReplayCtx, offset: number, offBmi: number, cbBmi: number, offBits: number, cbBits: number): { width: number; height: number; bits: Uint8Array } | null {
	const { view } = rCtx;
	if (!offBmi || !cbBmi || !offBits || !cbBits) {
		return null;
	}
	const bmi = offset + offBmi;
	if (bmi + 16 > view.byteLength) {
		return null;
	}
	const width = view.getInt32(bmi + 4, true);
	const heightRaw = view.getInt32(bmi + 8, true);
	const height = Math.abs(heightRaw);
	if (view.getUint16(bmi + 14, true) !== 1 || width <= 0 || height === 0 || width > 16384 || height > 16384) {
		return null;
	}
	const stride = ((width + 31) >> 5) * 4;
	const bits = offset + offBits;
	if (bits + stride * height > view.byteLength) {
		return null;
	}
	const out = new Uint8Array(width * height);
	for (let row = 0; row < height; row++) {
		const y = heightRaw > 0 ? height - 1 - row : row;
		const rowOff = bits + row * stride;
		for (let x = 0; x < width; x++) {
			out[y * width + x] = (view.getUint8(rowOff + (x >> 3)) >> (7 - (x & 7))) & 1;
		}
	}
	return { width, height, bits: out };
}

/**
 * The source rectangle a BitBlt-style record addresses: `xSrc`/`ySrc` and
 * the extents mapped through its XformSrc (the recorder crops the bitmap to
 * the part it reads and records the offset there). An all-zero XformSrc
 * means identity.
 */
function mappedSourceRect(view: DataView, xformOff: number, xSrc: number, ySrc: number, cx: number, cy: number): { sx: number; sy: number; sw: number; sh: number } {
	const m11 = view.getFloat32(xformOff, true);
	const m12 = view.getFloat32(xformOff + 4, true);
	const m21 = view.getFloat32(xformOff + 8, true);
	const m22 = view.getFloat32(xformOff + 12, true);
	const mdx = view.getFloat32(xformOff + 16, true);
	const mdy = view.getFloat32(xformOff + 20, true);
	const identity = m11 === 0 && m22 === 0 && m12 === 0 && m21 === 0;
	const a = identity ? 1 : m11;
	const d = identity ? 1 : m22;
	return {
		sx: Math.round(a * xSrc + (identity ? 0 : m21 * ySrc + mdx)),
		sy: Math.round(d * ySrc + (identity ? 0 : m12 * xSrc + mdy)),
		sw: Math.round(a * cx),
		sh: Math.round(d * cy),
	};
}

/** The pixel at (`x`, `y`) of `src` as `[0xRRGGBB, alpha]`, clamped to its edges. */
function texelAt(src: Source, x: number, y: number): number {
	const tx = x < 0 ? 0 : x >= src.width ? src.width - 1 : x;
	const ty = y < 0 ? 0 : y >= src.height ? src.height - 1 : y;
	const i = (ty * src.width + tx) * 4;
	return ((src.data[i + 3] << 24) | (src.data[i] << 16) | (src.data[i + 1] << 8) | src.data[i + 2]) >>> 0;
}

// ---------------------------------------------------------------------------
// Axis-aligned destination mapping
// ---------------------------------------------------------------------------

/** A destination box (clamped to the canvas) and the source texel of each of its columns and rows. */
interface AxisMap {
	box: PixelBox;
	/** Source column of device column `box.x + i`, row of device row `box.y + j`. */
	col: Int32Array;
	row: Int32Array;
}

/**
 * GDI's device rectangle for the logical destination `xDest, yDest, cx, cy`
 * and the nearest source texel of every device column and row, for the
 * source rectangle `sx, sy, sw, sh` (negative extents mirror). `null` when
 * nothing lands on the canvas.
 *
 * An upright destination takes each pixel's texel under its centre
 * (`gdiNearest`). A mirrored one (a negative extent after the world
 * transform) is stretched with GDI's edge-based DDA instead, texel
 * `floor(i * |sw| / W)` for the i-th pixel from the top/left on BOTH axes,
 * read backwards along each mirrored one (measured on a vertically
 * mirrored 1.25x AlphaBlend). A mirrored source is read backwards too.
 */
function axisMap(
	rCtx: EmfGdiReplayCtx,
	xDest: number,
	yDest: number,
	cxDest: number,
	cyDest: number,
	sx: number,
	sy: number,
	sw: number,
	sh: number,
): AxisMap | null {
	let dx = gmx(rCtx, xDest);
	let dy = gmy(rCtx, yDest);
	const dw = gmw(rCtx, cxDest);
	const dh = gmh(rCtx, cyDest);
	// A mirrored extent covers the pixels from its anchor inward (as StretchBlt).
	if (dw < 0) {
		dx += rCtx.useMappingMode ? 1 : rCtx.sx;
	}
	if (dh < 0) {
		dy += rCtx.useMappingMode ? 1 : rCtx.sy;
	}
	const W = Math.round(Math.abs(dw));
	const H = Math.round(Math.abs(dh));
	const aw = Math.abs(sw);
	const ah = Math.abs(sh);
	if (W === 0 || H === 0 || aw === 0 || ah === 0) {
		return null;
	}
	const left = Math.round(Math.min(dx, dx + dw));
	const top = Math.round(Math.min(dy, dy + dh));
	const x0 = Math.max(0, left);
	const y0 = Math.max(0, top);
	const x1 = Math.min(rCtx.canvasW, left + W);
	const y1 = Math.min(rCtx.canvasH, top + H);
	if (x1 <= x0 || y1 <= y0) {
		return null;
	}
	const baseX = Math.min(sx, sx + sw);
	const baseY = Math.min(sy, sy + sh);
	const col = new Int32Array(x1 - x0);
	const row = new Int32Array(y1 - y0);
	const mirrored = dw < 0 || dh < 0;
	const pick = (i: number, len: number, n: number): number => (mirrored ? Math.min(len - 1, Math.floor((i * len) / n)) : gdiNearest(i, len, n));
	for (let x = x0; x < x1; x++) {
		const k = pick(x - left, aw, W);
		col[x - x0] = (sw < 0) !== (dw < 0) ? baseX + aw - 1 - k : baseX + k;
	}
	for (let y = y0; y < y1; y++) {
		const k = pick(y - top, ah, H);
		row[y - y0] = (sh < 0) !== (dh < 0) ? baseY + ah - 1 - k : baseY + k;
	}
	return { box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, col, row };
}

/**
 * Writes `op`'s colour (or leaves the pixel, -1) at every pixel of `box`:
 * through `rewritePixels` when the destination can be read back, otherwise
 * (SVG without a raster mirror) through an overlay computed against a black
 * destination, which is exact for every destination-independent `op`.
 */
function writePixels(rCtx: EmfGdiReplayCtx, box: PixelBox, op: (x: number, y: number, d: number) => number): void {
	const { ctx } = rCtx;
	if (canReadBack(ctx) && typeof ctx.getImageData === 'function' && rewritePixels(ctx, box, op)) {
		return;
	}
	const scratch = acquireScratch(box.w, box.h);
	if (!scratch) {
		return;
	}
	const data = new Uint8ClampedArray(box.w * box.h * 4);
	for (let y = 0; y < box.h; y++) {
		for (let x = 0; x < box.w; x++) {
			const c = op(box.x + x, box.y + y, 0);
			if (c < 0) {
				continue;
			}
			const i = (y * box.w + x) * 4;
			data[i] = (c >> 16) & 0xff;
			data[i + 1] = (c >> 8) & 0xff;
			data[i + 2] = c & 0xff;
			data[i + 3] = 255;
		}
	}
	compositeOverlay(ctx, box, scratch, createImageDataCompat(data, box.w, box.h));
}

// ---------------------------------------------------------------------------
// AlphaBlend
// ---------------------------------------------------------------------------

/** `round(v / 255)` for the non-negative integers AlphaBlend's products give. */
function div255(v: number): number {
	return Math.round(v / 255);
}

/**
 * One AlphaBlend pixel (see the module doc): `s` is the source as
 * `0xAARRGGBB`, `d` the destination `0xRRGGBB`, `sca` the constant alpha;
 * -1 leaves the destination alone.
 */
export function alphaBlendPixel(s: number, d: number, sca: number, srcAlpha: boolean): number {
	const a = s >>> 24;
	if (sca === 0) {
		return -1;
	}
	const sr = (s >> 16) & 0xff;
	const sg = (s >> 8) & 0xff;
	const sb = s & 0xff;
	const dr = (d >> 16) & 0xff;
	const dg = (d >> 8) & 0xff;
	const db = d & 0xff;
	if (!srcAlpha || (a === 255 && sca !== 255)) {
		return (
			((dr + Math.round(((sr - dr) * sca) / 255)) << 16) |
			((dg + Math.round(((sg - dg) * sca) / 255)) << 8) |
			(db + Math.round(((sb - db) * sca) / 255))
		);
	}
	if (a === 0) {
		return -1;
	}
	let pr = sr;
	let pg = sg;
	let pb = sb;
	let pa = a;
	if (sca !== 255) {
		pr = div255(sr * sca);
		pg = div255(sg * sca);
		pb = div255(sb * sca);
		pa = div255(a * sca);
	}
	const k = 255 - pa;
	const b = pb + div255(db * k);
	const g = pg + div255(dg * k) + (b >> 8);
	const r = pr + div255(dr * k) + (g >> 8);
	return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

/** EMR_ALPHABLEND (114). */
function handleAlphaBlend(rCtx: EmfGdiReplayCtx, offset: number, dataOff: number, recSize: number): void {
	const { view } = rCtx;
	if (recSize < 108) {
		return;
	}
	const blend = view.getUint32(dataOff + 32, true);
	const sca = (blend >>> 16) & 0xff;
	const srcAlpha = (blend >>> 24 & 0x01) !== 0;
	const src = readSource(
		rCtx,
		offset,
		view.getUint32(dataOff + 76, true),
		view.getUint32(dataOff + 80, true),
		view.getUint32(dataOff + 84, true),
		view.getUint32(dataOff + 88, true),
		view.getUint32(dataOff + 72, true),
		true,
	);
	if (!src || sca === 0) {
		return;
	}
	const r = mappedSourceRect(view, dataOff + 44, view.getInt32(dataOff + 36, true), view.getInt32(dataOff + 40, true), view.getInt32(dataOff + 92, true), view.getInt32(dataOff + 96, true));
	const map = axisMap(rCtx, view.getInt32(dataOff + 16, true), view.getInt32(dataOff + 20, true), view.getInt32(dataOff + 24, true), view.getInt32(dataOff + 28, true), r.sx, r.sy, r.sw, r.sh);
	if (!map) {
		return;
	}
	const { box, col, row } = map;
	if (!canReadBack(rCtx.ctx)) {
		// No destination to read (SVG without a raster mirror): composite the
		// source with its own alpha instead, which Canvas and SVG blend the
		// same way up to rounding.
		drawAlphaOverlay(rCtx, map, src, sca, srcAlpha);
		return;
	}
	writePixels(rCtx, box, (x, y, d) => alphaBlendPixel(texelAt(src, col[x - box.x], row[y - box.y]), d, sca, srcAlpha));
}

/** AlphaBlend without a readable destination: a straight-alpha overlay composited source-over. */
function drawAlphaOverlay(rCtx: EmfGdiReplayCtx, map: AxisMap, src: Source, sca: number, srcAlpha: boolean): void {
	const { box, col, row } = map;
	const scratch = acquireScratch(box.w, box.h);
	if (!scratch) {
		return;
	}
	const data = new Uint8ClampedArray(box.w * box.h * 4);
	for (let y = 0; y < box.h; y++) {
		for (let x = 0; x < box.w; x++) {
			const s = texelAt(src, col[x], row[y]);
			const a = srcAlpha ? ((s >>> 24) * sca) / 255 : sca;
			const i = (y * box.w + x) * 4;
			// Premultiplied source: un-premultiply for the straight-alpha overlay.
			const k = srcAlpha && s >>> 24 > 0 ? 255 / (s >>> 24) : 1;
			data[i] = ((s >> 16) & 0xff) * k;
			data[i + 1] = ((s >> 8) & 0xff) * k;
			data[i + 2] = (s & 0xff) * k;
			data[i + 3] = a;
		}
	}
	compositeOverlay(rCtx.ctx, box, scratch, createImageDataCompat(data, box.w, box.h));
}

// ---------------------------------------------------------------------------
// TransparentBlt
// ---------------------------------------------------------------------------

/** EMR_TRANSPARENTBLT (116): every source pixel but the transparent colour is copied. */
function handleTransparentBlt(rCtx: EmfGdiReplayCtx, offset: number, dataOff: number, recSize: number): void {
	const { view } = rCtx;
	if (recSize < 108) {
		return;
	}
	const key = resolveColorRefRgb(view.getUint32(dataOff + 32, true), paletteEntries(rCtx.state));
	const src = readSource(
		rCtx,
		offset,
		view.getUint32(dataOff + 76, true),
		view.getUint32(dataOff + 80, true),
		view.getUint32(dataOff + 84, true),
		view.getUint32(dataOff + 88, true),
		view.getUint32(dataOff + 72, true),
	);
	if (!src) {
		return;
	}
	const r = mappedSourceRect(view, dataOff + 44, view.getInt32(dataOff + 36, true), view.getInt32(dataOff + 40, true), view.getInt32(dataOff + 92, true), view.getInt32(dataOff + 96, true));
	const map = axisMap(rCtx, view.getInt32(dataOff + 16, true), view.getInt32(dataOff + 20, true), view.getInt32(dataOff + 24, true), view.getInt32(dataOff + 28, true), r.sx, r.sy, r.sw, r.sh);
	if (!map) {
		return;
	}
	const { box, col, row } = map;
	writePixels(rCtx, box, (x, y) => {
		const s = texelAt(src, col[x - box.x], row[y - box.y]) & 0xffffff;
		return s === key ? -1 : s;
	});
}

// ---------------------------------------------------------------------------
// MaskBlt
// ---------------------------------------------------------------------------

/**
 * EMR_MASKBLT (78): the foreground ROP3 (`dwRop` bits 16..23) where the
 * 1bpp mask is 1, the background ROP3 (bits 24..31) where it is 0, with
 * the mask read from (`xMask`, `yMask`) on; no mask means the foreground
 * ROP everywhere. No stretching.
 */
function handleMaskBlt(rCtx: EmfGdiReplayCtx, offset: number, dataOff: number, recSize: number): void {
	const { view } = rCtx;
	if (recSize < 128) {
		return;
	}
	const rop = view.getUint32(dataOff + 32, true);
	const fore = (rop >>> 16) & 0xff;
	const back = (rop >>> 24) & 0xff;
	const cx = view.getInt32(dataOff + 24, true);
	const cy = view.getInt32(dataOff + 28, true);
	const src = readSource(
		rCtx,
		offset,
		view.getUint32(dataOff + 76, true),
		view.getUint32(dataOff + 80, true),
		view.getUint32(dataOff + 84, true),
		view.getUint32(dataOff + 88, true),
		view.getUint32(dataOff + 72, true),
	);
	const mask = readMask(rCtx, offset, view.getUint32(dataOff + 104, true), view.getUint32(dataOff + 108, true), view.getUint32(dataOff + 112, true), view.getUint32(dataOff + 116, true));
	const xMask = view.getInt32(dataOff + 92, true);
	const yMask = view.getInt32(dataOff + 96, true);
	const r = mappedSourceRect(view, dataOff + 44, view.getInt32(dataOff + 36, true), view.getInt32(dataOff + 40, true), cx, cy);
	const map = axisMap(rCtx, view.getInt32(dataOff + 16, true), view.getInt32(dataOff + 20, true), cx, cy, r.sx, r.sy, r.sw, r.sh);
	if (!map) {
		return;
	}
	const { box, col, row } = map;
	const needsDest = rop3Operands(fore).usesD || (mask !== null && rop3Operands(back).usesD);
	if (needsDest && !canReadBack(rCtx.ctx)) {
		emfWarn('EMR_MASKBLT: a destination-reading ROP needs the raster mirror; skipped in SVG output without one');
		return;
	}
	const pattern = patternOperand(rCtx, realizeBrush(rCtx.state));
	// Mask texels follow the (unstretched) source offset from the rectangle's origin.
	const mx0 = Math.min(r.sx, r.sx + r.sw);
	const my0 = Math.min(r.sy, r.sy + r.sh);
	writePixels(rCtx, box, (x, y, d) => {
		const sxp = col[x - box.x];
		const syp = row[y - box.y];
		let index = fore;
		if (mask) {
			const mx = xMask + sxp - mx0;
			const my = yMask + syp - my0;
			const bit = mx >= 0 && my >= 0 && mx < mask.width && my < mask.height ? mask.bits[my * mask.width + mx] : 0;
			index = bit ? fore : back;
		}
		const s = src ? texelAt(src, sxp, syp) & 0xffffff : 0;
		const p = typeof pattern === 'function' ? pattern(x, y) : pattern;
		return evalRop3(index, p, s, d);
	});
}

// ---------------------------------------------------------------------------
// PlgBlt
// ---------------------------------------------------------------------------

/**
 * EMR_PLGBLT (79): the source rectangle mapped onto the parallelogram of
 * `aptlDest` (upper-left, upper-right and lower-left corners), sampled per
 * device pixel like a rotated BitBlt; where the optional 1bpp mask is 0 the
 * destination is left alone.
 */
function handlePlgBlt(rCtx: EmfGdiReplayCtx, offset: number, dataOff: number, recSize: number): void {
	const { view } = rCtx;
	if (recSize < 140) {
		return;
	}
	const pts: Array<[number, number]> = [0, 1, 2].map((i) => fixPoint(rCtx, view.getInt32(dataOff + 16 + i * 8, true), view.getInt32(dataOff + 20 + i * 8, true)));
	const cx = view.getInt32(dataOff + 48, true);
	const cy = view.getInt32(dataOff + 52, true);
	const src = readSource(
		rCtx,
		offset,
		view.getUint32(dataOff + 88, true),
		view.getUint32(dataOff + 92, true),
		view.getUint32(dataOff + 96, true),
		view.getUint32(dataOff + 100, true),
		view.getUint32(dataOff + 84, true),
	);
	if (!src) {
		return;
	}
	const mask = readMask(rCtx, offset, view.getUint32(dataOff + 116, true), view.getUint32(dataOff + 120, true), view.getUint32(dataOff + 124, true), view.getUint32(dataOff + 128, true));
	const xMask = view.getInt32(dataOff + 104, true);
	const yMask = view.getInt32(dataOff + 108, true);
	const r = mappedSourceRect(view, dataOff + 56, view.getInt32(dataOff + 40, true), view.getInt32(dataOff + 44, true), cx, cy);
	// The mask texel (mix, miy) is the source texel for a rotated blit, but
	// stays unmirrored when an axis-aligned blit mirrors the source.
	const texel = (ix: number, iy: number, mix = ix, miy = iy): number => {
		if (mask) {
			const mx = xMask + mix;
			const my = yMask + miy;
			if (mx < 0 || my < 0 || mx >= mask.width || my >= mask.height || !mask.bits[my * mask.width + mx]) {
				return -1;
			}
		}
		const tx = r.sw < 0 ? r.sx - 1 - ix : r.sx + ix;
		const ty = r.sh < 0 ? r.sy - 1 - iy : r.sy + iy;
		return texelAt(src, tx, ty) & 0xffffff;
	};
	const [a, b, q] = pts;
	if (b[1] === a[1] && q[0] === a[0]) {
		// An axis-aligned parallelogram is a StretchBlt from A with extents
		// B - A and Q - A: a mirrored extent covers the pixels from its
		// anchor inward (x = 140 back to 111 for a 30-pixel mirror, not the
		// 110..139 of the box between the points), and each pixel takes the
		// texel under its centre, read backwards along a mirrored axis (the
		// mask is not: measured on a vertically mirrored masked PlgBlt).
		const W = Math.round(Math.abs(b[0] - a[0]) / 16);
		const H = Math.round(Math.abs(q[1] - a[1]) / 16);
		const left = Math.round(a[0] / 16) + (b[0] < a[0] ? 1 - W : 0);
		const top = Math.round(a[1] / 16) + (q[1] < a[1] ? 1 - H : 0);
		const aw = Math.abs(r.sw);
		const ah = Math.abs(r.sh);
		const x0 = Math.max(0, left);
		const y0 = Math.max(0, top);
		const x1 = Math.min(rCtx.canvasW, left + W);
		const y1 = Math.min(rCtx.canvasH, top + H);
		if (x1 <= x0 || y1 <= y0 || aw === 0 || ah === 0) {
			return;
		}
		const flipX = b[0] < a[0];
		const flipY = q[1] < a[1];
		writePixels(rCtx, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, (x, y) => {
			const kx = gdiNearest(x - left, aw, W);
			const ky = gdiNearest(y - top, ah, H);
			return texel(flipX ? aw - 1 - kx : kx, flipY ? ah - 1 - ky : ky, kx, ky);
		});
		return;
	}
	paintParallelogram(rCtx, a, b, q, r.sw, r.sh, (ix, iy) => texel(ix, iy));
}

// ---------------------------------------------------------------------------
// SetDIBitsToDevice
// ---------------------------------------------------------------------------

/**
 * Decodes the `cScans` scan lines a record carries: its BITMAPINFO still
 * gives the full DIB height, so the header is copied with the height set to
 * the band's.
 */
function readBand(rCtx: EmfGdiReplayCtx, offset: number, offBmi: number, cbBmi: number, offBits: number, cbBits: number, usage: number, scans: number): Source | null {
	const { view } = rCtx;
	if (!offBmi || !cbBmi || !offBits || !cbBits || offset + offBmi + cbBmi > view.byteLength || offset + offBits + cbBits > view.byteLength) {
		return null;
	}
	const bytes = new Uint8Array(cbBmi + cbBits);
	bytes.set(new Uint8Array(view.buffer, view.byteOffset + offset + offBmi, cbBmi), 0);
	bytes.set(new Uint8Array(view.buffer, view.byteOffset + offset + offBits, cbBits), cbBmi);
	const band = new DataView(bytes.buffer);
	const height = band.getInt32(8, true);
	band.setInt32(8, height < 0 ? -scans : scans, true);
	return decodeDibToImageData(band, 0, cbBmi, cbBits, usage === 1 ? paletteEntries(rCtx.state) : null);
}

/** EMR_SETDIBITSTODEVICE (80). */
function handleSetDibitsToDevice(rCtx: EmfGdiReplayCtx, offset: number, dataOff: number, recSize: number): void {
	const { view } = rCtx;
	if (recSize < 76) {
		return;
	}
	const xSrc = view.getInt32(dataOff + 24, true);
	const ySrc = view.getInt32(dataOff + 28, true);
	const cx = view.getInt32(dataOff + 32, true);
	const cy = view.getInt32(dataOff + 36, true);
	const offBmi = view.getUint32(dataOff + 40, true);
	const cbBmi = view.getUint32(dataOff + 44, true);
	const startScan = view.getUint32(dataOff + 60, true);
	const scans = view.getUint32(dataOff + 64, true);
	if (scans === 0 || !offBmi || offset + offBmi + 12 > view.byteLength) {
		return;
	}
	const fullHeight = view.getInt32(offset + offBmi + 8, true);
	const topDown = fullHeight < 0;
	const fullRows = Math.abs(fullHeight);
	const band = readBand(rCtx, offset, offBmi, cbBmi, view.getUint32(dataOff + 48, true), view.getUint32(dataOff + 52, true), view.getUint32(dataOff + 56, true), scans);
	if (!band) {
		return;
	}
	const map = axisMap(rCtx, view.getInt32(dataOff + 16, true), view.getInt32(dataOff + 20, true), cx, cy, 0, 0, cx, cy);
	if (!map) {
		return;
	}
	const { box, col, row } = map;
	writePixels(rCtx, box, (x, y) => {
		const i = col[x - box.x];
		const j = row[y - box.y];
		// Destination row j shows DIB row ySrc + cy - 1 - j counted from the
		// bottom: the source origin is the lower-left corner for a top-down
		// DIB too. A bottom-up band holds rows startScan.. from the bottom, a
		// top-down one rows startScan.. from the top.
		const fromBottom = ySrc + cy - 1 - j;
		const bandRow = topDown ? fullRows - 1 - fromBottom - startScan : scans - 1 - (fromBottom - startScan);
		if (bandRow < 0 || bandRow >= band.height) {
			return -1;
		}
		const sxp = xSrc + i;
		if (sxp < 0 || sxp >= band.width) {
			return -1;
		}
		return texelAt(band, sxp, bandRow) & 0xffffff;
	});
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/** Handles the records above; returns false for any other record type. */
export function handleEmfGdiBlendBlitRecord(rCtx: EmfGdiReplayCtx, recType: number, offset: number, dataOff: number, recSize: number): boolean {
	switch (recType) {
		case EMR_ALPHABLEND:
			handleAlphaBlend(rCtx, offset, dataOff, recSize);
			return true;
		case EMR_TRANSPARENTBLT:
			handleTransparentBlt(rCtx, offset, dataOff, recSize);
			return true;
		case EMR_MASKBLT:
			handleMaskBlt(rCtx, offset, dataOff, recSize);
			return true;
		case EMR_PLGBLT:
			handlePlgBlt(rCtx, offset, dataOff, recSize);
			return true;
		case EMR_SETDIBITSTODEVICE:
			handleSetDibitsToDevice(rCtx, offset, dataOff, recSize);
			return true;
		default:
			return false;
	}
}
