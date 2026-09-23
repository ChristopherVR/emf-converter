/**
 * Ternary raster-operation (ROP3) evaluation for EMR_BITBLT,
 * EMR_STRETCHBLT and EMR_STRETCHDIBITS.
 *
 * GDI's BitBlt/StretchBlt combine the brush pattern (P), a source bitmap (S)
 * and the destination pixels (D) with a bitwise boolean function. Bits 16..23
 * of the 32-bit ROP3 code are that function's truth table: bit `i` is the
 * result for the operand combination `i = P<<2 | S<<1 | D` (the classic
 * `P = 0xF0, S = 0xCC, D = 0xAA` encoding). The low word only describes
 * GDI's internal RPN program, and Windows itself ignores it.
 *
 * This module evaluates ALL 256 functions exactly, per pixel and per RGB
 * bit, via {@link applyRop3}. A handful of codes that touch at most one
 * operand keep a cheaper Canvas-native plan ({@link classifyRop3}).
 *
 * @module emf-rop3
 */

/** Extracts the truth-table index (bits 16..23) from a 32-bit ROP3 code. */
export function rop3Index(rop: number): number {
	return (rop >>> 16) & 0xff;
}

/** Which operands a ROP3 function actually depends on. */
export interface Rop3Operands {
	usesP: boolean;
	usesS: boolean;
	usesD: boolean;
}

/**
 * Pure: a function depends on an operand exactly when flipping that operand
 * changes some truth-table entry.
 */
export function rop3Operands(index: number): Rop3Operands {
	const t = index & 0xff;
	return {
		usesP: ((t >> 4) & 0x0f) !== (t & 0x0f),
		usesS: ((t >> 2) & 0x33) !== (t & 0x33),
		usesD: ((t >> 1) & 0x55) !== (t & 0x55),
	};
}

/**
 * Evaluates ROP3 function `index` bitwise over packed operands. Callers pass
 * 24-bit `0xRRGGBB` values so all three channels are computed in one pass;
 * `mask` bounds the result.
 */
export function evalRop3(index: number, p: number, s: number, d: number, mask = 0xffffff): number {
	let out = 0;
	const np = ~p;
	const ns = ~s;
	const nd = ~d;
	for (let i = 0; i < 8; i++) {
		if (index & (1 << i)) {
			out |= (i & 4 ? p : np) & (i & 2 ? s : ns) & (i & 1 ? d : nd);
		}
	}
	return out & mask;
}

/** How a ROP3 code should be realised on Canvas 2D. */
export type Rop3Plan =
	/** SRCCOPY: `drawImage` of the source. */
	| { kind: 'copy' }
	/** BLACKNESS / WHITENESS: a plain fill, no operands. */
	| { kind: 'solid'; color: 'black' | 'white' }
	/** D (0xAA): leaves the destination untouched. */
	| { kind: 'noop' }
	/** DSTINVERT (0x55): `~D` via a white `'difference'` fill. */
	| { kind: 'invert-dest' }
	/** Every other function: exact per-pixel evaluation. */
	| { kind: 'ternary'; index: number; operands: Rop3Operands };

/**
 * Pure decision function: picks the cheapest exact strategy for a ROP3 code.
 * Every one of the 256 functions maps to an exact plan; nothing degrades.
 */
export function classifyRop3(rop: number): Rop3Plan {
	const index = rop3Index(rop);
	switch (index) {
		case 0xcc:
			return { kind: 'copy' };
		case 0x00:
			return { kind: 'solid', color: 'black' };
		case 0xff:
			return { kind: 'solid', color: 'white' };
		case 0xaa:
			return { kind: 'noop' };
		case 0x55:
			return { kind: 'invert-dest' };
		default:
			return { kind: 'ternary', index, operands: rop3Operands(index) };
	}
}

/** Per-pixel pattern source: a solid `0xRRGGBB`, or a sampler over canvas pixel coordinates. */
export type Rop3Pattern = number | ((x: number, y: number) => number);

/**
 * Applies ROP3 function `index` in place over `dst` (the destination pixels),
 * reading `src` (same size, or `null` when the function does not use S) and
 * `pattern` (sampled at canvas coordinates `originX + x`, `originY + y`).
 * Alpha is forced opaque: GDI raster operations have no alpha channel, and
 * treating decoded alpha as real would produce partial transparency GDI
 * never paints.
 */
export function applyRop3(
	dst: ImageData,
	src: ImageData | null,
	pattern: Rop3Pattern,
	index: number,
	originX: number,
	originY: number,
): void {
	const d = dst.data;
	const s = src ? src.data : null;
	const w = dst.width;
	const h = dst.height;
	const solidP = typeof pattern === 'number' ? pattern : 0;
	const sampleP = typeof pattern === 'function' ? pattern : null;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			const dv = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
			const sv = s ? (s[i] << 16) | (s[i + 1] << 8) | s[i + 2] : 0;
			const pv = sampleP ? sampleP(originX + x, originY + y) : solidP;
			const r = evalRop3(index, pv, sv, dv);
			d[i] = (r >> 16) & 0xff;
			d[i + 1] = (r >> 8) & 0xff;
			d[i + 2] = r & 0xff;
			d[i + 3] = 255;
		}
	}
}

/**
 * Normalises a possibly-flipped (negative width/height) device rectangle to
 * positive dimensions and clamps it to the canvas bounds, as required by
 * `getImageData`. Returns `null` when the rect has no on-canvas area left
 * after clamping.
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
