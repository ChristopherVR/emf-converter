/**
 * Native GetGlyphOutline(GGO_BITMAP, GGO_NATIVE) of the Times New Roman Italic glyphs `<` `=` `>` `~` `j` `4` at 17 em heights
 * (`times-italic-glyphs.json.gz`, `GlyphSheetProbe.cs`, `generate-ms-sans-glyphs.ps1`). Needs the installed font.
 *
 * In this font the `hmtx` left side bearing of `<` and `>` is 150 against an xMin of 39 and 37, so the left phantom point
 * starts at -111 and -113 font units (-0.6 pixel at 11 px). Native GGO_NATIVE shows it from the first instruction on
 * (instruction-prefix variants of `>` at 11 and 17 px, 58 prefixes each, all equal to the converter's after the change; not
 * committed: the fonts derive from a Microsoft font): GDI's interpreter leaves that point where scaling put it and rounds the
 * advance, `pp2 = pp1 + round(width)`, where the converter used to round both points to the grid. The glyphs came out 25 to
 * 60/64 pixel too far right and the right apex of `>` a pixel too wide. Measured on a
 * capture of all printable ASCII of the face at these sizes (1,615 glyphs): 1,573 bitmaps exact before, 1,586 after, the
 * `<` `=` `>` `~` rows 2 to 10 pixels off at 11 to 20 px before.
 *
 * Still off, and pinned as such: `j` (not the phantom point: the instruction-prefix variants of `j` at 15 px agree with native up to
 * instruction 37, an ALIGNRP along a diagonal projection vector, after which one point is 1 to 2 units apart; 99 pixels, 70 of
 * them at 72 px) and `<` at 20 px (10 pixels, its right apex a pixel narrower than native's).
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { windowsFonts } from './__fixtures__/gdi-parity-harness';
import { GdiFontCollection } from './gdi-font-engine';

interface Capture { face: string; height: number; width: number; weight: number; italic: boolean; code: number; x: number; y: number; w: number; h: number; data: string; outline: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/times-italic-glyphs.json.gz', import.meta.url))).toString());
const fonts = windowsFonts();

/** Height:character:differing pixels of the bitmaps that still differ. */
const INEXACT = new Map(('-14:j:2 -15:j:1 -16:j:1 -20:<:10 -28:j:3 -32:j:1 -36:j:5 -48:j:6 -72:j:70').split(' ').map((s) => {
	const [h, c, n] = s.split(':'); return [`${h}:${c}`, Number(n)] as const;
}));

function nativePoints(encoded: string): Set<string> {
	const bytes = Buffer.from(encoded, 'base64'), points = new Set<string>();
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

describe.skipIf(!fonts)('native monochrome glyphs of Times New Roman Italic with a side bearing off xMin', () => {
	const collection = fonts ? new GdiFontCollection(fonts) : null;
	const realize = (height: number): any => collection!.realize({ face: 'Times New Roman', height, width: 0, weight: 400, italic: true, charSet: 1,
		pitchAndFamily: 0, quality: 3, unhinted: false, gdiPlus: false });

	it('draws 93 of 102 bitmaps exactly and no bitmap outside the recorded misses', () => {
		expect(captures).toHaveLength(102);
		let exact = 0, pixels = 0;
		for (const c of captures) {
			const font = realize(c.height);
			expect(font.syntheticItalic).toBe(false);
			const bitmap = font.glyph(font.glyphIndex(c.code)).bitmap;
			const ours = new Set<string>();
			if (bitmap) for (let row = 0; row < bitmap.height; row++) for (let col = 0; col < bitmap.width; col++) {
				if (bitmap.data[row * bitmap.width + col]) ours.add(`${bitmap.left + col},${bitmap.top - 1 - row}`);
			}
			const native = new Set<string>();
			const bytes = Buffer.from(c.data, 'base64'), stride = Math.ceil(c.w / 32) * 4;
			for (let row = 0; row < c.h; row++) for (let col = 0; col < c.w; col++) {
				if (bytes[row * stride + (col >> 3)] & (128 >> (col & 7))) native.add(`${c.x + col},${c.y - 1 - row}`);
			}
			const differing = [...new Set([...ours, ...native])].filter((p) => ours.has(p) !== native.has(p)).length;
			if (differing === 0) exact++;
			else {
				const key = `${c.height}:${String.fromCharCode(c.code)}`;
				expect(INEXACT.has(key), key).toBe(true);
				expect(differing, key).toBeLessThanOrEqual(INEXACT.get(key)!);
			}
			pixels += differing;
		}
		expect(exact).toBeGreaterThanOrEqual(93);
		expect(pixels).toBeLessThanOrEqual(99);
	});

	it('hints < > = ~ to the native outline point for point, `<` at 20 px aside', () => {
		let compared = 0;
		for (const c of captures) {
			if (!'<>=~'.includes(String.fromCharCode(c.code)) || (c.height === -20 && c.code === 60)) continue;
			const font = realize(c.height);
			const outline = font.outline(font.glyphIndex(c.code));
			const ours = new Set<string>(), implied = new Set<string>();
			let start = 0;
			for (const end of outline.endPts as number[]) {
				for (let i = start; i <= end; i++) {
					ours.add(`${outline.xs[i]},${outline.ys[i]}`);
					const next = i === end ? start : i + 1;
					if (!outline.onCurve[i] && !outline.onCurve[next]) implied.add(`${(outline.xs[i] + outline.xs[next]) / 2},${(outline.ys[i] + outline.ys[next]) / 2}`);
				}
				start = end + 1;
			}
			const native = nativePoints(c.outline);
			const missing = [...native].filter((p) => !ours.has(p) && !implied.has(p));
			if (missing.length > 0) expect(missing, `${c.height} ${String.fromCharCode(c.code)}`).toEqual([]);
			compared++;
		}
		expect(compared).toBe(4 * 17 - 1);
	});
});
