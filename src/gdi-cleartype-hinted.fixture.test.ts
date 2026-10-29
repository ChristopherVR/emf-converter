import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { GdiFontCollection } from './gdi-font-engine';
import { gdiTextCoverage } from './gdi-text-render';

/** Native black-on-white values of the seven ClearType coverage levels 0..6. */
const LEVELS = [255, 219, 182, 144, 102, 58, 0];
const dir = new URL('./__fixtures__/gdi/', import.meta.url);

interface Capture { font: string; glyph: number; rgb: string }
interface HintedFile { width: number; height: number; captures: Capture[] }

/**
 * `gdi-cleartype-hinted.json.gz`: native GDI ClearType (natural quality) of private program-free fonts whose glyphs are
 * the grid-fitted outlines our interpreter produces for the 1,260 glyphs of `gdi-cleartype-compat.json.gz` (Arial, Segoe UI
 * and Tahoma, 30 glyphs at 9 to 24 px; `build-cleartype-hinted-fonts.py`). Nothing is grid-fitted, so a difference is the
 * scan converter or the ClearType filter, never the hinting. Each font carries the `gasp` smoothing and the SCANCTRL /
 * SCANTYPE the real face would give its sizes (S<scan type> smooth|plain; S0 is dropout control off).
 */
describe('GDI ClearType scan conversion of hinted outlines (gdi-cleartype-hinted.json.gz)', () => {
	const file: HintedFile = JSON.parse(gunzipSync(readFileSync(new URL('gdi-cleartype-hinted.json.gz', dir))).toString());
	let fonts: GdiFontCollection;
	beforeAll(() => {
		const index: Record<string, unknown[]> = JSON.parse(readFileSync(new URL('cleartype-hinted-index.json', dir), 'utf8'));
		fonts = new GdiFontCollection(
			Object.keys(index).map((key) => {
				const [scan, smooth] = key.split(' ');
				return readFileSync(new URL(`cleartype-hinted-${scan.toLowerCase()}-${smooth}.ttf`, dir));
			}),
		);
	});

	function mismatches(c: Capture): number {
		const font = fonts.realize({ face: `Parity CT Hinted ${c.font}`, height: -32, width: 0, weight: 400, italic: false, charSet: 1, pitchAndFamily: 0, quality: 6 })!;
		const mask = gdiTextCoverage(font, {
			codes: [0xe000 + c.glyph], glyphIndices: false, x: 8, y: 40, dx: null, dy: null, textAlign: 24, textColor: '#000000',
			bkColor: '#ffffff', bkMode: 1, options: 0, rect: null, matrix: null, underline: false, strikeOut: false,
		});
		const ours = new Uint8Array(file.width * file.height * 3).fill(255);
		if (mask) {
			for (let y = 0; y < mask.height; y++) {
				for (let x = 0; x < mask.width; x++) {
					for (let ch = 0; ch < 3; ch++) {
						ours[((y + mask.y) * file.width + x + mask.x) * 3 + ch] = LEVELS[Math.round((mask.data[(y * mask.width + x) * 3 + ch] * 6) / 255)];
					}
				}
			}
		}
		const native = Buffer.from(c.rgb, 'base64');
		let bad = 0;
		for (let p = 0; p < native.length; p += 3) {
			if (native[p] !== ours[p] || native[p + 1] !== ours[p + 1] || native[p + 2] !== ours[p + 2]) bad++;
		}
		return bad;
	}

	// [glyphs, exact glyphs, differing pixels] per font. What is left: Tahoma 12 e, 13 @, 15 $ and 15 s (smart dropout
	// pixel of a curve) and Segoe UI 12 A (straight edges). Before the native arc walk (cut into monotonic pieces, each
	// walked on differences rounded to 2^s once it spans about 900 units) 1,221 were exact.
	const EXPECTED: Record<string, [number, number, number]> = {
		'S0 smooth': [150, 150, 0],
		'S1 plain': [600, 599, 4],
		'S1 smooth': [90, 90, 0],
		'S5 plain': [270, 266, 9],
		'S5 smooth': [150, 150, 0],
	};
	it('reproduces 1,255 of the 1,260 hinted glyphs exactly and the rest to a few samples', () => {
		const stats: Record<string, [number, number, number]> = {};
		for (const c of file.captures) {
			const bad = mismatches(c);
			const s = (stats[c.font] ??= [0, 0, 0]);
			s[0]++;
			if (bad === 0) s[1]++;
			s[2] += bad;
		}
		for (const [key, want] of Object.entries(EXPECTED)) {
			expect(stats[key][0]).toBe(want[0]);
			expect(stats[key][1]).toBeGreaterThanOrEqual(want[1]);
			expect(stats[key][2]).toBeLessThanOrEqual(want[2]);
		}
		expect(Object.keys(stats).sort()).toEqual(Object.keys(EXPECTED).sort());
	});
});
