import type { GdiRealizedFont } from './gdi-font-engine';
import type { EmfPlusStringFormat } from './emf-types';

// This helper positions individual cmap glyphs; it does not shape clusters.
// Native Arial lam-alef has a smaller advance than the two cmap glyphs, and
// decomposed Latin marks require placement. Keep those and bidi/joining format
// controls on the previous path. Private-use characters retain direct cmap lookup.
const SIMPLE_SCRIPT = /^(?:\p{Script=Latin}|\p{Script=Common}|\p{Co})$/u;
const SHAPING_CHARACTER = /[\p{M}\p{Cf}\p{Emoji_Presentation}]/u;

/** Single-line GDI+ layout, separated from the unresolved grid-fit run compensation. */
export function layoutPlusAlignedString(
	font: GdiRealizedFont,
	codes: readonly number[],
	format: EmfPlusStringFormat,
	x: number, y: number, width: number, height: number,
): { x: number; y: number; dx: number[] } | null {
	const horizontal = format.alignment, vertical = format.lineAlignment;
	if ((!horizontal && !vertical) || horizontal < 0 || horizontal > 2 || vertical < 0 || vertical > 2 ||
		font.gridFit || font.mode !== 'gray' || !font.designAdvance || font.ttf.winDescent === undefined ||
		font.syntheticBold || font.syntheticItalic || (format.flags & 3) ||
		![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0 ||
		codes.some((c) => !Number.isInteger(c) || c < 32 || c > 0x10ffff ||
			(c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029)) return null;
	if (codes.some((c) => {
		const character = String.fromCodePoint(c);
		return !SIMPLE_SCRIPT.test(character) || SHAPING_CHARACTER.test(character) || font.glyphIndex(c) === 0;
	})) return null;
	const em = font.ppem;
	const tracking = format.tracking ?? 1.03;
	const leading = em * (format.leadingMargin ?? 1 / 6);
	const trailing = em * (format.trailingMargin ?? 1 / 6);
	if (![tracking, leading, trailing].every((v) => Number.isFinite(v) && v >= 0)) return null;
	// Italic ink can extend beyond the advance cell. Native default formatting
	// fits that black box before alignment; its extra layout rules are unresolved.
	if (!(format.flags & 4) && ((font.ttf.fsSelection & 1) || (font.ttf.macStyle & 2))) return null;
	const dx = codes.map((c) => font.designAdvance!(font.glyphIndex(c), tracking));
	// GDI+ excludes trailing spaces from alignment unless MeasureTrailingSpaces
	// is requested. They remain in the run so their glyph/advance identity survives.
	let measuredCount = codes.length;
	if (!(format.flags & 0x800)) while (measuredCount > 0 && codes[measuredCount - 1] === 32) measuredCount--;
	const measuredWidth = dx.slice(0, measuredCount).reduce((a, b) => a + b, 0) + leading + trailing;
	// A single line uses the cell height, not hhea's extra line gap. Default
	// formatting adds an eighth-em descent pad; NoFitBlackBox omits it.
	const measuredHeight = em * (font.ttf.winAscent + font.ttf.winDescent) / font.ttf.unitsPerEm +
		((format.flags & 4) ? 0 : em / 8);
	// Wrapping, trimming and clipped/overflowing paragraphs retain the prior
	// path until their native line-layout rules have independent controls.
	if (measuredWidth > width || measuredHeight > height) return null;
	return {
		x: Math.fround(x + horizontal / 2 * (width - measuredWidth) + leading),
		y: Math.fround(y + vertical / 2 * (height - measuredHeight)) + Math.round(em * font.ttf.winAscent / font.ttf.unitsPerEm),
		dx,
	};
}
