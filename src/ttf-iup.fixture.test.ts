import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { applyTextContrast, textGamma } from './emf-plus-text-image-handlers';
import { GdiFontCollection } from './gdi-font-engine';
import { gdiTextCoverage } from './gdi-text-render';

// Private diagnostic font (scripts/gdi-fixtures/build-iup-fonts.py): one tall stem whose program touches the top
// point in y, runs IUP[x] and/or IUP[y] or not, and then moves the top point up by a pixel with DELTAP, SHPIX or
// MSIRP. The native captures show which moves still count: DELTAP in y stops once IUP[y] has run (IUP[x] alone
// does not stop it), on points touched in y only; SHPIX and MSIRP are not stopped by either IUP.
const KINDS = ['control', 'pre-deltap-touched', 'pre-deltap-untouched', 'post-both-deltap', 'post-iupy-deltap', 'post-iupx-deltap',
	'post-both-deltap-untouched', 'pre-shpix', 'post-both-shpix', 'pre-msirp', 'post-both-msirp', 'post-both-deltap-moved',
	'post-both-deltap-ip', 'post-both-deltap-rounded', 'post-iupy-only-deltap-ip'];
/** Kinds whose top point ends up a pixel higher at 16 ppem, as native draws them. */
const MOVED = new Set(['pre-deltap-touched', 'post-iupx-deltap', 'pre-shpix', 'post-both-shpix', 'pre-msirp', 'post-both-msirp']);

interface Capture { layout: string; index: number; size: number; hint: number; x: number; y: number; w: number; h: number; rgb: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/text-iup.json.gz', import.meta.url))).toString());
const fonts = new GdiFontCollection([readFileSync(new URL('./__fixtures__/gdi/iup-a.ttf', import.meta.url))]);

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
	const gray = c.hint !== 5;
	const font = fonts.realize({ face: 'Parity Iup A', height: -c.size, width: 0, weight: 400, italic: false, charSet: 1, pitchAndFamily: 0,
		quality: gray ? 4 : 6, gdiPlus: true })!;
	const mask = gdiTextCoverage(font, { codes: [0xe000 + c.index], glyphIndices: false, x: 8, y: 48, dx: null, dy: null, textAlign: 24,
		textColor: '#000000', bkColor: '#ffffff', bkMode: 1, options: 0, rect: null, matrix: null, underline: false, strikeOut: false }, gray ? { grayLevels: 15 } : undefined)!;
	if (gray) applyTextContrast(mask.data, textGamma(0));
	const rgb = new Uint8Array(64 * 64 * 3).fill(255);
	const channels = gray ? 1 : 3;
	for (let y = 0; y < mask.height; y++) {
		for (let x = 0; x < mask.width; x++) {
			for (let k = 0; k < 3; k++) {
				rgb[((y + mask.y) * 64 + x + mask.x) * 3 + k] = 255 - mask.data[(y * mask.width + x) * channels + (gray ? 0 : k)];
			}
		}
	}
	return rgb;
}

const topRow = (rgb: Uint8Array): number => {
	for (let i = 0; i < rgb.length; i++) if (rgb[i] !== 255) return Math.floor(i / (64 * 3));
	return -1;
};

describe('ClearType and grayscale point moves around IUP in the private diagnostic font', () => {
	it('holds fifteen kinds of program at 16 ppem through two hints', () => {
		expect(captures).toHaveLength(15 * 2);
	});

	it('is exact for every ClearType and grid-fitted grayscale capture', () => {
		const wrong: string[] = [];
		for (const c of captures) {
			const native = nativeRgb(c);
			const mine = ours(c);
			if (!native.every((v, i) => v === mine[i])) wrong.push(`${KINDS[c.index]} ${c.size}px hint ${c.hint}`);
		}
		expect(wrong).toEqual([]);
	});

	it('raises the top row at 16 ppem only for the moves native honours', () => {
		for (const c of captures) {
			const kind = KINDS[c.index];
			if (kind.includes('-ip')) continue;   // interpolation moves more than the top point
			expect(topRow(nativeRgb(c)), `${kind} hint ${c.hint}`).toBe(MOVED.has(kind) ? 38 : 39);
		}
	});
});
