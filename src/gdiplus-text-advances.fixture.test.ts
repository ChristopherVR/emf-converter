import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { windowsFonts } from './__fixtures__/gdi-parity-harness';
import { GdiFontCollection, type GdiRealizedFont } from './gdi-font-engine';

/**
 * Native GDI+ DrawString advances (`text-advances.json.gz`, `TextAdvanceProbe.cs`, `generate-text-advances.ps1`): every
 * printable ASCII glyph of Arial, Arial Bold, Times New Roman and Tahoma at 12, 16, 20 and 40 px, drawn once and in a run
 * of 30 copies, with the default StringFormat and GenericTypographic, under AntiAliasGridFit and ClearTypeGridFit. The
 * mean advance (last ink column of 30 copies minus that of one, over 29) is a whole number for the glyphs whose gaps are
 * all alike; the rest, where GDI+ redistributes the run's grid-fit width against its ideal width, are not compared.
 *
 * Findings (16 October 2026): ClearTypeGridFit spaces a glyph by its ClearType interpreter's phantom-point advance rounded
 * to a whole pixel (`ctGridAdvance`): 1,230 of 1,230 whole-number glyphs of the default format and 856 of 858 of
 * GenericTypographic, where the GDI widths of `advance` (hdmx, or the GDI interpreter) match 1,058 and 733. AntiAliasGridFit
 * keeps the GDI widths, but from GDI's own interpreter run, not the ClearType one the glyph shapes come from (Arial Bold 40:
 * W 39 and I 10, where the ClearType phantom points give 38 and 11): 1,085 of 1,093 and 807 of 819.
 */
interface Capture { face: string; style: number; size: number; hint: number; typo: boolean; code: number; one: [number, number]; run: [number, number] }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/text-advances.json.gz', import.meta.url))).toString());

describe.skipIf(!windowsFonts())('native GDI+ DrawString advances', () => {
	const fonts = new GdiFontCollection(windowsFonts() ?? []);
	const realized = new Map<string, GdiRealizedFont>();
	const font = (c: Capture): GdiRealizedFont => {
		const key = `${c.face}|${c.style}|${c.size}|${c.hint}`;
		if (!realized.has(key)) {
			realized.set(key, fonts.realize({ face: c.face, height: -c.size, width: 0, weight: c.style & 1 ? 700 : 400, italic: false, charSet: 1,
				pitchAndFamily: 0, quality: c.hint === 5 ? 6 : 4, gdiPlus: true })!);
		}
		return realized.get(key)!;
	};
	/** Captures whose glyphs advance by one whole number of pixels, with that number. */
	const whole = (hint: number, typo: boolean): Array<{ c: Capture; advance: number }> => captures.flatMap((c) => {
		if (c.hint !== hint || c.typo !== typo || c.one[1] < 0) return [];
		const mean = (c.run[1] - c.one[1]) / 29;
		return Math.abs(mean - Math.round(mean)) <= 0.05 ? [{ c, advance: Math.round(mean) }] : [];
	});
	const count = (list: Array<{ c: Capture; advance: number }>, advance: (c: Capture) => number): number => list.filter((x) => advance(x.c) === x.advance).length;
	const label = (c: Capture): string => `${c.face}${c.style ? ' bold' : ''} ${c.size} ${String.fromCharCode(c.code)}`;

	it('holds 4 faces, 4 sizes, 2 hints and 2 formats of 94 glyphs', () => {
		expect(captures).toHaveLength(4 * 4 * 2 * 2 * 94);
	});

	it('ClearTypeGridFit advances each default-format glyph by its ClearType phantom-point advance rounded: every whole-number glyph', () => {
		const list = whole(5, false);
		expect(list).toHaveLength(1230);
		const wrong = list.filter((x) => font(x.c).ctGridAdvance!(font(x.c).glyphIndex(x.c.code)) !== x.advance).map((x) => label(x.c));
		expect(wrong).toEqual([]);
		// The GDI widths the layout used before are right for 1,058.
		expect(count(list, (c) => font(c).advance(font(c).glyphIndex(c.code)))).toBe(1058);
	});

	it('the same advances place the GenericTypographic glyphs except Arial 12 m and Times New Roman 16 d', () => {
		const list = whole(5, true);
		expect(list).toHaveLength(858);
		const wrong = list.filter((x) => font(x.c).ctGridAdvance!(font(x.c).glyphIndex(x.c.code)) !== x.advance).map((x) => label(x.c));
		// Arial 12 m (native 10, 11.125 hinted) and Times New Roman 16 d (native 8, 9 hinted): runs the grid-fit compensation shortens.
		expect(wrong).toEqual(['Arial 12 m', 'Times New Roman 16 d']);
		expect(count(list, (c) => font(c).advance(font(c).glyphIndex(c.code)))).toBe(733);
	});

	it('AntiAliasGridFit advances by the widths of GDI\'s own interpreter', () => {
		expect(count(whole(3, false), (c) => font(c).advance(font(c).glyphIndex(c.code)))).toBe(1085);
		expect(whole(3, false)).toHaveLength(1093);
		expect(count(whole(3, true), (c) => font(c).advance(font(c).glyphIndex(c.code)))).toBe(807);
		expect(whole(3, true)).toHaveLength(819);
	});
});
