import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { windowsFonts } from './__fixtures__/gdi-parity-harness';
import { GdiFontCollection } from './gdi-font-engine';
import { gdiTextCoverage } from './gdi-text-render';

/**
 * GDI+ DrawString without grid fitting advances a glyph by its `hmtx` advance times the format's tracking (1.03)
 * *rounded to font units*, not by the 26.6 linear advance the converter used (Arial `l`: 455 x 1.03 = 468.65 -> 469
 * units = 3.6641 px at 16 px, not 3.6613). `text-singlebit-advances.json.gz` (`SingleBitAdvanceProbe.cs`,
 * `generate-singlebit-advances.ps1`) draws 24 or 25 repeated glyphs (`l`, `I` and the digits) of Arial, Segoe UI and
 * Times New Roman at 12, 13, 16 and 20 px with SingleBitPerPixel at 10 + fx (fx in sixteenths), where every glyph's
 * pixel column shows when the accumulated pen position crosses a pixel boundary. The ink columns of the 256 bar-like
 * strings of Arial and Segoe UI are reproduced, where the unrounded advance gets a column wrong in the later glyphs of
 * some of them (the accumulated error is 0.003 px per `l`): `textx-plus-singlebit` 125 -> 30 and `textx-plus-antialias`
 * 556 -> 42 differing pixels with the cleartype and underline work of this round.
 */
const captures: any[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/text-singlebit-advances.json.gz', import.meta.url))).toString());
const fonts = windowsFonts();

describe.skipIf(!fonts)('GDI+ SingleBitPerPixel advance accumulation against native DrawString', () => {
	const collection = new GdiFontCollection(fonts ?? []);

	function columns(c: any, rounded: boolean): string {
		const font = collection.realize({ face: c.face, height: -c.size, width: 0, weight: 400, italic: false, charSet: 1, pitchAndFamily: 0, quality: 3, unhinted: true, gdiPlus: true } as any)!;
		const codes = [...c.text].map((ch) => ch.codePointAt(0)!);
		const dx = codes.map((ch) => (rounded ? font.designAdvance!(font.glyphIndex(ch), 1.03) : font.advance(font.glyphIndex(ch)) * 1.03));
		const ascent = Math.round((c.size * font.ttf.winAscent) / font.ttf.unitsPerEm);
		const cov = gdiTextCoverage(font, { codes, glyphIndices: false, x: 10 + c.fx + c.size / 6, y: 6 + ascent, dx, dy: null, textAlign: 24, textColor: '#000000', bkColor: '#ffffff', bkMode: 1, options: 0, rect: null, matrix: null, underline: false, strikeOut: false }, { grayLevels: 15 })!;
		const out: number[] = [];
		for (let x = 0; x < cov.width; x++) {
			let any = false;
			for (let y = 0; y < cov.height; y++) if (cov.data[y * cov.width + x] > 0) any = true;
			if (any) out.push(cov.x + x);
		}
		return out.join(' ');
	}

	// Times New Roman's serifs and the hinted digits differ in glyph shape (columns), not in advance: only the bar-like
	// glyphs of Arial and Segoe UI are compared.
	const bars = () => captures.filter((c) => c.face !== 'Times New Roman' && (c.text[0] === 'l' || c.text[0] === 'I'));

	it('the ink columns of every Arial and Segoe UI `l` and `I` string are native with design-unit advances', () => {
		expect(captures).toHaveLength(576);
		expect(bars()).toHaveLength(256);
		let exact = 0;
		for (const c of bars()) if (columns(c, true) === c.cols) exact++;
		expect(exact).toBe(256);
	});

	it('the unrounded 26.6 advance gets a third of them wrong', () => {
		let exact = 0;
		for (const c of bars()) if (columns(c, false) === c.cols) exact++;
		expect(exact).toBeLessThan(200);
	});
});
