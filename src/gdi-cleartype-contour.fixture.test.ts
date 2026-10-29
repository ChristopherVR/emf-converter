import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GdiFontCollection } from './gdi-font-engine';
import { gdiTextCoverage } from './gdi-text-render';

/**
 * Native GDI ExtTextOut ClearType at default (compatible widths) and natural quality of 1,020 private glyphs at 16 ppem
 * (`build-cleartype-contour-fonts.py`, mode `text-gdi-cleartype-contour`): a stem set by a black MIRP between an outer and an
 * inner contour (a ring and an eight-point oval whose other points IUP[x] interpolates) or on one contour (a bar), with and
 * without an x SHPIX on the outer edge before the MIRPs, advances 6 to 7 px in 1/16 steps, stem widths 1, 1.1875 and 1.5 px.
 * All of them are exact at both qualities: neither the contour pairing nor a SHPIX before the MIRP changes the width-mode
 * shift (round 12; the Arial 12 and 13 px residual came from y SHPIX after IUP[y], see the parity log).
 */
interface Capture { set: string; index: number; quality: number; x: number; y: number; w: number; h: number; rgb: string }

const LEVELS = [255, 219, 182, 144, 102, 58, 0];
const W = 48;
const H = 64;
const dir = new URL('./__fixtures__/gdi/', import.meta.url);
const sets: { family: string; count: number }[] = JSON.parse(readFileSync(new URL('ctk-sets.json', dir), 'utf8'));
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('ctk-contour.json.gz', dir))).toString());
const fonts = new GdiFontCollection([readFileSync(new URL('ctk-contour.ttf', dir))]);

function ours(index: number, quality: number): Uint8Array {
	const font = fonts.realize({ face: sets[0].family, height: -16, width: 0, weight: 400, italic: false, charSet: 1, pitchAndFamily: 0, quality })!;
	const mask = gdiTextCoverage(font, {
		codes: [0xe000 + index], glyphIndices: false, x: 8, y: 48, dx: null, dy: null, textAlign: 24, textColor: '#000000',
		bkColor: '#ffffff', bkMode: 1, options: 0, rect: null, matrix: null, underline: false, strikeOut: false,
	});
	const out = new Uint8Array(W * H * 3).fill(255);
	if (mask) {
		for (let y = 0; y < mask.height; y++) {
			for (let x = 0; x < mask.width; x++) {
				for (let ch = 0; ch < 3; ch++) out[((y + mask.y) * W + x + mask.x) * 3 + ch] = LEVELS[Math.round((mask.data[(y * mask.width + x) * 3 + ch] * 6) / 255)];
			}
		}
	}
	return out;
}

describe('GDI ClearType outer/inner contour stems (ctk-contour.json.gz)', () => {
	for (const quality of [5, 6]) {
		it(`reproduces every capture at quality ${quality}`, () => {
			const list = captures.filter((c) => c.quality === quality);
			expect(list).toHaveLength(sets[0].count);
			let exact = 0;
			for (const c of list) {
				const native = new Uint8Array(W * H * 3).fill(255);
				const rgb = Buffer.from(c.rgb, 'base64');
				for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) for (let i = 0; i < 3; i++) native[((y + c.y) * W + x + c.x) * 3 + i] = rgb[(y * c.w + x) * 3 + i];
				const mine = ours(c.index, quality);
				if (native.every((v, i) => v === mine[i])) exact++;
			}
			expect(exact).toBe(list.length);
		});
	}
});
