import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { windowsFonts } from './__fixtures__/gdi-parity-harness';
import { GdiFontCollection } from './gdi-font-engine';
import { gdiTextCoverage } from './gdi-text-render';

interface Capture {
	face: string; style: number; size: number; hint: number; code: number;
	qx?: number; qy?: number; x: number; y: number; w: number; h: number; rgb?: string; gray?: string;
}
const read = (file: string): Capture[] => JSON.parse(gunzipSync(readFileSync(
	new URL(`./__fixtures__/gdi/${file}.json.gz`, import.meta.url),
)).toString('utf8'));
const system = read('courier-gray-phases');
const renamed = read('courier-gray-renamed');
const regular = read('text-real-glyphs').filter(c => c.face === 'Courier New');
const bounds: {
	system: number[]; systemBefore: number[]; regular: number[]; regularBefore: number[]; renamed: number[];
} = JSON.parse(readFileSync(new URL('./__fixtures__/gdi/courier-gray-bounds.json', import.meta.url), 'utf8'));

/** Whole-surface RGB mismatches, including blank margins and native ink. */
function mismatches(fonts: GdiFontCollection, c: Capture, size: number, privateName = false): number {
	const font = fonts.realize({ face: 'Courier New', height: -c.size, width: 0,
		weight: c.style & 1 ? 700 : 400, italic: !!(c.style & 2), charSet: 1, pitchAndFamily: 0,
		quality: 4, gdiPlus: true, ignoreGasp: c.hint === 4, unhinted: c.hint === 4 })!;
	if (privateName) {
		// The native private input differs only in its name table. Clone the
		// parsed metadata so no Windows font bytes need to be bundled and no
		// shared font object is changed. Glyph outlines/programs stay identical.
		Object.defineProperty(font, 'ttf', { value: { ...font.ttf, family: 'Parity Courier' } });
	}
	const mask = gdiTextCoverage(font, { codes: [c.code], glyphIndices: false,
		x: size === 64 ? 8 + (c.qx ?? 0) / 4 : 6, y: size === 64 ? 48 + (c.qy ?? 0) / 4 : 28,
		dx: null, dy: null, textAlign: 24, textColor: '#000000', bkColor: '#ffffff', bkMode: 1,
		options: 0, rect: null, matrix: null, underline: false, strikeOut: false }, { grayLevels: 15 });
	const actual = new Uint8Array(size * size).fill(255);
	const expected = new Uint8Array(size * size).fill(255);
	if (c.gray) expected.set(Buffer.from(c.gray, 'base64'));
	else {
		const rgb = Buffer.from(c.rgb!, 'base64');
		for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
			expected[(c.y + y) * size + c.x + x] = rgb[(y * c.w + x) * 3];
		}
	}
	let outsideInk = 0;
	if (mask) for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) {
		const ink = mask.data[y * mask.width + x];
		if (!ink) continue;
		const px = x + mask.x; const py = y + mask.y;
		if (px < 0 || px >= size || py < 0 || py >= size) { outsideInk++; continue; }
		actual[py * size + px] = 255 - ink;
	}
	expect(outsideInk, 'ink must stay inside the captured surface').toBe(0);
	let count = 0;
	for (let p = 0; p < actual.length; p++) if (actual[p] !== expected[p]) count++;
	return count;
}

describe.skipIf(!windowsFonts())('native Courier New GDI+ grayscale', () => {
	const source = windowsFonts() ?? [];
	const fonts = new GdiFontCollection(source);
	const privateFonts = new GdiFontCollection(source, 'cleartype', { installedFonts: false });
	const measured = source.length ? system.map(c => mismatches(fonts, c, 64)) : [];
	const broad = source.length ? regular.map(c => mismatches(fonts, c, 40)) : [];
	const privateMeasured = source.length ? renamed.map(c => mismatches(privateFonts, c, 64, true)) : [];

	it('pins all 6400 independent size/style/origin captures without losing an exact control', () => {
		expect(system).toHaveLength(6400);
		expect(bounds.system).toHaveLength(system.length);
		const excessive = measured.flatMap((v, i) => v > bounds.system[i] ? [i] : []);
		const lost = measured.flatMap((v, i) => bounds.systemBefore[i] === 0 && v > 0 ? [i] : []);
		expect(excessive).toEqual([]);
		expect(lost).toEqual([]);
		expect(measured.filter(v => v === 0).length).toBeGreaterThanOrEqual(4845);
		expect(bounds.systemBefore.filter(v => v === 0)).toHaveLength(4188);
	});

	it('preserves the gridfit and bold controls and gains regular/italic AntiAlias controls', () => {
		const exact: Record<string, number> = {};
		for (let i = 0; i < system.length; i++) {
			const c = system[i]; const key = `${c.style}/${c.hint}`;
			exact[key] = (exact[key] ?? 0) + (measured[i] === 0 ? 1 : 0);
			if (c.hint === 3 || c.style & 1) expect(measured[i]).toBeLessThanOrEqual(bounds.systemBefore[i]);
		}
		const minimum = { '0/3': 768, '0/4': 337, '1/3': 752, '1/4': 656,
			'2/3': 784, '2/4': 320, '3/3': 678, '3/4': 550 };
		for (const [key, count] of Object.entries(minimum)) expect(exact[key]).toBeGreaterThanOrEqual(count);
	});

	it('pins the broader regular-face corpus, including all 653 newly exact AntiAlias glyphs', () => {
		expect(broad.flatMap((v, i) => v > bounds.regular[i] ? [i] : [])).toEqual([]);
		expect(broad.flatMap((v, i) => bounds.regularBefore[i] === 0 && v > 0 ? [i] : [])).toEqual([]);
		expect(regular.filter((c, i) => c.hint === 4 && broad[i] === 0).length).toBeGreaterThanOrEqual(653);
	});

	it('exposes and bounds the five previously inexact captures that increase slightly', () => {
		const changed = (captures: Capture[], before: number[], after: number[]) => captures.flatMap((c, i) =>
			after[i] > before[i] ? [[c.style, c.size, c.hint, c.code, c.qx ?? 0, c.qy ?? 0, before[i], after[i]]] : []);
		// Historical before/after ceilings document the accepted tradeoffs;
		// the runtime assertions above permit their residuals to shrink.
		expect(changed(system, bounds.systemBefore, bounds.system)).toEqual([
			[2, 14, 4, 56, 3, 2, 25, 27], [2, 16, 4, 56, 0, 0, 26, 27],
		]);
		expect(changed(regular, bounds.regularBefore, bounds.regular)).toEqual([
			[0, 10, 4, 60, 0, 0, 12, 13], [0, 13, 4, 60, 0, 0, 10, 14], [0, 14, 4, 60, 0, 0, 13, 14],
		]);
	});

	it('does not widen a private copy whose family alone has been renamed', () => {
		expect(renamed).toHaveLength(1600);
		expect(privateMeasured.flatMap((v, i) => v > bounds.renamed[i] ? [i] : [])).toEqual([]);
		expect(renamed.filter((c, i) => c.hint === 4 && privateMeasured[i] === 0).length).toBeGreaterThanOrEqual(304);
	});
});
