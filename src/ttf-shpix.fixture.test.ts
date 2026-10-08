import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GdiFontCollection } from './gdi-font-engine';
import { gdiTextCoverage } from './gdi-text-render';

// Private diagnostic fonts (scripts/gdi-fixtures/build-shpix-fonts.py): one stem whose program shifts it by
// half a pixel with SHPIX, issued from 19 kinds of code, in four function-number layouts. The native
// ClearType captures show which shifts Windows applies along x.
const KINDS = ['control', 'gated', 'gated-mismatch', 'plain', 'rsonly', 'exact', 'bare', 'mixed', 'wrap-plain', 'wrap-gated',
	'inline-range', 'inline', 'prefixed', 'tailrs', 'strict', 'barempp', 'noelse', 'tailpop', 'exacttail'];
/** Kinds whose shift native ignores at the sizes below: the two generic per-size helpers, called directly or nested. */
const IGNORED = new Set(['plain', 'exact', 'wrap-plain']);
/** Kinds that do not fire at all at these sizes or modes. */
const NEVER = new Set(['control', 'gated-mismatch']);

interface Capture { layout: string; index: number; size: number; hint: number; x: number; y: number; w: number; h: number; rgb: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/text-shpix.json.gz', import.meta.url))).toString());
const fonts = new GdiFontCollection(['a', 'b', 'c', 'd'].map((l) => readFileSync(new URL(`./__fixtures__/gdi/shpix-${l}.ttf`, import.meta.url))));

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
	const font = fonts.realize({ face: 'Parity Shpix ' + c.layout.toUpperCase(), height: -c.size, width: 0, weight: 400, italic: false,
		charSet: 1, pitchAndFamily: 0, quality: 6, gdiPlus: true })!;
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

describe('ClearType x SHPIX shifts of the private diagnostic fonts', () => {
	const clearType = captures.filter((c) => c.hint === 5);

	it('holds four layouts, three sizes and nineteen kinds of code', () => {
		expect(clearType).toHaveLength(4 * 3 * 19);
		expect(captures).toHaveLength(2 * clearType.length);
	});

	it('is exact for every capture', () => {
		const wrong: string[] = [];
		for (const c of clearType) {
			const native = nativeRgb(c);
			const mine = ours(c);
			if (!native.every((v, i) => v === mine[i])) wrong.push(`${c.layout} ${KINDS[c.index]} ${c.size}px`);
		}
		expect(wrong).toEqual([]);
	});

	// At 16 ppem the stem spans 12 to 13 px (subpixel 36); the filter spills into subpixel 35, and half a pixel moves the first ink to subpixel 36.
	it('shifts the stem by half a pixel except for the generic per-size helpers', () => {
		for (const c of clearType.filter((c) => c.size === 16)) {
			const kind = KINDS[c.index];
			const native = nativeRgb(c);
			// First ink column of a middle row, in 1/3-pixel subpixels.
			const row = c.y + (c.h >> 1);
			let first = -1;
			for (let x = 0; x < 64 * 3 && first < 0; x++) if (native[row * 64 * 3 + x] !== 255) first = x;
			const shifted = first >= 36;
			expect(shifted, `${c.layout} ${kind}`).toBe(!IGNORED.has(kind) && !NEVER.has(kind));
		}
	});
});
