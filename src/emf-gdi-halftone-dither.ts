/**
 * The ordered dither Windows' halftone engine applies when it adjusts colours
 * (any `SetColorAdjustment` beyond plain per-channel curves).
 *
 * The engine quantises each source channel to 32 levels (`round(n * 255 / 31)`)
 * with a threshold from a 16 x 16 matrix, then maps the quantised colour
 * through the adjustment. Measured on native captures (flat patches stretched
 * with HALFTONE, every input level, every phase): a channel value `v` becomes
 * level `floor((31 * v + threshold) / 255)`, the three channels sharing one
 * threshold per pixel.
 *
 * The matrix is stretched over a 66 x 65 pixel period: the last 16-wide cell
 * of each row repeats its column 14 twice more (and the last cell of each
 * column repeats row 14 once more), so a pixel's matrix cell is
 * `column[x % 66]`, `row[y % 65]`. The pattern origin follows the destination
 * rectangle and the brush origin, and advances per source pixel when the
 * stretch enlarges and per destination pixel when it reduces.
 *
 * Mirrored destinations (all measured on native captures): a horizontal mirror
 * flips the pattern with the image; a vertical one still runs it down the
 * destination rows, shifted by the rows the enlargement adds (`H - SH`). When
 * one axis enlarges while the other reduces, the pattern follows the source
 * pixel only if the destination is larger than the source in area, otherwise
 * the destination pixel. A rotated or skewed blit (adjusted only in the case
 * `EmfGdiReplayCtx.halftoneRotatedAdjusts` describes) anchors the pattern at
 * the device origin and advances per destination pixel.
 *
 * @module emf-gdi-halftone-dither
 */

/** Thresholds 0..254, indexed `[row][column]`. */
const THRESHOLDS: readonly (readonly number[])[] = [
	[238, 110, 198, 70, 229, 102, 204, 76, 236, 108, 195, 69, 228, 100, 205, 78],
	[46, 174, 7, 134, 39, 166, 12, 140, 45, 171, 5, 132, 36, 164, 15, 142],
	[209, 83, 249, 122, 218, 90, 239, 112, 208, 80, 247, 120, 215, 88, 242, 114],
	[18, 146, 59, 185, 26, 154, 49, 176, 16, 144, 56, 184, 25, 152, 50, 178],
	[226, 98, 202, 74, 233, 107, 192, 64, 224, 96, 200, 73, 232, 104, 194, 66],
	[35, 162, 11, 138, 42, 170, 1, 128, 32, 160, 8, 136, 40, 168, 2, 130],
	[219, 91, 243, 115, 211, 83, 253, 125, 221, 93, 245, 117, 212, 85, 250, 123],
	[28, 154, 52, 178, 19, 147, 61, 188, 29, 157, 53, 181, 22, 149, 59, 187],
	[235, 107, 195, 67, 226, 100, 205, 77, 236, 109, 197, 69, 229, 101, 202, 76],
	[43, 171, 4, 131, 35, 163, 14, 141, 45, 173, 5, 133, 38, 164, 11, 139],
	[207, 79, 246, 119, 215, 87, 240, 113, 209, 81, 249, 121, 216, 90, 239, 111],
	[15, 143, 56, 183, 23, 151, 49, 177, 18, 145, 57, 185, 25, 153, 47, 175],
	[222, 95, 198, 71, 231, 103, 193, 66, 225, 97, 201, 73, 232, 105, 191, 63],
	[32, 159, 8, 135, 39, 167, 1, 129, 33, 161, 9, 137, 42, 169, 1, 127],
	[222, 94, 246, 118, 214, 86, 252, 124, 219, 92, 243, 116, 212, 84, 253, 126],
	[30, 158, 54, 181, 22, 150, 60, 188, 28, 156, 52, 180, 21, 147, 62, 190],
];

const PERIOD_X = 66;
const PERIOD_Y = 65;

/** The matrix column of period position `j` (0..65). */
function column(j: number): number {
	return j < 63 ? j % 16 : j <= 64 ? 14 : 15;
}

/** The matrix row of period position `i` (0..64). */
function row(i: number): number {
	return i < 63 ? i % 16 : i === 63 ? 14 : 15;
}

const mod = (a: number, m: number): number => ((a % m) + m) % m;

/**
 * Period position of a blit's first pixel along x: the destination rectangle's
 * left edge minus the brush origin, taken over 65 positions that skip the
 * repeated column (see the module doc).
 */
export function ditherStartX(destLeft: number, brushOrgX: number): number {
	const k = mod(destLeft - brushOrgX - 2, 65);
	return k < 63 ? k : k + 1;
}

/** Period position of a blit's first row. */
export function ditherStartY(destTop: number, brushOrgY: number): number {
	return mod(destTop - brushOrgY - 2, PERIOD_Y);
}

/** Threshold (0..254) of the pixel `dx` columns and `dy` rows from the start positions. */
export function ditherThreshold(startX: number, startY: number, dx: number, dy: number): number {
	return THRESHOLDS[row(mod(startY + dy, PERIOD_Y))][column(mod(startX + dx, PERIOD_X))];
}

/** The 8-bit value of 32-level palette entry `n`. */
export function paletteLevel(n: number): number {
	return Math.round((n * 255) / 31);
}

/** Quantises channel value `v` (0..255) with `threshold`, returning the palette level's 8-bit value. */
export function ditherQuantize(v: number, threshold: number): number {
	const n = Math.floor((31 * v + threshold) / 255);
	return paletteLevel(n < 0 ? 0 : n > 31 ? 31 : n);
}

/** Dither phase of a halftone blit; see {@link ditherStartX}. */
export interface HalftoneDither {
	startX: number;
	startY: number;
}
