/** Native GGO_BITMAP controls establish the safe scope of smart-crossing refinement.
 * System-font assertions run when the same Windows fonts used by the existing
 * parity harness are available; private portable controls live in ttf-mono-stub.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { windowsFonts } from './__fixtures__/gdi-parity-harness';
import { GdiFontCollection } from './gdi-font-engine';
import { rasterizeMono, type GlyphBitmap } from './ttf-raster';

interface Capture {
	face: string; ppem: number; width: number; weight: number; italic: boolean; code: number;
	x: number; y: number; w: number; h: number; data: string;
}
const load = (name: string): any => JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${name}`, import.meta.url))).toString());
const captures: Capture[] = load('mono-condensed.json.gz');
const evidence: { stats: { total: number; afterExact: number }; bounds: Record<string, [number, number]> } = load('mono-condensed-bounds.json.gz');
const fontFiles = windowsFonts();
function difference(bitmap: GlyphBitmap | null, c: Capture): number {
	const actual = new Set<string>(), expected = new Set<string>();
	if (bitmap) for (let row = 0; row < bitmap.height; row++) for (let col = 0; col < bitmap.width; col++) {
		if (bitmap.data[row * bitmap.width + col]) actual.add(`${bitmap.left + col},${bitmap.top - 1 - row}`);
	}
	const bytes = Buffer.from(c.data, 'base64'), stride = Math.ceil(c.w / 32) * 4;
	for (let row = 0; row < c.h; row++) for (let col = 0; col < c.w; col++) {
		if (bytes[row * stride + (col >> 3)] & (128 >> (col & 7))) expected.add(`${c.x + col},${c.y - 1 - row}`);
	}
	// Compare the whole absolute-coordinate ink union, including any output
	// beyond the native black box; negative x/y never wrap into another row.
	return [...new Set([...actual, ...expected])].filter((p) => actual.has(p) !== expected.has(p)).length;
}

describe.skipIf(!fontFiles)('native uniformly realised and stretched mono glyphs', () => {
	it('preserves each of 1,200 native controls across five faces and two styles', () => {
		const collection = new GdiFontCollection(fontFiles!);
		expect(captures).toHaveLength(1200);
		let exact = 0;
		for (const c of captures) {
			const font = collection.realize({ face: c.face, height: -c.ppem, width: c.width, weight: c.weight, italic: c.italic,
				charSet: 1, pitchAndFamily: 0, quality: 3, unhinted: false, gdiPlus: false })!;
			const key = `${c.face}:${c.ppem}:${c.width}:${c.weight}:${+c.italic}:${c.code}`;
			const [before, ceiling] = evidence.bounds[key];
			const mismatch = difference(font.glyph(font.glyphIndex(c.code)).bitmap, c);
			expect(mismatch, key).toBeLessThanOrEqual(ceiling);
			expect(mismatch, `prior bound ${key}`).toBeLessThanOrEqual(before);
			if (mismatch === 0) exact++;
		}
		expect(exact).toBeGreaterThanOrEqual(evidence.stats.afterExact);
	});
	it('rasterises the hinted condensed Tahoma x exactly with smart crossings', () => {
		const c = captures.find((c) => c.face === 'Tahoma' && c.ppem === 11 && c.width === 4 && c.weight === 400 && !c.italic && c.code === 120)!;
		const collection = new GdiFontCollection(fontFiles!);
		const font = collection.realize({ face: c.face, height: -c.ppem, width: c.width, weight: c.weight, italic: c.italic,
			charSet: 1, pitchAndFamily: 0, quality: 3, unhinted: false, gdiPlus: false }) as any;
		const index = font.glyphIndex(c.code), outline = font.outline(index);
		expect(font.ppemX).toBe(9);
		expect(difference(font.glyph(index).bitmap, c)).toBe(0);
		// Applying the smart refinement to this stretched glyph was a counterexample (3 samples wrong) while its
		// hinted outline still differed from native's (stretched IP used scaled font units); with GDI's hinting
		// arithmetic the outline is native's and the refinement is exact.
		expect(difference(rasterizeMono(outline, 5, undefined, true, true), c)).toBe(0);
	});
});
