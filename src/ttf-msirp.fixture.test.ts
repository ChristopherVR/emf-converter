import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GdiFontCollection } from './gdi-font-engine';
import { gdiTextCoverage } from './gdi-text-render';
import { HintedSize } from './ttf-hinting';

// Private diagnostic font (scripts/gdi-fixtures/build-msirp-fonts.py): one tall stem whose program moves the top left
// point in y, or the top right point in x, with MSIRP to the outline distance plus a literal amount, at the default
// CVT cut-in (17/16 pixel) or at one the program sets with SCVTCI. Native ClearType moves the point by any literal
// distance along y (cut-in or not, up to 8 pixels, down 2) and along x only within 1/16 of the cut-in.
const KINDS: string[] = ['control'];
const DELTAS: Record<string, number> = { control: 0 };
const add = (name: string, delta: number): void => { KINDS.push(name); DELTAS[name] = delta; };
for (const d of [0, 16, 32, 48, 64, 68, 72, 80, 96, 128, 192, 256]) add(`y+${d}`, d);
for (const d of [-16, -48, -128]) add(`y${d}`, d);
for (const d of [16, 64, 256]) add(`y+${d} cutin0`, d);
for (const d of [128, 256, 512]) add(`y+${d} cutin512`, d);
for (const d of [16, 32, 64, 128, 256]) add(`x+${d}`, d);
for (const d of [32, 128]) add(`x+${d} cutin0`, d);
for (const [d, c] of [[16, 512], [32, 512], [64, 512], [64, 1024], [128, 1024], [256, 1024]]) add(`x+${d} cutin${c}`, d);

interface Capture { layout: string; index: number; size: number; hint: number; x: number; y: number; w: number; h: number; rgb: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/text-msirp.json.gz', import.meta.url))).toString());
const fontFile = readFileSync(new URL('./__fixtures__/gdi/msirp-a.ttf', import.meta.url));
const fonts = new GdiFontCollection([fontFile]);

function nativeRgb(c: Capture): Uint8Array {
	const out = new Uint8Array(64 * 64 * 3).fill(255);
	const src = Buffer.from(c.rgb, 'base64');
	for (let y = 0; y < c.h; y++) {
		for (let x = 0; x < c.w; x++) {
			for (let k = 0; k < 3; k++) {
				out[((c.y + y) * 64 + c.x + x) * 3 + k] = src[(y * c.w + x) * 3 + k];
			}
		}
	}
	return out;
}

function ours(c: Capture): Uint8Array {
	const font = fonts.realize({ face: 'Parity Msirp A', height: -c.size, width: 0, weight: 400, italic: false, charSet: 1, pitchAndFamily: 0,
		quality: 6, gdiPlus: true })!;
	const mask = gdiTextCoverage(font, { codes: [0xe000 + c.index], glyphIndices: false, x: 8, y: 48, dx: null, dy: null, textAlign: 24,
		textColor: '#000000', bkColor: '#ffffff', bkMode: 1, options: 0, rect: null, matrix: null, underline: false, strikeOut: false })!;
	const rgb = new Uint8Array(64 * 64 * 3).fill(255);
	for (let y = 0; y < mask.height; y++) {
		for (let x = 0; x < mask.width; x++) {
			for (let k = 0; k < 3; k++) {
				rgb[((y + mask.y) * 64 + x + mask.x) * 3 + k] = 255 - mask.data[(y * mask.width + x) * 3 + k];
			}
		}
	}
	return rgb;
}

const inkRows = (rgb: Uint8Array): number => {
	let rows = 0;
	for (let y = 0; y < 64; y++) {
		for (let i = 0; i < 192; i++) {
			if (rgb[y * 192 + i] !== 255) {
				rows++;
				break;
			}
		}
	}
	return rows;
};

describe('MSIRP distances in the private diagnostic font', () => {
	const clearType = captures.filter((c) => c.hint === 5);

	it('holds 35 kinds of program at 16 ppem through two hints', () => {
		expect(captures).toHaveLength(35 * 2);
	});

	// The top left point lands at the outline height (8.594 px) plus the literal amount whatever the cut-in: the rows
	// with ink are those whose centre lies below the top left point, the thin wedge of the slanted top edge included
	// (native draws it although it is narrower than a sample, a dropout this converter keeps off for such a font).
	it('moves the point along y by the literal distance, with no cut-in, in every y kind', () => {
		for (const c of clearType) {
			const kind = KINDS[c.index];
			if (!kind.startsWith('y')) continue;
			const top = 8.594 + DELTAS[kind] / 64;
			expect(inkRows(nativeRgb(c)), kind).toBe(Math.max(9, Math.floor(top + 0.5)));
		}
	});

	it('moves the point in the engine by the literal distance in every y kind', () => {
		const ttf = (fonts.realize({ face: 'Parity Msirp A', height: -16, width: 0, weight: 400, italic: false, charSet: 1, pitchAndFamily: 0,
			quality: 6, gdiPlus: true }) as any).ttf;
		const size = new HintedSize(ttf, 16, 16, { version: 40, grayscale: false, clearType: true, compatibleWidths: false });
		KINDS.forEach((kind, i) => {
			if (!kind.startsWith('y')) return;
			const glyph = size.hintGlyph(ttf.glyphIndex(0xe000 + i));
			expect(glyph.ys[1] / 64, kind).toBeCloseTo(8.594 + DELTAS[kind] / 64, 2);
		});
	});

	// Along x the cut-in decides, at 1/16 of its value: a stem grows by the amount only when the amount is within it.
	it('is exact for every x kind and the controls but one', () => {
		const wrong: string[] = [];
		for (const c of clearType) {
			const kind = KINDS[c.index];
			if (kind.startsWith('y')) continue;
			const native = nativeRgb(c);
			const mine = ours(c);
			if (!native.every((v, i) => v === mine[i])) wrong.push(kind);
		}
		// A 1.25 px stem under a 1/2 px cut-in: native draws one sample more (129 levels of ink) than the 1.25 px edge gives us; unexplained.
		expect(wrong).toEqual(['x+16 cutin512']);
	});
});
