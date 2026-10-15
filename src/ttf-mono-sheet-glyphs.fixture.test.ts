/**
 * Native GDI `GetGlyphOutline` of every glyph the monochrome size and style sheets draw (`mono-sheet-glyphs.json.gz`,
 * `MonoSheetGlyphProbe.cs`): the hinted outline (GGO_NATIVE) and the 1-bit bitmap (GGO_BITMAP) of Arial, Times New
 * Roman, Courier New, Segoe UI and Tahoma at 31 sizes (em and cell heights), with the bold, italic and condensed variants
 * of the style sheets. It separates a residual of those sheets into hinting (the outline differs) and scan conversion
 * (it does not). Needs the installed fonts the captures were made with.
 *
 * Every glyph not listed below must stay exact, and the lists may only shrink.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { windowsFonts } from './__fixtures__/gdi-parity-harness';
import { GdiFontCollection } from './gdi-font-engine';

interface Capture { face: string; height: number; width: number; weight: number; italic: boolean; code: number; x: number; y: number; w: number; h: number; data: string; outline: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/mono-sheet-glyphs.json.gz', import.meta.url))).toString());
const fonts = windowsFonts();

/** Bitmaps that still differ from native (sample counts: 175 differing pixels over 140 glyphs). */
const INEXACT_BITMAP = new Set([
	'Arial:-28:400:0:0:97', 'Arial:-72:400:0:0:48', 'Arial:9:400:0:0:38', 'Arial:9:400:0:0:36', 'Arial:-11:400:1:0:81',
	'Arial:-11:400:1:0:51', 'Arial:-11:700:1:0:51', 'Arial:-17:400:1:0:83', 'Times New Roman:-8:400:0:0:64', 'Times New Roman:-9:400:0:0:64',
	'Times New Roman:-10:400:0:0:64', 'Times New Roman:-11:400:0:0:64', 'Times New Roman:-18:400:0:0:97', 'Times New Roman:-72:400:0:0:88',
	'Times New Roman:9:400:0:0:97', 'Times New Roman:9:400:0:0:109', 'Times New Roman:9:400:0:0:103', 'Times New Roman:9:400:0:0:101',
	'Times New Roman:9:400:0:0:110', 'Times New Roman:9:400:0:0:115', 'Times New Roman:9:400:0:0:116', 'Times New Roman:9:400:0:0:118',
	'Times New Roman:9:400:0:0:50', 'Times New Roman:9:400:0:0:65', 'Times New Roman:9:400:0:0:88', 'Times New Roman:9:400:0:0:38',
	'Times New Roman:9:400:0:0:64', 'Times New Roman:9:400:0:0:37', 'Times New Roman:10:400:0:0:64', 'Times New Roman:12:400:0:0:64',
	'Times New Roman:14:400:0:0:64', 'Times New Roman:20:400:0:0:97', 'Times New Roman:23:400:0:0:97', 'Times New Roman:56:400:0:0:87',
	'Times New Roman:-11:700:1:0:83', 'Times New Roman:-11:400:0:12:51', 'Courier New:-9:400:0:0:109', 'Courier New:-9:400:0:0:115',
	'Courier New:-9:400:0:0:37', 'Courier New:-11:400:0:0:97', 'Courier New:-12:400:0:0:97', 'Courier New:-13:400:0:0:97',
	'Courier New:-14:400:0:0:97', 'Courier New:-15:400:0:0:97', 'Courier New:-24:400:0:0:51', 'Courier New:-24:400:0:0:88',
	'Courier New:-36:400:0:0:50', 'Courier New:-72:400:0:0:98', 'Courier New:12:400:0:0:109', 'Courier New:12:400:0:0:115',
	'Courier New:12:400:0:0:37', 'Courier New:14:400:0:0:97', 'Courier New:16:400:0:0:97', 'Courier New:26:400:0:0:38',
	'Courier New:-11:400:1:0:101', 'Courier New:-11:400:0:12:51', 'Courier New:-17:400:0:7:120', 'Segoe UI:-8:400:0:0:109',
	'Segoe UI:-8:400:0:0:117', 'Segoe UI:-8:400:0:0:114', 'Segoe UI:-8:400:0:0:110', 'Segoe UI:-8:400:0:0:115', 'Segoe UI:-8:400:0:0:105',
	'Segoe UI:-13:400:0:0:51', 'Segoe UI:-15:400:0:0:101', 'Segoe UI:-16:400:0:0:101', 'Segoe UI:-20:400:0:0:51', 'Segoe UI:-22:400:0:0:51',
	'Segoe UI:-24:400:0:0:50', 'Segoe UI:-28:400:0:0:50', 'Segoe UI:-32:400:0:0:51', 'Segoe UI:-36:400:0:0:64', 'Segoe UI:-72:400:0:0:97',
	'Segoe UI:-72:400:0:0:98', 'Segoe UI:-72:400:0:0:64', 'Segoe UI:9:400:0:0:97', 'Segoe UI:9:400:0:0:109', 'Segoe UI:9:400:0:0:98',
	'Segoe UI:9:400:0:0:114', 'Segoe UI:9:400:0:0:101', 'Segoe UI:9:400:0:0:102', 'Segoe UI:9:400:0:0:110', 'Segoe UI:9:400:0:0:105',
	'Segoe UI:9:400:0:0:49', 'Segoe UI:9:400:0:0:51', 'Segoe UI:9:400:0:0:65', 'Segoe UI:9:400:0:0:37', 'Segoe UI:10:400:0:0:97',
	'Segoe UI:10:400:0:0:109', 'Segoe UI:10:400:0:0:98', 'Segoe UI:10:400:0:0:114', 'Segoe UI:10:400:0:0:101', 'Segoe UI:10:400:0:0:102',
	'Segoe UI:10:400:0:0:110', 'Segoe UI:10:400:0:0:105', 'Segoe UI:10:400:0:0:49', 'Segoe UI:10:400:0:0:51', 'Segoe UI:10:400:0:0:65',
	'Segoe UI:10:400:0:0:37', 'Segoe UI:18:400:0:0:51', 'Segoe UI:20:400:0:0:101', 'Segoe UI:26:400:0:0:51', 'Segoe UI:30:400:0:0:51',
	'Segoe UI:36:400:0:0:50', 'Segoe UI:44:400:0:0:51', 'Segoe UI:56:400:0:0:36', 'Segoe UI:-11:400:1:0:112', 'Segoe UI:-11:400:0:4:109',
	'Segoe UI:-11:400:0:12:115', 'Segoe UI:-17:400:1:0:83', 'Segoe UI:-17:400:1:0:99', 'Segoe UI:-17:400:1:0:115', 'Tahoma:-8:400:0:0:97',
	'Tahoma:-8:400:0:0:109', 'Tahoma:-8:400:0:0:98', 'Tahoma:-8:400:0:0:114', 'Tahoma:-8:400:0:0:102', 'Tahoma:-8:400:0:0:110',
	'Tahoma:-8:400:0:0:105', 'Tahoma:-16:400:0:0:97', 'Tahoma:9:400:0:0:109', 'Tahoma:9:400:0:0:103', 'Tahoma:9:400:0:0:102',
	'Tahoma:9:400:0:0:110', 'Tahoma:9:400:0:0:36', 'Tahoma:10:400:0:0:97', 'Tahoma:10:400:0:0:109', 'Tahoma:10:400:0:0:98',
	'Tahoma:10:400:0:0:114', 'Tahoma:10:400:0:0:102', 'Tahoma:10:400:0:0:110', 'Tahoma:10:400:0:0:105', 'Tahoma:20:400:0:0:97',
	'Tahoma:56:400:0:0:103', 'Tahoma:-11:400:1:0:51', 'Tahoma:-11:700:1:0:51', 'Tahoma:-11:400:0:12:51', 'Tahoma:-17:400:1:0:83',
	'Tahoma:-17:400:1:0:99', 'Tahoma:-17:400:0:15:51',
]);
/** Upright regular glyphs whose hinted outline still differs (the others are point for point native's). */
const INEXACT_OUTLINE = new Set([
	'Arial:-8:400:0:0:36', 'Arial:-12:400:0:0:36', 'Arial:-14:400:0:0:36', 'Arial:-16:400:0:0:97', 'Arial:-72:400:0:0:36',
	'Arial:9:400:0:0:36', 'Arial:10:400:0:0:36', 'Arial:18:400:0:0:97', 'Arial:20:400:0:0:97', 'Arial:26:400:0:0:36', 'Arial:30:400:0:0:101',
	'Arial:44:400:0:0:36', 'Arial:-17:400:0:15:120', 'Times New Roman:-8:400:0:0:88', 'Times New Roman:-9:400:0:0:88',
	'Times New Roman:-10:400:0:0:87', 'Times New Roman:-10:400:0:0:88', 'Times New Roman:-12:400:0:0:88', 'Times New Roman:-14:400:0:0:87',
	'Times New Roman:-14:400:0:0:88', 'Times New Roman:-15:400:0:0:88', 'Times New Roman:-16:400:0:0:87', 'Times New Roman:-16:400:0:0:88',
	'Times New Roman:-18:400:0:0:88', 'Times New Roman:-20:400:0:0:88', 'Times New Roman:-22:400:0:0:88', 'Times New Roman:-24:400:0:0:87',
	'Times New Roman:-28:400:0:0:88', 'Times New Roman:-32:400:0:0:88', 'Times New Roman:-36:400:0:0:87', 'Times New Roman:-36:400:0:0:88',
	'Times New Roman:-48:400:0:0:88', 'Times New Roman:-72:400:0:0:88', 'Times New Roman:10:400:0:0:88', 'Times New Roman:12:400:0:0:88',
	'Times New Roman:16:400:0:0:87', 'Times New Roman:16:400:0:0:88', 'Times New Roman:18:400:0:0:88', 'Times New Roman:20:400:0:0:88',
	'Times New Roman:26:400:0:0:87', 'Times New Roman:26:400:0:0:88', 'Times New Roman:30:400:0:0:88', 'Times New Roman:36:400:0:0:88',
	'Times New Roman:44:400:0:0:87', 'Courier New:-16:400:0:0:88', 'Courier New:-18:400:0:0:51', 'Courier New:-20:400:0:0:51',
	'Courier New:-22:400:0:0:51', 'Courier New:-24:400:0:0:51', 'Courier New:18:400:0:0:88', 'Courier New:20:400:0:0:51',
	'Courier New:23:400:0:0:51', 'Courier New:26:400:0:0:51', 'Courier New:-11:400:0:12:120', 'Courier New:-17:400:0:0:120',
	'Courier New:-17:400:0:0:51', 'Courier New:-17:300:0:0:120', 'Courier New:-17:300:0:0:51', 'Courier New:-17:100:0:0:120',
	'Courier New:-17:100:0:0:51', 'Courier New:-17:400:0:7:51', 'Courier New:-17:400:0:15:120', 'Courier New:-17:400:0:15:51',
]);

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

	it('draws 6,600 of 6,740 glyph bitmaps exactly and no glyph outside the recorded misses', () => {
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
		expect(exact).toBeGreaterThanOrEqual(6600);
		expect(pixels).toBeLessThanOrEqual(175);
	});

	it('hints the upright regular glyphs to the native outline, 63 misses aside', () => {
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
		expect(identical).toBeGreaterThanOrEqual(5477);
	});
});
