/** Native neighbouring-square stub control and smart 26.6 crossing precision.
 * Regenerate inputs with scripts/gdi-fixtures/generate-mono-stubs.ps1.
 * Bounds record a frozen pre-change renderer and this change against the
 * same complete native GGO_BITMAP masks; expected exact counts are minima.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseFontFile } from './ttf-font';
import { HintedSize } from './ttf-hinting';
import { rasterizeMono, type GlyphBitmap } from './ttf-raster';

interface NativeBitmap {
	group: 'original' | 'independent' | 'heldout';
	mode: number;
	ppem: number;
	index: number;
	x: number;
	y: number;
	w: number;
	h: number;
	data: string;
}
const file = (name: string): Buffer => readFileSync(new URL(`./__fixtures__/gdi/${name}`, import.meta.url));
const load = (name: string): any => JSON.parse(gunzipSync(file(name)).toString());
const references: NativeBitmap[] = [
	...load('text-raster-mono.json.gz').filter((c: any) => c.format === 1 && ['st1', 'st4', 'st5'].includes(c.set))
		.map((c: any) => ({ ...c, group: 'original', mode: +c.set.slice(-1) })),
	...load('mono-stubs.json.gz').map((c: any) => ({ ...c, group: 'independent' })),
	...load('mono-stubs-heldout.json.gz').map((c: any) => ({ ...c, group: 'heldout' })),
];
const evidence = load('mono-stub-bounds.json.gz') as {
	stats: Record<string, { total: number; afterExact: number }>;
	increases: { key: string; before: number; after: number }[];
	bounds: Record<string, [number, number, string?]>;
};
const fonts = {
	original: parseFontFile(file('raster-polygons-st1.ttf'))[0],
	independent: parseFontFile(file('mono-stub-st1.ttf'))[0],
	heldout: parseFontFile(file('mono-stub-heldout-st1.ttf'))[0],
};

function samples(bitmap: GlyphBitmap | null): Set<string> {
	const result = new Set<string>();
	if (bitmap) for (let row = 0; row < bitmap.height; row++) for (let col = 0; col < bitmap.width; col++) {
		if (bitmap.data[row * bitmap.width + col]) result.add(`${bitmap.left + col},${bitmap.top - 1 - row}`);
	}
	return result;
}
function native(c: NativeBitmap): Set<string> {
	const result = new Set<string>(), bytes = Buffer.from(c.data, 'base64'), stride = Math.ceil(c.w / 32) * 4;
	for (let row = 0; row < c.h; row++) for (let col = 0; col < c.w; col++) {
		if (bytes[row * stride + (col >> 3)] & (128 >> (col & 7))) result.add(`${c.x + col},${c.y - 1 - row}`);
	}
	return result;
}
function difference(a: Set<string>, b: Set<string>): number {
	// Absolute-coordinate union includes every output pixel beyond the native
	// black box, with no clipping or negative-coordinate row wrapping.
	let count = 0;
	for (const key of new Set([...a, ...b])) if (a.has(key) !== b.has(key)) count++;
	return count;
}
function fingerprint(bitmap: GlyphBitmap | null): string {
	const hash = createHash('sha256').update(JSON.stringify(bitmap ? [bitmap.width, bitmap.height, bitmap.left, bitmap.top] : null));
	if (bitmap) hash.update(bitmap.data);
	return hash.digest('hex');
}

describe('monochrome stub control against native Windows', () => {
	it('compares every original, independent and held-out bitmap', () => {
		expect(references).toHaveLength(29_696);
		expect(Object.keys(evidence.bounds)).toHaveLength(references.length);
	});
	for (const [groupMode, stats] of Object.entries(evidence.stats)) {
		it(`${groupMode}: preserves every prior exact case and pins each residual`, () => {
			const [group, mode] = groupMode.split(':');
			const selected = references.filter((c) => c.group === group && c.mode === +mode);
			expect(selected).toHaveLength(stats.total);
			const sizes = new Map<number, HintedSize>();
			let exact = 0;
			for (const c of selected) {
				let size = sizes.get(c.ppem);
				if (!size) {
					size = new HintedSize(fonts[c.group], c.ppem, c.ppem, { version: 35, grayscale: false });
					sizes.set(c.ppem, size);
				}
				const outline = size.hintGlyph(c.index + 1), bitmap = rasterizeMono(outline, c.mode, undefined, true, true);
				const key = `${groupMode}:${c.ppem}:${c.index}`;
				const [before, ceiling, unchanged] = evidence.bounds[key];
				const mismatch = difference(samples(bitmap), native(c));
				expect(mismatch, key).toBeLessThanOrEqual(ceiling);
				if (before === 0) expect(mismatch, `prior exact ${key}`).toBe(0);
				// Curved and multiple contours retain the complete prior bitmap,
				// including its dimensions, placement and every zero/one sample.
				if (unchanged) expect(fingerprint(bitmap), key).toBe(unchanged);
				if (mismatch === 0) exact++;
			}
			expect(exact).toBeGreaterThanOrEqual(stats.afterExact);
		});
	}
	it('records twelve one-pixel increases in previously inexact independent controls', () => {
		// Historical metadata; runtime ceilings above permit later improvements.
		expect(evidence.increases).toHaveLength(12);
		for (const c of evidence.increases) {
			expect(c.key).not.toMatch(/^original:/);
			expect([c.before, c.after]).toEqual([1, 2]);
		}
	});
});
