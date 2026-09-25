/**
 * GDI brush patterns: the "P" operand of a ROP3 blit.
 *
 * GDI realises every brush as a repeating bitmap anchored at the DC's brush
 * origin (EMR_SETBRUSHORGEX) in device pixels. A solid brush is one colour; a
 * hatched brush is an 8x8 one-bit pattern painted in the brush colour over the
 * DC background colour (whatever the background MODE, for raster ops); a
 * monochrome pattern brush (EMR_CREATEMONOBRUSH) paints 0 bits in the text
 * colour and 1 bits in the background colour; a DIB pattern brush
 * (EMR_CREATEDIBPATTERNBRUSHPT) is its own colour bitmap. The hatch bit
 * patterns and colour rules below were read back from real Windows GDI output
 * (see `scripts/gdi-fixtures`).
 *
 * @module emf-gdi-brush-pattern
 */

import { decodeDibToImageData } from './emf-dib-decoder';
import type { DrawState, GdiBrushPattern } from './emf-types';

/**
 * The six HS_* hatch styles as 8 rows of 8 bits (bit 7 = leftmost pixel),
 * exactly as Windows GDI paints them with a zero brush origin.
 */
export const HATCH_ROWS: readonly (readonly number[])[] = [
	[0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0x00], // HS_HORIZONTAL
	[0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08], // HS_VERTICAL
	[0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01], // HS_FDIAGONAL
	[0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80], // HS_BDIAGONAL
	[0x08, 0x08, 0x08, 0xff, 0x08, 0x08, 0x08, 0x08], // HS_CROSS
	[0x81, 0x42, 0x24, 0x18, 0x18, 0x24, 0x42, 0x81], // HS_DIAGCROSS
];

/** True when hatch style `hatch` sets pixel (`x`, `y`) of its 8x8 cell. */
export function hatchBit(hatch: number, x: number, y: number): boolean {
	const rows = HATCH_ROWS[hatch] ?? HATCH_ROWS[0];
	return ((rows[y & 7] >> (7 - (x & 7))) & 1) === 1;
}

/** Parses a `#rrggbb` (or `#rgb`) CSS colour to packed `0xRRGGBB`; anything else is black. */
export function cssHexToRgb(color: string): number {
	const m = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(color.trim());
	if (!m) {
		return 0;
	}
	const hex = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
	return parseInt(hex, 16);
}

/**
 * Decodes a bottom-up or top-down 1bpp DIB's bits (no colour table needed)
 * into one byte per pixel, top-down. Returns `null` when out of bounds.
 */
export function decodeMonoBits(
	view: DataView,
	bmiOffset: number,
	bitsOffset: number,
): { width: number; height: number; bits: Uint8Array } | null {
	if (bmiOffset + 16 > view.byteLength) {
		return null;
	}
	const width = view.getInt32(bmiOffset + 4, true);
	const heightRaw = view.getInt32(bmiOffset + 8, true);
	const bitCount = view.getUint16(bmiOffset + 14, true);
	const height = Math.abs(heightRaw);
	if (bitCount !== 1 || width <= 0 || height === 0 || width > 256 || height > 256) {
		return null;
	}
	const stride = ((width + 31) >> 5) * 4;
	if (bitsOffset + stride * height > view.byteLength) {
		return null;
	}
	const bits = new Uint8Array(width * height);
	for (let row = 0; row < height; row++) {
		const y = heightRaw > 0 ? height - 1 - row : row;
		const rowOff = bitsOffset + row * stride;
		for (let x = 0; x < width; x++) {
			bits[y * width + x] = (view.getUint8(rowOff + (x >> 3)) >> (7 - (x & 7))) & 1;
		}
	}
	return { width, height, bits };
}

/**
 * Parses the pattern of an EMR_CREATEMONOBRUSH / EMR_CREATEDIBPATTERNBRUSHPT
 * record (`ihBrush, iUsage, offBmi, cbBmi, offBits, cbBits` at `dataOff`,
 * offsets relative to the record start `offset`).
 */
export function parsePatternBrush(
	view: DataView,
	offset: number,
	dataOff: number,
	mono: boolean,
): GdiBrushPattern | null {
	if (dataOff + 24 > view.byteLength) {
		return null;
	}
	const offBmi = view.getUint32(dataOff + 8, true);
	const offBits = view.getUint32(dataOff + 16, true);
	const cbBits = view.getUint32(dataOff + 20, true);
	const bmi = offset + offBmi;
	const bitsAt = offset + offBits;
	const bitCount = bmi + 16 <= view.byteLength ? view.getUint16(bmi + 14, true) : 0;
	if (mono || bitCount === 1) {
		const decoded = decodeMonoBits(view, bmi, bitsAt);
		// EMR_CREATEMONOBRUSH ignores any colour table: text/background colours apply.
		if (decoded && mono) {
			return { kind: 'mono', ...decoded };
		}
	}
	const image = decodeDibToImageData(view, bmi, bitsAt, cbBits);
	if (!image) {
		return null;
	}
	const rgb = new Uint32Array(image.width * image.height);
	const d = image.data;
	for (let i = 0; i < rgb.length; i++) {
		rgb[i] = (d[i * 4] << 16) | (d[i * 4 + 1] << 8) | d[i * 4 + 2];
	}
	return { kind: 'bitmap', width: image.width, height: image.height, rgb };
}

/** A realised brush: one colour, or a repeating tile of `0xRRGGBB` pixels. */
export type RealizedBrush =
	| { kind: 'none' }
	| { kind: 'solid'; rgb: number }
	| { kind: 'tile'; width: number; height: number; rgb: Uint32Array };

/**
 * Pure: realises the selected brush against the DC's current text and
 * background colours (hatched and monochrome brushes take their colours from
 * the DC at blit time, not at creation time).
 */
export function realizeBrush(state: DrawState): RealizedBrush {
	if (state.brushStyle === 1) {
		return { kind: 'none' };
	}
	const pattern = state.brushPattern;
	if (!pattern) {
		return { kind: 'solid', rgb: cssHexToRgb(state.brushColor) };
	}
	if (pattern.kind === 'bitmap') {
		return { kind: 'tile', width: pattern.width, height: pattern.height, rgb: pattern.rgb };
	}
	const bk = cssHexToRgb(state.bkColor);
	if (pattern.kind === 'hatch') {
		const fg = cssHexToRgb(state.brushColor);
		const rgb = new Uint32Array(64);
		for (let y = 0; y < 8; y++) {
			for (let x = 0; x < 8; x++) {
				rgb[y * 8 + x] = hatchBit(pattern.hatch, x, y) ? fg : bk;
			}
		}
		return { kind: 'tile', width: 8, height: 8, rgb };
	}
	const text = cssHexToRgb(state.textColor);
	const rgb = new Uint32Array(pattern.width * pattern.height);
	for (let i = 0; i < rgb.length; i++) {
		rgb[i] = pattern.bits[i] ? bk : text;
	}
	return { kind: 'tile', width: pattern.width, height: pattern.height, rgb };
}

/**
 * Samples a realised tile at a device pixel, honouring the brush origin: the
 * tile's pixel (0,0) lands on device pixel (`orgX`, `orgY`) and repeats.
 */
export function sampleTile(
	tile: { width: number; height: number; rgb: Uint32Array },
	devX: number,
	devY: number,
	orgX: number,
	orgY: number,
): number {
	const tx = (((devX - orgX) % tile.width) + tile.width) % tile.width;
	const ty = (((devY - orgY) % tile.height) + tile.height) % tile.height;
	return tile.rgb[ty * tile.width + tx];
}
