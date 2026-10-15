/**
 * Native GetGlyphOutline(GGO_BITMAP) of program-free ovals of four quadratic arcs at 32 ppem (`curve-ovals.ttf`, one font unit
 * is one 26.6 unit, so the outline GDI scan converts is the one written, unhinted). The curved edges are the converter's
 * scan conversion alone, free of hinting: 921 of 1,024 bitmaps are exact, 149 pixels differ (the thin tips of the extremes,
 * where dropout control decides, and a few edge samples). Measured with this set and the 6,907 curved-edge decisions of
 * `mono-sheet-glyphs.json.gz`: GDI scan converts a straight edge exactly and rounds the on-curve point implied between two
 * off-curve points to the 26.6 grid, halves up.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GdiFontCollection } from './gdi-font-engine';

interface Capture { glyph: number; variant: number; bitmap: string; x: number; y: number; w: number; h: number }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/curve-ovals.json.gz', import.meta.url))).toString())
	.filter((c: Capture) => c.glyph * 256 + c.variant < 1024);

describe('native monochrome bitmaps of generated oval glyphs', () => {
	it('keeps the recorded exact count and pixel difference', () => {
		const collection = new GdiFontCollection([readFileSync(new URL('./__fixtures__/gdi/curve-ovals.ttf', import.meta.url))]);
		const font = collection.realize({ face: 'Parity Curves', height: -32, width: 0, weight: 400, italic: false, charSet: 1,
			pitchAndFamily: 0, quality: 3, unhinted: false, gdiPlus: false }) as any;
		expect(captures).toHaveLength(1024);
		let exact = 0, pixels = 0;
		for (const c of captures) {
			const bitmap = font.glyph(font.glyphIndex(0xE000 + c.glyph * 256 + c.variant)).bitmap;
			const ours = new Set<string>();
			if (bitmap) for (let row = 0; row < bitmap.height; row++) for (let col = 0; col < bitmap.width; col++) {
				if (bitmap.data[row * bitmap.width + col]) ours.add(`${bitmap.left + col},${bitmap.top - 1 - row}`);
			}
			const native = new Set<string>();
			const bytes = Buffer.from(c.bitmap, 'base64'), stride = Math.ceil(c.w / 32) * 4;
			for (let row = 0; row < c.h; row++) for (let col = 0; col < c.w; col++) {
				if (bytes[row * stride + (col >> 3)] & (128 >> (col & 7))) native.add(`${c.x + col},${c.y - 1 - row}`);
			}
			const differing = [...new Set([...ours, ...native])].filter((p) => ours.has(p) !== native.has(p)).length;
			if (differing === 0) exact++;
			pixels += differing;
		}
		expect(exact).toBeGreaterThanOrEqual(921);
		expect(pixels).toBeLessThanOrEqual(149);
	});
});
