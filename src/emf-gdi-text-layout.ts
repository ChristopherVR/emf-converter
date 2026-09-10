/**
 * Pure per-glyph text-layout helpers shared by the EMF (EMR_EXTTEXTOUTW) and
 * WMF (META_EXTTEXTOUT) drawers.
 *
 * GDI's ExtTextOut* records may carry an explicit "Dx" array: one advance
 * width per character, in logical units. When present it is authoritative
 * and reproduces GDI's exact glyph spacing regardless of the destination
 * font's own metrics (metrics the browser's font engine supplies, and which
 * can differ from the Windows font that authored the file). Without a Dx
 * array, per-glyph spacing falls back to the browser's own shaping of the
 * whole string in one `fillText` call: that remaining case is not
 * deterministic (it depends on whether the original font is installed and
 * how closely a substitute's metrics match it), so it is documented rather
 * than emulated.
 *
 * @module emf-gdi-text-layout
 */

// ---------------------------------------------------------------------------
// Dx array -> per-glyph device offsets
// ---------------------------------------------------------------------------

/**
 * Cumulative left-edge offsets for a Dx array of `dx.length` character
 * advances. `dx[i]` is the distance GDI advances *after* drawing character
 * `i`, so character `i`'s own left edge sits at the sum of every advance
 * before it: index 0 is always 0, and the array has the same length as `dx`.
 */
export function cumulativeGlyphOffsets(dx: readonly number[]): number[] {
	const offsets: number[] = [];
	let acc = 0;
	for (let i = 0; i < dx.length; i++) {
		offsets.push(acc);
		acc += dx[i];
	}
	return offsets;
}

/** Total advance width covered by a Dx array (the sum of every entry). */
export function totalGlyphAdvance(dx: readonly number[]): number {
	let sum = 0;
	for (const d of dx) {
		sum += d;
	}
	return sum;
}

/**
 * The horizontal offset (from the anchor point GDI's alignment flags
 * establish) at which a run's first glyph should be drawn. GDI applies
 * TA_CENTER / TA_RIGHT to the string's total advance width whether or not a
 * Dx array overrides individual glyph spacing, so a Dx-driven per-glyph draw
 * must apply the same offset before laying out glyph 0.
 */
export function alignmentStartOffset(
	totalWidth: number,
	align: 'left' | 'center' | 'right',
): number {
	if (align === 'center') {
		return -totalWidth / 2;
	}
	if (align === 'right') {
		return -totalWidth;
	}
	return 0;
}

// ---------------------------------------------------------------------------
// Escapement / orientation
// ---------------------------------------------------------------------------

const DEG_TO_RAD = Math.PI / 180;

/**
 * Canvas rotation angle (radians, clockwise-positive) for a GDI escapement
 * or orientation value (tenths of a degree). LOGFONT documents both angles
 * as measured counterclockwise in the device's own coordinate system;
 * Canvas 2D's `rotate()` is clockwise-positive in that same y-down device
 * space, so the sign is flipped to match.
 *
 * This sign convention follows LOGFONT's documented semantics and matches
 * the behaviour of other independent EMF/WMF renderers, but has not been
 * independently re-verified against real Windows GDI output in this
 * repository (no Windows/COM environment is available here to measure it,
 * unlike this package's consumer project).
 */
export function escapementToCanvasRadians(tenthsOfDegree: number): number {
	return -(tenthsOfDegree / 10) * DEG_TO_RAD;
}

// ---------------------------------------------------------------------------
// LOGFONT height sign convention
// ---------------------------------------------------------------------------

/**
 * Approximate ratio between GDI "cell height" (ascent + descent + internal
 * leading) and "character height" (matched directly against the font's em
 * size), used only to resolve a positive (cell-height) `lfHeight`. Derived
 * from common TrueType UI-font metrics (Arial/Calibri-class fonts carry
 * roughly 10-15% internal leading relative to their em square); the exact
 * figure is font-specific and lives in that font's own OS/2 table, which a
 * browser does not expose, so this is a documented approximation rather
 * than an exact conversion.
 */
const CELL_TO_CHAR_HEIGHT_RATIO = 1.15;

/**
 * Resolves a signed LOGFONT `lfHeight` to the unsigned magnitude a CSS
 * `font-size` should target, honouring GDI's documented height-sign
 * convention:
 *
 * - `lfHeight < 0` ("character height"): the font mapper matches
 *   `|lfHeight|` directly against the font's em size, which is exactly what
 *   CSS `font-size` already targets - no adjustment needed, and this case is
 *   exact.
 * - `lfHeight > 0` ("cell height"): ascent + descent + internal leading.
 *   {@link CELL_TO_CHAR_HEIGHT_RATIO} approximates the corresponding
 *   character height; this case is NOT exact.
 * - `lfHeight === 0`: GDI substitutes a device-default size; returns 0 so
 *   callers can apply their own fallback minimum.
 */
export function resolveFontPixelHeight(lfHeight: number): number {
	if (lfHeight === 0) {
		return 0;
	}
	if (lfHeight < 0) {
		return -lfHeight;
	}
	return lfHeight / CELL_TO_CHAR_HEIGHT_RATIO;
}
