/**
 * Font-shorthand parsing and font-free text width estimates, shared by the
 * SVG recorder and the pure-JavaScript rasteriser (which have no font
 * engine to measure or draw glyphs with).
 *
 * @module text-estimate
 */

/** Parses the Canvas font shorthand the replay code produces. */
export function parseFont(font: string): { style: string; weight: string; size: number; family: string } {
	const m = /^\s*((?:(?:italic|oblique|normal|bold|bolder|lighter|small-caps|\d{3})\s+)*)([\d.]+)px\s+(.+)$/i.exec(font);
	if (!m) {
		return { style: '', weight: '', size: 10, family: 'sans-serif' };
	}
	const tokens = m[1].trim().split(/\s+/).filter(Boolean);
	const style = tokens.find((t) => /^(italic|oblique)$/i.test(t)) ?? '';
	const weight = tokens.find((t) => /^(bold|bolder|lighter|\d{3})$/i.test(t)) ?? '';
	return { style, weight, size: parseFloat(m[2]), family: m[3].trim() };
}

/** Rough advance-width estimate used only when no canvas exists to measure text. */
export function estimateTextWidth(text: string, size: number): number {
	let em = 0;
	for (const ch of text) {
		if (/[ilj.,;:'!|]/.test(ch)) {
			em += 0.28;
		} else if (/[mwMW@]/.test(ch)) {
			em += 0.83;
		} else if (/[A-Z0-9]/.test(ch)) {
			em += 0.64;
		} else if (ch === ' ') {
			em += 0.28;
		} else if (ch.charCodeAt(0) > 0x2e7f) {
			em += 1;
		} else {
			em += 0.52;
		}
	}
	return em * size;
}

/**
 * A generous device-independent box (in the text's own user space) that
 * contains every glyph pixel `fillText(text, x, y)` can paint in ANY
 * reasonable font of the given size: the estimated advance is widened by
 * half again plus one em (real fonts, bold and wide faces included, stay
 * within it), and the vertical extent reaches past any ascender, accent or
 * descender for the given `textBaseline`. Used to mark the pixels a font-
 * less rasteriser cannot know.
 */
export function textInkBox(
	text: string,
	x: number,
	y: number,
	font: string,
	textAlign: string,
	textBaseline: string,
	maxWidth?: number,
): { x0: number; y0: number; x1: number; y1: number } {
	const size = parseFont(font).size;
	let w = estimateTextWidth(text, size) * 1.5 + size;
	if (maxWidth !== undefined && Number.isFinite(maxWidth) && maxWidth > 0) {
		w = Math.min(w, maxWidth + size);
	}
	const pad = size * 0.3;
	let x0: number;
	let x1: number;
	if (textAlign === 'center') {
		x0 = x - w / 2;
		x1 = x + w / 2;
	} else if (textAlign === 'right' || textAlign === 'end') {
		x0 = x - w;
		x1 = x + pad;
	} else {
		x0 = x - pad;
		x1 = x + w;
	}
	let up: number;
	let down: number;
	switch (textBaseline) {
		case 'top':
		case 'hanging':
			up = 0.3;
			down = 1.5;
			break;
		case 'middle':
			up = 0.9;
			down = 0.9;
			break;
		case 'bottom':
		case 'ideographic':
			up = 1.5;
			down = 0.3;
			break;
		default:
			up = 1.2;
			down = 0.5;
	}
	return { x0, y0: y - up * size, x1, y1: y + down * size };
}
