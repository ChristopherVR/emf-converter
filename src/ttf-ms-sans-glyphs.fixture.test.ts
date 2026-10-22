/**
 * Native GetGlyphOutline(GGO_BITMAP) of Microsoft Sans Serif (the face behind MS Shell Dlg) at 24 em heights, U+0020..U+007E
 * (`ms-sans-glyphs.json.gz`, `GlyphSheetProbe.cs`, `generate-ms-sans-glyphs.ps1`). Needs the installed font the capture was made with.
 *
 * The 7 at 11 to 15 px is the case that showed where GDI places a bitmap: the glyph program shifts the left phantom point by -28/64
 * pixel (SHPIX), GGO_NATIVE reports the outline relative to that point (our hinted outline equals it), and the bitmap is
 * rasterized from the whole pixel nearest to it, keeping the fraction (`rasterShift`). Before the rule those five glyphs differed
 * by 6 to 8 pixels each and `text-msshelldlg-hm13` by 8; every other glyph that moves the point does so by whole pixels.
 *
 * Every glyph not listed below must stay exact, and the list (single curve or diagonal ties; 63 pixels over 40 glyphs) may only shrink.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { windowsFonts } from './__fixtures__/gdi-parity-harness';
import { GdiFontCollection } from './gdi-font-engine';
import { dropoutMode, rasterizeGray } from './ttf-raster';

interface Capture { face: string; height: number; width: number; weight: number; italic: boolean; code: number; x: number; y: number; w: number; h: number; data: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/ms-sans-glyphs.json.gz', import.meta.url))).toString());
const fonts = windowsFonts();

/** Height:character:differing pixels of the glyphs that still differ. */
const INEXACT = new Map(('-6:@:2 -6:O:1 -6:Q:1 -6:S:1 -6:f:1 -6:g:1 -7:$:2 -7:%:1 -7:>:1 -7:d:1 -7:g:1 -7:q:1 -8:s:2 -13:8:2 -13:g:2 -13:q:2 -14:&:2 ' +
	'-14:5:2 -16:@:2 -17:@:2 -18:%:1 -19:y:1 -26:D:1 -26:\\:1 -33:1:1 -33:B:1 -36:(:1 -36:):1 -36:0:1 -44:@:1 -44:D:1 -44:^:1 -48:@:1 -48:u:1 ' +
	'-72:(:7 -72:):6 -72:@:3 -72:O:1 -72:Q:1 -72:a:1').split(' ').map((s) => { const [h, c, n] = s.split(':'); return [`${h}:${c}`, Number(n)] as const; }));

describe.skipIf(!fonts)('native grayscale glyphs of Microsoft Sans Serif (GGO_GRAY4_BITMAP)', () => {
	it('rasterizes the 7 of 11 to 15 px from the pixel nearest its moved left phantom point, as native does', () => {
		const gray: any[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/ms-sans-glyphs-gray.json.gz', import.meta.url))).toString());
		const collection = new GdiFontCollection(fonts!);
		const levels = (b: { width: number; height: number; left: number; top: number; data: ArrayLike<number> } | null): Map<string, number> => {
			const out = new Map<string, number>();
			if (b) for (let r = 0; r < b.height; r++) for (let q = 0; q < b.width; q++) if (b.data[r * b.width + q]) out.set(`${b.left + q},${b.top - 1 - r}`, b.data[r * b.width + q]);
			return out;
		};
		let moved = 0;
		for (const c of gray) {
			if (c.format !== 5) continue;
			const font: any = collection.realize({ face: c.face, height: c.height, width: 0, weight: 400, italic: false, charSet: 1, pitchAndFamily: 0, quality: 4, unhinted: false, gdiPlus: false });
			const src = font.outline(font.glyphIndex(c.code));
			if (!src.rasterShift) continue;
			moved++;
			const native = new Map<string, number>();
			const bytes = Buffer.from(c.data, 'base64'), stride = (c.w + 3) & ~3;
			for (let r = 0; r < c.h; r++) for (let q = 0; q < c.w; q++) if (bytes[r * stride + q]) native.set(`${c.x + q},${c.y - 1 - r}`, bytes[r * stride + q]);
			const shifted = { ...src, xs: Float64Array.from(src.xs as ArrayLike<number>, (x) => x + src.rasterShift) };
			const ours = levels(rasterizeGray(shifted, src.scanSet ? dropoutMode(src.scanControl, src.scanType) : 2, true, false, true));
			expect([...new Set([...ours.keys(), ...native.keys()])].filter((k) => ours.get(k) !== native.get(k)), `${c.height} ${String.fromCharCode(c.code)}`).toEqual([]);
		}
		expect(moved).toBe(5);
	});
});

describe.skipIf(!fonts)('native monochrome glyphs of Microsoft Sans Serif', () => {
	it('draws 2,240 of 2,280 bitmaps exactly and no glyph outside the recorded misses', () => {
		const collection = new GdiFontCollection(fonts!);
		expect(captures).toHaveLength(2280);
		let exact = 0, pixels = 0;
		const fonts_ = new Map<number, any>();
		for (const c of captures) {
			let font = fonts_.get(c.height);
			if (!font) {
				font = collection.realize({ face: c.face, height: c.height, width: 0, weight: 400, italic: false, charSet: 1, pitchAndFamily: 0, quality: 3, unhinted: false, gdiPlus: false });
				fonts_.set(c.height, font);
			}
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
		expect(exact).toBeGreaterThanOrEqual(2240);
		expect(pixels).toBeLessThanOrEqual(63);
	});
});
