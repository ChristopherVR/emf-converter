import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { windowsFonts } from './__fixtures__/gdi-parity-harness';
import { GdiFontCollection } from './gdi-font-engine';
import { gdiTextCoverage } from './gdi-text-render';

/**
 * Native GDI ExtTextOut ClearType at default quality (backward-compatible "bi-level" advance widths) against natural
 * quality, for private fonts whose glyph programs place edges with one known instruction (generator
 * `scripts/gdi-fixtures/build-cleartype-width-fonts.py`, probe `GdiClearTypeWidthProbe.cs`, mode
 * `text-gdi-cleartype-width`, captures `gdi-cleartype-width.json.gz`, 8,418 glyph captures at 16 ppem).
 *
 * What the captures show (round 8):
 * - the advance phantom point sits at the black-and-white width for every instruction anchored to it (set `phantom`,
 *   `pp2`, `flags`: MIRP, MDRP, MSIRP and ALIGNRP from pp2 land at BW - outline distance);
 * - a stem the program sets with MIRP or MSIRP between two glyph points moves rigidly (both edges, and the points that
 *   follow them) by (the pair's centre) * (BW / natural advance - 1), the stem keeping its hinted width (sets `sweep`,
 *   `centre`, `types`, `kinds`, `corners`, `follow`, `rects`, `h`): MDAP, MDRP, MIAP and a MIRP from a phantom point do
 *   not shift anything, and neither does the same glyph at natural quality.
 */
interface Capture { set: string; size: number; quality: number; index: number; width: number; x: number; y: number; w: number; h: number; rgb: string }
interface SetInfo { set: string; file: string; family: string; count: number }

const LEVELS = [255, 219, 182, 144, 102, 58, 0];
const W = 48;
const H = 64;
const dir = new URL('./__fixtures__/gdi/', import.meta.url);
const sets: SetInfo[] = JSON.parse(readFileSync(new URL('ctw-sets.json', dir), 'utf8'));
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('gdi-cleartype-width.json.gz', dir))).toString());
const fonts = new GdiFontCollection(sets.map((s) => readFileSync(new URL(s.file, dir))));

function render(info: SetInfo, quality: number, index: number): Uint8Array {
	const font = fonts.realize({ face: info.family, height: -16, width: 0, weight: 400, italic: false, charSet: 1, pitchAndFamily: 0, quality })!;
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

function exactCount(info: SetInfo, quality: number): { exact: number; total: number } {
	let exact = 0;
	let total = 0;
	for (const c of captures.filter((x) => x.set === info.set && x.quality === quality)) {
		const native = new Uint8Array(W * H * 3).fill(255);
		const rgb = Buffer.from(c.rgb, 'base64');
		for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) for (let i = 0; i < 3; i++) native[((y + c.y) * W + x + c.x) * 3 + i] = rgb[(y * c.w + x) * 3 + i];
		const ours = render(info, quality, c.index);
		total++;
		if (native.every((v, i) => v === ours[i])) exact++;
	}
	return { exact, total };
}

/**
 * Exact glyph captures per set at natural quality and at default quality (compatible widths), of the 357 + 585 + 1,632 + 324
 * + 288 + 36 + 196 + 27 + 112 + 544 + 108 glyphs (8,418 captures). Before the width mode default quality was exact for 139, 90,
 * 904, 66, 7, 12, 123, 8, 9, 282 and 36 of them (1,676 of 4,209). What is left at either quality is not the width mode: the
 * `phantom`, `flags` and `follow` bars that a program moves past four pixels are clipped by native at the fourth pixel (24
 * samples; ours are not), and 72 `types` glyphs (MIRP from pp1 then MDRP, rounded) have a faint extra top sample row in native
 * at both qualities. The `rects` and `h` rest is a stem whose second edge is set by MIRP from a point that is not in the stem.
 */
const EXPECTED: Record<string, [number, number]> = {
	phantom: [278, 308],
	types: [513, 513],
	sweep: [1632, 1632],
	kinds: [281, 290],
	corners: [284, 284],
	rects: [36, 36],
	centre: [196, 196],
	h: [27, 27],
	follow: [98, 97],
	pp2: [544, 544],
	flags: [51, 70],
};

describe('GDI ClearType compatible widths on private fonts (gdi-cleartype-width.json.gz)', () => {
	it('captured every glyph of every set at both qualities', () => {
		expect(sets.map((s) => s.set)).toEqual(Object.keys(EXPECTED));
		for (const s of sets) {
			expect(captures.filter((c) => c.set === s.set && c.quality === 5)).toHaveLength(s.count);
			expect(captures.filter((c) => c.set === s.set && c.quality === 6)).toHaveLength(s.count);
		}
	});

	for (const s of sets) {
		it(`reproduces the ${s.set} set`, () => {
			const natural = exactCount(s, 6);
			const compat = exactCount(s, 5);
			expect(natural.total).toBe(s.count);
			expect([natural.exact, compat.exact]).toEqual(EXPECTED[s.set]);
		});
	}
});

interface CompatCapture { face: string; size: number; quality: number; code: number; x: number; y: number; w: number; h: number; rgb: string }

/**
 * The Windows fonts: `gdi-cleartype-compat.json.gz` holds 30 glyphs of Arial, Segoe UI and Tahoma at 14 sizes (9 to 24 px)
 * drawn by native GDI at default and at natural ClearType quality. A glyph counts as exact when every pixel matches; the
 * differing-pixel total is over all 420 glyphs of a face and quality. Default quality before round 8: Arial 81 exact and 6,296
 * differing pixels, Segoe UI 71 and 4,686, Tahoma 56 and 5,112 (the converter then scaled the natural outline by BW / natural
 * advance); natural quality 320 and 1,768, 306 and 2,221, 368 and 248 (it did not report GETINFO bit 18).
 */
describe.skipIf(!windowsFonts())('GDI ClearType compatible widths on the Windows fonts (gdi-cleartype-compat.json.gz)', () => {
	const compat: CompatCapture[] = JSON.parse(gunzipSync(readFileSync(new URL('gdi-cleartype-compat.json.gz', dir))).toString());
	let system: GdiFontCollection;
	beforeAll(() => {
		system = new GdiFontCollection(windowsFonts()!);
	});
	const CW = 56;
	const CH = 64;

	function stats(face: string, quality: number): { exact: number; total: number; pixels: number } {
		let exact = 0;
		let pixels = 0;
		const list = compat.filter((c) => c.face === face && c.quality === quality);
		for (const c of list) {
			const font = system.realize({ face, height: -c.size, width: 0, weight: 400, italic: false, charSet: 1, pitchAndFamily: 0, quality })!;
			const mask = gdiTextCoverage(font, {
				codes: [c.code], glyphIndices: false, x: 8, y: 40, dx: null, dy: null, textAlign: 24, textColor: '#000000',
				bkColor: '#ffffff', bkMode: 1, options: 0, rect: null, matrix: null, underline: false, strikeOut: false,
			});
			const ours = new Uint8Array(CW * CH * 3).fill(255);
			if (mask) {
				for (let y = 0; y < mask.height; y++) {
					for (let x = 0; x < mask.width; x++) {
						for (let ch = 0; ch < 3; ch++) ours[((y + mask.y) * CW + x + mask.x) * 3 + ch] = LEVELS[Math.round((mask.data[(y * mask.width + x) * 3 + ch] * 6) / 255)];
					}
				}
			}
			const native = new Uint8Array(CW * CH * 3).fill(255);
			const rgb = Buffer.from(c.rgb, 'base64');
			for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) for (let i = 0; i < 3; i++) native[((y + c.y) * CW + x + c.x) * 3 + i] = rgb[(y * c.w + x) * 3 + i];
			let bad = 0;
			for (let p = 0; p < native.length; p += 3) if (native[p] !== ours[p] || native[p + 1] !== ours[p + 1] || native[p + 2] !== ours[p + 2]) bad++;
			pixels += bad;
			if (bad === 0) exact++;
		}
		return { exact, total: list.length, pixels };
	}

	const PINS: Record<string, { natural: [number, number]; default: [number, number] }> = {
		Arial: { natural: [411, 12], default: [403, 42] },
		'Segoe UI': { natural: [396, 42], default: [400, 36] },
		Tahoma: { natural: [406, 27], default: [401, 42] },
	};
	for (const [face, pin] of Object.entries(PINS)) {
		it(`${face}: natural quality exact for ${pin.natural[0]} of 420 glyphs, default quality for ${pin.default[0]}`, () => {
			const natural = stats(face, 6);
			const compatible = stats(face, 5);
			expect(natural.total).toBe(420);
			expect(natural.exact).toBeGreaterThanOrEqual(pin.natural[0]);
			expect(natural.pixels).toBeLessThanOrEqual(pin.natural[1]);
			expect(compatible.exact).toBeGreaterThanOrEqual(pin.default[0]);
			expect(compatible.pixels).toBeLessThanOrEqual(pin.default[1]);
		});
	}
});
