import { describe, expect, it } from 'vitest';
import { windowsFonts } from './__fixtures__/gdi-parity-harness';
import { GdiFontCollection } from './gdi-font-engine';
import { gdiTextCoverage } from './gdi-text-render';

const fontBytes = windowsFonts();

describe.skipIf(!fontBytes)('GDI+ ClearType glyph overlap', () => {
	it.each([
		{ text: 'oe', size: 12, weight: 700, spacing: 7, x: 19, y: 36, nativeCoverage: [85, 127, 212] },
		{ text: 'oeo', size: 10, weight: 400, spacing: 0, x: 12, y: 37, nativeCoverage: [170, 255, 255] },
	])('matches the native overlapping sample for $text at spacing $spacing', (c) => {
		const fonts = new GdiFontCollection(fontBytes!);
		const font = fonts.realize({
			face: 'Segoe UI', height: -c.size, width: 0, weight: c.weight, italic: false,
			charSet: 1, pitchAndFamily: 0, quality: 6, gdiPlus: true,
		});
		expect(font).not.toBeNull();
		const codes = Array.from(c.text, (character) => character.charCodeAt(0));
		const mask = gdiTextCoverage(font!, {
			codes, glyphIndices: false, x: 12, y: 40, dx: codes.map(() => c.spacing), dy: null, textAlign: 24,
			textColor: '#000000', bkColor: '#ffffff', bkMode: 1, options: 0, rect: null, matrix: null,
			underline: false, strikeOut: false,
		});
		expect(mask).toMatchObject({ channels: 3 });
		const offset = ((c.y - mask!.y) * mask!.width + (c.x - mask!.x)) * 3;
		expect([...mask!.data.slice(offset, offset + 3)]).toEqual(c.nativeCoverage);
	});
});
