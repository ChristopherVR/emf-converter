import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { windowsFonts } from './__fixtures__/gdi-parity-harness';
import { GdiFontCollection } from './gdi-font-engine';
import { gdiTextCoverage } from './gdi-text-render';
import { applyTextContrast, textGamma } from './emf-plus-text-image-handlers';

interface Capture { face: string; size: number; style: number; hint: number; contrast: number; code: number; qx: number; qy: number; rgba: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/text-coverage.json.gz', import.meta.url))).toString());
const clearTypeCaptures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/text-cleartype-coverage.json.gz', import.meta.url))).toString());

const fineCaptures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/text-origin-phases.json.gz', import.meta.url))).toString());

const verticalCaptures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/text-origin-vertical-phases.json.gz', import.meta.url))).toString());

it('matches native ClearType contrast independently on every RGB channel', () => {
	expect(clearTypeCaptures).toHaveLength(1664);
	let mismatched = 0;
	for (let i = 0; i < clearTypeCaptures.length; i++) {
		const c = clearTypeCaptures[i];
		if (c.contrast !== 0) continue;
		const a = Buffer.from(c.rgba, 'base64');
		const b = Buffer.from(clearTypeCaptures[i + 13 * 16].rgba, 'base64');
		const coverage = Uint8ClampedArray.from(a, (v) => 255 - v);
		applyTextContrast(coverage, textGamma(4));
		for (let p = 0; p < coverage.length; p++) {
			if (p % 4 !== 3 && 255 - coverage[p] !== b[p]) mismatched++;
		}
	}
	expect(mismatched).toBe(0);
});

describe.skipIf(!windowsFonts())('GDI+ baseline-controlled ClearType glyphs', () => {
	it('matches the closed fractional-origin RGB controls at both contrasts', () => {
		const fonts = new GdiFontCollection(windowsFonts()!);
		let compared = 0;
		for (const c of [...clearTypeCaptures, ...verticalCaptures.filter(c => c.hint === 5).map(c => ({ ...c, qy: c.qy / 16 }))]) {
			if (c.qx % 2) continue;
			const char = String.fromCharCode(c.code);
			const closed = c.face === 'Segoe UI' && !'ak4'.includes(char) ||
				c.face === 'Times New Roman' && 'IS4'.includes(char) ||
				c.size === 16 && 'v02'.includes(char) || c.size === 40 && 'I4'.includes(char);
			if (!closed) continue;
			const font = fonts.realize({ face: c.face, height: -c.size, width: 0, weight: c.style & 1 ? 700 : 400,
				italic: !!(c.style & 2), charSet: 1, pitchAndFamily: 0, quality: 6, gdiPlus: true })!;
			const mask = gdiTextCoverage(font, { codes: [c.code], glyphIndices: false, x: 8 + c.qx / 4, y: 48 + c.qy / 4, dx: null, dy: null,
				textAlign: 24, textColor: '#000000', bkColor: '#ffffff', bkMode: 1, options: 0, rect: null, matrix: null,
				underline: false, strikeOut: false })!;
			applyTextContrast(mask.data, textGamma(c.contrast));
			const rgba = new Uint8ClampedArray(64 * 64 * 4).fill(255);
			for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) {
				const o = ((y + mask.y) * 64 + x + mask.x) * 4;
				for (let ch = 0; ch < 3; ch++) rgba[o + ch] = 255 - mask.data[(y * mask.width + x) * 3 + ch];
			}
			expect(Buffer.from(rgba).equals(Buffer.from(c.rgba, 'base64')), JSON.stringify({ ...c, rgba: undefined })).toBe(true);
			compared++;
		}
		expect(compared).toBe(672);
	});
});

it('matches native text contrast independently of glyph geometry at every captured origin', () => {
	expect(captures).toHaveLength(3328);
	const shades = new Set<number>();
	let mismatched = 0;
	for (let i = 0; i < captures.length; i++) {
		const c = captures[i];
		if (c.contrast !== 0) continue;
		const a = Buffer.from(c.rgba, 'base64');
		// Captures are grouped by font, hint, contrast, character, x and y.
		const b = Buffer.from(captures[i + 13 * 16].rgba, 'base64');
		const coverage = new Uint8ClampedArray(a.length / 4);
		for (let p = 0; p < coverage.length; p++) {
			shades.add(a[p * 4]);
			coverage[p] = 255 - a[p * 4];
		}
		applyTextContrast(coverage, textGamma(4));
		for (let p = 0; p < coverage.length; p++) if (255 - coverage[p] !== b[p * 4]) mismatched++;
	}
	expect([...shades].sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => i * 17));
	expect(mismatched).toBe(0);
});

describe.skipIf(!windowsFonts())('GDI+ baseline-controlled grayscale glyphs', () => {
	it('matches the closed fractional-origin controls under both contrast settings', () => {
		const fonts = new GdiFontCollection(windowsFonts()!);
		let compared = 0;
		for (const c of captures) {

			const char = String.fromCharCode(c.code);
			const closed = c.face === 'Segoe UI' ||
				(c.face === 'Times New Roman' && 'IvSy028'.includes(char)) ||
				(c.size === 40 && 'IgaS0148'.includes(char)) ||
				(c.size === 16 && (c.hint === 3 ? char !== 'y' : 'Igay048'.includes(char)));
			if (!closed) continue;
			const font = fonts.realize({ face: c.face, height: -c.size, width: 0, weight: c.style & 1 ? 700 : 400,
				italic: !!(c.style & 2), charSet: 1, pitchAndFamily: 0, quality: 4, unhinted: c.hint === 4,
				ignoreGasp: c.hint === 4, gdiPlus: true })!;
			const mask = gdiTextCoverage(font, { codes: [c.code], glyphIndices: false, x: 8 + c.qx / 4, y: 48 + c.qy / 4, dx: null, dy: null,
				textAlign: 24, textColor: '#000000', bkColor: '#ffffff', bkMode: 1, options: 0, rect: null, matrix: null,
				underline: false, strikeOut: false }, { grayLevels: 15 })!;
			applyTextContrast(mask.data, textGamma(c.contrast));
			const rgba = new Uint8ClampedArray(64 * 64 * 4).fill(255);
			for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) {
				const o = ((y + mask.y) * 64 + x + mask.x) * 4;
				rgba[o] = rgba[o + 1] = rgba[o + 2] = 255 - mask.data[y * mask.width + x];
			}
			expect(Buffer.from(rgba).equals(Buffer.from(c.rgba, 'base64')), JSON.stringify({ ...c, rgba: undefined })).toBe(true);
			compared++;
		}
		expect(compared).toBe(2400);
	});
	it.each([['x', fineCaptures], ['y', verticalCaptures]] as const)('matches independent grayscale %s phases at every 1/64-pixel origin', (_axis, records) => {
		expect(records).toHaveLength(2304);
		const fonts = new GdiFontCollection(windowsFonts()!);
		let compared = 0;
		for (const c of records) {

			if (c.hint === 5) continue;
			const char = String.fromCharCode(c.code);
			const closed = c.face === 'Segoe UI' ||
				(c.face === 'Times New Roman' && 'Iv'.includes(char)) ||
				(c.size === 40 && 'Ig'.includes(char)) ||
				(c.size === 16);
			if (!closed) continue;
			const font = fonts.realize({ face: c.face, height: -c.size, width: 0, weight: c.style & 1 ? 700 : 400,
				italic: !!(c.style & 2), charSet: 1, pitchAndFamily: 0, quality: 4, unhinted: c.hint === 4,
				ignoreGasp: c.hint === 4, gdiPlus: true })!;
			const mask = gdiTextCoverage(font, { codes: [c.code], glyphIndices: false, x: 8 + c.qx / 64, y: 48 + c.qy / 64, dx: null, dy: null,
				textAlign: 24, textColor: '#000000', bkColor: '#ffffff', bkMode: 1, options: 0, rect: null, matrix: null,
				underline: false, strikeOut: false }, { grayLevels: 15 })!;
			applyTextContrast(mask.data, textGamma(c.contrast));
			const rgba = new Uint8ClampedArray(64 * 64 * 4).fill(255);
			for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) {
				const o = ((y + mask.y) * 64 + x + mask.x) * 4;
				rgba[o] = rgba[o + 1] = rgba[o + 2] = 255 - mask.data[y * mask.width + x];
			}
			expect(Buffer.from(rgba).equals(Buffer.from(c.rgba, 'base64')), JSON.stringify({ ...c, rgba: undefined })).toBe(true);
			compared++;
		}
		expect(compared).toBe(1280);
	});
});
