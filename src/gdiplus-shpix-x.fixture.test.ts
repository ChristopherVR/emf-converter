import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { windowsFonts } from './__fixtures__/gdi-parity-harness';
import { applyTextContrast, textGamma } from './emf-plus-text-image-handlers';
import { GdiFontCollection } from './gdi-font-engine';
import { gdiTextCoverage } from './gdi-text-render';

/**
 * SHPIX along x in GDI+ grayscale text at an identity world scale (round 10, R10-B). Backward-compatible ClearType skips
 * SHPIX except on touched points, but Arial Bold's `y` (and `W`, `k`) shift their stems by +-1/4 pixel with inline
 * SHPIX along x after both IUPs and native applies them: the Arial Bold 40 `y` of `gpx-rec-textcontrast` had arm tops a
 * quarter pixel off (61 pixels per string; found with prefix copies of the glyph program, each drawn natively and
 * compared with the converter instruction by instruction: identical up to the first of the four SHPIX, 62 pixels after).
 * The rule (`HintedSize.plusShpixX`): a call's shifts apply; an inline shift applies to a point touched in one
 * direction, or in both after both IUPs, or to a point touched in neither after both IUPs when the shift is at least half a
 * pixel (Arial Bold `2` 40: 328 pixels to exact); not to smaller shifts of untouched points (Courier New `R` 22, 8/64) nor to a
 * point touched in both before the IUPs (Times New Roman Italic `T` 22, 6/64), where applying them costs pixels in the pinned controls. It is only
 * on at an identity world scale: the uniformly scaled alignment controls (`W` and `AV`) get a few pixels worse otherwise.
 *
 * Everything below is native data: no capture that was exact without the rule is lost.
 */
interface Capture { face: string; size: number; style: number; hint: number; contrast?: number; code: number; qx?: number; qy?: number; rgba?: string; gray?: string }
const load = (name: string): any[] => JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${name}`, import.meta.url))).toString());

function render(fonts: GdiFontCollection, c: Capture, scaled: boolean, x: number, y: number, size: number): Uint8Array {
	const font = fonts.realize({ face: c.face, height: -c.size, width: 0, weight: c.style & 1 ? 700 : 400, italic: !!(c.style & 2), charSet: 1,
		pitchAndFamily: 0, quality: 4, unhinted: c.hint === 4, ignoreGasp: c.hint === 4, gdiPlus: true, unscaledText: !scaled })!;
	const mask = gdiTextCoverage(font, { codes: [c.code], glyphIndices: false, x, y, dx: null, dy: null, textAlign: 24, textColor: '#000000',
		bkColor: '#ffffff', bkMode: 1, options: 0, rect: null, matrix: null, underline: false, strikeOut: false }, { grayLevels: 15 })!;
	applyTextContrast(mask.data, textGamma(c.contrast ?? 0));
	const image = new Uint8Array(size * size).fill(255);
	for (let yy = 0; yy < mask.height; yy++) for (let xx = 0; xx < mask.width; xx++) {
		const py = yy + mask.y, px = xx + mask.x;
		if (py >= 0 && py < size && px >= 0 && px < size) image[py * size + px] = 255 - mask.data[yy * mask.width + xx];
	}
	return image;
}

/** `[exact without the rule, exact with it, lost]` of a set of captures. */
function tally(captures: Capture[], origin: (c: Capture) => [number, number], size: number, expected: (c: Capture) => Uint8Array): [number, number, string[], Record<string, number[]>] {
	const fonts = new GdiFontCollection(windowsFonts()!);
	let before = 0, after = 0;
	const lost: string[] = [];
	const pixels: Record<string, number[]> = {};
	for (const c of captures) {
		if (c.hint === 5) continue;
		const [x, y] = origin(c);
		const native = Buffer.from(expected(c));
		const a = Buffer.from(render(fonts, c, true, x, y, size)).equals(native), b = Buffer.from(render(fonts, c, false, x, y, size)).equals(native);
		const ra = render(fonts, c, true, x, y, size), rb = render(fonts, c, false, x, y, size);
		const k = `${c.face}/${c.style}/${c.size}/${String.fromCharCode(c.code)}/hint${c.hint}`;
		const p = (pixels[k] ??= [0, 0]);
		for (let i = 0; i < native.length; i++) { p[0] += Number(ra[i] !== native[i]); p[1] += Number(rb[i] !== native[i]); }
		before += Number(a); after += Number(b);
		if (a && !b) lost.push(`${c.face}/${c.size}/${String.fromCharCode(c.code)}/hint${c.hint}`);
	}
	return [before, after, lost, pixels];
}

describe.skipIf(!windowsFonts())('SHPIX along x in GDI+ grayscale text', () => {
	it('closes Arial Bold 40 y in the quarter-pixel coverage captures without losing an exact one', () => {
		const coverage: Capture[] = load('text-coverage.json.gz');
		const red = (c: Capture): Uint8Array => { const b = Buffer.from(c.rgba!, 'base64'), o = new Uint8Array(64 * 64); for (let i = 0; i < o.length; i++) o[i] = b[i * 4]; return o; };
		const [before, after, lost, pixels] = tally(coverage, (c) => [8 + (c.qx ?? 0) / 4, 48 + (c.qy ?? 0) / 4], 64, red);
		expect(lost).toEqual([]);
		// No glyph has more differing pixels than before; Arial Bold 40 `y` (32 origins per hint, two contrasts each) drops from
		// 2,056 to 60 differing pixels in both hints (the remainder is the stem foot and the right arm's last pixels), `2` (an untouched point shifted by half a pixel) from 328 to exact.
		expect(Object.entries(pixels).filter(([, v]) => v[1] > v[0])).toEqual([]);
		expect(Object.fromEntries(Object.entries(pixels).filter(([, v]) => v[0] !== v[1]))).toEqual({
			'Arial/1/40/y/hint3': [2056, 60], 'Arial/1/40/y/hint4': [2056, 60], 'Arial/1/40/2/hint3': [328, 0], 'Arial/1/40/2/hint4': [328, 0],
		});
		expect([before, after]).toEqual([2528, 2592]);
	}, 120000);

	it('gains real glyphs and loses none (text-real-glyphs: 9 to 24 ppem, both gray hints)', () => {
		const glyphs: Capture[] = load('text-real-glyphs.json.gz');
		const [before, after, lost] = tally(glyphs, () => [6, 28], 40, (c) => new Uint8Array(Buffer.from(c.gray!, 'base64')));
		expect(lost).toEqual([]);
		expect([before, after]).toEqual([17015, 17410]);
	}, 240000);
});
