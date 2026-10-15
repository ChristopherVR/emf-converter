import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';

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
