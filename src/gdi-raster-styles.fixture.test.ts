import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GdiFontCollection, type RasterRealizedFont } from './gdi-font-engine';
import { fixturePath, windowsFonts } from './__fixtures__/gdi-parity-harness';

/**
 * `text-raster-styles` (RasterStyleProbe.cs, 15 October 2026): seven raster faces (Courier, MS Sans Serif, MS Serif,
 * Small Fonts, System, Terminal, Fixedsys) at seven heights, drawn by GDI into a 32 bpp bitmap as "Hgy. a", "   ", "H",
 * "y" and "g" under all 16 combinations of bold, italic, underline and strike-out, plus "Hgy. a" under lfWidth 4, 7, 12
 * and 20 (plain, bold, italic, underlined), as the black pixels of each bitmap. The converter's glyph bitmaps and
 * decoration bars are composed here the way the text painter places them and compared pixel for pixel.
 *
 * `raster-mapper-widths.json.gz`: GetTextMetrics of the same faces at 21 heights and every lfWidth 1 to 40.
 */
interface StyleCase {
	face: string; height: number; weight: number; italic: number; underline: number; strike: number; width: number; text: string;
	minX: number; minY: number; rows: string[]; tm: { height: number; aveCharWidth: number };
}
const styles: { cases: StyleCase[] } = JSON.parse(gunzipSync(readFileSync(fixturePath('raster-styles.json.gz'))).toString());
const widths: { rows: Array<{ face: string; height: number; width: number; tmHeight: number; tmAveCharWidth: number }> } = JSON.parse(gunzipSync(readFileSync(fixturePath('raster-mapper-widths.json.gz'))).toString());

function extra(): Buffer[] | null {
	const dir = process.env.GDI_FIXTURE_FONTS ?? join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts');
	const paths = ['8514sys.fon', '8514fix.fon'].map((f) => join(dir, f));
	return paths.every((p) => existsSync(p)) ? paths.map((p) => readFileSync(p)) : null;
}
const available = (): boolean => windowsFonts() !== null && extra() !== null;

/** Pixels of one capture the way the converter draws it: glyph bitmaps from (16, 8), then the decoration bars. */
function compose(collection: GdiFontCollection, c: StyleCase): { mine: Set<string>; native: Set<string> } {
	const font = collection.realize({ face: c.face, height: c.height, width: c.width, weight: c.weight, italic: c.italic === 1, charSet: 1, pitchAndFamily: 0, quality: 3 }) as unknown as RasterRealizedFont;
	const mine = new Set<string>();
	let pen = 16;
	for (const ch of c.text) {
		const g = font.glyph(font.glyphIndex(ch.charCodeAt(0)));
		if (g.bitmap) {
			const b = g.bitmap;
			for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) if (b.data[y * b.width + x]) mine.add(`${8 + y},${pen + b.left + x}`);
		}
		pen += g.advance;
	}
	const bar = (position: number, thickness: number, lean: number): void => {
		for (let k = 0; k < thickness; k++) for (let x = 16 + lean; x < pen + lean; x++) mine.add(`${8 + font.ascent - position + k},${x}`);
	};
	if (c.underline) bar(font.underlinePosition, font.underlineThickness, 0);
	if (c.strike) bar(font.strikeoutPosition, font.strikeoutThickness, font.strikeoutShift);
	const native = new Set<string>();
	c.rows.forEach((row, i) => {
		for (let x = 0; x < row.length; x++) if (row[x] === '#') native.add(`${c.minY + i},${c.minX + x}`);
	});
	return { mine, native };
}
const same = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && [...a].every((k) => b.has(k));

describe('raster faces under bold, italic, underline and strike-out', () => {
	it('are the captures of 7 faces x 7 heights x 16 styles (five texts) and 4 widths x 4 styles', () => {
		expect(styles.cases.filter((c) => !c.width)).toHaveLength(3920);
		expect(styles.cases.filter((c) => c.width)).toHaveLength(784);
	});
	it.skipIf(!available())('are reproduced pixel for pixel without lfWidth: 3,920 of 3,920 captures', () => {
		const collection = new GdiFontCollection([...windowsFonts()!, ...extra()!], 'cleartype');
		const bad = styles.cases.filter((c) => !c.width).filter((c) => {
			const { mine, native } = compose(collection, c);
			return !same(mine, native);
		});
		expect(bad.map((c) => `${c.face} ${c.height} ${c.weight} i${c.italic} u${c.underline} s${c.strike} '${c.text}'`)).toEqual([]);
	});
	it.skipIf(!available())('are reproduced under lfWidth for 746 of 784 captures (the other 38 are Terminal, whose native face set is larger than the fixture fonts)', () => {
		const collection = new GdiFontCollection([...windowsFonts()!, ...extra()!], 'cleartype');
		const good = styles.cases.filter((c) => c.width).filter((c) => {
			const { mine, native } = compose(collection, c);
			return same(mine, native);
		});
		expect(good).toHaveLength(746);
	});
	it.skipIf(!available())('bold italic leans one pixel further on a stretched face and loses the smear into a byte boundary', () => {
		const collection = new GdiFontCollection([...windowsFonts()!, ...extra()!], 'cleartype');
		// Courier -33 (the 9x16 face doubled) and MS Sans Serif -11 (unstretched, where the smeared pixel at column 8 of "y" is lost).
		for (const [face, height] of [['Courier', -33], ['MS Sans Serif', -11], ['Small Fonts', -24]] as const) {
			for (const text of ['H', 'y', 'g']) {
				const c = styles.cases.find((k) => k.face === face && k.height === height && k.weight === 700 && k.italic === 1 && !k.underline && !k.strike && !k.width && k.text === text)!;
				const { mine, native } = compose(collection, c);
				expect(same(mine, native), `${face} ${height} ${text}`).toBe(true);
			}
		}
	});
});

describe('raster font mapper under lfWidth', () => {
	it.skipIf(!available())('agrees with the native cell height and average width on 5,477 of 5,880 lfWidth rows (391 of the others are Terminal)', () => {
		const collection = new GdiFontCollection([...windowsFonts()!, ...extra()!], 'cleartype');
		let exact = 0;
		let heightOnly = 0;
		for (const r of widths.rows) {
			const font = collection.realize({ face: r.face, height: r.height, width: r.width, weight: 400, italic: false, charSet: 1, pitchAndFamily: 0, quality: 3 }) as unknown as RasterRealizedFont;
			const h = font.face.pixHeight * font.scale === r.tmHeight;
			heightOnly += h ? 1 : 0;
			exact += h && font.face.avgWidth * font.scaleX === r.tmAveCharWidth ? 1 : 0;
		}
		expect(widths.rows).toHaveLength(5880);
		expect({ exact, heightOnly }).toEqual({ exact: 5477, heightOnly: 5726 });
	});
});
