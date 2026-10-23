import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { applyTextContrast, textGamma } from './emf-plus-text-image-handlers';
import { GdiFontCollection } from './gdi-font-engine';
import { gdiTextCoverage } from './gdi-text-render';

// Private diagnostic font (scripts/gdi-fixtures/build-shpix-order-fonts.py): three stems, 16 px, whose programs raise each
// stem top by a pixel with SHPIX along y after touching it (MDAP in y, MDAP in x, IP in y, IP in x, or not at all), before
// or after IUP[x] and IUP[y], inline, in an ordinary function, with one SLOOP, or through the two generic per-size helper
// functions Monotype fonts define (`MPPEM >= lo and MPPEM <= hi: SHPIX`, `MPPEM == ppem: SHPIX`).
//
// Native (16 October 2026, `text-shpix-order.json.gz`, both gray ClearType hints): an inline or ordinary function's SHPIX
// always moves the stem top, touched or not, before or after the IUPs. A helper function's SHPIX moves it only when the
// point is touched in y, and stops once IUP[y] has run (IUP[x] alone does not stop it). The converter follows all of this
// except the shifts of points never touched in y (six kinds, pinned below): Arial, Times New Roman and Courier New programs
// rely on the touched-in-y rule at other sizes, and dropping it loses more glyphs than it gains (see docs/parity-log.md).
const KINDS = ['ipy-inline', 'mdap-inline', 'ipx-ipy-inline', 'ipy-call', 'mdapx-inline', 'ipy-loop', 'untouched-inline', 'ipx-only-inline',
	'pre-ipy-inline', 'ipy-iupx-inline', 'ipy-iupy-inline', 'pre-untouched-inline', 'iupy-untouched-inline', 'iupx-untouched-inline',
	'post-touched-helper', 'post-untouched-helper', 'pre-touched-helper', 'pre-untouched-helper', 'post-touched-helper-eq',
	'post-touched-helper-iupy', 'post-touched-helper-iupx', 'call-first-of-three'];
/** Kinds whose stem tops are one pixel higher (row 38, not 39) in the native capture. */
const RAISED = new Set(['ipy-inline', 'mdap-inline', 'ipx-ipy-inline', 'ipy-call', 'mdapx-inline', 'ipy-loop', 'untouched-inline', 'ipx-only-inline',
	'pre-ipy-inline', 'ipy-iupx-inline', 'ipy-iupy-inline', 'pre-untouched-inline', 'iupy-untouched-inline', 'iupx-untouched-inline',
	'pre-touched-helper', 'post-touched-helper-iupx']);
/** Raised natively but not by the converter: the SHPIX of a point never touched in y. */
const OPEN = new Set(['mdapx-inline', 'untouched-inline', 'ipx-only-inline', 'pre-untouched-inline', 'iupy-untouched-inline', 'iupx-untouched-inline']);

interface Capture { layout: string; index: number; size: number; hint: number; x: number; y: number; w: number; h: number; rgb: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/text-shpix-order.json.gz', import.meta.url))).toString());
const fonts = new GdiFontCollection([readFileSync(new URL('./__fixtures__/gdi/shpix-order-a.ttf', import.meta.url))]);

function nativeRgb(c: Capture): Uint8Array {
	const out = new Uint8Array(64 * 64 * 3).fill(255);
	const src = Buffer.from(c.rgb, 'base64');
	for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) for (let k = 0; k < 3; k++) out[((c.y + y) * 64 + c.x + x) * 3 + k] = src[(y * c.w + x) * 3 + k];
	return out;
}

function ours(c: Capture): Uint8Array {
	const gray = c.hint !== 5;
	const font = fonts.realize({ face: 'Parity Shpix Order A', height: -c.size, width: 0, weight: 400, italic: false, charSet: 1, pitchAndFamily: 0,
		quality: gray ? 4 : 6, gdiPlus: true })!;
	const mask = gdiTextCoverage(font, { codes: [0xe000 + c.index], glyphIndices: false, x: 8, y: 48, dx: null, dy: null, textAlign: 24,
		textColor: '#000000', bkColor: '#ffffff', bkMode: 1, options: 0, rect: null, matrix: null, underline: false, strikeOut: false }, gray ? { grayLevels: 15 } : undefined)!;
	if (gray) applyTextContrast(mask.data, textGamma(0));
	const rgb = new Uint8Array(64 * 64 * 3).fill(255);
	const channels = gray ? 1 : 3;
	for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) for (let k = 0; k < 3; k++) rgb[((y + mask.y) * 64 + x + mask.x) * 3 + k] = 255 - mask.data[(y * mask.width + x) * channels + (gray ? 0 : k)];
	return rgb;
}

/** First ink row of each stem. */
function tops(rgb: Uint8Array): number[] {
	return [[8, 12], [12, 16], [16, 22]].map(([a, b]) => {
		for (let y = 0; y < 64; y++) for (let x = a; x < b; x++) if (rgb[(y * 64 + x) * 3] !== 255) return y;
		return -1;
	});
}

describe('SHPIX along y after touches and IUPs in the private diagnostic font', () => {
	it('holds 22 kinds of program at 16 ppem through two hints', () => {
		expect(captures).toHaveLength(22 * 2);
	});

	it('raises the stem tops natively exactly for the kinds listed', () => {
		for (const c of captures) {
			const kind = KINDS[c.index];
			const rows = tops(nativeRgb(c));
			if (kind === 'call-first-of-three') {
				expect(rows, `${kind} hint ${c.hint}`).toEqual([38, 39, 39]);
				continue;
			}
			expect(rows, `${kind} hint ${c.hint}`).toEqual(Array(3).fill(RAISED.has(kind) ? 38 : 39));
		}
	});

	it('is exact for every capture except the six kinds whose shifted points were never touched in y', () => {
		const wrong = new Set<string>();
		for (const c of captures) {
			const native = nativeRgb(c);
			const mine = ours(c);
			if (!native.every((v, i) => v === mine[i])) wrong.add(KINDS[c.index]);
		}
		expect([...wrong].sort()).toEqual([...OPEN].sort());
	});
});
