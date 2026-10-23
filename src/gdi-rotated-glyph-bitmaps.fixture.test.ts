import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GdiFontCollection, rotationMatrix, type RealizedFont } from './gdi-font-engine';
import { fixturePath, windowsFonts } from './__fixtures__/gdi-parity-harness';
import { HintedSize } from './ttf-hinting';

/**
 * `rotated-glyph-bitmaps-small.json.gz` (TextRotatedPlacementProbe.RunGlyphs, `generate-rotated-bitmaps.ps1`, 16 October 2026):
 * GetGlyphOutline GGO_BITMAP (1-bit) and GGO_NATIVE of "TgEscap0123456789" in Arial, Times New Roman, Tahoma and Courier New
 * at lfHeight -13, -16 and -20 and at 25, 30, 45, 120, 135, 160, 225, 300 and 315 degrees, drawn with an escapement and (Arial
 * -16 only) with a world rotation. A rotated glyph is hinted unrotated at the rounded major ppem and then rotated (see
 * `rotationMatrix`); its bitmap is the native scan conversion of that outline, one 26.6 unit to the right at odd multiples of 45 degrees (see the last test).
 */
interface Row { face: string; lfHeight: number; degrees: number; mode: string; glyph: string; bw: number; bh: number; ox: number; oy: number; rows: string; words: number[] }
const rows: Row[] = JSON.parse(gunzipSync(readFileSync(fixturePath('rotated-glyph-bitmaps-small.json.gz'))).toString());

function nativePixels(r: Row): Set<string> {
	const set = new Set<string>();
	const rowChars = Math.ceil(r.bw / 32) * 8;
	for (let y = 0; y < r.bh; y++) {
		const line = r.rows.slice(y * rowChars, (y + 1) * rowChars);
		for (let x = 0; x < r.bw; x++) {
			if (parseInt(line.slice((x >> 3) * 2, (x >> 3) * 2 + 2), 16) & (0x80 >> (x & 7))) {
				set.add(`${r.ox + x},${r.oy - y}`);
			}
		}
	}
	return set;
}

/** The native outline's points in 1/64 pixel, and whether it has any curve segment (quadratic splines add implied points). */
function nativeOutline(words: number[]): { points: number[][]; curved: boolean } {
	const points: number[][] = [];
	let curved = false;
	for (let i = 0; i < words.length; ) {
		const end = i + words[i] / 4;
		points.push([words[i + 2] / 1024, words[i + 3] / 1024]);
		i += 4;
		while (i < end) {
			curved ||= (words[i] & 0xffff) !== 1;
			const n = (words[i] >>> 16) & 0xffff;
			i++;
			for (let k = 0; k < n; k++, i += 2) {
				points.push([words[i] / 1024, words[i + 1] / 1024]);
			}
		}
	}
	return { points, curved };
}

describe('the capture', () => {
	it('holds 4 faces x 3 heights x 9 angles x 17 glyphs with an escapement and the Arial -16 world rotations', () => {
		expect(rows).toHaveLength(4 * 3 * 9 * 17 + 9 * 17);
		expect(new Set(rows.map((r) => r.face)).size).toBe(4);
	});
});

describe.skipIf(!windowsFonts())('against the native glyphs', () => {
	const monochrome = new GdiFontCollection(windowsFonts() ?? [], 'mono');
	const realize = (collection: GdiFontCollection, r: Row): RealizedFont =>
		collection.realize({ face: r.face, height: r.lfHeight, width: 0, weight: 400, italic: false, charSet: 1, pitchAndFamily: 0, quality: 3 }) as RealizedFont;

	it('hits every point of the native hinted outline of the glyphs without curves, after the rotation', () => {
		const byFace: Record<string, { points: number; hits: number }> = {};
		const cache = new Map<string, HintedSize>();
		for (const r of rows) {
			const outline = nativeOutline(r.words);
			if (outline.curved) {
				continue;
			}
			const font = realize(monochrome, r);
			// The capture draws both modes with the same turn: a world rotation by -degrees, an escapement of +degrees.
			const rad = (-r.degrees * Math.PI) / 180;
			const c = Math.fround(Math.cos(rad));
			const s = Math.fround(Math.sin(rad));
			const rm = rotationMatrix([c, s, -s, c], font.ppem, (font.ttf.headFlags & 8) !== 0)!;
			const key = `${r.face}|${rm.ppem}`;
			let size = cache.get(key);
			if (!size) {
				size = new HintedSize(font.ttf, rm.ppem, rm.ppem, { version: 35, grayscale: false, rotated: true, gdiArithmetic: true });
				cache.set(key, size);
			}
			const g = size.hintGlyph(font.glyphIndex(r.glyph.charCodeAt(0)));
			expect(g.xs.length).toBe(outline.points.length);
			const m = rm.matrix;
			const face = (byFace[r.face] ??= { points: 0, hits: 0 });
			for (let i = 0; i < g.xs.length; i++) {
				const x = Math.round(m[0] * g.xs[i] - m[2] * g.ys[i]);
				const y = Math.round(-(m[1] * g.xs[i] - m[3] * g.ys[i]));
				face.points++;
				if (x === outline.points[i][0] && y === outline.points[i][1]) {
					face.hits++;
				}
			}
		}
		// Courier New's glyphs all have curved serifs; the straight-edged glyphs (T, E, 4, 7, 1) of the others are exact point for point.
		expect(byFace).toEqual({ Arial: { points: 1224, hits: 1224 }, 'Times New Roman': { points: 378, hits: 378 }, Tahoma: { points: 1107, hits: 1107 } });
	});

	it('draws the rotated glyph bitmaps as GDI does', () => {
		const stats: Record<string, { glyphs: number; exact: number; differing: number; ink: number }> = {};
		const f32 = Math.fround;
		for (const r of rows) {
			const font = realize(monochrome, r);
			const rad = (r.degrees * Math.PI) / 180;
			const g = font.glyph(font.glyphIndex(r.glyph.charCodeAt(0)), [f32(Math.cos(rad)), -f32(Math.sin(rad)), f32(Math.sin(rad)), f32(Math.cos(rad))]);
			const native = nativePixels(r);
			const mine = new Set<string>();
			if (g.bitmap) {
				const b = g.bitmap;
				for (let y = 0; y < b.height; y++) {
					for (let x = 0; x < b.width; x++) {
						if (b.data[y * b.width + x]) {
							mine.add(`${b.left + x},${b.top - y}`);
						}
					}
				}
			}
			let differing = 0;
			for (const p of native) if (!mine.has(p)) differing++;
			for (const p of mine) if (!native.has(p)) differing++;
			const key = `${[45, 135, 225, 315].includes(r.degrees) ? 'diagonal' : 'other'} ${r.mode}`;
			const entry = (stats[key] ??= { glyphs: 0, exact: 0, differing: 0, ink: 0 });
			entry.glyphs++;
			entry.ink += native.size;
			entry.differing += differing;
			if (differing === 0) entry.exact++;
		}
		// The native scan converter (`ttf-msscan.ts`) reproduces the rotated glyphs bar three: a diagonal at 45 degrees puts edges
		// through pixel centres, which native resolves as if the outline were one 26.6 unit to the right (see `glyph` in
		// gdi-font-engine.ts). Before round 11: 482 of 816 diagonal escapement glyphs and 49 of 68 world ones were exact.
		expect(stats['diagonal esc'].glyphs).toBe(816);
		expect(stats['diagonal esc'].exact).toBeGreaterThanOrEqual(816);
		expect(stats['diagonal esc'].differing).toBeLessThanOrEqual(0);
		expect(stats['diagonal world'].exact).toBeGreaterThanOrEqual(68);
		expect(stats['diagonal world'].differing).toBeLessThanOrEqual(0);
		expect(stats['other esc'].exact).toBeGreaterThanOrEqual(1017);
		expect(stats['other esc'].differing).toBeLessThanOrEqual(6);
		expect(stats['other world'].exact).toBeGreaterThanOrEqual(85);
		expect(stats['other world'].differing).toBeLessThanOrEqual(0);
	});
});
