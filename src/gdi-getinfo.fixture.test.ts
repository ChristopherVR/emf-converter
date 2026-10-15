import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { GdiFontCollection } from './gdi-font-engine';
import { gdiTextCoverage } from './gdi-text-render';

/** Native GETINFO answers (gdi-getinfo.json.gz, build-getinfo-font.py): a glyph's stem is one row taller when the bit is set. */
interface Capture { api: string; mode: number; size: number; index: number; h: number }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/gdi-getinfo.json.gz', import.meta.url))).toString());
const TESTS = ['always', 'never', 'v>=35', 'v>=36', 'v>=37', 'v>=38', 'v>=39', 'v>=40', 'v>=41', 'rotated', 'stretched', 'variations', 'vphantom', 'gray', 'cleartype', 'compat', 'vlcd', 'bgr', 'subpx', 'symsmooth', 'graycl'];
const set = (api: string, mode: number, size: number, test: string): boolean => {
	const base = captures.find((c) => c.api === api && c.mode === mode && c.size === size && c.index === 1)!.h;
	return captures.find((c) => c.api === api && c.mode === mode && c.size === size && c.index === TESTS.indexOf(test))!.h > base;
};

it('reports native GETINFO bits: ClearType and compatible widths belong to GDI qualities 0 and 5 only, natural quality drops the compatible bit', () => {
	for (const size of [14, 20]) {
		expect(set('gdi', 5, size, 'cleartype')).toBe(true);
		expect(set('gdi', 5, size, 'compat')).toBe(true);
		expect(set('gdi', 0, size, 'compat')).toBe(true);
		expect(set('gdi', 6, size, 'cleartype')).toBe(true);
		expect(set('gdi', 6, size, 'compat')).toBe(false);
		expect(set('gdiplus', 5, size, 'cleartype')).toBe(true);
		expect(set('gdiplus', 5, size, 'compat')).toBe(false);
		expect(set('gdi', 4, size, 'gray')).toBe(size === 20);
		expect(set('gdi', 5, size, 'gray')).toBe(false);
		// GDI's own ClearType reports symmetric smoothing (bit 18, selector 2048); GDI+ does not. The converter does not
		// report it: switching it on made the Arial controls worse (11,327 to 14,955 differing pixels at ClearType quality).
		expect(set('gdi', 5, size, 'symsmooth')).toBe(true);
		expect(set('gdiplus', 5, size, 'symsmooth')).toBe(false);
		for (const mode of [0, 5, 6]) {
			expect(set('gdi', mode, size, 'always')).toBe(true);
			expect(set('gdi', mode, size, 'v>=40')).toBe(true);
			expect(set('gdi', mode, size, 'v>=41')).toBe(true);
		}
	}
});

it('reports GDI+ grayscale text as gray ClearType: ClearType and selector 4096 set, grayscale (selector 32) not', () => {
	for (const size of [14, 20]) {
		// AntiAlias runs the ClearType interpreter at every size.
		expect(set('gdiplus', 4, size, 'cleartype')).toBe(true);
		expect(set('gdiplus', 4, size, 'graycl')).toBe(true);
		expect(set('gdiplus', 4, size, 'gray')).toBe(false);
		expect(set('gdiplus', 4, size, 'compat')).toBe(false);
		// ClearTypeGridFit says ClearType alone.
		expect(set('gdiplus', 5, size, 'cleartype')).toBe(true);
		expect(set('gdiplus', 5, size, 'graycl')).toBe(false);
		// The two single-bit hints run no ClearType interpreter.
		expect(set('gdiplus', 1, size, 'cleartype')).toBe(false);
		expect(set('gdiplus', 2, size, 'always')).toBe(false);
	}
	// AntiAliasGridFit follows `gasp`: the bi-level rasteriser at 14 px, the gray ClearType interpreter at 20 px.
	expect(set('gdiplus', 3, 14, 'cleartype')).toBe(false);
	expect(set('gdiplus', 3, 20, 'cleartype')).toBe(true);
	expect(set('gdiplus', 3, 20, 'graycl')).toBe(true);
	expect(set('gdiplus', 3, 20, 'gray')).toBe(false);
});

it("the engine's GETINFO answers reproduce every native bit of the GDI+ grayscale and ClearType interpreters except the version above 40, variations and vertical phantom points", () => {
	const fonts = new GdiFontCollection([readFileSync(new URL('./__fixtures__/gdi/getinfo-a.ttf', import.meta.url))]);
	const mismatches: Record<string, string[]> = {};
	// AntiAlias (4) at both sizes, AntiAliasGridFit (3) and ClearTypeGridFit (5) at 20 px.
	for (const [mode, size] of [[4, 14], [4, 20], [3, 20], [5, 20]]) {
		const font = fonts.realize({ face: 'Parity GetInfo A', height: -size, width: 0, weight: 400, italic: false, charSet: 1, pitchAndFamily: 0,
			quality: mode === 5 ? 6 : 4, unhinted: mode === 4, ignoreGasp: mode === 4, gdiPlus: true })!;
		const wrong: string[] = [];
		TESTS.forEach((name, index) => {
			const native = captures.find((c) => c.api === 'gdiplus' && c.mode === mode && c.size === size && c.index === index)!;
			const mask = gdiTextCoverage(font, { codes: [0xe000 + index], glyphIndices: false, x: 8, y: 48, dx: null, dy: null, textAlign: 24,
				textColor: '#000000', bkColor: '#ffffff', bkMode: 1, options: 0, rect: null, matrix: null, underline: false, strikeOut: false },
			mode === 5 ? undefined : { grayLevels: 15 })!;
			const rows = new Set<number>();
			const channels = mode === 5 ? 3 : 1;
			for (let y = 0; y < mask.height; y++) {
				for (let x = 0; x < mask.width; x++) {
					for (let k = 0; k < channels; k++) if (mask.data[(y * mask.width + x) * channels + k] > 0) rows.add(y + mask.y);
				}
			}
			if (rows.size !== native.h) wrong.push(name);
		});
		mismatches[`${mode}/${size}`] = wrong;
	}
	expect(mismatches).toEqual({
		'4/14': ['v>=41', 'variations', 'vphantom'], '4/20': ['v>=41', 'variations', 'vphantom'], '3/20': ['v>=41', 'variations', 'vphantom'],
		'5/20': ['v>=41', 'variations', 'vphantom'],
	});
});
