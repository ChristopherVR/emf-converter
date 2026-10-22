/**
 * Native GDI `GetGlyphOutline` of every glyph the monochrome size and style sheets draw (`mono-sheet-glyphs.json.gz`,
 * `MonoSheetGlyphProbe.cs`): the hinted outline (GGO_NATIVE) and the 1-bit bitmap (GGO_BITMAP) of Arial, Times New
 * Roman, Courier New, Segoe UI and Tahoma at 31 sizes (em and cell heights), with the bold, italic and condensed variants
 * of the style sheets. It separates a residual of those sheets into hinting (the outline differs) and scan conversion
 * (it does not). Needs the installed fonts the captures were made with.
 *
 * Round 11: the native scan converter (`ttf-msscan.ts`) draws every upright regular bitmap from the native outline, and the exact
 * ISECT, MUL and IUP arithmetic hint every one of them to the native outline, so no glyph is listed any more.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { windowsFonts } from './__fixtures__/gdi-parity-harness';
import { GdiFontCollection } from './gdi-font-engine';

interface Capture { face: string; height: number; width: number; weight: number; italic: boolean; code: number; x: number; y: number; w: number; h: number; data: string; outline: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/mono-sheet-glyphs.json.gz', import.meta.url))).toString());
const fonts = windowsFonts();

/** Bitmaps that still differ from native (6,718 of 6,740 before round 11, the 22 listed in the tests before: now only bold and italic ones, which are not compared). */
const INEXACT_BITMAP = new Set<string>();
/** Upright regular glyphs whose hinted outline still differs (the others are point for point native's). */
const INEXACT_OUTLINE = new Set<string>();

const key = (c: Capture): string => `${c.face}:${c.height}:${c.weight}:${c.italic ? 1 : 0}:${c.width}:${c.code}`;
function nativeOutlinePoints(encoded: string): Set<string> {
	const bytes = Buffer.from(encoded, 'base64');
	const points = new Set<string>();
	for (let o = 0; o < bytes.length;) {
		const size = bytes.readUInt32LE(o);
		points.add(`${bytes.readInt32LE(o + 8) / 1024},${bytes.readInt32LE(o + 12) / 1024}`);
		for (let p = o + 16; p < o + size;) {
			const count = bytes.readUInt16LE(p + 2);
			for (let i = 0; i < count; i++) points.add(`${bytes.readInt32LE(p + 4 + i * 8) / 1024},${bytes.readInt32LE(p + 8 + i * 8) / 1024}`);
			p += 4 + count * 8;
		}
		o += size;
	}
	return points;
}
function nativeInk(c: Capture): Set<string> {
	const ink = new Set<string>();
	const bytes = Buffer.from(c.data, 'base64');
	const stride = Math.ceil(c.w / 32) * 4;
	for (let row = 0; row < c.h; row++) for (let col = 0; col < c.w; col++) {
		if (bytes[row * stride + (col >> 3)] & (128 >> (col & 7))) ink.add(`${c.x + col},${c.y - 1 - row}`);
	}
	return ink;
}

describe.skipIf(!fonts)('native monochrome glyphs of the text size and style sheets', () => {
	const collection = fonts ? new GdiFontCollection(fonts) : null;
	const realize = (c: Capture): any => collection!.realize({ face: c.face, height: c.height, width: c.width, weight: c.weight, italic: c.italic,
		charSet: 1, pitchAndFamily: 0, quality: 3, unhinted: false, gdiPlus: false });

	it('draws every glyph bitmap exactly', () => {
		expect(captures).toHaveLength(6740);
		let exact = 0, pixels = 0;
		for (const c of captures) {
			const font = realize(c);
			const bitmap = font.glyph(font.glyphIndex(c.code)).bitmap;
			const ours = new Set<string>();
			if (bitmap) for (let row = 0; row < bitmap.height; row++) for (let col = 0; col < bitmap.width; col++) {
				if (bitmap.data[row * bitmap.width + col]) ours.add(`${bitmap.left + col},${bitmap.top - 1 - row}`);
			}
			const native = nativeInk(c);
			const differing = [...new Set([...ours, ...native])].filter((p) => ours.has(p) !== native.has(p)).length;
			if (differing === 0) exact++;
			else expect(INEXACT_BITMAP.has(key(c)), key(c)).toBe(true);
			pixels += differing;
		}
		expect(exact).toBeGreaterThanOrEqual(6740);
		expect(pixels).toBeLessThanOrEqual(0);
	});

	it('hints the upright regular glyphs to the native outline', () => {
		let identical = 0, plain = 0;
		for (const c of captures) {
			if (c.italic || c.weight > 400) continue;
			plain++;
			const font = realize(c);
			const outline = font.outline(font.glyphIndex(c.code));
			const native = nativeOutlinePoints(c.outline);
			const ours = new Set<string>(), implied = new Set<string>();
			let start = 0;
			for (const end of outline.endPts) {
				for (let i = start; i <= end; i++) {
					ours.add(`${outline.xs[i]},${outline.ys[i]}`);
					const next = i === end ? start : i + 1;
					if (!outline.onCurve[i] && !outline.onCurve[next]) implied.add(`${(outline.xs[i] + outline.xs[next]) / 2},${(outline.ys[i] + outline.ys[next]) / 2}`);
				}
				start = end + 1;
			}
			const same = ![...native].some((p) => !ours.has(p) && !implied.has(p)) && ![...ours].some((p) => !native.has(p) && !implied.has(p));
			if (same) identical++;
			else expect(INEXACT_OUTLINE.has(key(c)), key(c)).toBe(true);
		}
		expect(plain).toBe(identical + INEXACT_OUTLINE.size);
		expect(identical).toBeGreaterThanOrEqual(5540);
	});
});
