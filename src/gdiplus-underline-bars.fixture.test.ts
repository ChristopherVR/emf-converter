import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { windowsFonts } from './__fixtures__/gdi-parity-harness';
import { GdiFontCollection } from './gdi-font-engine';
import { gdiTextCoverage } from './gdi-text-render';

/**
 * GDI+ TextRenderingHintAntiAlias draws underline and strike-out bars at fractional positions: the converter drew
 * whole device rows (about 170 of the 556 differing pixels of `textx-plus-antialias`). `text-underline.json.gz`
 * (`scripts/gdi-fixtures/UnderlineProbe.cs`, `generate-underline.ps1`) holds 8,000 native DrawString captures of
 * "        x" (Arial, Segoe UI, Times New Roman, Courier New and Tahoma at 20 sizes from 6 to 64 px, underline,
 * underline + bold, underline + italic, strike-out, and both, at 16 origin phases): per case the column profile
 * inside the bar and the ink sums of the bar's first and last three columns.
 *
 * Measured (16 October 2026; the 8,000 captures are of one OS build, gdiplus.dll hashes in `environment-text-underline.json`):
 *  - Vertically a bar is `max(1, round(thickness))` rows thick, centred so that its top edge is
 *    `baseline + position - (thickness - 1) / 2` (underline) or `baseline - position - (thickness - 1) / 2`
 *    (strike-out), where the baseline is the origin plus the rounded cell ascent, raised to the next quarter pixel
 *    after truncation to 1/512 pixel. Every captured column profile agrees.
 *  - The coverage is four sub-scanlines by eight horizontal samples, 32 levels: a value is `round(255 * k / 32)`.
 *  - Bars of two or more rows start at `ceil8(origin + 0.5)` (every capture agrees); their end is within an eighth
 *    pixel of `ceil8(end + 0.5)` in most captures. A bar one row thick has sub-scanline dependent ends that are not
 *    modelled (the converter uses start + 0.3 and end + 0.8).
 */
const json = (name: string): any[] => JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${name}`, import.meta.url))).toString());
const fonts = windowsFonts();

describe.skipIf(!fonts)('GDI+ AntiAlias underline and strike-out bars against native DrawString', () => {
	const collection = new GdiFontCollection(fonts ?? []);
	const captures = json('text-underline.json.gz');

	function bars(c: any): { at: (x: number, y: number) => number; sumColumn: (x: number) => number; y0: number; y1: number } {
		const style = c.style;
		const font = collection.realize({ face: c.face, height: -c.size, width: 0, weight: style & 1 ? 700 : 400, italic: !!(style & 2), charSet: 1, pitchAndFamily: 0, quality: 4, unhinted: true, ignoreGasp: true, gdiPlus: true } as any)!;
		const codes = [...'        x'].map((ch) => ch.codePointAt(0)!);
		const dx = codes.map((ch) => font.advance(font.glyphIndex(ch)) * 1.03);
		const x0 = 10 + c.ox + c.size / 6;
		const y = 8 + c.oy + Math.round((font.ttf.winAscent * c.size) / font.ttf.unitsPerEm);
		const cov = gdiTextCoverage(font, { codes, glyphIndices: false, x: x0, y, dx, dy: null, textAlign: 24, textColor: '#000000', bkColor: '#ffffff', bkMode: 1, options: 0, rect: null, matrix: null, underline: !!(style & 4), strikeOut: !!(style & 8), fractionalDecorations: true }, { decorations: true, grayLevels: 15 })!;
		const data = cov.bars!;
		const at = (x: number, yy: number): number => (x >= cov.x && x < cov.x + cov.width && yy >= cov.y && yy < cov.y + cov.height ? data[(yy - cov.y) * cov.width + (x - cov.x)] : 0);
		return { at, sumColumn: (x) => { let s = 0; for (let yy = cov.y; yy < cov.y + cov.height; yy++) s += at(x, yy); return s; }, y0: cov.y, y1: cov.y + cov.height };
	}

	it('every column profile through the bars is exact', () => {
		let exact = 0;
		for (const c of captures) {
			const b = bars(c);
			const cx = 10 + c.size;
			const native = new Map<number, number>();
			for (const part of c.col.split(' ').filter(Boolean)) { const [y, v] = part.split(':').map(Number); native.set(y, v); }
			let same = true;
			for (let y = b.y0; y < b.y1; y++) if (b.at(cx, y) !== (native.get(y) ?? 0)) same = false;
			for (const y of native.keys()) if (b.at(cx, y) !== native.get(y)) same = false;
			if (same) exact++;
		}
		expect(captures).toHaveLength(8000);
		// The 60 others are Tahoma's synthesised italic (no italic face), a quarter row off at three sizes.
		expect(exact).toBe(7940);
	});

	it('the start of bars two or more rows thick is exact; the other ends are counted', () => {
		const stats = { thickStartExact: 0, thickStart: 0, thickEndExact: 0, thickEnd: 0, thinStartExact: 0, thinStart: 0, thinEndExact: 0, thinEnd: 0 };
		for (const c of captures) {
			const rows = c.col.split(' ').filter(Boolean).map((p: string) => Number(p.split(':')[1]));
			// Underline + strike-out profiles of two bars are not a thickness: only single-bar styles here.
			if (c.style === 12 || rows.length === 0) continue;
			const thickness = rows.reduce((a: number, v: number) => a + v, 0) / 255;
			const thick = thickness > 1.5;
			const b = bars(c);
			const check = (side: 'left' | 'right'): boolean => c[side].split(' ').filter(Boolean).every((p: string) => { const [x, t] = p.split(':').map(Number); return Math.abs(b.sumColumn(x) - t) <= 1; });
			const start = check('left'), end = check('right');
			if (thick) { stats.thickStart++; stats.thickEnd++; if (start) stats.thickStartExact++; if (end) stats.thickEndExact++; }
			else { stats.thinStart++; stats.thinEnd++; if (start) stats.thinStartExact++; if (end) stats.thinEndExact++; }
		}
		expect(stats).toEqual({
			thickStart: 1968, thickStartExact: 1968, thickEnd: 1968, thickEndExact: 1607,
			thinStart: 4432, thinStartExact: 1536, thinEnd: 4432, thinEndExact: 1272,
		});
	});
});
