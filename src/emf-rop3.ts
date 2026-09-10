/**
 * Ternary raster-operation (ROP3) emulation for EMR_BITBLT / EMR_STRETCHDIBITS.
 *
 * GDI's BitBlt/StretchBlt combine a source bitmap (S), the current brush
 * pattern (P), and the destination pixels (D) with a bitwise boolean
 * expression selected by a 32-bit ROP3 code. Canvas 2D has no bitwise
 * compositing primitive, so each supported code is classified into one of a
 * few emulation strategies:
 *
 * - Codes that only ever touch S or D alone, or neither, map onto ordinary
 *   Canvas operations exactly (`drawImage`, `fillRect`, or the same
 *   `'difference'`-blend inversion trick `rop2Paint` uses for `R2_NOT`).
 * - Codes that combine S and D bitwise (SRCPAINT/SRCAND/SRCINVERT/SRCERASE/
 *   NOTSRCERASE/MERGEPAINT) are computed exactly, per pixel, via
 *   {@link applyRop3Bitwise} over `ImageData` read back from the canvas -
 *   Canvas offers no blend mode equivalent to bitwise AND/OR/XOR at 8-bit
 *   precision.
 * - Codes that also involve the brush pattern P as a genuine tiled pattern
 *   (MERGECOPY, PATPAINT, PATINVERT) are not implemented: GDI's "pattern" is
 *   a full repeating bitmap, not just the flat brush colour this converter
 *   already tracks, so an exact emulation would need the realized brush
 *   bitmap. These degrade to a plain source copy, logged via `emfWarn`.
 *
 * @module emf-rop3
 */

import {
	ROP3_SRCCOPY,
	ROP3_SRCPAINT,
	ROP3_SRCAND,
	ROP3_SRCINVERT,
	ROP3_SRCERASE,
	ROP3_NOTSRCCOPY,
	ROP3_NOTSRCERASE,
	ROP3_PATCOPY,
	ROP3_DSTINVERT,
	ROP3_BLACKNESS,
	ROP3_WHITENESS,
	ROP3_MERGEPAINT,
} from './emf-constants';
import { emfLog } from './emf-logging';

/** Per-pixel bitwise combination of the decoded source with the destination. */
export type Rop3BitwiseOp =
	| 'or' // SRCPAINT: S | D
	| 'and' // SRCAND: S & D
	| 'xor' // SRCINVERT: S ^ D
	| 'src-and-not-dst' // SRCERASE: S & ~D
	| 'not-src-or-dst' // MERGEPAINT: ~S | D
	| 'not-src-and-not-dst'; // NOTSRCERASE: ~(S | D) = ~S & ~D

/** How a ROP3 code should be realised on Canvas 2D. */
export type Rop3Plan =
	| { kind: 'copy' } // SRCCOPY, and the fallback for unrecognised/unsupported codes
	| { kind: 'solid'; color: 'black' | 'white' } // BLACKNESS / WHITENESS
	| { kind: 'pattern' } // PATCOPY: ignore the source bitmap entirely, fill with the brush
	| { kind: 'invert-source' } // NOTSRCCOPY: draw ~S, ignoring D
	| { kind: 'invert-dest' } // DSTINVERT: ignore S, draw ~D in place
	| { kind: 'bitwise'; op: Rop3BitwiseOp };

/**
 * Classifies a ROP3 code into a Canvas 2D emulation strategy. Unrecognised
 * codes (and the pattern-bitmap codes noted in the module doc) degrade to
 * `{ kind: 'copy' }`, matching this codebase's general "approximate, don't
 * crash" philosophy for raster operations (see `rop2Paint`).
 */
export function classifyRop3(rop3: number): Rop3Plan {
	switch (rop3) {
		case ROP3_SRCCOPY:
			return { kind: 'copy' };
		case ROP3_BLACKNESS:
			return { kind: 'solid', color: 'black' };
		case ROP3_WHITENESS:
			return { kind: 'solid', color: 'white' };
		case ROP3_PATCOPY:
			return { kind: 'pattern' };
		case ROP3_NOTSRCCOPY:
			return { kind: 'invert-source' };
		case ROP3_DSTINVERT:
			return { kind: 'invert-dest' };
		case ROP3_SRCPAINT:
			return { kind: 'bitwise', op: 'or' };
		case ROP3_SRCAND:
			return { kind: 'bitwise', op: 'and' };
		case ROP3_SRCINVERT:
			return { kind: 'bitwise', op: 'xor' };
		case ROP3_SRCERASE:
			return { kind: 'bitwise', op: 'src-and-not-dst' };
		case ROP3_NOTSRCERASE:
			return { kind: 'bitwise', op: 'not-src-and-not-dst' };
		case ROP3_MERGEPAINT:
			return { kind: 'bitwise', op: 'not-src-or-dst' };
		default:
			emfLog(`classifyRop3: ROP3 0x${rop3.toString(16)} has no exact emulation - using SRCCOPY`);
			return { kind: 'copy' };
	}
}

/**
 * Combines `src` into `dst` in place, per pixel, per RGB channel, per `op`.
 * Both `ImageData`s must have identical `width`/`height`. Alpha is always
 * forced to fully opaque: GDI device-independent bitmaps carry no
 * meaningful per-pixel alpha for ROP3 purposes, and treating the decoded
 * alpha as a real channel would let bitwise combination produce partial
 * transparency GDI itself never would.
 */
export function applyRop3Bitwise(dst: ImageData, src: ImageData, op: Rop3BitwiseOp): void {
	const d = dst.data;
	const s = src.data;
	const n = Math.min(d.length, s.length);
	for (let i = 0; i < n; i += 4) {
		for (let c = 0; c < 3; c++) {
			const sv = s[i + c];
			const dv = d[i + c];
			d[i + c] = combineChannel(sv, dv, op);
		}
		d[i + 3] = 255;
	}
}

function combineChannel(s: number, d: number, op: Rop3BitwiseOp): number {
	switch (op) {
		case 'or':
			return s | d;
		case 'and':
			return s & d;
		case 'xor':
			return s ^ d;
		case 'src-and-not-dst':
			return s & ~d & 0xff;
		case 'not-src-or-dst':
			return (~s & 0xff) | d;
		case 'not-src-and-not-dst':
			return ~(s | d) & 0xff;
	}
}

/** Inverts the RGB channels of `data` in place (used for NOTSRCCOPY). Alpha is left untouched. */
export function invertImageDataRgb(data: ImageData): void {
	const d = data.data;
	for (let i = 0; i < d.length; i += 4) {
		d[i] = 255 - d[i];
		d[i + 1] = 255 - d[i + 1];
		d[i + 2] = 255 - d[i + 2];
	}
}

/**
 * Normalises a possibly-flipped (negative width/height) device rectangle to
 * positive dimensions and clamps it to the canvas bounds, as required by
 * `getImageData`/`putImageData` (unlike `drawImage`/`fillRect`, which accept
 * negative extents directly). Returns `null` when the rect has no on-canvas
 * area left after clamping.
 */
export function clampPositiveRect(
	x: number,
	y: number,
	w: number,
	h: number,
	canvasW: number,
	canvasH: number,
): { x: number; y: number; w: number; h: number } | null {
	let left = w < 0 ? x + w : x;
	let top = h < 0 ? y + h : y;
	let width = Math.abs(w);
	let height = Math.abs(h);

	left = Math.round(left);
	top = Math.round(top);
	width = Math.round(width);
	height = Math.round(height);

	const right = Math.min(left + width, Math.round(canvasW));
	const bottom = Math.min(top + height, Math.round(canvasH));
	left = Math.max(left, 0);
	top = Math.max(top, 0);
	width = right - left;
	height = bottom - top;

	if (width <= 0 || height <= 0) {
		return null;
	}
	return { x: left, y: top, w: width, h: height };
}
